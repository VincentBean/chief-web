import path from 'node:path';

import type { Config } from '../config.js';
import { type Database, getRepository, getSession, type Session, type SessionStatus } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { type PrdStatus, readPrdStatus } from '../prd/index.js';
import { CONTAINER_REPO_DIR, isCloned, type SessionContainers } from '../sessions/index.js';
import { TerminalError } from '../terminal/index.js';
import type { CreateTerminalInput, TerminalView } from '../terminal/index.js';
import {
  MAX_CONTEXT_LENGTH,
  type PlanningMode,
  planningCommand,
  planningPrompt,
  prdPathFor,
} from './prompts.js';

/**
 * The planning terminal of a `pending` session (US-011).
 *
 * This is `chief new` in the browser: an interactive `claude` in the session's
 * own container, started with chief's PRD-generation prompt and left running
 * until the operator is happy with `.chief/prds/<session>/prd.md`. The terminal
 * is an ordinary US-007 terminal, so a page reload rejoins the same
 * conversation and closing the tab does not interrupt it.
 *
 * Nothing about it is persisted: like every terminal, the exec dies with the
 * server's connection to the daemon, and a restart therefore offers "Resume
 * planning" — which, because `prd.md` is already on the data volume, starts
 * chief's *edit* prompt rather than beginning again.
 */

/** A failure with the HTTP status and code the route should answer with. */
export class PlanningError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PlanningError';
  }
}

/**
 * The slice of {@link import('../terminal/index.js').TerminalManager} planning
 * uses; the manager satisfies it structurally, and tests pass a stub.
 */
export interface PlanningTerminals {
  create(input: CreateTerminalInput): Promise<TerminalView>;
  get(id: string): { toView(): TerminalView } | undefined;
  remove(id: string): Promise<boolean>;
}

/** Everything the session page needs to render the planning state. */
export interface PlanningView {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly status: SessionStatus;
  /** Terminal to attach to, or `null` when planning has never been started. */
  readonly terminalId: string | null;
  /** True while the `claude` process is alive. */
  readonly running: boolean;
  /** Exit code of a finished planning process, when Docker reported one. */
  readonly exitCode: number | null;
  /** Which prompt the current (or last) terminal was started with. */
  readonly mode: PlanningMode | null;
  /** Which prompt starting one *now* would use. */
  readonly nextMode: PlanningMode;
  /** Working directory of the terminal; the clone, as chief uses the repo root. */
  readonly cwd: string;
  readonly prd: PrdStatus;
}

export interface StartPlanningInput {
  /** Free text describing the feature; fills chief's `{{CONTEXT}}` slot. */
  readonly context?: string | undefined;
}

