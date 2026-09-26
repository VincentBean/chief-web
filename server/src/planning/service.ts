import type { Config } from '../config.js';
import {
  type Database,
  deleteVoiceSessionAgent,
  getRepository,
  getSession,
  getVoiceSessionAgent,
  type Session,
  type SessionStatus,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { type PrdStatus, prdPathFor, readPrdStatus } from '../prd/index.js';
import {
  CONTAINER_REPO_DIR,
  isCloned,
  type SessionContainers,
  sessionPrdFile,
} from '../sessions/index.js';
import { getPlanningModel } from '../settings/index.js';
import { TerminalError } from '../terminal/index.js';
import type { CreateTerminalInput, TerminalView } from '../terminal/index.js';
import {
  MAX_CONTEXT_LENGTH,
  type PlanningMode,
  planningCommand,
  planningPrompt,
  VOICE_HANDOVER_PROMPT,
} from './prompts.js';
import type { VoiceEventSink } from '../voice/events.js';

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

/** The slice of the session voice agent registry planning asks. */
export interface VoiceAgentLock {
  isAlive(sessionId: string): boolean;
  /** Ends the session's voice agent, and moves a call focused on it back to chief (voice US-025). */
  stop?(sessionId: string): Promise<void>;
}

export interface StartPlanningInput {
  /** Free text describing the feature; fills chief's `{{CONTEXT}}` slot. */
  readonly context?: string | undefined;
  /**
   * The operator confirmed closing the session's voice agent (voice US-025):
   * without it a live one is refused with `409 session_in_voice_call`.
   */
  readonly stopVoiceAgent?: boolean | undefined;
}

/** A planning terminal this service opened. */
interface PlanningTerminal {
  readonly terminalId: string;
  readonly mode: PlanningMode;
  /** The voice planning conversation it continues (`--resume`), or `null` for a new one. */
  readonly resumeId: string | null;
  /** Set once its end has been looked at, so it is only looked at once. */
  ended: boolean;
}

export class PlanningService {
  /** Live planning terminals by session id. Not persisted, by design. */
  private readonly terminalsBySession = new Map<string, PlanningTerminal>();
  /** What {@link noticePrd} last saw per session: the valid PRD's mtime, or `null`. */
  private readonly validPrds = new Map<string, string | null>();
  /** Starts in flight, so a double click cannot open two `claude` processes. */
  private readonly starting = new Map<string, Promise<PlanningView>>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly terminals: PlanningTerminals,
    private readonly containers: SessionContainers,
    /** Voice background events (voice US-015); `null` where nothing listens. */
    private readonly events: VoiceEventSink | null = null,
    /** The session voice agents (voice US-018): a live one keeps the terminal shut. */
    private readonly voiceAgents: VoiceAgentLock | null = null,
  ) {}

  /** Whether the session's planning `claude` is running right now (the voice call's side of the lock). */
  isTerminalRunning(sessionId: string): boolean {
    return this.liveTerminal(sessionId)?.view.status === 'running';
  }

  /**
   * Cheap enough to poll: a `stat` plus a parse of a small markdown file.
   * The page polls it while planning, which makes it the planning poller the
   * `prd.valid` event comes from.
   */
  status(sessionId: string): PlanningView {
    const view = this.toView(this.requireSession(sessionId));
    this.noticePrd(view);
    return view;
  }

  /**
   * Tells the voice call when a pending session's PRD has just become valid:
   * it parses with at least one story, and it was not in that state (with
   * that modification time) the last time this session was polled. The first
   * poll after a restart only takes note.
   */
  private noticePrd(view: PlanningView): void {
    const { prd } = view;
    const valid = view.status === 'pending' && prd.parses && prd.storyCount > 0 ? (prd.updatedAt ?? '') : null;
    const known = this.validPrds.has(view.sessionId);
    const previous = this.validPrds.get(view.sessionId);
    this.validPrds.set(view.sessionId, valid);
    if (!known || valid === null || valid === previous) return;
    this.events?.publish({ kind: 'prd.valid', sessionId: view.sessionId, name: view.sessionName, stories: prd.storyCount });
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
      this.terminalEnded(sessionId, current, null);
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
    return sessionPrdFile(this.config, session);
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
    if (this.voiceAgents?.isAlive(session.id) === true && input.stopVoiceAgent === true && this.voiceAgents.stop !== undefined) {
      await this.voiceAgents.stop(session.id);
    }
    if (this.voiceAgents?.isAlive(session.id) === true) {
      throw new PlanningError(
        409,
        'session_in_voice_call',
        `"${session.name}" is being planned by voice. Hang up or leave the session agent first.`,
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
    // A voice planning conversation carries on here (voice US-025): it already
    // holds the planning prompt, so it only hears that the medium changed.
    const voice = getVoiceSessionAgent(this.db, session.id);
    const resumeId = voice?.mode === 'plan' ? voice.claudeSessionId : null;
    const prompt =
      resumeId !== null
        ? VOICE_HANDOVER_PROMPT
        : planningPrompt(mode, {
            sessionName: session.name,
            featureBranch: session.featureBranch,
            repositoryName: repository?.name ?? session.repositoryId,
            context: input.context,
            feedback: session.feedback,
          });

    let terminal: TerminalView;
    try {
      terminal = await this.terminals.create({
        container: containerId,
        // Read here rather than cached, so a model chosen on the settings page
        // applies to the next planning terminal without a restart.
        command: planningCommand(prompt, getPlanningModel(this.db), resumeId),
        cwd: CONTAINER_REPO_DIR,
      });
    } catch (cause) {
      if (cause instanceof TerminalError) {
        throw new PlanningError(cause.status, cause.code, cause.message);
      }
      throw cause;
    }

    this.terminalsBySession.set(sessionId, { terminalId: terminal.id, mode, resumeId, ended: false });
    logger.info('planning terminal opened', {
      session: sessionId,
      terminal: terminal.id,
      container: containerId,
      mode,
      resumed: resumeId !== null,
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
  private liveTerminal(sessionId: string): (PlanningTerminal & { view: TerminalView }) | null {
    const current = this.terminalsBySession.get(sessionId);
    if (current === undefined) return null;
    const terminal = this.terminals.get(current.terminalId);
    if (terminal === undefined) {
      this.terminalsBySession.delete(sessionId);
      this.terminalEnded(sessionId, current, null);
      return null;
    }
    const view = terminal.toView();
    if (view.status !== 'running') this.terminalEnded(sessionId, current, view.exitCode);
    return { ...current, view };
  }

  /**
   * The voice conversation id is only worth keeping while it is the one the
   * terminal ended in (voice US-025). A terminal that did not resume it ran a
   * conversation of its own, so the next voice call must not go back to the
   * older one; a resume that failed (a non-zero exit) would fail every time.
   */
  private terminalEnded(sessionId: string, terminal: PlanningTerminal, exitCode: number | null): void {
    if (terminal.ended) return;
    terminal.ended = true;
    const voice = getVoiceSessionAgent(this.db, sessionId);
    if (voice === null) return;
    const failedResume = terminal.resumeId !== null && exitCode !== null && exitCode !== 0;
    if (voice.claudeSessionId === terminal.resumeId && !failedResume) return;
    deleteVoiceSessionAgent(this.db, sessionId);
    logger.info('planning terminal ended in another conversation; the voice one is dropped', { session: sessionId });
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
  events: VoiceEventSink | null = null,
  voiceAgents: VoiceAgentLock | null = null,
): PlanningService {
  return new PlanningService(config, db, terminals, containers, events, voiceAgents);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
