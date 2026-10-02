import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import { type Database, listClaudeAccounts } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { claudeAccountBind, claudeAccountDir, type HostPathTranslator } from '../runner/index.js';
import { type CommandRunner, spawnCommand } from '../ssh/index.js';
import { CLAUDE_CREDENTIALS_FILE } from './accounts.js';

/**
 * How much of each account's 5-hour and 7-day plan limit is used (multiple
 * accounts US-005).
 *
 * The numbers come from the same endpoint Claude Code's own `/usage` reads:
 * `GET /api/oauth/usage`, authorised with the account's OAuth access token out
 * of `<account dir>/.credentials.json`. The server only ever *reads* that
 * file. When the access token has expired, the CLI is asked to refresh it in
 * a probe container (the CLI owns the refresh, and writes the file itself), so
 * the operator only signs in again once the refresh token is gone.
 *
 * Nothing in here throws to its caller: every failure is an `error` text on
 * the answer, with both windows `null`.
 */

/** The path appended to `CLAUDE_USAGE_URL`. */
export const CLAUDE_USAGE_PATH = '/api/oauth/usage';
/** The beta header the OAuth endpoints require. */
export const CLAUDE_USAGE_BETA = 'oauth-2025-04-20';
/** The error text that means "only a new login helps"; the web compares against it. */
export const CLAUDE_SIGN_IN_AGAIN = 'sign in again';
/** Label put on the refresh probe container, so a stray one is identifiable. */
export const CLAUDE_REFRESH_LABEL = 'chief-web.role=claude-token-refresh';
/** The cheapest model, for the `claude -p` that forces a refresh. */
export const CLAUDE_REFRESH_MODEL = 'haiku';
/** Tokens expiring within this window are refreshed by the background sweep. */
export const CLAUDE_REFRESH_AHEAD_MS = 10 * 60_000;
/**
 * After a refresh that left an expired token expired, the same account is not
 * probed again for this long; the background sweep of a token that has not
 * expired yet is throttled to one probe per this long as well.
 */
export const CLAUDE_REFRESH_COOLDOWN_MS = 60_000;
/** How often the background ticker looks at every account; matches the 5-second stats poll. */
export const CLAUDE_USAGE_TICK_MS = 5_000;
/** Cap on one usage request, so a hung API cannot pin the ticker. */
const FETCH_TIMEOUT_MS = 15_000;
/** The `claude -p` step starts a model call as well as a container. */
const PROMPT_REFRESH_MIN_TIMEOUT_MS = 90_000;

/** One rolling limit window. */
export interface ClaudeUsageWindow {
  /** Percentage of the window used, 0–100. */
  readonly utilization: number;
  /**
   * When the window resets (ISO-8601), or `null` when the API names no reset —
   * a window nothing has been used in yet has not started.
   */
  readonly resetsAt: string | null;
}

export interface ClaudeUsage {
  /** `null` when the API does not report this window (API-key or console accounts). */
  readonly fiveHour: ClaudeUsageWindow | null;
  readonly sevenDay: ClaudeUsageWindow | null;
  /** When this answer was produced (UTC ISO-8601). */
  readonly fetchedAt: string;
  /** Why there are no numbers, or `null` when the API answered. */
  readonly error: string | null;
}

/** What `.credentials.json` says about an account's login. */
export type ClaudeCredentials =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'not-oauth' }
  | {
      readonly kind: 'oauth';
      readonly accessToken: string;
      /** Epoch ms the access token expires at; `null` when the file does not say. */
      readonly expiresAt: number | null;
      /** Epoch ms the refresh token expires at; `null` (treated as valid) when the file does not say. */
      readonly refreshTokenExpiresAt: number | null;
    };

export function claudeCredentialsPath(config: Pick<Config, 'dataDir'>, accountId: string): string {
  return path.join(claudeAccountDir(config, accountId), CLAUDE_CREDENTIALS_FILE);
}

