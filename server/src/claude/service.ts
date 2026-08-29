import type { Config } from '../config.js';
import { logger } from '../lib/logger.js';
import { type CommandRunner, spawnCommand } from '../ssh/index.js';
import { TerminalError, type TerminalManager } from '../terminal/index.js';
import {
  CLAUDE_LOGIN_COMMAND,
  CLAUDE_LOGIN_CONTAINER_NAME,
  CLAUDE_LOGIN_CWD,
  claudeLoginContainerArgs,
  removeContainerArgs,
} from './login.js';
import { type ClaudeAuthStatus, probeClaudeAuth } from './status.js';

/** A failure with an HTTP status the route can hand straight back. */
export class ClaudeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
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
  /** Terminal to attach to (US-007), or `null` when no login is in progress. */
  readonly terminalId: string | null;
  readonly containerId: string | null;
  readonly containerName: string;
}

/** Everything the settings page needs in one response. */
export interface ClaudeStateView {
  readonly status: ClaudeAuthStatus;
  readonly login: ClaudeLoginView;
}

/**
 * Claude Code authentication (US-008).
 *
 * Owns two things: the cached answer to "is Claude signed in?" (a probe
 * container, see `status.ts`) and the temporary container the interactive
 * `claude auth login` runs in.
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
  private login: { terminalId: string; containerId: string } | null = null;

  constructor(
    private readonly config: Config,
    private readonly terminals: TerminalManager,
    private readonly run: CommandRunner = spawnCommand,
  ) {}

  /**
   * Cached unless `force`, or unless the cached answer is older than
   * `CLAUDE_STATUS_CACHE_MS`. Concurrent callers share one probe container.
   */
  async status(force = false): Promise<ClaudeAuthStatus> {
    if (!force && this.cached !== null && this.isFresh(this.cached)) return this.cached;
    this.probing ??= probeClaudeAuth(this.config, this.run).finally(() => {
      this.probing = null;
    });
    const status = await this.probing;
    this.cached = status;
    return status;
  }

  async state(force = false): Promise<ClaudeStateView> {
    return { status: await this.status(force), login: this.loginView() };
  }

  /**
   * Spawns the login container and opens a terminal running the login flow.
   * Calling it again while a login is already running returns the same
   * terminal instead of starting a second one.
   */
  async startLogin(): Promise<ClaudeStateView> {
    const existing = this.loginView();
    if (existing.active) return { status: await this.status(), login: existing };

    // Either nothing is running, or a previous attempt left a container behind
    // (a server restart drops terminals but not containers). The name is fixed,
    // so clearing it is also what makes `docker run --name` succeed.
    await this.discardLogin();

    const created = await this.run(
      this.config.dockerBin,
      claudeLoginContainerArgs(this.config),
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

    this.login = { terminalId, containerId };
    // The login is about to change the credentials; nothing cached survives it.
    this.cached = null;
    logger.info('claude login terminal opened', { terminal: terminalId, container: containerId });
    return { status: await this.status(), login: this.loginView() };
  }

  /**
   * Ends the login: kills the terminal, removes the container, and re-probes so
   * the caller gets the state the login actually left behind.
   */
  async stopLogin(): Promise<ClaudeStateView> {
    await this.discardLogin();
    this.cached = null;
    return { status: await this.status(true), login: this.loginView() };
  }

  private loginView(): ClaudeLoginView {
    const terminal = this.login === null ? undefined : this.terminals.get(this.login.terminalId);
    // A terminal the manager has forgotten (closed from the terminal page) is
    // no longer a login in progress.
    if (this.login === null || terminal === undefined) {
      return {
        active: false,
        terminalId: null,
        containerId: this.login?.containerId ?? null,
        containerName: CLAUDE_LOGIN_CONTAINER_NAME,
      };
    }
    return {
      active: terminal.toView().status === 'running',
      terminalId: this.login.terminalId,
      containerId: this.login.containerId,
      containerName: CLAUDE_LOGIN_CONTAINER_NAME,
    };
  }

  /** Best effort: a login that is already gone is not an error. */
  private async discardLogin(): Promise<void> {
    const current = this.login;
    this.login = null;
    if (current !== null) {
      try {
        await this.terminals.remove(current.terminalId);
      } catch (cause) {
        logger.warn('could not close the claude login terminal', { error: String(cause) });
      }
    }
    await this.removeContainer(CLAUDE_LOGIN_CONTAINER_NAME);
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

export function createClaudeService(
  config: Config,
  terminals: TerminalManager,
  run: CommandRunner = spawnCommand,
): ClaudeService {
  return new ClaudeService(config, terminals, run);
}

function describeFailure(stderr: string, timedOut: boolean): string {
  if (timedOut) return 'the command timed out.';
  const detail = stderr.trim();
  return detail === '' ? 'Docker reported no reason.' : detail.slice(0, 1000);
}