export class PlanningService {
  /** Live planning terminals by session id. Not persisted, by design. */
  private readonly terminalsBySession = new Map<
    string,
    { terminalId: string; mode: PlanningMode }
  >();
  /** Starts in flight, so a double click cannot open two `claude` processes. */
  private readonly starting = new Map<string, Promise<PlanningView>>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly terminals: PlanningTerminals,
    private readonly containers: SessionContainers,
  ) {}

  /** Cheap enough to poll: a `stat` plus a parse of a small markdown file. */
  status(sessionId: string): PlanningView {
    return this.toView(this.requireSession(sessionId));
  }

  /**
   * Starts (or resumes) the planning conversation. Returns the existing
   * terminal untouched when one is still running, so the button is safe to
   * press twice and a second browser tab joins rather than restarts.
   */
  start(sessionId: string, input: StartPlanningInput = {}): Promise<PlanningView> {
    const inFlight = this.starting.get(sessionId);
    if (inFlight !== undefined) return inFlight;

    const run = this.performStart(sessionId, input).finally(() => this.starting.delete(sessionId));
    this.starting.set(sessionId, run);
    return run;
  }

  /** Ends the conversation: kills `claude` and forgets the terminal. */
  async stop(sessionId: string): Promise<PlanningView> {
    const session = this.requireSession(sessionId);
    const current = this.terminalsBySession.get(sessionId);
    this.terminalsBySession.delete(sessionId);
    if (current !== undefined) {
      try {
        await this.terminals.remove(current.terminalId);
      } catch (cause) {
        logger.warn('could not close the planning terminal', {
          session: sessionId,
          error: String(cause),
        });
      }
    }
    return this.toView(session);
  }

  /** Where the PRD lives on the data volume, for anything that must read it. */
  prdFilePath(session: Pick<Session, 'id' | 'name'>): string {
    return path.join(sessionRepoDir(this.config, session.id), prdPathFor(session.name));
  }

  private async performStart(sessionId: string, input: StartPlanningInput): Promise<PlanningView> {
    const session = this.requireSession(sessionId);

    if (session.status !== 'pending') {
      throw new PlanningError(
        409,
        'session_not_pending',
        `Planning happens while a session is pending; "${session.name}" is ${session.status}.`,
      );
    }
    if (!isCloned(this.config, session.id)) {
      throw new PlanningError(
        409,
        'session_not_cloned',
        `"${session.name}" has no clone yet, so there is nothing to plan against. Run setup first.`,
      );
    }
    if ((input.context ?? '').length > MAX_CONTEXT_LENGTH) {
      throw new PlanningError(
        400,
        'context_too_long',
        `Keep the description under ${MAX_CONTEXT_LENGTH} characters.`,
      );
    }

    const live = this.liveTerminal(sessionId);
    if (live !== null) {
      if (live.view.status === 'running') return this.toView(session);
      // Resuming: the previous conversation has exited, so its terminal is only
      // a dead tab in the registry. Drop it before opening the next one.
      this.terminalsBySession.delete(sessionId);
      await this.terminals.remove(live.terminalId);
    }

    // The container is deliberately left running after setup, but a restart or
    // a failed step can have removed it; starting it again is idempotent.
    let containerId: string;
    try {
      containerId = (await this.containers.start(session)).id;
    } catch (cause) {
      throw new PlanningError(
        502,
        'session_container_unavailable',
        `The session container could not be started: ${describe(cause)}`,
      );
    }

    const repository = getRepository(this.db, session.repositoryId);
    const mode: PlanningMode = this.prdStatus(session).exists ? 'edit' : 'create';
    const prompt = planningPrompt(mode, {
      sessionName: session.name,
      featureBranch: session.featureBranch,
      repositoryName: repository?.name ?? session.repositoryId,
      context: input.context,
    });

    let terminal: TerminalView;
    try {
      terminal = await this.terminals.create({
        container: containerId,
        command: planningCommand(prompt),
        cwd: CONTAINER_REPO_DIR,
      });
    } catch (cause) {
      if (cause instanceof TerminalError) {
        throw new PlanningError(cause.status, cause.code, cause.message);
      }
      throw cause;
    }

    this.terminalsBySession.set(sessionId, { terminalId: terminal.id, mode });
    logger.info('planning terminal opened', {
      session: sessionId,
      terminal: terminal.id,
      container: containerId,
      mode,
    });
    return this.toView(session);
  }

  private requireSession(sessionId: string): Session {
    const session = getSession(this.db, sessionId);
    if (session === null) {
      throw new PlanningError(404, 'session_not_found', 'No such session.');
    }
    return session;
  }

  /** `null` once the manager has forgotten the terminal (e.g. it was closed). */
  private liveTerminal(
    sessionId: string,
  ): { terminalId: string; mode: PlanningMode; view: TerminalView } | null {
    const current = this.terminalsBySession.get(sessionId);
    if (current === undefined) return null;
    const terminal = this.terminals.get(current.terminalId);
    if (terminal === undefined) {
      this.terminalsBySession.delete(sessionId);
      return null;
    }
    return { ...current, view: terminal.toView() };
  }

  private prdStatus(session: Session): PrdStatus {
    return readPrdStatus(this.prdFilePath(session), prdPathFor(session.name));
  }

  private toView(session: Session): PlanningView {
    const live = this.liveTerminal(session.id);
    const prd = this.prdStatus(session);
    return {
      sessionId: session.id,
      sessionName: session.name,
      status: session.status,
      terminalId: live?.terminalId ?? null,
      running: live?.view.status === 'running',
      exitCode: live?.view.exitCode ?? null,
      mode: live?.mode ?? null,
      // A PRD that already exists is edited, never rewritten from scratch —
      // that is chief's `new` vs `edit` split, and what "Resume planning" does.
      nextMode: prd.exists ? 'edit' : 'create',
      cwd: CONTAINER_REPO_DIR,
      prd,
    };
  }
}

export function createPlanningService(
  config: Config,
  db: Database,
  terminals: PlanningTerminals,
  containers: SessionContainers,
): PlanningService {
  return new PlanningService(config, db, terminals, containers);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
