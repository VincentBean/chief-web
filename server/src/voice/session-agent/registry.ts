import { randomUUID } from 'node:crypto';

import type { Config } from '../../config.js';
import {
  type Database,
  getRepository,
  getSession,
  getVoiceSessionAgent,
  insertVoiceTurn,
  type Session,
  upsertVoiceSessionAgent,
  type VoiceAgentMode,
} from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { prdPathFor, readPrdStatus } from '../../prd/index.js';
import { isCloned, type SessionContainers, sessionPrdFile } from '../../sessions/index.js';
import { getVoiceSettings } from '../../settings/index.js';
import { toolCardSummary } from './agent.js';
import {
  INTERRUPT_GRACE_MS,
  interruptRequestLine,
  QA_DISALLOWED_TOOLS,
  type SessionAgentDocker,
  SessionAgentProcess,
  userMessageLine,
} from './process.js';
import { voicePlanningPrompt, voiceQaPrompt, voiceRulesPrompt } from './prompt.js';

/**
 * The session voice agents that are alive (docs/voice-plan.md §10.4): at most one per
 * session and `VOICE_MAX_SESSION_AGENTS` in all, the least recently used idle
 * one stopped (TERM through its pid file) to make room; one drafting (a
 * detached turn running) is never stopped for room, and when every agent
 * drafts a new one is refused (`session_agents_busy`). They outlive a call by
 * `VOICE_KEEP_AGENTS_MS`, so calling back a minute later finds the same
 * process; after that everything is stopped, and the next start continues
 * the conversation with `--resume`.
 *
 * A `pending` session is planned (`plan` mode); any other is only talked
 * about (`qa` mode, voice US-025): the Q&A prompt, and the edit tools
 * disallowed on the command line. A conversation is only resumed in the mode
 * it was started in, so a planning conversation never carries on as Q&A.
 */

/** The mode a session's agent runs in: planning while pending, questions after. */
export function voiceAgentMode(session: Pick<Session, 'status'>): VoiceAgentMode {
  return session.status === 'pending' ? 'plan' : 'qa';
}

/** A refusal with the HTTP status and code a route (or chief) reports. */
export class SessionAgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionAgentError';
  }
}

/**
 * How a detached turn (one nobody on the call is listening to) ended:
 * `stopped` when the process was stopped on purpose (the keep timer, shutdown).
 */
export type DetachedTurnOutcome = 'ok' | 'error' | 'timeout' | 'stopped';

/** What {@link SessionAgentRegistry.runDetached} resolves with. */
export interface DetachedTurnResult {
  readonly ok: boolean;
  readonly reason: DetachedTurnOutcome;
  /** The agent's complete reply, as far as it got. */
  readonly text: string;
  readonly durationMs: number;
}

/** The call a detached turn's rows are stored against. */
export interface DetachedTurnCall {
  readonly id: string;
  /** The call's turn in progress, for the row's `turn`. */
  turn(): number;
}

/** What the registry knows of a session's detached turns; in memory only. */
export interface DetachedTurnState {
  readonly running: boolean;
  /** The last one that ended, until the operator focuses the session again. */
  readonly lastOutcome: DetachedTurnOutcome | null;
}

export interface SessionAgentRegistryDeps {
  readonly config: Pick<Config, 'workspacesDir' | 'voiceMaxSessionAgents' | 'voiceKeepAgentsMs' | 'voiceDetachedTurnTimeoutMs'>;
  readonly db: Database;
  readonly docker: SessionAgentDocker;
  readonly containers: SessionContainers;
  /** Claude's usage-limit hold: no agent starts while it is on. */
  readonly hold: { active(): boolean; until(): string | null };
  /**
   * The planning terminal's side of the lock. A thunk, because the planning
   * service is built after the registry (it asks the registry the reverse).
   */
  readonly planning?: () => { isTerminalRunning(sessionId: string): boolean } | null;
  readonly now?: () => number;
  /** How long a timed-out detached turn may take to end after the interrupt. */
  readonly interruptGraceMs?: number;
}

