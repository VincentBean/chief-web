import {
  abandonDecisions,
  askDecision,
  closeDecision,
  type Database,
  type Decision,
  getDecision,
  getOpenDecision,
  getSession,
  listSessionOpenDecisions,
  type Session,
  updateSession,
} from '../db/index.js';
import {
  type ExecDeadline,
  listRequestFiles,
  REQUEST_DISCOVERY_MS,
  REQUEST_POLL_MS,
  type RequestFileDocker,
  writeAnswerFile,
} from '../docker/index.js';
import { logger } from '../lib/logger.js';
import type { VoiceEventSink } from '../voice/events.js';
import {
  BUILD_MCP_CONFIG_FILE,
  buildMcpConfigWriteSpec,
  DECISION_ASK_DIR,
  storyAskDir,
  storyMcpConfigFile,
} from './mcp.js';

/**
 * The operator's half of `ask_operator` (decisions US-004).
 *
 * A build iteration that calls the tool is blocked inside its own `claude`
 * process, holding its context, its container and its build slot, until an
 * answer file appears next to the request it wrote. This is what notices the
 * call, parks the session on it, and writes that file.
 *
 * Three things have to be true for the wait to be safe, and each is one line
 * below:
 *
 * - **The iteration's clock stops.** An agent waiting for a person has not
 *   spent its budget, and reaping it at the deadline would throw the story
 *   away at the exact moment the answer arrived. {@link ExecDeadline} is
 *   paused while the question is open.
 * - **The wait ends either way.** The tool gives up after
 *   {@link DECISION_TIMEOUT_MS} and tells the agent to take the most
 *   conservative reading, so the same timer here puts the session back to
 *   `building`. A question nobody answers costs wall-clock time and nothing
 *   else.
 * - **Nothing is left open behind a run.** A stopped build, a failed
 *   iteration or a restart all leave a row that no agent is waiting on any
 *   more, and an `open` row the page would still offer to answer is a trap.
 *   {@link DecisionWatcher.abandon} is called from every path out of a run.
 */

/** As the CLI names the tool of the `chief` MCP server (`runner/chief-mcp.js`). */
export const ASK_OPERATOR_TOOL = 'mcp__chief__ask_operator';

/**
 * How long a question may stand before the agent stops waiting for it.
 *
 * Four hours is long enough to cover a night's sleep in most of a time zone
 * and short enough that a forgotten question does not hold a build slot for a
 * week. It is passed into the MCP server's environment
 * (`buildMcpConfig`), so the two ends of the wait cannot drift apart.
 */
export const DECISION_TIMEOUT_MS = 4 * 60 * 60_000;

/** Writing one small file into a running container; it is not work. */
const MCP_WRITE_TIMEOUT_MS = 10_000;

/** The answer file, as `runner/chief-mcp.js` reads it. */
export type DecisionAnswer =
  | { readonly answered: true; readonly answer: string }
  | { readonly answered: false; readonly reason: string };

/** What the watcher needs of the world around it. */
export interface DecisionWatcherDeps {
  readonly db: Database;
  readonly docker: RequestFileDocker;
  /** Background events for the voice call: a question is something to mention. */
  readonly events?: VoiceEventSink | null;
  /** How long a question stands; the MCP server is given the same number. */
  readonly timeoutMs?: number;
  /** How long the request file is looked for after the tool call showed up. */
  readonly discoveryMs?: number;
  readonly pollMs?: number;
}

/** One question being waited on, as the watcher holds it while a run is live. */
interface PendingDecision {
  readonly id: string;
  readonly sessionId: string;
  /** The story whose agent asked; the key it is pending under. */
  readonly storyId: string | null;
  readonly containerId: string;
  /** Where its request was found, and so where its answer goes. */
  readonly askDir: string;
  /** Told when the wait ends, however it ends (async stories US-010). */
  readonly onClosed: (() => void) | null;
  /** The iteration's clock, stopped for as long as the question stands. */
  readonly deadline: ExecDeadline | null;
  /** Fires when the agent will have stopped waiting; cleared when answered. */
  timer: NodeJS.Timeout | null;
}

/**
 * The key a question is pending under: one per story agent, so a parallel run
 * (async stories US-010) can have several agents waiting at once.
 */
