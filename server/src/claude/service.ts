import type { Config } from '../config.js';
import {
  type ClaudeAccount,
  type Database,
  getClaudeAccount,
  listClaudeAccounts,
  updateClaudeAccount,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { HostPathTranslator } from '../runner/index.js';
import { type CommandRunner, spawnCommand } from '../ssh/index.js';
import { TerminalError, type TerminalManager } from '../terminal/index.js';
import {
  CLAUDE_LOGIN_COMMAND,
  CLAUDE_LOGIN_CWD,
  claudeLoginContainerArgs,
  claudeLoginContainerName,
  removeContainerArgs,
} from './login.js';
import { addClaudeAccount, defaultClaudeAccountId, removeClaudeAccount } from './accounts.js';
import { type ClaudeAuthStatus, probeClaudeAuth } from './status.js';
import type { ClaudeUsage } from './usage.js';

/** Where the account views read each account's cached plan usage from (US-005). */
export interface ClaudeUsageReader {
  /** The cached usage, or `null` before the first fetch. Must never wait. */
  usage(accountId: string): ClaudeUsage | null;
}

const NO_USAGE: ClaudeUsageReader = { usage: () => null };

/** A failure with an HTTP status the route can hand straight back. */
export class ClaudeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra fields for the JSON body, next to `error` and `message`. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** How long a `docker run --detach` / `docker rm -f` may take. */
const CONTAINER_COMMAND_TIMEOUT_MS = 60_000;

/** At most this many probe containers run at once when every account is checked. */
export const CLAUDE_STATUS_PROBE_CONCURRENCY = 3;

export interface ClaudeLoginView {
  /** True while a login terminal is open and its process still running. */
  readonly active: boolean;
  /** The account being signed in, or `null` when no login is in progress. */
  readonly accountId: string | null;
  /** Terminal to attach to (US-007), or `null` when no login is in progress. */
  readonly terminalId: string | null;
  readonly containerId: string | null;
  readonly containerName: string | null;
}

/**
 * One account and what its last probe said (multiple accounts US-004). The
 * profile fields come off the row, which every successful probe updates, so
 * an account that is signed out still shows who it was.
 */
export interface ClaudeAccountStatusView {
  readonly id: string;
  readonly nickname: string | null;
  readonly email: string | null;
  readonly organization: string | null;
  readonly subscription: string | null;
  readonly authenticated: boolean;
  /** Why the probe could not answer, or `null` when it did. */
  readonly error: string | null;
  readonly checkedAt: string;
  /**
   * The account's 5-hour and 7-day usage as last fetched (US-005), or `null`
   * before the first fetch. `usage.error === 'sign in again'` means only a
   * new login helps.
   */
  readonly usage: ClaudeUsage | null;
}

/** Everything the settings page needs in one response. */
export interface ClaudeStateView {
  /** Every account in display order. */
  readonly accounts: readonly ClaudeAccountStatusView[];
  /** The account a launch uses unless told otherwise, or null when none exist. */
  readonly defaultAccountId: string | null;
  readonly login: ClaudeLoginView;
}

/**
 * The answer to starting or ending an account's login. `account` is null once
 * an abandoned login has deleted the account it created.
 */
export interface ClaudeAccountLoginView {
  readonly account: ClaudeAccount | null;
  /** What the probe said when the login ended; null while it is starting. */
  readonly status: ClaudeAuthStatus | null;
  readonly login: ClaudeLoginView;
}

interface OpenLogin {
  readonly accountId: string;
  readonly terminalId: string;
  readonly containerId: string;
  /**
   * The account was created for this login attempt (`POST /api/claude/accounts`),
   * so abandoning the login may delete it again. In memory only: after a
   * restart nothing is ever deleted automatically.
   */
  readonly createdByLogin: boolean;
}

/**
 * Claude Code authentication (US-008).
 *
 * Owns two things: the cached answer to "is this account signed in?" (a probe
 * container per account, see `status.ts`; multiple accounts US-004) and the
 * temporary container the interactive `claude auth login` of one account runs
 * in (multiple accounts US-003). At most one login is open at a time.
 *
 * Probe results are cached per account because each costs a container start
 * (~1.5s) and is read on every settings page load and every session creation.
 * Starting or ending an account's login clears that account's entry, so the
 * status indicator reflects a finished login immediately and without a server
 * restart.
 */
export class ClaudeService {
  private readonly cached = new Map<string, ClaudeAuthStatus>();
  private readonly probing = new Map<string, Promise<ClaudeAuthStatus>>();
  private login: OpenLogin | null = null;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly terminals: TerminalManager,
    private readonly paths: HostPathTranslator,
    private readonly run: CommandRunner = spawnCommand,
    private readonly usage: ClaudeUsageReader = NO_USAGE,
  ) {}

  /**
   * One account's status: cached unless `force`, or unless the cached answer
   * is older than `CLAUDE_STATUS_CACHE_MS`. Concurrent callers for the same
   * account share one probe container.
   */
  async status(accountId: string, force = false): Promise<ClaudeAuthStatus> {
    this.requireAccount(accountId);
    const cached = this.cached.get(accountId);
    if (!force && cached !== undefined && this.isFresh(cached)) return cached;
    let probing = this.probing.get(accountId);
    if (probing === undefined) {
      // An entry invalidated while this probe ran is not refilled by it.
      const current = (): boolean => this.probing.get(accountId) === started;
      const started: Promise<ClaudeAuthStatus> = this.probe(accountId)
        .then((status) => {
          if (current()) this.cached.set(accountId, status);
          return status;
        })
        .finally(() => {
          if (current()) this.probing.delete(accountId);
        });
      probing = started;
      this.probing.set(accountId, started);
    }
    return probing;
  }

  /**
   * Every account's status in display order, probing in parallel with at most
   * `CLAUDE_STATUS_PROBE_CONCURRENCY` probe containers at once.
   */
  async statuses(force = false): Promise<ClaudeAccountStatusView[]> {
    const accounts = listClaudeAccounts(this.db);
    const statuses = await mapWithConcurrency(
      accounts,
      CLAUDE_STATUS_PROBE_CONCURRENCY,
      (account) => this.status(account.id, force).catch(() => null),
    );
    const views: ClaudeAccountStatusView[] = [];
    accounts.forEach((account, index) => {
      const status = statuses[index];
      // Removed while it was being probed.
      if (status === null || status === undefined) return;
      views.push(
        accountStatusView(
          getClaudeAccount(this.db, account.id) ?? account,
          status,
          this.usage.usage(account.id),
        ),
      );
    });
    return views;
  }

  /**
   * Runs the probe and, when the CLI says the account is signed in, writes the
   * profile it reported onto the row so lists can show it without a probe.
   */
  private async probe(accountId: string): Promise<ClaudeAuthStatus> {
    const status = await probeClaudeAuth(this.config, this.run, this.paths, accountId);
    if (status.authenticated) {
      updateClaudeAccount(this.db, accountId, {
        email: status.account,
        organization: status.organization,
        subscription: status.subscription,
        authMethod: status.authMethod,
      });
    }
    return status;
  }

  /** Forgets an account's cached status, and any probe of it still running. */
  private invalidate(accountId: string): void {
    this.cached.delete(accountId);
    this.probing.delete(accountId);
  }

  async state(force = false): Promise<ClaudeStateView> {
    const accounts = await this.statuses(force);
    return { accounts, defaultAccountId: defaultClaudeAccountId(this.db), login: this.loginView() };
  }

  /**
   * Adds an account and opens the login terminal that signs it in. An account
   * whose login cannot even be started is removed again.
   */
  async createAccountLogin(): Promise<ClaudeAccountLoginView> {
    this.refuseConcurrentLogin();
    const account = addClaudeAccount(this.config, this.db);
    try {
      await this.openLogin(account.id, true);
    } catch (cause) {
      removeClaudeAccount(this.config, this.db, account.id);
      throw cause;
    }
    return { account, status: null, login: this.loginView() };
  }

  /**
   * Signs an existing account in again: an expired token, or another email
   * behind the same account.
   */
  async startLogin(accountId: string): Promise<ClaudeAccountLoginView> {
    const account = this.requireAccount(accountId);
    this.refuseConcurrentLogin();
    await this.openLogin(account.id, false);
    return { account, status: null, login: this.loginView() };
  }

  /**
   * Ends an account's login: kills the terminal, removes the container, and
   * probes that account so the caller gets the state the login left behind.
   *
   * An account this login attempt created, that the probe says is not signed
   * in and that has never been signed in, is deleted again — an abandoned
   * "Add account" leaves nothing behind. Idempotent: with no login open (a
   * page reloaded after a server restart) the container is still cleared.
   */
  async stopLogin(accountId: string): Promise<ClaudeAccountLoginView> {
    this.requireAccount(accountId);
    const open = this.login?.accountId === accountId ? this.login : null;
    if (open !== null) await this.discardLogin();
    await this.removeContainer(claudeLoginContainerName(accountId));
    this.invalidate(accountId);

    // A successful probe has already written the profile onto the row.
    const status = await this.status(accountId, true);
    const account = this.requireAccount(accountId);
    if (!status.authenticated && open?.createdByLogin === true && neverAuthenticated(account)) {
      removeClaudeAccount(this.config, this.db, accountId);
      this.invalidate(accountId);
      logger.info('removed the account of an abandoned claude login', { accountId });
      return { account: null, status, login: this.loginView() };
    }
    return { account, status, login: this.loginView() };
  }

  private requireAccount(accountId: string): ClaudeAccount {
    const account = getClaudeAccount(this.db, accountId);
    if (account === null) {
      throw new ClaudeError(404, 'claude_account_not_found', `No Claude account ${accountId}.`);
    }
    return account;
  }

  /**
   * A login counts as open while its terminal exists, running or exited: a
   * finished `claude auth login` still waits for the operator to close it.
   */
  private refuseConcurrentLogin(): void {
    const open = this.login;
    if (open === null || this.terminals.get(open.terminalId) === undefined) return;
    const account = getClaudeAccount(this.db, open.accountId);
    const name = account?.nickname ?? account?.email ?? open.accountId;
    throw new ClaudeError(
      409,
      'claude_login_in_progress',
      `The login of Claude account ${name} is still open. Close its terminal first.`,
      { accountId: open.accountId },
    );
  }

  /** Spawns the account's login container and opens the terminal in it. */
  private async openLogin(accountId: string, createdByLogin: boolean): Promise<void> {
    // A previous login whose terminal was closed elsewhere, or a container a
    // server restart left behind (restarts drop terminals, not containers).
    // The name is fixed per account, so clearing it is also what makes
    // `docker run --name` succeed.
    if (this.login !== null) await this.discardLogin();
    const containerName = claudeLoginContainerName(accountId);
    await this.removeContainer(containerName);

    const created = await this.run(
      this.config.dockerBin,
      await claudeLoginContainerArgs(this.config, this.paths, accountId),
      '',
      CONTAINER_COMMAND_TIMEOUT_MS,
    );
    if (created.code !== 0) {
      throw new ClaudeError(
        502,
        'claude_login_container_failed',
        `Could not start the Claude login container: ${describeFailure(created.stderr, created.timedOut)}`,
      );
    }
    const containerId = created.stdout.trim().split('\n').pop()?.trim() ?? '';
    if (containerId === '') {
      throw new ClaudeError(
        502,
        'claude_login_container_failed',
        'Docker did not report an id for the Claude login container.',
      );
    }

    let terminalId: string;
    try {
      const terminal = await this.terminals.create({
        container: containerId,
        command: CLAUDE_LOGIN_COMMAND,
        cwd: CLAUDE_LOGIN_CWD,
      });
      terminalId = terminal.id;
    } catch (cause) {
      await this.removeContainer(containerId);
      if (cause instanceof TerminalError) {
        throw new ClaudeError(cause.status, cause.code, cause.message);
      }
      throw cause;
    }

    this.login = { accountId, terminalId, containerId, createdByLogin };
    // The login is about to change this account's credentials.
    this.invalidate(accountId);
    logger.info('claude login terminal opened', {
      accountId,
      terminal: terminalId,
      container: containerId,
    });
  }

  private loginView(): ClaudeLoginView {
    const login = this.login;
    const terminal = login === null ? undefined : this.terminals.get(login.terminalId);
    // A terminal the manager has forgotten (closed from the terminal page) is
    // no longer a login in progress.
    if (login === null || terminal === undefined) {
      return {
        active: false,
        accountId: login?.accountId ?? null,
        terminalId: null,
        containerId: login?.containerId ?? null,
        containerName: login === null ? null : claudeLoginContainerName(login.accountId),
      };
    }
    return {
      active: terminal.toView().status === 'running',
      accountId: login.accountId,
      terminalId: login.terminalId,
      containerId: login.containerId,
      containerName: claudeLoginContainerName(login.accountId),
    };
  }

  /** Best effort: a login that is already gone is not an error. */
  private async discardLogin(): Promise<void> {
    const current = this.login;
    this.login = null;
    if (current === null) return;
    try {
      await this.terminals.remove(current.terminalId);
    } catch (cause) {
      logger.warn('could not close the claude login terminal', { error: String(cause) });
    }
    await this.removeContainer(claudeLoginContainerName(current.accountId));
  }

  private async removeContainer(nameOrId: string): Promise<void> {
    try {
      await this.run(
        this.config.dockerBin,
        removeContainerArgs(nameOrId),
        '',
        CONTAINER_COMMAND_TIMEOUT_MS,
      );
    } catch (cause) {
      logger.warn('could not remove the claude login container', { error: String(cause) });
    }
  }

  private isFresh(status: ClaudeAuthStatus): boolean {
    const age = Date.now() - Date.parse(status.checkedAt);
    return Number.isFinite(age) && age >= 0 && age < this.config.claudeStatusCacheMs;
  }
}

function accountStatusView(
  account: ClaudeAccount,
  status: ClaudeAuthStatus,
  usage: ClaudeUsage | null,
): ClaudeAccountStatusView {
  return {
    id: account.id,
    nickname: account.nickname,
    email: account.email,
    organization: account.organization,
    subscription: account.subscription,
    authenticated: status.authenticated,
    error: status.error,
    checkedAt: status.checkedAt,
    usage,
  };
}

/** `items.map(fn)` with at most `limit` calls in flight; results keep their order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** No probe has ever written a profile onto the row. */
function neverAuthenticated(account: ClaudeAccount): boolean {
  return account.email === null && account.authMethod === null;
}

export function createClaudeService(
  config: Config,
  db: Database,
  terminals: TerminalManager,
  paths: HostPathTranslator,
  run: CommandRunner = spawnCommand,
  usage: ClaudeUsageReader = NO_USAGE,
): ClaudeService {
  return new ClaudeService(config, db, terminals, paths, run, usage);
}

function describeFailure(stderr: string, timedOut: boolean): string {
  if (timedOut) return 'the command timed out.';
  const detail = stderr.trim();
  return detail === '' ? 'Docker reported no reason.' : detail.slice(0, 1000);
}