/** Reads an account's credentials file. Never throws. */
export function readClaudeCredentials(file: string): ClaudeCredentials {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', reason: String(cause) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unreadable', reason: 'the credentials file is not JSON' };
  }
  const oauth = isRecord(parsed) ? parsed['claudeAiOauth'] : undefined;
  if (!isRecord(oauth)) return { kind: 'not-oauth' };
  const accessToken = oauth['accessToken'];
  if (typeof accessToken !== 'string' || accessToken === '') return { kind: 'not-oauth' };
  return {
    kind: 'oauth',
    accessToken,
    expiresAt: epochMs(oauth['expiresAt']),
    refreshTokenExpiresAt: epochMs(oauth['refreshTokenExpiresAt']),
  };
}

/** A number is epoch milliseconds, a string an ISO date; anything else is unknown. */
function epochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function expired(at: number | null, now: number): boolean {
  return at !== null && at <= now;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Asks the usage endpoint with one access token. Never throws. */
export async function fetchClaudeUsage(
  baseUrl: string,
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<ClaudeUsage> {
  const url = `${baseUrl.replace(/\/+$/, '')}${CLAUDE_USAGE_PATH}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': CLAUDE_USAGE_BETA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    return failedClaudeUsage(`The usage request failed: ${describe(cause)}`);
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).trim().slice(0, 300);
    return failedClaudeUsage(
      `The usage endpoint answered ${String(response.status)}${body === '' ? '' : `: ${body}`}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return failedClaudeUsage('The usage endpoint did not answer with JSON.');
  }
  if (!isRecord(body)) return failedClaudeUsage('The usage endpoint answered with no usage.');
  return {
    fiveHour: usageWindow(body['five_hour'] ?? body['fiveHour']),
    sevenDay: usageWindow(body['seven_day'] ?? body['sevenDay']),
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

/** A window the API reports; anything else (absent, `null`, no number) is `null`. */
function usageWindow(raw: unknown): ClaudeUsageWindow | null {
  if (!isRecord(raw)) return null;
  const utilization = raw['utilization'];
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  const reset = epochMs(raw['resets_at'] ?? raw['resetsAt']);
  return {
    utilization: Math.min(100, Math.max(0, utilization)),
    resetsAt: reset === null ? null : new Date(reset).toISOString(),
  };
}

/** An answer with no numbers, carrying why. */
export function failedClaudeUsage(message: string): ClaudeUsage {
  return { fiveHour: null, sevenDay: null, fetchedAt: new Date().toISOString(), error: message };
}

/** `docker run` arguments for one step of the refresh probe. Exported so tests can assert them. */
export async function claudeRefreshArgs(
  config: Config,
  paths: HostPathTranslator,
  accountId: string,
  cliArgs: readonly string[],
): Promise<string[]> {
  return [
    'run',
    '--rm',
    '--label',
    CLAUDE_REFRESH_LABEL,
    '--volume',
    await claudeAccountBind(config, paths, accountId),
    '--entrypoint',
    'claude',
    config.runnerImage,
    ...cliArgs,
  ];
}

export const CLAUDE_REFRESH_STATUS_ARGS = ['auth', 'status', '--json'] as const;
export const CLAUDE_REFRESH_PROMPT_ARGS = [
  '-p',
  'ok',
  '--max-turns',
  '1',
  '--model',
  CLAUDE_REFRESH_MODEL,
] as const;

/**
 * Reads, caches and refreshes every account's plan usage, and keeps the
 * accounts' OAuth tokens fresh (multiple accounts US-005).
 *
 * `usage(id)` is a plain cache read, so `/api/stats` and `/api/claude` never
 * wait on the network: the background ticker (`start()`) fetches each
 * account's usage once its cached answer is older than `CLAUDE_USAGE_CACHE_MS`,
 * and on the same tick refreshes every token that expires within the next ten
 * minutes, so a launch never mounts a stale one.
 */
export class ClaudeUsageService {
  private readonly cached = new Map<string, ClaudeUsage>();
  private readonly fetching = new Map<string, Promise<ClaudeUsage>>();
  private readonly refreshing = new Map<string, Promise<void>>();
  /** When a refresh last left an *expired* token expired, per account. */
  private readonly lastFailedRefresh = new Map<string, number>();
  /** When the sweep last probed a token that had not expired yet, per account. */
  private readonly lastSweep = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  /** Told about every fetched answer; see {@link onUsage}. */
  private readonly listeners: ((accountId: string, usage: ClaudeUsage) => void)[] = [];

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly paths: HostPathTranslator,
    private readonly run: CommandRunner = spawnCommand,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached usage of an account, or `null` before its first fetch. Never waits. */
  usage(accountId: string): ClaudeUsage | null {
    return this.cached.get(accountId) ?? null;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.arm();
  }

  stop(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.arm();
      void this.tick();
    }, CLAUDE_USAGE_TICK_MS);
    // The HTTP listener keeps the process alive; the ticker must never be the reason.
    this.timer.unref();
  }

  /**
   * One pass over every account: refresh tokens about to expire, then fetch
   * the usage of every account whose cached answer is stale. A tick still
   * running is joined rather than doubled.
   */
  tick(): Promise<void> {
    if (this.ticking !== null) return this.ticking;
    const run = this.runTick()
      .catch((cause: unknown) => {
        logger.warn('the claude usage tick failed', { error: describe(cause) });
      })
      .finally(() => {
        this.ticking = null;
      });
    this.ticking = run;
    return run;
  }

  private async runTick(): Promise<void> {
    const ids = listClaudeAccounts(this.db).map((account) => account.id);
    const known = new Set(ids);
    for (const id of [...this.cached.keys()]) if (!known.has(id)) this.cached.delete(id);
    for (const map of [this.lastFailedRefresh, this.lastSweep]) {
      for (const id of [...map.keys()]) if (!known.has(id)) map.delete(id);
    }
    await Promise.all(
      ids.map(async (id) => {
        await this.sweep(id);
        const cached = this.cached.get(id);
        if (cached === undefined || !this.isFresh(cached)) await this.refresh(id);
      }),
    );
  }

  /** Refreshes the account's token when it expires within the next ten minutes. */
  private async sweep(accountId: string): Promise<void> {
    const credentials = readClaudeCredentials(claudeCredentialsPath(this.config, accountId));
    if (credentials.kind !== 'oauth' || credentials.expiresAt === null) return;
    const now = this.now();
    if (credentials.expiresAt > now + CLAUDE_REFRESH_AHEAD_MS) return;
    if (expired(credentials.refreshTokenExpiresAt, now)) return;
    if (this.coolingDown(accountId)) return;
    // The CLI only refreshes inside its own buffer, so a token with minutes
    // left may come back unchanged; ask again a minute later, no sooner.
    if (!expired(credentials.expiresAt, now)) {
      const last = this.lastSweep.get(accountId);
      if (last !== undefined && now - last < CLAUDE_REFRESH_COOLDOWN_MS) return;
      this.lastSweep.set(accountId, now);
    }
    await this.refreshToken(accountId);
  }

  /**
   * Calls `listener` with every usage answer this service caches — how a
   * capped window arms the usage-limit hold (multiple accounts US-014)
   * without `claude/` knowing about the hold. A listener that throws is
   * logged and ignored.
   */
  onUsage(listener: (accountId: string, usage: ClaudeUsage) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Fetches an account's usage now and caches it. Concurrent callers for the
   * same account share one request. Never throws.
   */
  refresh(accountId: string): Promise<ClaudeUsage> {
    const inFlight = this.fetching.get(accountId);
    if (inFlight !== undefined) return inFlight;
    const started = this.read(accountId)
      .catch((cause: unknown) => failedClaudeUsage(`The usage could not be read: ${describe(cause)}`))
      .then((usage) => {
        if (this.fetching.get(accountId) === started) {
          this.cached.set(accountId, usage);
          for (const listener of this.listeners) {
            try {
              listener(accountId, usage);
            } catch (cause) {
              logger.warn('a Claude usage listener failed', { account: accountId, error: describe(cause) });
            }
          }
        }
        return usage;
      })
      .finally(() => {
        if (this.fetching.get(accountId) === started) this.fetching.delete(accountId);
      });
    this.fetching.set(accountId, started);
    return started;
  }

  private async read(accountId: string): Promise<ClaudeUsage> {
    const file = claudeCredentialsPath(this.config, accountId);
    let credentials = readClaudeCredentials(file);
    if (credentials.kind === 'oauth' && expired(credentials.expiresAt, this.now())) {
      if (expired(credentials.refreshTokenExpiresAt, this.now())) {
        return failedClaudeUsage(CLAUDE_SIGN_IN_AGAIN);
      }
      if (!this.coolingDown(accountId)) await this.refreshToken(accountId);
      credentials = readClaudeCredentials(file);
      if (credentials.kind === 'oauth' && expired(credentials.expiresAt, this.now())) {
        return failedClaudeUsage(CLAUDE_SIGN_IN_AGAIN);
      }
    }
    switch (credentials.kind) {
      case 'missing':
        return failedClaudeUsage('This account has no credentials file; it has never been signed in.');
      case 'unreadable':
        return failedClaudeUsage(`The credentials file could not be read: ${credentials.reason}`);
      case 'not-oauth':
        return failedClaudeUsage('This account is not signed in with a Claude.ai login, so it has no plan usage.');
      case 'oauth':
        return fetchClaudeUsage(this.config.claudeUsageUrl, credentials.accessToken, this.fetchImpl);
    }
  }

  /**
   * The refresh probe: lets the CLI refresh its own token in a `--rm` runner
   * container mounting the account's directory. `claude auth status` first;
   * when the file is still expired afterwards, one cheap `claude -p`, which
   * cannot run without a valid token. Shared per account; only a refresh that
   * leaves an expired token expired starts the cooldown — a token that had
   * not expired yet and came back unchanged is not a failure. Never throws.
   */
  private refreshToken(accountId: string): Promise<void> {
    const inFlight = this.refreshing.get(accountId);
    if (inFlight !== undefined) return inFlight;
    const started = this.runRefresh(accountId)
      .catch((cause: unknown) => {
        logger.warn('the claude token refresh failed', { accountId, error: describe(cause) });
      })
      .finally(() => {
        this.refreshing.delete(accountId);
      });
    this.refreshing.set(accountId, started);
    return started;
  }

  private async runRefresh(accountId: string): Promise<void> {
    const file = claudeCredentialsPath(this.config, accountId);
    const before = expiryOf(readClaudeCredentials(file));
    await this.runCli(accountId, CLAUDE_REFRESH_STATUS_ARGS, this.config.claudeProbeTimeoutMs);
    if (!expired(expiryOf(readClaudeCredentials(file)), this.now())) {
      if (expiryOf(readClaudeCredentials(file)) !== before) {
        this.lastFailedRefresh.delete(accountId);
        logger.info('claude token refreshed', { accountId });
      }
      return;
    }
    await this.runCli(
      accountId,
      CLAUDE_REFRESH_PROMPT_ARGS,
      Math.max(this.config.claudeProbeTimeoutMs, PROMPT_REFRESH_MIN_TIMEOUT_MS),
    );
    if (expired(expiryOf(readClaudeCredentials(file)), this.now())) {
      this.lastFailedRefresh.set(accountId, this.now());
    } else {
      this.lastFailedRefresh.delete(accountId);
      logger.info('claude token refreshed', { accountId });
    }
  }

  private async runCli(accountId: string, cliArgs: readonly string[], timeoutMs: number): Promise<void> {
    const args = await claudeRefreshArgs(this.config, this.paths, accountId, cliArgs);
    const result = await this.run(this.config.dockerBin, args, '', timeoutMs);
    if (result.timedOut) logger.warn('the claude token refresh probe timed out', { accountId });
  }

  private coolingDown(accountId: string): boolean {
    const last = this.lastFailedRefresh.get(accountId);
    return last !== undefined && this.now() - last < CLAUDE_REFRESH_COOLDOWN_MS;
  }

  private isFresh(usage: ClaudeUsage): boolean {
    const age = this.now() - Date.parse(usage.fetchedAt);
    return Number.isFinite(age) && age >= 0 && age < this.config.claudeUsageCacheMs;
  }
}

function expiryOf(credentials: ClaudeCredentials): number | null {
  return credentials.kind === 'oauth' ? credentials.expiresAt : null;
}

export function createClaudeUsageService(
  config: Config,
  db: Database,
  paths: HostPathTranslator,
  run: CommandRunner = spawnCommand,
): ClaudeUsageService {
  return new ClaudeUsageService(config, db, paths, run);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