function pendingKey(sessionId: string, storyId: string | null): string {
  return `${sessionId}\u0000${storyId ?? ''}`;
}

export class DecisionWatcher {
  /** At most one per story agent: it is blocked on the question it asked. */
  private readonly pending = new Map<string, PendingDecision>();
  /** Request ids already handled, so a file read twice is one question. */
  private readonly seen = new Set<string>();

  constructor(private readonly deps: DecisionWatcherDeps) {}

  /** How long a question stands, for the MCP config and for the UI. */
  get timeoutMs(): number {
    return this.deps.timeoutMs ?? DECISION_TIMEOUT_MS;
  }

  /** The question this session is waiting on, from the database; the newest when there are several. */
  open(sessionId: string): Decision | null {
    return getOpenDecision(this.deps.db, sessionId);
  }

  /** Every open question of this session, oldest first (async stories US-010). */
  openAll(sessionId: string): Decision[] {
    return listSessionOpenDecisions(this.deps.db, sessionId);
  }

  /**
   * Writes the iteration's `--mcp-config` into the container and returns the
   * path to pass, or `null` when it could not be written.
   *
   * `null` is not a failure to report: an iteration launched without the flag
   * is exactly the iteration chief-web ran before decisions existed. It builds
   * the story, and the one thing it cannot do is ask — which beats not
   * starting at all over a file in `/tmp`.
   */
  async prepare(sessionId: string, containerId: string, storyId?: string): Promise<string | null> {
    // A story of a parallel run gets a config and an ask directory of its own
    // (async stories US-010), so two agents' questions can never be mixed up.
    const file = storyId === undefined ? BUILD_MCP_CONFIG_FILE : storyMcpConfigFile(storyId);
    const askDir = storyId === undefined ? DECISION_ASK_DIR : storyAskDir(storyId);
    try {
      const written = await this.deps.docker.runExec(
        containerId,
        buildMcpConfigWriteSpec({ askTimeoutMs: this.timeoutMs, askDir, file }),
        MCP_WRITE_TIMEOUT_MS,
      );
      if (written.exitCode === 0) return file;
      logger.warn('could not write the iteration MCP config; it cannot ask anything', {
        session: sessionId,
        exitCode: written.exitCode,
        stderr: written.stderr.trim().slice(0, 200),
      });
    } catch (cause) {
      logger.warn('could not write the iteration MCP config; it cannot ask anything', {
        session: sessionId,
        error: String(cause),
      });
    }
    return null;
  }

  /** True while an agent of this session is actually blocked on a question. */
  isWaiting(sessionId: string): boolean {
    return this.entriesOf(sessionId).length > 0;
  }

  /** True while the agent that asked this question is still blocked on it. */
  isPending(decisionId: string): boolean {
    for (const entry of this.pending.values()) if (entry.id === decisionId) return true;
    return false;
  }

  /** The stories of this session whose agents are blocked on a question (async stories US-010). */
  waitingStories(sessionId: string): string[] {
    return this.entriesOf(sessionId)
      .map((entry) => entry.storyId)
      .filter((storyId): storyId is string => storyId !== null);
  }

