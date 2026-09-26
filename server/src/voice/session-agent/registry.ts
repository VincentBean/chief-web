import type { Config } from '../../config.js';
import {
  type Database,
  getRepository,
  getSession,
  getVoiceSessionAgent,
  type Session,
  upsertVoiceSessionAgent,
  type VoiceAgentMode,
} from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { prdPathFor, readPrdStatus } from '../../prd/index.js';
import { isCloned, type SessionContainers, sessionPrdFile } from '../../sessions/index.js';
import { getVoiceSettings } from '../../settings/index.js';
import { QA_DISALLOWED_TOOLS, type SessionAgentDocker, SessionAgentProcess } from './process.js';
import { voicePlanningPrompt, voiceQaPrompt, voiceRulesPrompt } from './prompt.js';

/**
 * The session voice agents that are alive (docs/voice-plan.md §10.4): at most one per
 * session and `VOICE_MAX_SESSION_AGENTS` in all, the least recently used
 * stopped (TERM through its pid file) to make room. They outlive a call by
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

export interface SessionAgentRegistryDeps {
  readonly config: Pick<Config, 'workspacesDir' | 'voiceMaxSessionAgents' | 'voiceKeepAgentsMs'>;
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
  /**
   * The session browsers (voice feedback US-012): an agent that is stopped or
   * reaped takes its session's browser with it. A thunk for the same reason.
   */
  readonly browsers?: () => { stop(sessionId: string): Promise<void> } | null;
  readonly now?: () => number;
}

export class SessionAgentRegistry {
  private readonly agents = new Map<string, SessionAgentProcess>();
  /** The mode each live agent was started in. */
  private readonly modes = new Map<string, VoiceAgentMode>();
  private readonly starting = new Map<string, Promise<SessionAgentProcess>>();
  private keepTimer: NodeJS.Timeout | null = null;

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
      feedback: session.feedback,
    });
  }

  /** Stops the session's agent, if it has one, and its browser; it is out of the registry at once. */
  async stop(sessionId: string, signal = 'TERM'): Promise<void> {
    const agent = this.agents.get(sessionId);
    this.agents.delete(sessionId);
    this.modes.delete(sessionId);
    const browser = this.deps
      .browsers?.()
      ?.stop(sessionId)
      .catch((cause: unknown) => {
        logger.warn('could not stop the session browser', { session: sessionId, error: String(cause) });
      });
    await agent?.stop(signal);
    await browser;
  }

  async stopAll(): Promise<void> {
    this.clearKeepTimer();
    await Promise.all([...this.agents.keys()].map((sessionId) => this.stop(sessionId)));
  }

  /** A call began: the agents it may find stay. */
  callStarted(): void {
    this.clearKeepTimer();
  }

  /** The call ended: every agent goes after `VOICE_KEEP_AGENTS_MS`, unless a call comes back first. */
  callEnded(): void {
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
      sessionName: session.name,
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

  /** `init` repeats every turn; the row only changes when the conversation does. */
  private remember(sessionId: string, claudeSessionId: string, mode: VoiceAgentMode): void {
    const stored = getVoiceSessionAgent(this.deps.db, sessionId);
    if (stored?.claudeSessionId === claudeSessionId && stored.mode === mode) return;
    if (getSession(this.deps.db, sessionId) === null) return;
    upsertVoiceSessionAgent(this.deps.db, { sessionId, claudeSessionId, mode });
  }

  /** Stops the least recently used agents (never `keep`) until the cap holds. */
  private evict(keep: string): void {
    for (const [sessionId, agent] of this.agents) {
      if (!agent.exited) continue;
      this.agents.delete(sessionId);
      this.modes.delete(sessionId);
    }
    const others = [...this.agents.values()].filter((agent) => agent.sessionId !== keep).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
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