export class SessionAgentRegistry {
  private readonly agents = new Map<string, SessionAgentProcess>();
  /** The mode each live agent was started in. */
  private readonly modes = new Map<string, VoiceAgentMode>();
  private readonly starting = new Map<string, Promise<SessionAgentProcess>>();
  private keepTimer: NodeJS.Timeout | null = null;
  private readonly detached = new Map<string, DetachedTurnState>();
  /** Settles when the session's running detached turn ends. */
  private readonly detachedRuns = new Map<string, Promise<void>>();
  /** The open call, for the rows of detached turns. */
  private activeCall: DetachedTurnCall | null = null;

  constructor(private readonly deps: SessionAgentRegistryDeps) {}

  /** A process is running (or starting) for the session; the planning terminal stays shut meanwhile. */
  isAlive(sessionId: string): boolean {
    return this.starting.has(sessionId) || this.live(sessionId) !== null;
  }

  /** Sessions with a live agent, most recently used first. */
  aliveSessions(): string[] {
    return [...this.agents.values()]
      .filter((agent) => !agent.exited)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .map((agent) => agent.sessionId);
  }

  /** Whether a detached turn runs for the session, and how the last one ended. */
  detachedState(sessionId: string): DetachedTurnState {
    return this.detached.get(sessionId) ?? { running: false, lastOutcome: null };
  }

  /** A detached turn started for the session. */
  detachedStarted(sessionId: string): void {
    this.detached.set(sessionId, { running: true, lastOutcome: this.detachedState(sessionId).lastOutcome });
  }

  /** The session's detached turn ended with `outcome`. */
  detachedEnded(sessionId: string, outcome: DetachedTurnOutcome): void {
    this.detached.set(sessionId, { running: false, lastOutcome: outcome });
  }

  /**
   * The operator focused the session: the last detached outcome has been dealt
   * with. A turn still running keeps running, and how it ends is recorded anew.
   */
  focused(sessionId: string): void {
    const state = this.detached.get(sessionId);
    if (state === undefined) return;
    if (state.running) this.detached.set(sessionId, { running: true, lastOutcome: null });
    else this.detached.delete(sessionId);
  }