  /**
   * Called when `ask_operator` appears on an iteration's stream.
   *
   * Finds the request file the tool wrote, records the question, stops the
   * iteration's clock and parks the session at `deciding`. Returns the
   * question, or `null` when there was nothing to find — a tool call whose
   * request never appeared, or a session that is already waiting on one — in
   * which case the iteration simply carries on as it would have.
   */
  async asked(input: {
    readonly session: Session;
    readonly containerId: string;
    readonly storyId: string | null;
    readonly iteration: number;
    readonly deadline?: ExecDeadline | null;
    /** True once the loop has given up on this iteration; stops the search. */
    readonly stopped?: () => boolean;
    /**
     * The story agent's own ask directory (async stories US-010); the shared
     * {@link DECISION_ASK_DIR} by default.
     */
    readonly askDir?: string;
    /** Called once the wait ends: answered, expired or abandoned. */
    readonly onClosed?: () => void;
  }): Promise<Decision | null> {
    const { session, containerId } = input;
    const key = pendingKey(session.id, input.storyId);
    if (this.pending.has(key)) {
      logger.warn('a second question arrived while one was still open', { session: session.id, story: input.storyId });
      return null;
    }
    const askDir = input.askDir ?? DECISION_ASK_DIR;
    const request = await this.findRequest(session.id, containerId, askDir, input.stopped ?? (() => false));
    if (request === null) return null;
    // The iteration may have ended while the file was being read; a question
    // recorded after that would have nobody left to answer it.
    if (input.stopped?.() === true) return null;

    const decision = askDecision(this.deps.db, {
      id: request.id,
      sessionId: session.id,
      storyId: input.storyId,
      iteration: input.iteration,
      question: request.question,
      options: request.options,
      context: request.context,
      recommendation: request.recommendation,
    });

    const deadline = input.deadline ?? null;
    // Stopped before the session is parked, so nothing can reap the agent
    // between the two.
    deadline?.pause();
    const entry: PendingDecision = {
      id: decision.id,
      sessionId: session.id,
      storyId: input.storyId,
      containerId,
      askDir,
      onClosed: input.onClosed ?? null,
      deadline,
      timer: null,
    };
    entry.timer = setTimeout(() => {
      void this.giveUp(key, decision.id);
    }, this.timeoutMs);
    // A question stands for hours: it must not be the thing keeping the
    // process alive on the way down, and a server that is shutting down has
    // nothing useful to do about an unanswered one anyway.
    entry.timer.unref();
    this.pending.set(key, entry);

    updateSession(this.deps.db, session.id, { status: 'deciding' });
    logger.info('the build agent asked the operator a decision', {
      session: session.id,
      name: session.name,
      decision: decision.id,
      story: input.storyId,
      iteration: input.iteration,
    });
    this.deps.events?.publish({
      kind: 'build.deciding',
      sessionId: session.id,
      name: session.name,
      question: decision.question,
    });
    return decision;
  }

  /**
   * The operator's answer: into the answer file, onto the row, and the session
   * back to `building` with its clock running again.
   *
   * Returns the closed row, or `null` when the question was not open any more
   * — the agent had already stopped waiting, or someone else answered it
   * first. The file is written *before* the row is closed, because the file is
   * what actually unblocks the agent; a row closed on an answer that never
   * reached it would leave the session `building` with nothing building.
   */
  async answer(sessionId: string, answer: string, decisionId?: string): Promise<Decision | null> {
    const text = answer.trim();
    if (text === '') throw new Error('An answer cannot be empty.');
    // Several can be open in a parallel run (async stories US-010); without an
    // id it is the newest, as it always was.
    const open = decisionId === undefined ? this.open(sessionId) : getDecision(this.deps.db, decisionId);
    if (open?.sessionId !== sessionId || open.status !== 'open') return null;
    const key = pendingKey(sessionId, open.storyId);
    const entry = this.pending.get(key);

    if (entry?.id === open.id) {
      const written = await this.write(sessionId, entry.containerId, entry.askDir, entry.id, {
        answered: true,
        answer: text,
      });
      if (!written) {
        throw new Error('The answer could not be written into the session container.');
      }
    }
    const closed = closeDecision(this.deps.db, open.id, 'answered', text);
    if (closed === null) return null;
    if (entry?.id === open.id) this.resume(key, 'answered');
    else this.leaveDeciding(sessionId, 'answered');
    logger.info('the operator answered the build agent', { session: sessionId, decision: closed.id });
    return closed;
  }

  /**
   * Nobody answered in time. The tool has stopped waiting by now and told the
   * agent to carry on, so the row is closed and the session goes back to
   * `building` — it is building again, with one assumption in it.
   */
  private async giveUp(key: string, decisionId: string): Promise<void> {
    const entry = this.pending.get(key);
    if (entry === undefined || entry.id !== decisionId) return;
    closeDecision(this.deps.db, decisionId, 'expired');
    this.resume(key, 'expired');
    logger.warn('nobody answered the build agent; it was told to carry on', {
      session: entry.sessionId,
      decision: decisionId,
      waitedMs: this.timeoutMs,
    });
    await Promise.resolve();
  }

