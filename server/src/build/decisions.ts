import {
  abandonDecisions,
  askDecision,
  closeDecision,
  type Database,
  type Decision,
  getOpenDecision,
  getSession,
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
import { BUILD_MCP_CONFIG_FILE, buildMcpConfigWriteSpec, DECISION_ASK_DIR } from './mcp.js';

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
  readonly containerId: string;
  /** The iteration's clock, stopped for as long as the question stands. */
  readonly deadline: ExecDeadline | null;
  /** Fires when the agent will have stopped waiting; cleared when answered. */
  timer: NodeJS.Timeout | null;
}

export class DecisionWatcher {
  /** At most one per session: its agent is blocked on the question it asked. */
  private readonly pending = new Map<string, PendingDecision>();
  /** Request ids already handled, so a file read twice is one question. */
  private readonly seen = new Set<string>();

  constructor(private readonly deps: DecisionWatcherDeps) {}

  /** How long a question stands, for the MCP config and for the UI. */
  get timeoutMs(): number {
    return this.deps.timeoutMs ?? DECISION_TIMEOUT_MS;
  }

  /** The question this session is waiting on, from the database. */
  open(sessionId: string): Decision | null {
    return getOpenDecision(this.deps.db, sessionId);
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
  async prepare(sessionId: string, containerId: string): Promise<string | null> {
    try {
      const written = await this.deps.docker.runExec(
        containerId,
        buildMcpConfigWriteSpec({ askTimeoutMs: this.timeoutMs }),
        MCP_WRITE_TIMEOUT_MS,
      );
      if (written.exitCode === 0) return BUILD_MCP_CONFIG_FILE;
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
    return this.pending.has(sessionId);
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
  }): Promise<Decision | null> {
    const { session, containerId } = input;
    if (this.pending.has(session.id)) {
      logger.warn('a second question arrived while one was still open', { session: session.id });
      return null;
    }
    const request = await this.findRequest(session.id, containerId, input.stopped ?? (() => false));
    if (request === null) return null;

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
    const entry: PendingDecision = { id: decision.id, sessionId: session.id, containerId, deadline, timer: null };
    entry.timer = setTimeout(() => {
      void this.giveUp(session.id, decision.id);
    }, this.timeoutMs);
    // A question stands for hours: it must not be the thing keeping the
    // process alive on the way down, and a server that is shutting down has
    // nothing useful to do about an unanswered one anyway.
    entry.timer.unref();
    this.pending.set(session.id, entry);

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
  async answer(sessionId: string, answer: string): Promise<Decision | null> {
    const text = answer.trim();
    if (text === '') throw new Error('An answer cannot be empty.');
    const entry = this.pending.get(sessionId);
    const open = this.open(sessionId);
    if (open === null) return null;

    if (entry !== undefined) {
      const written = await this.write(sessionId, entry.containerId, entry.id, { answered: true, answer: text });
      if (!written) {
        throw new Error('The answer could not be written into the session container.');
      }
    }
    const closed = closeDecision(this.deps.db, open.id, 'answered', text);
    if (closed === null) return null;
    this.resume(sessionId, 'answered');
    logger.info('the operator answered the build agent', { session: sessionId, decision: closed.id });
    return closed;
  }

  /**
   * Nobody answered in time. The tool has stopped waiting by now and told the
   * agent to carry on, so the row is closed and the session goes back to
   * `building` — it is building again, with one assumption in it.
   */
  private async giveUp(sessionId: string, decisionId: string): Promise<void> {
    const entry = this.pending.get(sessionId);
    if (entry === undefined || entry.id !== decisionId) return;
    closeDecision(this.deps.db, decisionId, 'expired');
    this.resume(sessionId, 'expired');
    logger.warn('nobody answered the build agent; it was told to carry on', {
      session: sessionId,
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
  abandon(sessionId: string): void {
    this.clear(sessionId, { resumeClock: false });
    const closed = abandonDecisions(this.deps.db, sessionId);
    if (closed > 0) logger.info('open questions dropped with the run that asked them', { session: sessionId, closed });
    this.leaveDeciding(sessionId, 'the question was dropped');
  }

  /** Clears the wait and puts the session back to `building`, clock and all. */
  private resume(sessionId: string, why: string): void {
    this.clear(sessionId, { resumeClock: true });
    this.leaveDeciding(sessionId, why);
  }

  /** Drops the pending entry and its timer, optionally restarting the clock. */
  private clear(sessionId: string, options: { readonly resumeClock: boolean }): void {
    const entry = this.pending.get(sessionId);
    if (entry === undefined) return;
    this.pending.delete(sessionId);
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (options.resumeClock) entry.deadline?.resume();
  }

  /**
   * `deciding` is this class's status, in and out: nothing else ever writes
   * it, and nothing else takes it away. A session that has moved on by itself
   * — stopped back to `ready`, failed, finished — is left exactly as it is.
   */
  private leaveDeciding(sessionId: string, why: string): void {
    const session = getSession(this.deps.db, sessionId);
    if (session?.status !== 'deciding') return;
    updateSession(this.deps.db, sessionId, { status: 'building' });
    logger.info('the session is building again', { session: sessionId, why });
  }

  /** The newest unhandled request file in the session's container. */
  private async findRequest(
    sessionId: string,
    containerId: string,
    stopped: () => boolean,
  ): Promise<AskRequest | null> {
    const deadline = Date.now() + (this.deps.discoveryMs ?? REQUEST_DISCOVERY_MS);
    for (;;) {
      if (stopped()) return null;
      let fresh;
      try {
        fresh = (await listRequestFiles(this.deps.docker, containerId, DECISION_ASK_DIR, 'decision')).filter(
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

  private write(sessionId: string, containerId: string, id: string, answer: DecisionAnswer): Promise<boolean> {
    return writeAnswerFile(this.deps.docker, containerId, DECISION_ASK_DIR, id, { id, ...answer }, {
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
