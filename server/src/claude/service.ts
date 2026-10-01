import type { Config } from '../config.js';
import {
  type ClaudeAccount,
  type Database,
  getClaudeAccount,
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
import { type ClaudeAuthStatus, failedClaudeStatus, probeClaudeAuth } from './status.js';

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

/** Everything the settings page needs in one response. */
export interface ClaudeStateView {
  readonly status: ClaudeAuthStatus;
  /** The account `status` describes, or null when none is connected. */
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
 * Owns two things: the cached answer to "is Claude signed in?" (a probe
 * container, see `status.ts`) and the temporary container the interactive
 * `claude auth login` of one account runs in (multiple accounts US-003). At
 * most one login is open at a time.
 *
 * The probe result is cached because it costs a container start (~1.5s) and is
 * read on every settings page load and every session creation. Anything that
 * could have changed the credentials — starting or ending a login — clears the
 * cache, so the status indicator reflects a finished login immediately and
 * without a server restart.
 */
export class ClaudeService {
  private cached: ClaudeAuthStatus | null = null;
  private probing: Promise<ClaudeAuthStatus> | null = null;
  private login: OpenLogin | null = null;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly terminals: TerminalManager,
    private readonly paths: HostPathTranslator,
    private readonly run: CommandRunner = spawnCommand,
  ) {}

  /**
   * Cached unless `force`, or unless the cached answer is older than
   * `CLAUDE_STATUS_CACHE_MS`. Concurrent callers share one probe container.
   */
  async status(force = false): Promise<ClaudeAuthStatus> {
    if (!force && this.cached !== null && this.isFresh(this.cached)) return this.cached;
    this.probing ??= this.probe().finally(() => {
      this.probing = null;
    });
    const status = await this.probing;
    this.cached = status;
    return status;
  }

  /**
   * Probes the default account. Until per-account status (US-004) there is one
   * answer, and with no account at all it is "not signed in", without a probe.
   */
  private probe(): Promise<ClaudeAuthStatus> {
    const accountId = defaultClaudeAccountId(this.db);
    if (accountId === null) {
      return Promise.resolve(
        failedClaudeStatus('No Claude account is connected yet. Use Set up Claude to sign one in.'),
      );
    }
    return probeClaudeAuth(this.config, this.run, this.paths, accountId);
  }

  async state(force = false): Promise<ClaudeStateView> {
    const status = await this.status(force);
    return { status, defaultAccountId: defaultClaudeAccountId(this.db), login: this.loginView() };
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
    this.cached = null;

    const status = await probeClaudeAuth(this.config, this.run, this.paths, accountId);
    let account = this.requireAccount(accountId);
    if (status.authenticated) {
      account =
        updateClaudeAccount(this.db, accountId, {
          email: status.account,
          organization: status.organization,
          subscription: status.subscription,
          authMethod: status.authMethod,
        }) ?? account;
    } else if (open?.createdByLogin === true && neverAuthenticated(account)) {
      removeClaudeAccount(this.config, this.db, accountId);
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
    // The login is about to change the credentials; nothing cached survives it.
    this.cached = null;
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
): ClaudeService {
  return new ClaudeService(config, db, terminals, paths, run);
}

function describeFailure(stderr: string, timedOut: boolean): string {
  if (timedOut) return 'the command timed out.';
  const detail = stderr.trim();
  return detail === '' ? 'Docker reported no reason.' : detail.slice(0, 1000);
}