  /**
   * Forgets every question of this session without answering it: the agent
   * that asked is gone, so there is nobody left to answer.
   *
   * Called from every path out of an iteration — it finished, it was stopped,
   * it ran out of time, it threw — because a row left `open` is a question the
   * page would still offer to answer into a container with nothing in it. The
   * clock is deliberately *not* resumed: there is no iteration left to charge
   * it to, and the deadline dies with the exec.
   */
  abandon(sessionId: string, storyId?: string): void {
    // Given a story, only that story's agent is gone (async stories US-010):
    // the questions of its siblings in a parallel run still stand.
    const keys =
      storyId === undefined
        ? this.entriesOf(sessionId).map((entry) => pendingKey(sessionId, entry.storyId))
        : [pendingKey(sessionId, storyId)];
    for (const key of keys) this.clear(key, { resumeClock: false });
    const closed = abandonDecisions(this.deps.db, sessionId, storyId);
    if (closed > 0) {
      logger.info('open questions dropped with the run that asked them', { session: sessionId, story: storyId, closed });
    }
    this.leaveDeciding(sessionId, 'the question was dropped');
  }

  /** Clears the wait and puts the session back to `building`, clock and all. */
  private resume(key: string, why: string): void {
    const sessionId = this.pending.get(key)?.sessionId;
    this.clear(key, { resumeClock: true });
    if (sessionId !== undefined) this.leaveDeciding(sessionId, why);
  }

  /** Drops the pending entry and its timer, optionally restarting the clock. */
  private clear(key: string, options: { readonly resumeClock: boolean }): void {
    const entry = this.pending.get(key);
    if (entry === undefined) return;
    this.pending.delete(key);
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (options.resumeClock) entry.deadline?.resume();
    entry.onClosed?.();
  }

  /** The questions this session's agents are blocked on right now. */
  private entriesOf(sessionId: string): PendingDecision[] {
    return [...this.pending.values()].filter((entry) => entry.sessionId === sessionId);
  }

  /**
   * `deciding` is this class's status, in and out: nothing else ever writes
   * it, and nothing else takes it away. A session that has moved on by itself
   * — stopped back to `ready`, failed, finished — is left exactly as it is,
   * and so is one with another story still waiting on a question (async
   * stories US-010): it stays `deciding` until the last one is closed.
   */
  private leaveDeciding(sessionId: string, why: string): void {
    if (this.isWaiting(sessionId)) return;
    const session = getSession(this.deps.db, sessionId);
    if (session?.status !== 'deciding') return;
    updateSession(this.deps.db, sessionId, { status: 'building' });
    logger.info('the session is building again', { session: sessionId, why });
  }

  /** The newest unhandled request file in the session's container. */
  private async findRequest(
    sessionId: string,
    containerId: string,
    askDir: string,
    stopped: () => boolean,
  ): Promise<AskRequest | null> {
    const deadline = Date.now() + (this.deps.discoveryMs ?? REQUEST_DISCOVERY_MS);
    for (;;) {
      if (stopped()) return null;
      let fresh;
      try {
        fresh = (await listRequestFiles(this.deps.docker, containerId, askDir, 'decision')).filter(
          (request) => !this.seen.has(request.id),
        );
      } catch (cause) {
        logger.warn('could not look for the question', { session: sessionId, error: String(cause) });
        return null;
      }
      const newest = [...fresh].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (newest !== undefined) {
        this.seen.add(newest.id);
        const question = asText(newest['question']);
        if (question === null) {
          logger.warn('a question request file carried no question', { session: sessionId, request: newest.id });
          return null;
        }
        return {
          id: newest.id,
          question,
          options: asTextList(newest['options']),
          context: asText(newest['context']),
          recommendation: asText(newest['recommendation']),
        };
      }
      if (Date.now() >= deadline) {
        logger.warn('no question request file appeared', { session: sessionId });
        return null;
      }
      await pause(this.deps.pollMs ?? REQUEST_POLL_MS);
    }
  }

  private write(
    sessionId: string,
    containerId: string,
    askDir: string,
    id: string,
    answer: DecisionAnswer,
  ): Promise<boolean> {
    return writeAnswerFile(this.deps.docker, containerId, askDir, id, { id, ...answer }, {
      what: 'decision',
      session: sessionId,
    });
  }
}

/** The request file's fields, once they have been checked. */
interface AskRequest {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly context: string | null;
  readonly recommendation: string | null;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

function asTextList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asText(entry)).filter((entry): entry is string => entry !== null);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