  /** Resolves once the session's detached turn (if one runs) has ended, or `signal` aborts. */
  detachedTurnEnded(sessionId: string, signal?: AbortSignal): Promise<void> {
    const run = this.detachedRuns.get(sessionId);
    if (run === undefined || signal?.aborted === true) return Promise.resolve();
    if (signal === undefined) return run;
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      void run.then(done);
    });
  }

  /**
   * Runs one turn on the session's agent that nobody is listening to (the
   * call is elsewhere): `message` goes in as one stream-json turn, and the
   * reply is collected instead of spoken. Its text and tool names are stored
   * in `voice_turns` as a `[detached] ` agent row of the open call, or of
   * the call that started it once that one has ended. Never queued: a second
   * one for the same session is refused with 409 while the first runs. After
   * `timeoutMs` (`VOICE_DETACHED_TURN_TIMEOUT_MS`) the turn is interrupted;
   * a crash is reported, not retried.
   */
  async runDetached(sessionId: string, message: string, options: { timeoutMs?: number } = {}): Promise<DetachedTurnResult> {
    if (this.detachedState(sessionId).running) {
      throw new SessionAgentError(409, 'session_agent_busy', 'The session agent is still working on its previous detached turn.');
    }
    this.detachedStarted(sessionId);
    const call = this.activeCall;
    const startedAt = this.now();
    let settle = (): void => undefined;
    this.detachedRuns.set(sessionId, new Promise<void>((resolve) => (settle = resolve)));
    let outcome: DetachedTurnOutcome = 'error';
    try {
      const agent = await this.acquire(sessionId);
      const turn = await this.detachedTurn(agent, message, options.timeoutMs ?? this.deps.config.voiceDetachedTurnTimeoutMs);
      outcome = turn.reason;
      this.storeDetached(this.activeCall ?? call, sessionId, turn.text, turn.tools);
      logger.info('detached session agent turn ended', { session: sessionId, reason: outcome });
      return { ok: outcome === 'ok', reason: outcome, text: turn.text, durationMs: this.now() - startedAt };
    } finally {
      this.detachedEnded(sessionId, outcome);
      this.detachedRuns.delete(sessionId);
      settle();
    }
  }

  /**
   * Why a voice agent cannot start for this session right now, as a thrown
   * {@link SessionAgentError}; the session when it can. Starting the
   * container is the one precondition left to {@link acquire}.
   */
  check(sessionId: string): Session {
    const session = getSession(this.deps.db, sessionId);
    if (session === null) throw new SessionAgentError(404, 'session_not_found', 'No such session.');
    if (!isCloned(this.deps.config, session.id)) {
      throw new SessionAgentError(409, 'session_not_cloned', `${session.name} has no clone yet, so there is nothing to plan against.`);
    }
    if (this.deps.hold.active()) {
      const until = this.deps.hold.until();
      throw new SessionAgentError(
        409,
        'usage_limit_hold',
        `Claude is on a usage-limit hold${until === null ? '' : ` until ${until}`}, so the session agent cannot start.`,
      );
    }
    if (this.deps.planning?.()?.isTerminalRunning(session.id) === true) {
      throw new SessionAgentError(409, 'session_in_planning_terminal', `The planning terminal is open for ${session.name}.`);
    }
    return session;
  }

  /**
   * The session's running agent, started (after {@link check}) when there is
   * none. One started in the other mode (the session was marked ready, or
   * sent back to planning, since) is stopped first.
   */
  acquire(sessionId: string): Promise<SessionAgentProcess> {
    const inFlight = this.starting.get(sessionId);
    if (inFlight !== undefined) return inFlight;
    const live = this.live(sessionId);
    const session = live === null ? null : getSession(this.deps.db, sessionId);
    if (live !== null && (session === null || this.modes.get(sessionId) === voiceAgentMode(session))) {
      live.lastUsedAt = this.now();
      return Promise.resolve(live);
    }
    const busy = live === null ? this.allDrafting(sessionId) : null;
    if (busy !== null) return Promise.reject(busy);
    const run = (live === null ? this.start(sessionId) : this.stop(sessionId).then(() => this.start(sessionId))).finally(() =>
      this.starting.delete(sessionId),
    );
    this.starting.set(sessionId, run);
    return run;
  }

  /**
   * The first stdin message for a fresh conversation: chief's planning prompt
   * in `create` or `edit` mode (whether `prd.md` exists now) plus the voice
   * overrides, or the Q&A prompt for a session that is not pending, with the
   * operator's first words when there are any.
   */
  openingPrompt(sessionId: string, firstWords: string | null): string {
    const session = this.check(sessionId);
    if (voiceAgentMode(session) === 'qa') {
      return voiceQaPrompt({ sessionName: session.name, status: session.status, firstWords });
    }
    const exists = readPrdStatus(sessionPrdFile(this.deps.config, session), prdPathFor(session.name)).exists;
    return voicePlanningPrompt(exists ? 'edit' : 'create', {
      sessionName: session.name,
      featureBranch: session.featureBranch,
      repositoryName: getRepository(this.deps.db, session.repositoryId)?.name ?? session.repositoryId,
      firstWords,
    });
  }

  /** Stops the session's agent, if it has one; it is out of the registry at once. */
  async stop(sessionId: string, signal = 'TERM'): Promise<void> {
    const agent = this.agents.get(sessionId);
    this.agents.delete(sessionId);
    this.modes.delete(sessionId);
    await agent?.stop(signal);
  }

  async stopAll(): Promise<void> {
    this.clearKeepTimer();
    await Promise.all([...this.agents.keys()].map((sessionId) => this.stop(sessionId)));
  }

  /** A call began: the agents it may find stay, and detached turns are stored against `call`. */
  callStarted(call: DetachedTurnCall | null = null): void {
    this.clearKeepTimer();
    this.activeCall = call;
  }

  /** The call ended: every agent goes after `VOICE_KEEP_AGENTS_MS`, unless a call comes back first. */
  callEnded(): void {
    this.activeCall = null;
    this.clearKeepTimer();
    this.keepTimer = setTimeout(() => {
      this.keepTimer = null;
      this.stopAll().catch((cause: unknown) => {
        logger.warn('could not stop the session voice agents', { error: String(cause) });
      });
    }, this.deps.config.voiceKeepAgentsMs);
    this.keepTimer.unref();
  }

  private async start(sessionId: string): Promise<SessionAgentProcess> {
    const session = this.check(sessionId);
    let containerId: string;
    try {
      containerId = (await this.deps.containers.start(session)).id;
    } catch (cause) {
      throw new SessionAgentError(
        502,
        'session_container_unavailable',
        `The session container could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const settings = getVoiceSettings(this.deps.db);
    const mode = voiceAgentMode(session);
    const stored = getVoiceSessionAgent(this.deps.db, sessionId);
    const resumeId = stored !== null && stored.mode === mode ? stored.claudeSessionId : null;
    const agent = await SessionAgentProcess.start(this.deps.docker, {
      sessionId,
      containerId,
      command: {
        model: settings.sessionModel,
        resumeId,
        systemPrompt: voiceRulesPrompt(settings.language),
        ...(mode === 'qa' ? { disallowedTools: QA_DISALLOWED_TOOLS } : {}),
      },
      onInit: (claudeSessionId) => this.remember(sessionId, claudeSessionId, mode),
      now: () => this.now(),
    });
    this.agents.set(sessionId, agent);
    this.modes.set(sessionId, mode);
    logger.info('session voice agent started', { session: sessionId, exec: agent.execId, mode, resumed: resumeId !== null });
    this.evict(sessionId);
    return agent;
  }

  /** Reads one detached turn to its end; a turn past `timeoutMs` is interrupted. */
  private async detachedTurn(
    agent: SessionAgentProcess,
    message: string,
    timeoutMs: number,
  ): Promise<{ reason: DetachedTurnOutcome; text: string; tools: DetachedTool[] }> {
    agent.discardPending();
    agent.write(userMessageLine(message));
    const deadline = AbortSignal.timeout(timeoutMs);
    let text = '';
    const tools = new Map<string, DetachedTool>();
    const result = (reason: DetachedTurnOutcome): { reason: DetachedTurnOutcome; text: string; tools: DetachedTool[] } => ({
      reason,
      text,
      tools: [...tools.values()],
    });
    for (;;) {
      const event = await agent.next(deadline);
      if (event === null) break;
      switch (event.type) {
        case 'turnEnd':
          return result(event.ok ? 'ok' : 'error');
        case 'delta':
          text += event.text;
          break;
        case 'tool':
          tools.set(event.toolUseId ?? randomUUID(), { name: event.name, status: 'running', summary: toolCardSummary(event.name, event.input) });
          break;
        case 'toolResult': {
          const tool = event.toolUseId === null ? undefined : tools.get(event.toolUseId);
          if (tool !== undefined) tool.status = event.ok ? 'ok' : 'error';
          break;
        }
        default:
          break;
      }
    }
    if (agent.exited) return result(agent.crashed ? 'error' : 'stopped');

    // Past the deadline: the interrupt, then the rest of the turn dropped until its `result`.
    logger.warn('detached session agent turn timed out', { session: agent.sessionId, timeoutMs });
    agent.write(interruptRequestLine(randomUUID()));
    const grace = AbortSignal.timeout(this.deps.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    for (;;) {
      const event = await agent.next(grace);
      if (event?.type === 'turnEnd') return result('timeout');
      if (event === null) break;
    }
    if (!agent.exited) {
      logger.warn('session voice agent ignored the interrupt', { session: agent.sessionId });
      await this.stop(agent.sessionId, 'INT');
    }
    return result('timeout');
  }

  /** The `[detached] ` agent row, so Call history shows what the agent did. */
  private storeDetached(call: DetachedTurnCall | null, sessionId: string, text: string, tools: readonly DetachedTool[]): void {
    if (call === null) return;
    try {
      insertVoiceTurn(this.deps.db, {
        callId: call.id,
        turn: call.turn(),
        speaker: 'agent',
        sessionId,
        text: `[detached] ${text}`,
        toolsJson: tools.length === 0 ? null : JSON.stringify(tools),
      });
    } catch (cause) {
      logger.warn('could not store a detached session agent turn', { session: sessionId, call: call.id, error: String(cause) });
    }
  }

  /** `init` repeats every turn; the row only changes when the conversation does. */
  private remember(sessionId: string, claudeSessionId: string, mode: VoiceAgentMode): void {
    const stored = getVoiceSessionAgent(this.deps.db, sessionId);
    if (stored?.claudeSessionId === claudeSessionId && stored.mode === mode) return;
    if (getSession(this.deps.db, sessionId) === null) return;
    upsertVoiceSessionAgent(this.deps.db, { sessionId, claudeSessionId, mode });
  }

  /**
   * A drafting agent is never evicted (voice multi-planning US-007), so with
   * the cap reached by agents that all run a detached turn there is no room:
   * refused with the sessions named, for chief (or the session agent) to say.
   * Agents still starting count, so two starts at once cannot pass the cap.
   */
  private allDrafting(sessionId: string): SessionAgentError | null {
    const live = [...this.agents.values()].filter((agent) => !agent.exited).map((agent) => agent.sessionId);
    const others = [...new Set([...live, ...this.starting.keys()])].filter((id) => id !== sessionId);
    if (others.length < this.deps.config.voiceMaxSessionAgents) return null;
    if (others.some((id) => !this.detachedState(id).running)) return null;
    const names = others.map((id) => getSession(this.deps.db, id)?.name ?? id);
    return new SessionAgentError(
      409,
      'session_agents_busy',
      `${countWord(names.length)} sessions are still drafting: ${spokenList(names)}. Wait for one to finish, or talk to one of them instead.`,
    );
  }

  /** Stops the least recently used agents (never `keep`, nor one mid detached turn) until the cap holds. */
  private evict(keep: string): void {
    for (const [sessionId, agent] of this.agents) {
      if (!agent.exited) continue;
      this.agents.delete(sessionId);
      this.modes.delete(sessionId);
    }
    const others = [...this.agents.values()].filter((agent) => agent.sessionId !== keep && !this.detachedState(agent.sessionId).running)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    while (this.agents.size > this.deps.config.voiceMaxSessionAgents) {
      const oldest = others.shift();
      if (oldest === undefined) return;
      logger.info('stopping the least recently used session voice agent', { session: oldest.sessionId });
      this.stop(oldest.sessionId).catch((cause: unknown) => {
        logger.warn('could not stop a session voice agent', { session: oldest.sessionId, error: String(cause) });
      });
    }
  }

  private live(sessionId: string): SessionAgentProcess | null {
    const agent = this.agents.get(sessionId);
    return agent === undefined || agent.exited ? null : agent;
  }

  private clearKeepTimer(): void {
    if (this.keepTimer !== null) clearTimeout(this.keepTimer);
    this.keepTimer = null;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** A count as a sentence opens with it: `Three`, or digits past ten. */
function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/** `a, b and c`. */
function spokenList(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

/** A tool a detached turn used, as `voice_turns.tools_json` stores it. */
interface DetachedTool {
  readonly name: string;
  status: 'running' | 'ok' | 'error';
  readonly summary: string;
}
