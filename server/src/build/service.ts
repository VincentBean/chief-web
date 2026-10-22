import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import {
  type BuildQueueEntry,
  type BuildQueueKind,
  buildQueuePosition,
  countActivePrConflictFixes,
  countActivePrReviews,
  countActivePrRuns,
  countSessionsByStatus,
  type Database,
  enqueueBuild,
  failSession,
  getDependencyPlan,
  getDependencyPlanOrigin,
  getDependencyPlanStoryIds,
  type FailureStage,
  type Decision,
  type DependencyPlanSource,
  getQueuedBuild,
  getSession,
  listBuildQueue,
  listDueWaitingSessions,
  listPrConflictFixes,
  listPrReviews,
  listPrRuns,
  listSessions,
  listStories,
  listWaitingSessions,
  nowIso,
  parsePrRefId,
  prRefId,
  removeBuildQueueEntry,
  removeQueuedBuild,
  replaceDependencyPlan,
  type Session,
  type SessionStatus,
  type Story,
  type StoryStatus,
  syncStories,
  updateSession,
  updateStory,
} from '../db/index.js';
import { ExecDeadline } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import { isUsageLimitRefusal, UsageLimitHold } from '../limits/index.js';
import { sessionWorkspaceDir } from '../orchestrator/index.js';
import {
  type ParsedPrd,
  type PrdStatus,
  type PrdStory,
  prdPathFor,
  progressPathFor,
  readPrdDocument,
  setStoryStatus,
} from '../prd/index.js';
import {
  isCloned,
  type SessionContainers,
  sessionPrdFile,
  sessionProgressFile,
  storyInputOf,
} from '../sessions/index.js';
import {
  ADVISOR_MODELS,
  type AdvisorModel,
  effectiveClaudeAccountId,
  runningClaudeAccountId,
  effortFor,
  getAgentTimeoutMs,
  getBuildModel,
  getMaxConcurrentSessions,
  getStoredAdvisorModel,
  isAdvisorModel,
} from '../settings/index.js';
import { type StoryTarget, storyBranch, storyWorktreeDir } from './agent.js';
import { ASK_OPERATOR_TOOL, type DecisionWatcher } from './decisions.js';
import { type BuildLogs, NullBuildLogs } from './log.js';
import {
  classifyIteration,
  iterationCap,
  MAX_RETRIES,
  remainingStories,
  selectNextStory,
} from './loop.js';
import { describePlan, normalizePlan, parseDependencyAnswer, type RawPlan, sequentialPlan } from './plan.js';
import { agentPrompt, dependencyAnalysisPrompt } from './prompts.js';
import type { AgentResult, AgentRunner } from './runner.js';
import { RUNNER_WORKSPACE_DIR } from '../runner/index.js';
import type { VoiceEventSink } from '../voice/events.js';

/**
 * The Ralph loop (US-013).
 *
 * "Start build" turns a `ready` session into a `building` one and hands it to a
 * loop that, over and over: picks the lowest-priority story that is not `done`,
 * runs one headless `claude -p` inside the session container, and then looks at
 * the world to decide what happened — `prd.md` as the agent left it, and the
 * git history. Nothing about an iteration is taken on the agent's word.
 *
 * Everything that must survive lives outside this class: the statuses are in
 * `prd.md` on the data volume, the work is in commits, and the learnings are in
 * `progress.md`. So a build that is stopped, or a server that is restarted,
 * loses at most the iteration that was in flight — which is exactly why the
 * loop can afford to be this simple.
 */

/** A failure with the HTTP status and code the route should answer with. */
export class BuildError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BuildError';
  }
}

/** What the session page needs to render the build state. */
export interface BuildView {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly status: SessionStatus;
  /** True while this server is driving a loop for the session. */
  readonly running: boolean;
  /** Iterations started so far in the current run; 0 when none is running. */
  readonly iteration: number;
  /** The dynamic cap this run aborts at. */
  readonly maxIterations: number;
  /** The story the current iteration is implementing. */
  readonly currentStoryId: string | null;
  /** Consecutive fruitless iterations on that story; a retry counter. */
  readonly attempts: number;
  readonly stories: readonly Story[];
  readonly prd: PrdStatus;
  readonly lastError: string | null;
  /** Which step failed, when the session is `failed` (US-019). */
  readonly failureStage: FailureStage | null;
  /** The per-iteration agent timeout in force right now, in milliseconds. */
  readonly agentTimeoutMs: number;
  /** Model this session's iterations run on; `null` is the CLI's own default. */
  readonly buildModel: string | null;
  readonly startedAt: string | null;
  /** Waiting for a build slot: a `ready` session with a `queued_at` (US-018). */
  readonly queued: boolean;
  /** Its 1-based place in the FIFO queue — the "#2" the UI shows — or null. */
  readonly queuePosition: number | null;
  /** Build slots in use right now, of every kind, across the server (US-006). */
  readonly activeBuilds: number;
  /** The cap those builds are counted against (US-004). */
  readonly maxConcurrentBuilds: number;
  /**
   * The question the agent is waiting on (decisions US-005), or `null`.
   *
   * It rides along with the build view rather than on an endpoint of its own
   * because it *is* build state: the session page already polls this, and a
   * question that arrived in the same tick as the status that explains it must
   * not be a poll behind it.
   */
  readonly decision: DecisionView | null;
  /** How long a question stands before the agent stops waiting for it. */
  readonly decisionTimeoutMs: number | null;
}

/** One question of the session, as the page renders it (decisions US-005). */
export interface DecisionView {
  readonly id: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly context: string | null;
  readonly recommendation: string | null;
  /** The story the iteration was on when it asked. */
  readonly storyId: string | null;
  readonly askedAt: string;
  /** When the agent will stop waiting; null when nothing is waiting any more. */
  readonly waitingUntil: string | null;
  /** False once the agent has gone: the row is history, not a question. */
  readonly waiting: boolean;
}

/**
 * What the loop does with the work it produces (US-014).
 *
 * Two moments: after every story it completes, so `origin` is never more than
 * one story behind the container, and once at the end, when the branch is
 * pushed again and turned into a pull request. Both are someone else's
 * business — `DeliveryService` implements this — which keeps the loop about
 * running stories and lets a failed delivery be retried on its own.
 */
export interface BuildCompletion {
  /**
   * Pushes the feature branch after a completed story. Best-effort: it must
   * never throw and never end the run, because the commits are safe locally
   * and the next story pushes them again.
   */
  push(session: Session): Promise<void>;
  /** Every story is done: deliver the branch and settle the session's state. */
  complete(session: Session, stories: readonly Story[]): Promise<void>;
}

/**
 * The default hand-off: the session is finished, with nothing pushed.
 *
 * `finished` — and not `pr-open` (US-002) — is exactly right here: no pull
 * request was opened, so there is nothing for the PR sync to follow, and this
 * is where such a session's life ends.
 */
export class MarkSessionFinished implements BuildCompletion {
  constructor(private readonly db: Database) {}

  push(): Promise<void> {
    return Promise.resolve();
  }

  complete(session: Session): Promise<void> {
    updateSession(this.db, session.id, {
      status: 'finished',
      lastError: null,
      failureStage: null,
    });
    return Promise.resolve();
  }
}

/** One live loop. Mutable on purpose: it is the run's own scratch space. */
interface RunState {
  containerId: string;
  iteration: number;
  attempts: number;
  storyId: string | null;
  readonly maxIterations: number;
  readonly startedAt: string;
  stopping: boolean;
  /**
   * Whether this run has settled its dependency plan (async stories US-005):
   * analysed, reused or not needed. Not part of {@link ParkedRun} on purpose —
   * a resumed run checks the stored plan against `prd.md` again.
   */
  planned: boolean;
  /**
   * The expiry of the global hold this run must park on (US-005), or null.
   *
   * The limit is on the account, so one session being refused takes every
   * other run off the agent too. Setting a field rather than tearing the run
   * down from outside is what lets the loop park itself at a point where its
   * own bookkeeping is finished, exactly as it does for "Stop build".
   */
  holdUntil: string | null;
  /**
   * The Claude account the run's container was started on (multiple accounts
   * US-014): the one a refusal holds, and the one {@link BuildService.holdAll}
   * matches against. Resolved at launch, because the container keeps that
   * account until the next launch even if the session's choice changes.
   */
  readonly accountId: string | null;
  /** Resolves when the loop has finished; awaited by "Stop build". */
  finished: Promise<void>;
}

/**
 * What a parked run left behind, so the resume is a continuation (US-006).
 *
 * The `RunState` itself dies with the loop, and everything durable about a
 * session is in `prd.md` and the git history — but the counters are neither.
 * They are this process's account of how far the run got and how many retries
 * the current story has already spent, and a hold must cost the session an
 * hour and nothing else. So they are kept here for exactly as long as the
 * session is `waiting`, and a resume starts from them rather than from zero.
 */
interface ParkedRun {
  readonly iteration: number;
  readonly attempts: number;
  readonly storyId: string | null;
  readonly maxIterations: number;
  readonly startedAt: string;
}

/**
 * Where one story attempt works (async stories US-006): the clone, or — for a
 * session that runs stories in parallel — the story's own worktree. The files
 * are host paths on the data volume.
 */
interface StoryWorkspace {
  /** The worktree the agent runs in; `null` for the clone. */
  readonly story: StoryTarget | null;
  /** `chief-story/<session>/<story-id>`; `null` for the clone. */
  readonly branch: string | null;
  readonly prdFile: string;
  readonly progressFile: string;
}

/** What one re-read of `prd.md` produced. */
interface PrdSnapshot {
  readonly stories: readonly Story[];
  readonly parsed: ParsedPrd | null;
  readonly status: PrdStatus;
  /** False when the file could not be parsed, so nothing was synced. */
  readonly synced: boolean;
}

/**
 * The session statuses that occupy a build slot.
 *
 * A `waiting` session (US-003) is held by Claude's usage limit rather than
 * working, but it has not given anything back: its container is still up and
 * its loop resumes in the same place once the hold lifts. Counting it as an
 * active build is what stops a fourth session from starting into a limit that
 * has already refused the other three.
 *
 * A `deciding` one (decisions US-001) has given up even less: its agent is
 * alive inside its iteration, holding the container and the working tree,
 * waiting for an answer. Handing its slot away would start a second build
 * into a pool that is still fully occupied.
 *
 * A `reviewing` one (US-002) is running the delivery's code review, which is
 * an agent in the session's own container just as a build iteration is. The
 * session was counted for that review back when it stayed `building` through
 * it, and it has to stay counted now that it does not, or the cap would hand
 * the slot it is still using to a queued build. `fixing` is deliberately not
 * here: the feedback run the session is waiting on holds a slot of its own
 * through {@link countActivePrRuns}, and counting both would spend two.
 */
const ACTIVE_BUILD_STATUSES: readonly SessionStatus[] = ['building', 'waiting', 'deciding', 'reviewing'];

/**
 * How long an answer may be (decisions US-006). Generous enough for a
 * paragraph with a code snippet in it, bounded because it goes into a prompt.
 */
export const MAX_DECISION_ANSWER_CHARS = 4000;

/**
 * The statuses "Stop build" acts on: a run in flight, one parked on the usage
 * limit, and one waiting for a decision (decisions US-007). All three hold a
 * slot and a container, and all three go back to `ready` with everything they
 * committed intact.
 */
const STOPPABLE_STATUSES: readonly SessionStatus[] = ['building', 'waiting', 'deciding'];

/**
 * A kind of work that can hold a build slot (US-001).
 *
 * The three queueable kinds plus the merge-conflict fixer, which shares the
 * pool but keeps its timer-retry instead of joining the queue.
 */
export type BuildSlotKind = BuildQueueKind | 'pr-conflict-fix';
/**
 * One build slot that is in use, and what is using it (US-006).
 *
 * The overview page renders these as the meter's breakdown, so `label` is for
 * a person — a session name, "Review of PR #12" — while `kind` and `refId` are
 * how the rest of the server names the same work.
 */
export interface BuildSlotUse {
  readonly kind: BuildSlotKind;
  /** A session id, or `<repositoryId>:<prNumber>` for the pull-request kinds. */
  readonly refId: string;
  readonly label: string;
}

/** One entry of the unified queue, with its 1-based place in it (US-006). */
export interface QueuedBuildView {
  readonly kind: BuildQueueKind;
  readonly refId: string;
  readonly label: string;
  /** 1-based FIFO position: the "#2" the UI shows. */
  readonly position: number;
  readonly queuedAt: string;
}

/** The whole build pool in one answer: what holds it, and what waits for it. */
export interface BuildPoolView {
  /** Slots in use — always `slots.length`, and exactly what the cap counts. */
  readonly active: number;
  readonly max: number;
  /** `max - active`; negative when the cap was lowered under running work. */
  readonly free: number;
  readonly slots: readonly BuildSlotUse[];
  /** Everything in the unified FIFO queue — always `queue.length`. */
  readonly queued: number;
  readonly queue: readonly QueuedBuildView[];
}

/**
 * How one piece of work reads to a person.
 *
 * A session is its name; a pull-request kind is its number, because the number
 * is what the operator sees on GitHub and the repository is usually obvious
 * from the rest of the page. A reference that cannot be parsed is shown raw
 * rather than hidden — an unreadable label beats a missing slot.
 */
function slotLabel(db: Database, kind: BuildSlotKind, refId: string): string {
  if (kind === 'session') return getSession(db, refId)?.name ?? refId;
  const pr = parsePrRefId(refId);
  const number = pr === null ? refId : `#${String(pr.prNumber)}`;
  if (kind === 'pr-review') return `Review of PR ${number}`;
  if (kind === 'pr-feedback') return `Feedback on PR ${number}`;
  return `Conflict fix: PR ${number}`;
}


/**
 * How the pump starts one kind of queued entry.
 *
 * Registered per kind at composition time rather than imported here, because
 * the services that start reviews and feedback runs sit *above* this one and
 * already depend on it for the cap. The pump only ever asks three things: is
 * it still there, is it already running, and start it.
 */
export interface QueuedStart {
  /** False when the referent is gone; the entry is dropped rather than started. */
  exists?(entry: BuildQueueEntry): boolean;
  /** True when this server is already running that work — skip, never start twice. */
  isRunning?(entry: BuildQueueEntry): boolean;
  /** Starts the entry. It is already out of the queue by the time this runs. */
  start(entry: BuildQueueEntry): Promise<void>;
  /**
   * The Claude account the entry would launch on (multiple accounts US-014),
   * so the pump can skip it while that account is held and serve the rest.
   * Without it the entry waits only while every account is held.
   */
  accountId?(entry: BuildQueueEntry): string | null;
  /** Puts a start that threw somewhere the operator will see it. */
  onFailed?(entry: BuildQueueEntry, message: string): void;
}

/** The in-flight key of one piece of work, so two kinds cannot collide on an id. */
function slotKey(kind: BuildSlotKind, refId: string): string {
  return `${kind}:${refId}`;
}

export class BuildService {
  private readonly runs = new Map<string, RunState>();
  /**
   * Work whose container is being started right now, of every kind (US-001).
   * It is not `building`, `running` or anything else in the database yet, so
   * it has to be counted against the cap here or two simultaneous starts —
   * the pump and a conflict-fix scan, say — would both see the same free slot.
   */
  private readonly starting = new Map<string, { kind: BuildSlotKind; refId: string }>();
  /** How the pump starts each kind of queued entry; see {@link registerStart}. */
  private readonly starters = new Map<BuildQueueKind, QueuedStart>();
  /**
   * The counters of the runs parked on a usage-limit hold (US-006), by session
   * id. Written by {@link park} and spent by the launch that resumes them.
   */
  private readonly parked = new Map<string, ParkedRun>();
  /** Serialises {@link pump}, so one freed slot is handed to one session. */
  private draining: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly runner: AgentRunner,
    private readonly completion: BuildCompletion,
    private readonly logs: BuildLogs = new NullBuildLogs(),
    /**
     * The global usage-limit hold (US-002). One per database, handed in rather
     * than made per call site, so it is obvious that every part of the server
     * is arming and reading the same hold.
     */
    private readonly hold: UsageLimitHold = new UsageLimitHold(db),
    /** Voice background events (voice US-015); `null` where nothing listens. */
    private readonly events: VoiceEventSink | null = null,
    /**
     * The operator's half of `ask_operator` (decisions US-004); `null` where
     * no question can be relayed — a test on a stub executor, or any install
     * whose Docker client cannot attach an exec. An iteration then launches
     * with no `--mcp-config` and no clock to pause, exactly as it did before
     * decisions existed.
     */
    private readonly decisions: DecisionWatcher | null = null,
  ) {
    // Sessions are the one kind this service starts itself; reviews and
    // feedback runs register theirs from above.
    this.registerStart('session', {
      exists: (entry) => getSession(this.db, entry.refId) !== null,
      isRunning: (entry) => this.runs.has(entry.refId),
      accountId: (entry) => {
        const session = getSession(this.db, entry.refId);
        return session === null ? null : effectiveClaudeAccountId(this.db, session);
      },
      start: async (entry) => {
        const session = this.requireSession(entry.refId);
        // Something may have changed while it waited — it went back to
        // planning, or its stories are all done.
        this.assertStartable(session);
        try {
          await this.launch(session);
        } catch (cause) {
          throw new Error(
            `The queued build could not be started, so the session left the queue: ${describe(cause)}`,
            { cause },
          );
        }
      },
      onFailed: (entry, message) => {
        updateSession(this.db, entry.refId, { lastError: message });
      },
    });
  }

  /**
   * Teaches the pump how to start one kind of queued entry (US-001).
   *
   * Wired at composition time. A kind with nothing registered is not a
   * deadlock: the pump drops those entries rather than letting one sit at the
   * head forever with the queue behind it.
   */
  registerStart(kind: BuildQueueKind, starter: QueuedStart): void {
    this.starters.set(kind, starter);
  }

  /**
   * Counts an in-flight start of any kind against the cap until the returned
   * function is called (US-001). Every start path — the pump, a review, a
   * conflict-fix scan — claims here first, so two of them can never hand the
   * same free slot to two different agents.
   */
  claimStart(kind: BuildSlotKind, refId: string): () => void {
    const key = slotKey(kind, refId);
    this.starting.set(key, { kind, refId });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.starting.delete(key);
    };
  }

  /** True while a start of that work is in flight here. */
  isStarting(kind: BuildSlotKind, refId: string): boolean {
    return this.starting.has(slotKey(kind, refId));
  }

  /**
   * Puts any kind of work at the back of the queue, or leaves it where it
   * already is. Idempotent, so an automatic trigger that fires twice does not
   * queue the same pull request twice.
   */
  enqueue(kind: BuildQueueKind, refId: string): BuildQueueEntry {
    return enqueueBuild(this.db, { kind, refId });
  }

  /** Takes any kind of work back out of the queue; false when it was not in it. */
  leaveQueue(kind: BuildQueueKind, refId: string): boolean {
    return removeQueuedBuild(this.db, kind, refId);
  }

  /** The whole queue in FIFO order, every kind together. */
  queue(): BuildQueueEntry[] {
    return listBuildQueue(this.db);
  }

  /**
   * Every build slot in use right now, and what is using it (US-006).
   *
   * This is the pool's occupancy, and the only definition of it: `freeSlots()`
   * subtracts its length and the stats page lists its entries, so the meter can
   * never show capacity the cap will not hand out. It counts exactly what the
   * cap does — sessions `building`, `waiting` or `reviewing`, starts in flight
   * here, running feedback runs, running reviews and running conflict fixes.
   *
   * Keyed on kind and reference, so work that is both starting here and already
   * live in the database — the window between a row going `running` and its
   * claim being released — is the one slot it actually is.
   */
  slotsInUse(): BuildSlotUse[] {
    const uses = new Map<string, BuildSlotUse>();
    const add = (kind: BuildSlotKind, refId: string, label: string): void => {
      uses.set(slotKey(kind, refId), { kind, refId, label });
    };

    for (const status of ACTIVE_BUILD_STATUSES) {
      for (const session of listSessions(this.db, { status })) {
        add('session', session.id, session.name);
      }
    }
    for (const run of listPrRuns(this.db)) {
      if (run.status !== 'running') continue;
      const refId = prRefId(run.repositoryId, run.prNumber);
      add('pr-feedback', refId, slotLabel(this.db, 'pr-feedback', refId));
    }
    for (const review of listPrReviews(this.db)) {
      if (review.status !== 'running') continue;
      const refId = prRefId(review.repositoryId, review.prNumber);
      add('pr-review', refId, slotLabel(this.db, 'pr-review', refId));
    }
    for (const fix of listPrConflictFixes(this.db)) {
      if (fix.status !== 'running') continue;
      const refId = prRefId(fix.repositoryId, fix.prNumber);
      add('pr-conflict-fix', refId, slotLabel(this.db, 'pr-conflict-fix', refId));
    }
    // Starts whose work the database cannot see yet: the container is coming
    // up, so nothing but this set is holding their slot.
    for (const [key, claim] of this.starting) {
      if (uses.has(key)) continue;
      uses.set(key, { ...claim, label: slotLabel(this.db, claim.kind, claim.refId) });
    }
    return [...uses.values()];
  }

  /**
   * The whole pool for the overview page (US-006): the slots in use with a
   * label each, and the unified queue in FIFO order.
   *
   * One read of the same accounting `freeSlots()` does, so the number on the
   * meter and the number the cap enforces are the same number by construction
   * rather than by two places agreeing to count the same way.
   */
  pool(): BuildPoolView {
    const max = getMaxConcurrentSessions(this.db, this.config);
    const slots = this.slotsInUse();
    const queue = this.queue().map((entry, index) => ({
      kind: entry.kind,
      refId: entry.refId,
      label: slotLabel(this.db, entry.kind, entry.refId),
      position: index + 1,
      queuedAt: entry.queuedAt,
    }));
    return {
      active: slots.length,
      max,
      free: max - slots.length,
      slots,
      queued: queue.length,
      queue,
    };
  }

  status(sessionId: string): BuildView {
    return this.toView(this.requireSession(sessionId));
  }

  /**
   * Starts the loop, or takes a place in the queue (US-018).
   *
   * The cap is checked before anything is spawned, so a start beyond it costs
   * nothing and is not a refusal: the session stays `ready` with a `queued_at`
   * and is launched by {@link pump} the moment a slot frees. Everything below
   * the cap behaves exactly as it did — the container is brought up first, so a
   * broken environment is a failed *request* rather than a session that
   * flickers into `building` and straight back out to `failed`.
   */
  async start(sessionId: string): Promise<BuildView> {
    const session = this.requireSession(sessionId);
    if (this.runs.has(sessionId)) return this.toView(session);

    this.assertStartable(session);

    // Nothing may be launched while the hold is on (US-005): the limit is on
    // the account, so a fresh session would be refused within seconds and
    // spend an iteration finding out what the held sessions already know. The
    // queue is exactly the right place to put it — it is already the answer to
    // "there is no room for you yet", and the pump hands it a slot by itself
    // once the hold lifts.
    // With a failover account free (US-015) it is not held at all: the
    // orchestrator launches it there.
    const until = this.hold.waitingUntil(effectiveClaudeAccountId(this.db, session));
    if (until !== null) {
      this.enqueueSession(session);
      throw new BuildError(429, 'usage_limit_hold', queuedForHoldMessage(session, until));
    }

    if (this.freeSlots() <= 0) return this.toView(this.enqueueSession(session));
    return this.toView(await this.launch(session));
  }

  /**
   * "Leave queue": one click that takes a waiting session back to plain
   * `ready`. Nothing has been spawned for it yet, so there is nothing to
   * unwind — it simply stops being next.
   */
  dequeue(sessionId: string): BuildView {
    const session = this.requireSession(sessionId);
    if (!removeQueuedBuild(this.db, 'session', session.id)) {
      throw new BuildError(
        409,
        'session_not_queued',
        `"${session.name}" is not waiting for a build slot.`,
      );
    }

    logger.info('session left the build queue', { session: session.id, name: session.name });
    return this.toView(getSession(this.db, session.id) ?? session);
  }

  /**
   * Gives every free slot to the head of the queue.
   *
   * Called whenever a run ends — that is what "starts automatically when a slot
   * frees" means — and from the scheduler's tick, which is what picks the queue
   * up again after a restart: `queued_at` is in the database, so the order
   * survives even though nothing about this loop does.
   *
   * Serialised on a single promise chain: two slots freeing at the same moment
   * must not be offered to the same session.
   */
  pump(): Promise<void> {
    this.draining = this.draining
      // Never let one failed pass poison the chain, and never reject: callers
      // fire this and forget it.
      .catch(() => undefined)
      .then(() => this.drain())
      .catch((cause: unknown) => {
        logger.warn('could not start the next queued build', { error: describe(cause) });
      });
    return this.draining;
  }

  /** Free build slots right now; zero or negative when the cap is reached. */
  /**
   * Slots free right now. Public because feedback runs (US-021), pull request
   * reviews and conflict fixes (US-005) share the cap: they hold a slot each
   * while they run, and a build must not think the last one is free because
   * the run holding it is not a session.
   *
   * Counted off {@link slotsInUse}, which is also what the stats page shows.
   */
  freeSlots(): number {
    return getMaxConcurrentSessions(this.db, this.config) - this.slotsInUse().length;
  }

  /**
   * Resumes the sessions whose usage-limit hold has run out (US-006). Returns
   * how many were started; called from the scheduler's tick, which is the one
   * thing already looking at the clock on a timer.
   *
   * A held session kept its slot, its container and its place in the story
   * while it waited, so a resume is a continuation: the container is reused if
   * it is still up, nothing about the workspace is touched, and the run picks
   * its own counters back up. Whatever does not fit under the cap — the cap was
   * lowered while the hold was on, or something else took the slots — goes on
   * the FIFO queue in the order it was resumed in, rather than every session
   * starting at once the moment the hour is up.
   */
  async resumeHeld(now: string = nowIso()): Promise<number> {
    // A second refusal during the hold extends it (US-002) without re-parking
    // the sessions that were already `waiting`, so their own expiry can be the
    // stale one. The hold is what the resume is really waiting for — and it is
    // per account (US-014): only a session whose account is still held waits.
    // And a session whose own account is still held need not wait for it once
    // another account can take its work (US-015), so those are resumed before
    // their own expiry — re-evaluated on every tick, as usage changes. Nor
    // does a session parked by a refusal on its failover account: its
    // `waiting_until` is that account's hold, not its own one's.
    const due = new Set(listDueWaitingSessions(this.db, now).map((session) => session.id));
    const at = new Date(now);
    return this.resume(
      this.notHeld(listWaitingSessions(this.db), at).filter(
        (session) =>
          due.has(session.id) ||
          session.failoverClaudeAccountId !== null ||
          this.hold.active(effectiveClaudeAccountId(this.db, session), at),
      ),
    );
  }

  /**
   * Ends the hold early and resumes every held session (US-008): the operator
   * has decided the limit was a false positive, or that it reset sooner than
   * the hour chief-web waits. Returns how many sessions were started.
   *
   * Lifting the hold is part of the operation rather than something the caller
   * does first, because a resume attempted while the hold is still on refuses
   * itself — and because the sessions being brought back are precisely the ones
   * whose own `waiting_until` has not been reached, so nothing else would let
   * them through. Everything after that is the ordinary resume: the cap is
   * respected and the overflow goes on the queue.
   */
  async resumeAllHeld(accountId?: string): Promise<number> {
    if (accountId === undefined) this.hold.clearAll();
    else this.hold.clear(accountId);
    // Every waiting session whose account is free now: with one account
    // cleared, the sessions on another account still held keep waiting.
    const resumed = await this.resume(this.notHeld(listWaitingSessions(this.db)));
    // The hold turned `drain()` into a no-op (US-005), so anything queued while
    // it was on is still sitting there. Held sessions were served their slots
    // first, above; this hands whatever is left to the queue rather than making
    // it wait for the next scheduler tick.
    void this.pump();
    return resumed;
  }

  /**
   * Restarts the loop of every `building` session this process is not running
   * (the server was restarted mid-build). Returns how many were started;
   * called from the scheduler's tick, whose first pass runs at boot.
   *
   * Reconciliation has already failed the sessions whose container went with
   * the restart, so what is left here still has its container and its
   * workspace. Nothing about the run is lost that matters — the statuses are
   * in `prd.md` and the work is in commits — so this is the same continuation
   * a stop and a start would be, minus the operator. The in-flight iteration
   * is the only thing given up: the loop's first act is to reap the agent the
   * last process left behind, and the story is picked again from the file.
   *
   * No cap check: a `building` session never gave its slot back. When its
   * account is held (US-014) and no failover account can take the work
   * (US-015) it is parked instead, exactly as {@link holdOthers} would have
   * done, and resumed with the rest when the hold lifts.
   */
  async resumeOrphaned(): Promise<number> {
    let resumed = 0;
    for (const session of listSessions(this.db, { status: 'building' })) {
      if (this.runs.has(session.id) || this.isStarting('session', session.id)) continue;

      const until = this.hold.waitingUntil(effectiveClaudeAccountId(this.db, session));
      if (until !== null) {
        this.park(session, null, until);
        continue;
      }

      try {
        await this.launch(session);
        resumed += 1;
        logger.info('build restarted after a server restart', {
          session: session.id,
          name: session.name,
        });
      } catch (cause) {
        // Docker is not answering yet, most likely because it is coming up
        // with this server. The session stays `building` and the next tick
        // tries again.
        logger.warn('could not restart a build left by a previous process', {
          session: session.id,
          name: session.name,
          error: describe(cause),
        });
      }
    }
    return resumed;
  }

  /**
   * The sessions that can launch: their effective Claude account is not held
   * (US-014), or a failover account can take their work (US-015).
   */
  private notHeld(sessions: readonly Session[], now: Date = new Date()): Session[] {
    return sessions.filter(
      (session) => this.hold.waitingUntil(effectiveClaudeAccountId(this.db, session), now) === null,
    );
  }

  /** The shared body of both resumes: cap first, queue for the overflow. */
  private async resume(sessions: readonly Session[]): Promise<number> {
    let resumed = 0;
    for (const session of sessions) {
      if (this.runs.has(session.id) || this.isStarting('session', session.id)) continue;

      if (this.resumeSlots() <= 0) {
        this.enqueueSession(session, queuedAfterHoldMessage(session));
        continue;
      }

      try {
        await this.launch(session);
        resumed += 1;
      } catch (cause) {
        // Docker is not answering, or the container could not be brought back
        // up. The session stays `waiting` with its counters intact and the next
        // tick tries again — which is the same catch-up every other part of
        // this service does, and far better than failing a build for an outage
        // that is usually seconds long.
        logger.warn('could not resume a held build', {
          session: session.id,
          name: session.name,
          error: describe(cause),
        });
      }
    }
    return resumed;
  }

  /**
   * Slots a held session may resume into.
   *
   * A `waiting` session is already counted against the cap (US-003) — it never
   * gave its slot back — so the sessions being resumed must not be counted
   * against a cap they are already inside. Only what is actually working is:
   * `reviewing` is in here for the same reason it is an active build (US-002),
   * because the review it names is an agent running right now — and so is
   * `deciding` (decisions US-001), whose agent is alive and waiting rather
   * than working, but is in the pool either way.
   */
  private resumeSlots(): number {
    const max = getMaxConcurrentSessions(this.db, this.config);
    return (
      max -
      (countSessionsByStatus(this.db, 'building') +
        countSessionsByStatus(this.db, 'deciding') +
        countSessionsByStatus(this.db, 'reviewing') +
        this.starting.size +
        countActivePrRuns(this.db) +
        countActivePrReviews(this.db) +
        countActivePrConflictFixes(this.db))
    );
  }

  private async drain(): Promise<void> {
    for (;;) {
      // A free slot is no use to an entry whose account is held (US-005,
      // per account since US-014). Such entries keep their order and their
      // place; the first entry on an account that can work takes the slot,
      // and the pump that runs when a hold lifts serves the rest.
      if (this.hold.allHeld()) return;
      if (this.freeSlots() <= 0) return;

      const next = this.queue().find((entry) => !this.isBusy(entry) && !this.isHeld(entry));
      if (next === undefined) return;

      const starter = this.starters.get(next.kind);
      if (starter === undefined) {
        // Nothing here knows how to start this kind — an entry left by a newer
        // version, or a service that was not wired up. It must not sit at the
        // head with the whole queue behind it, so it goes.
        removeBuildQueueEntry(this.db, next.id);
        logger.warn('queued entry has no way to be started, so it left the queue', {
          kind: next.kind,
          ref: next.refId,
        });
        continue;
      }

      if (starter.exists?.(next) === false) {
        // The session was deleted, or the pull request closed, while it
        // waited. There is nobody left to tell.
        removeBuildQueueEntry(this.db, next.id);
        logger.info('queued entry no longer exists, so it left the queue', {
          kind: next.kind,
          ref: next.refId,
        });
        continue;
      }

      // Out of the queue *before* it is started, so no start — however it goes
      // — can leave this entry at the head a second time.
      removeBuildQueueEntry(this.db, next.id);
      try {
        await starter.start(next);
      } catch (cause) {
        const message = describe(cause);
        logger.warn('a queued entry could not be started, so it left the queue', {
          kind: next.kind,
          ref: next.refId,
          error: message,
        });
        // Somewhere the operator will actually see it — for a session, on the
        // session itself.
        starter.onFailed?.(next, message);
      }
    }
  }

  /**
   * True when the account the entry would launch on is held (US-014) and no
   * failover account can take it instead (US-015).
   */
  private isHeld(entry: BuildQueueEntry): boolean {
    const starter = this.starters.get(entry.kind);
    if (starter?.accountId === undefined) return this.hold.allHeld();
    return this.hold.waitingUntil(starter.accountId(entry)) !== null;
  }

  /** True when the entry's work is already starting or running here. */
  private isBusy(entry: BuildQueueEntry): boolean {
    if (this.isStarting(entry.kind, entry.refId)) return true;
    return this.starters.get(entry.kind)?.isRunning?.(entry) === true;
  }

  /** Everything that has to be true before a session can be built at all. */
  private assertStartable(session: Session): void {
    // `failed` is startable too, and that is the "Retry" of the session page:
    // a run that stopped because the agent stalled, the PRD broke or the
    // delivery failed leaves everything it did commit in place, so starting
    // again resumes from the PRD rather than redoing anything.
    if (session.status !== 'ready' && session.status !== 'failed') {
      throw new BuildError(
        409,
        'session_not_ready',
        `Only a ready or failed session can be built; "${session.name}" is ${session.status}.`,
      );
    }
    if (!isCloned(this.config, session.id)) {
      throw new BuildError(
        409,
        'session_not_cloned',
        `"${session.name}" has no clone yet, so there is nothing to build in. Run setup first.`,
      );
    }

    const stories = listStories(this.db, session.id);
    if (selectNextStory(stories) === null) {
      throw new BuildError(
        409,
        stories.length === 0 ? 'session_has_no_stories' : 'session_already_complete',
        stories.length === 0
          ? `"${session.name}" has no stories. Mark it ready again to re-read its PRD.`
          : `Every story of "${session.name}" is already done.`,
      );
    }
  }

  /**
   * Puts the session in the FIFO queue. Idempotent: a session already waiting
   * keeps its original `queued_at`, so pressing the button twice — or a
   * scheduler that fires the same session again — never sends it to the back.
   *
   * The schedule is spent here just as it is on a real start (US-017): the
   * session *did* start, in the only sense the operator asked for, and a
   * timestamp left behind would fire it a second time.
   */
  private enqueueSession(session: Session, note?: string): Session {
    const entry = this.enqueue('session', session.id);
    const queued =
      updateSession(this.db, session.id, {
        status: 'ready',
        scheduledStartAt: null,
        // A retry that only got as far as the queue has still left `failed`
        // behind, so the stage of that failure goes with it (US-019).
        failureStage: null,
        // A held session queued instead of resumed is no longer waiting on the
        // clock, it is waiting for a slot (US-006).
        waitingUntil: null,
        ...(note === undefined ? {} : { lastError: note }),
      }) ?? session;
    logger.info('build queued: the concurrency cap is reached', {
      session: session.id,
      name: session.name,
      queuedAt: entry.queuedAt,
      position: buildQueuePosition(this.db, 'session', session.id),
      maxConcurrentBuilds: getMaxConcurrentSessions(this.db, this.config),
    });
    return queued;
  }

  /** Brings the container up and puts the session into `building`. */
  private async launch(session: Session): Promise<Session> {
    // A run parked on a usage-limit hold is continued rather than restarted
    // (US-006): the counters it left behind are picked up here, whether the
    // resume came straight from the scheduler's tick or by way of the queue.
    // Taken before anything can throw, so a failed launch cannot leave a stale
    // set of counters for the next one.
    const parked = this.parked.get(session.id) ?? null;
    this.parked.delete(session.id);
    const startedSlot = this.claimStart('session', session.id);
    try {
      let containerId: string;
      try {
        containerId = (await this.containers.start(session, { agentWork: true })).id;
      } catch (cause) {
        throw new BuildError(
          502,
          'session_container_unavailable',
          `The session container could not be started: ${describe(cause)}`,
        );
      }

      const stories = listStories(this.db, session.id);
      // It has a slot now, so it is not waiting for one — whether it came off
      // the queue or never joined it.
      removeQueuedBuild(this.db, 'session', session.id);
      // A schedule is spent the moment its session starts building, however
      // that happened (US-017): the scheduler fired it, or someone pressed the
      // button early. Clearing it here — the one place `building` is entered —
      // is what stops a session that is later stopped or failed from starting
      // itself again from a timestamp that has long passed. The queue entry
      // goes the same way: the session is no longer waiting for a slot, it has
      // one.
      const building =
        updateSession(this.db, session.id, {
          status: 'building',
          lastError: null,
          // Whatever the last run failed at is history the moment this one
          // starts; leaving the stage behind would have the UI offering a
          // retry for a failure that is being retried right now.
          failureStage: null,
          scheduledStartAt: null,
          // Whether this is a resume or a fresh start, the session is working
          // again and is not waiting for anything (US-006).
          waitingUntil: null,
        }) ?? session;
      const state: RunState = {
        containerId,
        iteration: parked?.iteration ?? 0,
        attempts: parked?.attempts ?? 0,
        storyId: parked?.storyId ?? null,
        maxIterations: parked?.maxIterations ?? iterationCap(remainingStories(stories)),
        startedAt: parked?.startedAt ?? nowIso(),
        stopping: false,
        planned: false,
        holdUntil: null,
        // The account `start` just resolved for the container: the row as it
        // is now, which is what the orchestrator read and wrote — the failover
        // account while the session's own is held (US-015).
        accountId: runningClaudeAccountId(this.db, getSession(this.db, session.id) ?? session),
        finished: Promise.resolve(),
      };
      this.runs.set(session.id, state);
      state.finished = this.runLoop(session.id, state).finally(() => {
        // Only ever forget *this* run: a session started again in the meantime
        // has its own state in the map.
        if (this.runs.get(session.id) === state) this.runs.delete(session.id);
        // The slot this run held is free now. Detached on purpose: "Stop
        // build" awaits `finished`, and it must not also wait for the next
        // session's container to come up.
        void this.pump();
      });

      logger.info(parked === null ? 'build started' : 'build resumed after the usage-limit hold', {
        session: session.id,
        name: session.name,
        container: containerId,
        stories: stories.length,
        iteration: state.iteration,
        story: state.storyId,
        attempts: state.attempts,
        maxIterations: state.maxIterations,
      });
      return building;
    } finally {
      startedSlot();
    }
  }

  /**
   * "Stop build": signals the running agent and waits for the loop to unwind,
   * leaving the session `ready`. Everything already committed stays committed,
   * and the statuses in `prd.md` are whatever the last finished iteration
   * wrote — a stopped build resumes rather than restarts.
   *
   * A session parked on Claude's usage limit stops the same way (US-009). Its
   * loop has already unwound, so there is nothing to signal: it is the row that
   * is stopped, which is what the operator who does not want to wait out the
   * hold on this particular session is asking for.
   */
  async stop(sessionId: string): Promise<BuildView> {
    const session = this.requireSession(sessionId);
    const state = this.runs.get(sessionId);

    if (state === undefined) {
      if (!STOPPABLE_STATUSES.includes(session.status)) {
        throw new BuildError(
          409,
          'session_not_building',
          `Only a building session can be stopped; "${session.name}" is ${session.status}.`,
        );
      }
      // `building` with no loop behind it: this server was restarted while the
      // session was running. `waiting` never has one — the loop unwound when
      // the hold parked it — and a `deciding` session only reaches this with
      // its agent gone, so its question goes with the run. Returning any of
      // them to `ready` is the whole of "stop", and it frees the slot it was
      // counted against.
      this.decisions?.abandon(session.id);
      const idle = this.returnToReady(session);
      void this.pump();
      return this.toView(idle);
    }

    state.stopping = true;
    try {
      // A blocked agent is signalled like any other: it is waiting inside its
      // own process, and the stop is what the operator wants instead of the
      // answer. The row goes with it when the iteration unwinds.
      await this.runner.stop(sessionId, state.containerId);
    } catch (cause) {
      logger.warn('could not signal the build agent', {
        session: sessionId,
        error: describe(cause),
      });
    }
    await settle(state.finished, this.config.buildStopTimeoutMs);
    // SIGTERM is a request, and `settle` gives up on it after the stop timeout
    // whether or not it was honoured. An agent that outlasted both is the same
    // orphan a timed-out iteration leaves behind — the session is about to go
    // back to `ready` and be startable again, so it cannot be left holding the
    // workspace. Nothing to reap is the normal case, and costs one exec.
    await this.runner.reap(sessionId, state.containerId);

    const stopped = getSession(this.db, sessionId) ?? session;
    logger.info('build stopped', { session: sessionId, iterations: state.iteration });
    return this.toView(
      STOPPABLE_STATUSES.includes(stopped.status) ? this.returnToReady(stopped) : stopped,
    );
  }

  /** Resolves when the session's loop has unwound; immediately if none runs. */
  whenIdle(sessionId: string): Promise<void> {
    return this.runs.get(sessionId)?.finished ?? Promise.resolve();
  }

  private async runLoop(sessionId: string, state: RunState): Promise<void> {
    // A server that was restarted mid-iteration left its agent running: the
    // container outlives the process that was watching it, and nothing on the
    // way back up signals what it holds. Sweeping the session's pid files
    // before the first iteration is what keeps that agent from meeting the one
    // this run is about to start. It costs one exec per run, and on the usual
    // path there is nothing to find.
    await this.runner.reap(sessionId, state.containerId);

    for (;;) {
      const session = getSession(this.db, sessionId);
      // A session that was deleted, or moved out of `building` by something
      // else, is not this loop's business any more.
      if (session === null) return;
      if (state.stopping) {
        this.returnToReady(session);
        return;
      }
      // Another session was refused while this one was between iterations
      // (US-005). Nothing is in flight, so there is nothing to reap: the run
      // simply parks on the same expiry as the session that hit the wall.
      if (state.holdUntil !== null) {
        this.park(session, state, state.holdUntil);
        return;
      }
      if (session.status !== 'building') return;

      let snapshot: PrdSnapshot;
      try {
        snapshot = this.readPrd(session);
      } catch (cause) {
        this.fail(session, 'prd', `The PRD could not be read: ${describe(cause)}`);
        return;
      }
      if (!snapshot.synced) {
        this.fail(session, 'prd', prdBrokenMessage(snapshot));
        return;
      }

      const story = selectNextStory(snapshot.stories);
      if (story === null) {
        await this.handOff(session, snapshot.stories);
        return;
      }

      // Before any story agent starts, and once per run (async stories
      // US-005). Back to the top afterwards: the analysis took a while, and
      // the stop, the hold and the PRD are all checked again from scratch.
      if (!state.planned) {
        state.planned = true;
        if (!(await this.planDependencies(session, snapshot, state))) return;
        continue;
      }

      if (state.iteration >= state.maxIterations) {
        this.fail(
          session,
          'agent',
          `The build was stopped after ${String(state.maxIterations)} iterations with ` +
            `${String(remainingStories(snapshot.stories))} of ${String(snapshot.stories.length)} ` +
            `stories still outstanding (currently ${story.storyId}). That is more than one and a ` +
            'half passes over the PRD, so the loop is not converging.',
        );
        return;
      }

      if (state.storyId !== story.storyId) {
        state.storyId = story.storyId;
        state.attempts = 0;
      }
      state.iteration += 1;

      let keepGoing: boolean;
      try {
        keepGoing = await this.iterate(session, story, snapshot, state);
      } catch (cause) {
        // The exec this run was in was killed to put the session on the hold
        // (US-005), so whatever it threw on the way out describes our own
        // signal rather than a broken build. Park it.
        if (state.holdUntil !== null) {
          this.park(session, state, state.holdUntil);
          return;
        }
        this.fail(
          session,
          'agent',
          `Iteration ${String(state.iteration)} (${story.storyId}) could not be run: ${describe(cause)}`,
        );
        return;
      }
      if (!keepGoing) return;
    }
  }

  /** One iteration. Returns false when the loop must not continue. */
  private async iterate(
    session: Session,
    story: Story,
    snapshot: PrdSnapshot,
    state: RunState,
  ): Promise<boolean> {
    state.containerId = (await this.containers.start(session, { agentWork: true })).id;

    // chief marks the story in-progress before invoking the agent, and so does
    // this: the status the loop leaves behind is what the *next* read is
    // compared against, so the loop can never mistake its own write for work.
    //
    // A parallel session's story runs in a worktree of its own (async stories
    // US-006), so everything below — the mark, HEAD, the prompt's paths, the
    // read-back — is that worktree's rather than the clone's.
    const workspace = await this.storyWorkspace(session, story, state);
    const before = this.markInProgress(session, story, workspace.prdFile);
    const headBefore = await this.runner.headSha(state.containerId, workspace.story?.workingDir);

    logger.info('build iteration started', {
      session: session.id,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      story: story.storyId,
      attempt: state.attempts + 1,
    });

    // Everything the agent prints goes to the log before it goes anywhere
    // else: the file in the workspace is the record, and whoever is watching
    // the session page is reading over its shoulder.
    const log = this.logs.begin(session, state.iteration, story.storyId);
    // The model and its advisor are read here, one line above the launch, so a
    // settings change lands at the next story rather than at the next restart
    // (US-005) — and so the pair the rules are applied to is the pair that is
    // actually about to be used (US-007).
    const buildModel = getBuildModel(this.db);
    const advisor = advisorFor(this.db);
    if (advisor.dropped !== null) log.write(`${advisor.dropped}\n`);
    // The effort is resolved on the same line and from a fresh read of the
    // session row, so an effort changed mid-build lands at the next iteration.
    const effort = effortFor(this.db, getSession(this.db, session.id) ?? session);
    if (effort !== null) log.write(`Thinking effort: ${effort.level} (${effort.source})\n`);
    // Read per iteration, so a timeout changed on the settings page applies to
    // the next one without a restart (US-019). The agent is told the same
    // number it is held to: it is the only one of the two that can decide not
    // to start a full-suite run with four minutes left.
    const timeoutMs = getAgentTimeoutMs(this.db, this.config);
    // The budget as a clock that can be stopped (decisions US-004): the time
    // the agent spends waiting for an answer is not time it spent working, so
    // it is not charged to the iteration. Without a watcher there is nothing
    // that could pause it and the plain timeout is used instead.
    const deadline = this.decisions === null ? null : new ExecDeadline(timeoutMs);
    // Written one line above the launch, like the model and the effort: the
    // file carries the answer timeout, and a `null` here is an iteration that
    // simply has no way to ask.
    const mcpConfigFile = (await this.decisions?.prepare(session.id, state.containerId)) ?? null;
    let result: AgentResult;
    try {
      result = await this.runner.run({
        sessionId: session.id,
        containerId: state.containerId,
        iteration: state.iteration,
        prompt: agentPrompt({
          sessionName: session.name,
          story: promptStory(story, snapshot.parsed),
          timeoutMs,
          prd: snapshot.parsed,
          progress: this.readProgress(session, workspace.progressFile),
          canAsk: mcpConfigFile !== null,
          worktree:
            workspace.story === null || workspace.branch === null
              ? null
              : { dir: workspace.story.workingDir, branch: workspace.branch },
        }),
        timeoutMs,
        model: buildModel,
        advisor: advisor.model,
        effort: effort?.level ?? null,
        mcpConfigFile,
        deadline,
        story: workspace.story,
        onOutput: (text) => log.write(text),
        onToolCall: (call) => {
          if (call.name !== ASK_OPERATOR_TOOL) return;
          // Detached on purpose: this runs on the output stream, and finding
          // the request file is an exec into the container. The agent is
          // already blocked on its answer file, so nothing is racing us.
          void this.asked(session, story, state, deadline, log);
        },
      });
    } catch (cause) {
      // The question dies with the iteration that asked it, however that
      // iteration ended (decisions US-007).
      this.decisions?.abandon(session.id);
      log.end(null);
      await this.abandonWorktree(session, state, workspace);
      throw cause;
    }
    this.decisions?.abandon(session.id);

    // The hold went up under this iteration because *another* session was
    // refused (US-005), and the agent was signalled off the machine to make
    // that true. Handled before the refusal check for the same reason it is
    // handled before classification: the output belongs to an exec we killed,
    // so it is not evidence of anything — least of all of a second limit hit,
    // which would push the shared expiry another hour into the future.
    if (state.holdUntil !== null) {
      const held = state.holdUntil;
      log.write(`\n${holdMessage(held)}\n`);
      log.end(result.exitCode);
      await this.runner.reap(session.id, state.containerId, workspace.story?.storyId);
      await this.abandonWorktree(session, state, workspace);
      if (state.stopping) this.returnToReady(session);
      else this.park(session, state, held);
      return false;
    }

    // Asked before anything is classified, because there is nothing to
    // classify (US-004): the agent did not fail to do the work, it was never
    // allowed to start it. `classifyIteration` would see no commit and no
    // status change, call the iteration stalled and spend one of the story's
    // two retries on a wall the session cannot climb — and two more iterations
    // would hit it within seconds. So the run is parked on a global hold
    // instead and picks the same story up again when the hold lifts.
    if (isUsageLimitRefusal(result)) {
      const until = this.hold.arm(state.accountId);
      // Inside this iteration's own markers, so the per-iteration history
      // explains the gap rather than showing a section that stops mid-air.
      log.write(`\n${holdMessage(until)}\n`);
      log.end(result.exitCode);

      // The same reasoning as the timeout path: the loop is walking away from
      // this exec, and whatever the CLI left behind in the container must not
      // still be holding the workspace when the session resumes into it.
      await this.runner.reap(session.id, state.containerId, workspace.story?.storyId);
      await this.abandonWorktree(session, state, workspace);

      // "Stop build" pressed while the refused iteration was in flight still
      // wins — the hold is armed either way, because the limit is on the
      // account rather than on this session, but the session goes back to
      // `ready` rather than waiting for an hour nobody asked it to wait.
      if (state.stopping) this.returnToReady(session);
      else this.park(session, state, until);

      // The limit belongs to the account, not to this session, so every other
      // run on that account is about to be refused for the same reason
      // (US-005, US-014). They come off the agent now, on this expiry, rather
      // than each discovering the wall for itself; runs on other accounts
      // carry on.
      await this.holdOthers(session.id, state.accountId, until);
      return false;
    }

    log.end(result.timedOut ? null : result.exitCode);

    // A timed-out iteration is abandoned, not stopped: all a timeout can do is
    // close chief-web's end of the exec stream, and the Engine API has no way
    // to kill an exec — so the agent, and every test run, database server and
    // stray process it started, is still going, in this container, with this
    // workspace under it. Reaping it here is what stops the retry from exec-ing
    // a second agent into a working tree the first one is still editing: two
    // agents in one clone is a collision neither can win, and the loop reads
    // the resulting standoff as three attempts that changed nothing.
    //
    // It happens before HEAD and the PRD are read back, so what the iteration
    // is judged on is a workspace nothing is still writing to.
    if (result.timedOut) await this.runner.reap(session.id, state.containerId, workspace.story?.storyId);

    // The bookkeeping happens even when the operator pressed "Stop build"
    // while this iteration was running: the agent may well have committed the
    // story before it was signalled, and that has to be recorded before the
    // run unwinds or the work loses its commit.
    const headAfter = await this.runner.headSha(state.containerId, workspace.story?.workingDir);
    const after = workspace.story === null ? this.readPrd(session) : this.readWorktreePrd(session, workspace.prdFile);
    const updated = after.stories.find((candidate) => candidate.storyId === story.storyId) ?? null;
    const change = classifyIteration(
      before,
      updated?.status ?? null,
      headBefore,
      headAfter,
      result.timedOut,
    );
    if (change.commitSha !== null && updated !== null) {
      updateStory(this.db, session.id, story.storyId, { commitSha: change.commitSha });
    }
    // A finished story's worktree waits for its merge (US-007), which removes
    // it; any other ending abandons this attempt, and a retry starts afresh.
    if (updated?.status !== 'done') await this.abandonWorktree(session, state, workspace);

    // A story the agent finished is pushed straight away, so what `origin` has
    // is never more than one story behind what the container has — including
    // when the operator stops the build a moment later, which is why this comes
    // before the stop check rather than after it.
    if (updated?.status === 'done') {
      await this.completion.push(session);
      const stories = listStories(this.db, session.id);
      this.events?.publish({
        kind: 'build.story_done',
        sessionId: session.id,
        name: session.name,
        storyId: story.storyId,
        done: stories.filter((candidate) => candidate.status === 'done').length,
        total: stories.length,
      });
    }

    if (state.stopping) {
      this.returnToReady(session);
      return false;
    }
    // A PRD chief-web can no longer read is the end of the run: it is the only
    // record of which stories are done, so continuing would be guesswork.
    if (!after.synced) {
      this.fail(session, 'prd', prdBrokenMessage(after));
      return false;
    }

    logger.info('build iteration finished', {
      session: session.id,
      iteration: state.iteration,
      story: story.storyId,
      status: updated?.status ?? 'gone',
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      commit: change.commitSha,
      stalled: change.stalled,
    });

    if (!change.stalled) {
      state.attempts = 0;
      return true;
    }

    state.attempts += 1;
    if (state.attempts > MAX_RETRIES) {
      this.fail(session, 'agent', stalledMessage(story, state.attempts, result));
      return false;
    }
    logger.warn(
      change.timedOut
        ? 'build iteration ran out of time; retrying'
        : 'build iteration produced nothing; retrying',
      {
        session: session.id,
        story: story.storyId,
        attempt: state.attempts,
        remainingRetries: MAX_RETRIES - state.attempts + 1,
      },
    );
    return true;
  }

  /**
   * Settles the run's dependency plan before any story agent starts (async
   * stories US-005). Returns false when the loop must not continue: the
   * analysis was stopped, or put the session on the usage-limit hold.
   *
   * With a limit of 1, or one story left, there is nothing to run side by
   * side and nothing happens. A stored plan made for exactly the stories in
   * `prd.md` is reused, so a resumed build does not pay for the analysis
   * twice. Otherwise one headless `claude -p` reads the PRD and answers with
   * JSON — and whatever goes wrong with that, short of a stop or a hold, ends
   * in the sequential fallback rather than in a failed build.
   */
  private async planDependencies(session: Session, snapshot: PrdSnapshot, state: RunState): Promise<boolean> {
    const fresh = getSession(this.db, session.id) ?? session;
    if (fresh.maxParallelStories <= 1 || remainingStories(snapshot.stories) <= 1) return true;

    const storyIds = snapshot.stories.map((candidate) => candidate.storyId).sort();
    const origin = getDependencyPlanOrigin(this.db, session.id);
    const storedIds = getDependencyPlanStoryIds(this.db, session.id);
    if (origin.source !== null && storedIds !== null && sameIds(storedIds, storyIds)) {
      const log = this.logs.begin(session, ANALYSIS_ITERATION, null);
      log.write(
        `${planHeadline(origin.source, origin.reason)}\n` +
          '(stored when this build first started; the stories in prd.md have not changed)\n' +
          describePlan(snapshot.stories, getDependencyPlan(this.db, session.id)).map((line) => `${line}\n`).join(''),
      );
      log.end(0);
      return true;
    }

    state.containerId = (await this.containers.start(session, { agentWork: true })).id;
    const log = this.logs.begin(session, ANALYSIS_ITERATION, null);
    logger.info('dependency analysis started', {
      session: session.id,
      stories: storyIds.length,
      reanalysis: origin.source !== null,
    });
    if (origin.source !== null) {
      log.write('The stories in prd.md changed since the stored plan was made, so it is worked out again.\n');
    }

    let prd: string;
    try {
      prd = fs.readFileSync(sessionPrdFile(this.config, session), 'utf8');
    } catch (cause) {
      this.storePlan(session, snapshot, log, null, `prd.md could not be read: ${describe(cause)}`);
      log.end(null);
      return true;
    }

    const before = (await this.runner.workspaceStatus?.(state.containerId)) ?? null;
    let result: AgentResult | null = null;
    let failure: string | null = null;
    try {
      result = await this.runner.run({
        sessionId: session.id,
        containerId: state.containerId,
        iteration: ANALYSIS_ITERATION,
        prompt: dependencyAnalysisPrompt({
          sessionName: session.name,
          prd,
          storyIds: snapshot.stories.map((candidate) => candidate.storyId),
        }),
        timeoutMs: DEPENDENCY_ANALYSIS_TIMEOUT_MS,
        model: getBuildModel(this.db),
        mcpConfigFile: null,
        deadline: null,
        onOutput: (text) => log.write(text),
      });
    } catch (cause) {
      failure = `the analysis agent could not be run: ${describe(cause)}`;
    }

    // Something else took the run off the agent while it was analysing: a
    // hold armed by another session, the operator's stop, or this agent's own
    // refusal. None of those is an answer, so no plan is stored — a fallback
    // stored here would be reused by the resume for the rest of the build.
    const refused = result !== null && isUsageLimitRefusal(result);
    const interrupted = state.holdUntil !== null || state.stopping || refused;
    if (interrupted || result?.timedOut === true) await this.runner.reap(session.id, state.containerId);
    await this.discardAnalysisChanges(session, state, before, log);

    if (state.holdUntil !== null) {
      const held = state.holdUntil;
      log.write(`\n${holdMessage(held)}\n`);
      log.end(result?.exitCode ?? null);
      if (state.stopping) this.returnToReady(session);
      else this.park(session, state, held, false);
      return false;
    }
    if (refused) {
      const until = this.hold.arm(state.accountId);
      log.write(`\n${holdMessage(until)}\n`);
      log.end(result?.exitCode ?? null);
      if (state.stopping) this.returnToReady(session);
      else this.park(session, state, until, false);
      await this.holdOthers(session.id, state.accountId, until);
      return false;
    }
    if (state.stopping) {
      log.end(result?.exitCode ?? null);
      this.returnToReady(session);
      return false;
    }

    if (result !== null && failure === null) {
      if (result.timedOut) {
        failure = `the analysis timed out after ${String(DEPENDENCY_ANALYSIS_TIMEOUT_MS / 60_000)} minutes`;
      } else if (result.exitCode !== 0) {
        failure = `the analysis agent exited with code ${String(result.exitCode)}`;
      }
    }
    let raw: RawPlan | null = null;
    if (failure === null && result !== null) {
      const answer = parseDependencyAnswer(result.output);
      if (answer.raw === null) failure = answer.error;
      else raw = answer.raw;
    }
    this.storePlan(session, snapshot, log, raw, failure);
    log.end(result?.timedOut === true ? null : (result?.exitCode ?? null));
    return true;
  }

  /**
   * The analysis agent is told not to change anything; this is what makes
   * that true. Only a change *it* made is undone: the clone is compared with
   * how it was before the agent started.
   */
  private async discardAnalysisChanges(
    session: Session,
    state: RunState,
    before: string | null,
    log: { write(text: string): void },
  ): Promise<void> {
    if (before === null || this.runner.workspaceStatus === undefined) return;
    const after = await this.runner.workspaceStatus(state.containerId);
    if (after === null || after === before) return;
    logger.warn('the dependency analysis changed the clone; restoring it', { session: session.id });
    log.write('\nThe analysis agent changed files it was told to leave alone; they were thrown away.\n');
    await this.runner.restoreWorkspace?.(state.containerId);
  }

  /**
   * Stores the agent's plan, or the sequential fallback when `failure` says
   * why there is none or `normalizePlan` rejects it, and writes it to the log.
   */
  private storePlan(
    session: Session,
    snapshot: PrdSnapshot,
    log: { write(text: string): void },
    raw: RawPlan | null,
    failure: string | null,
  ): void {
    const storyIds = snapshot.stories.map((candidate) => candidate.storyId);
    let plan = sequentialPlan(snapshot.stories);
    let reason = failure;
    if (raw !== null && failure === null) {
      const normalized = normalizePlan(snapshot.stories, raw);
      plan = normalized.plan;
      reason = normalized.fallbackReason;
    }
    const source = reason === null ? 'agent' : 'fallback';
    replaceDependencyPlan(this.db, session.id, plan, source, reason, storyIds);
    logger.info('dependency plan stored', { session: session.id, source, reason });
    log.write(
      `\n${planHeadline(source, reason)}\n` +
        describePlan(snapshot.stories, plan).map((line) => `${line}\n`).join(''),
    );
  }

  /**
   * The iteration asked the operator something (decisions US-004).
   *
   * Everything that matters here is in {@link DecisionWatcher.asked}; what is
   * left is the log, which is the only place an operator who is not on the
   * session page will see the question. It goes inside the iteration's own
   * markers, exactly as a usage-limit hold does, so the per-iteration history
   * explains the gap instead of showing a section that stops mid-air.
   */
  private async asked(
    session: Session,
    story: Story,
    state: RunState,
    deadline: ExecDeadline | null,
    log: { write(text: string): void },
  ): Promise<void> {
    try {
      const decision = await this.decisions?.asked({
        session,
        containerId: state.containerId,
        storyId: story.storyId,
        iteration: state.iteration,
        deadline,
        stopped: () => state.stopping || state.holdUntil !== null,
      });
      if (decision === null || decision === undefined) return;
      log.write(`\n${decisionMessage(decision)}\n`);
    } catch (cause) {
      // A question that could not be taken down is not a failed build: the
      // agent's own wait runs out and it carries on with its best guess.
      logger.warn('could not take down the build agent’s question', {
        session: session.id,
        error: describe(cause),
      });
    }
  }

  private async handOff(session: Session, stories: readonly Story[]): Promise<void> {
    logger.info('build complete: every story is done', {
      session: session.id,
      name: session.name,
      stories: stories.length,
    });
    this.events?.publish({ kind: 'build.finished', sessionId: session.id, name: session.name, stories: stories.length });
    await this.completion.complete(session, stories);
  }

  /**
   * Writes `**Status:** in-progress` into `prd.md` and the row, and returns the
   * status the story now has as far as the loop is concerned. A file that
   * cannot be written leaves the story where it was — the comparison after the
   * iteration has to be against reality, not against an intention.
   */
  private markInProgress(
    session: Session,
    story: Story,
    file: string = sessionPrdFile(this.config, session),
  ): StoryStatus {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (cause) {
      logger.warn('could not read the PRD to mark a story in progress', {
        session: session.id,
        story: story.storyId,
        error: describe(cause),
      });
      return story.status;
    }

    const result = setStoryStatus(content, story.storyId, 'in-progress');
    if (result.missing.length > 0) return story.status;
    if (result.changed) {
      try {
        // Written in place, so the file keeps the ownership the runner needs:
        // the server is root in Docker and a fresh file would be root's.
        fs.writeFileSync(file, result.content);
      } catch (cause) {
        logger.warn('could not mark a story in progress', {
          session: session.id,
          story: story.storyId,
          error: describe(cause),
        });
        return story.status;
      }
    }
    updateStory(this.db, session.id, story.storyId, { status: 'in-progress' });
    return 'in-progress';
  }

  /** Re-reads `prd.md` and syncs the `stories` table with what it now says. */
  private readPrd(session: Session): PrdSnapshot {
    const document = readPrdDocument(sessionPrdFile(this.config, session), prdPathFor(session.name));
    if (document.parsed === null || !document.status.parses) {
      return {
        stories: listStories(this.db, session.id),
        parsed: document.parsed,
        status: document.status,
        synced: false,
      };
    }
    return {
      stories: syncStories(this.db, session.id, document.parsed.stories.map(storyInputOf)),
      parsed: document.parsed,
      status: document.status,
      synced: true,
    };
  }

  /**
   * A story worktree's `prd.md` as its agent left it (async stories US-006).
   *
   * Unlike {@link readPrd} it does not sync the `stories` table: the worktree
   * speaks for its own story only, and what it says reaches the session's PRD
   * through the merge (US-007). The rows are the table's, each carrying the
   * status the worktree gives it; a story the worktree no longer has is left
   * out, exactly as a synced read would drop it.
   */
  private readWorktreePrd(session: Session, file: string): PrdSnapshot {
    const document = readPrdDocument(file, prdPathFor(session.name));
    const rows = listStories(this.db, session.id);
    if (document.parsed === null || !document.status.parses) {
      return { stories: rows, parsed: document.parsed, status: document.status, synced: false };
    }
    const statuses = new Map(document.parsed.stories.map((parsed) => [parsed.id, parsed.status]));
    const stories: Story[] = [];
    for (const row of rows) {
      const status = statuses.get(row.storyId);
      if (status !== undefined) stories.push({ ...row, status });
    }
    return { stories, parsed: document.parsed, status: document.status, synced: true };
  }

  /**
   * Where this attempt at `story` works (async stories US-006).
   *
   * A session that may run more than one story at a time gives every story a
   * worktree of its own, created fresh off the session branch's HEAD — so the
   * limit is read from a fresh row, like every other per-iteration setting. A
   * limit of 1, or a runner that cannot make worktrees, works in the clone.
   */
  private async storyWorkspace(session: Session, story: Story, state: RunState): Promise<StoryWorkspace> {
    const clone: StoryWorkspace = {
      story: null,
      branch: null,
      prdFile: sessionPrdFile(this.config, session),
      progressFile: sessionProgressFile(this.config, session),
    };
    const limit = (getSession(this.db, session.id) ?? session).maxParallelStories;
    if (limit <= 1 || this.runner.addStoryWorktree === undefined) return clone;

    await this.runner.addStoryWorktree(state.containerId, session.name, story.storyId);
    const workingDir = storyWorktreeDir(story.storyId);
    // `/workspace` in the container is the session's workspace on the data
    // volume, so the worktree's files can be read from here directly.
    const hostDir = path.join(
      sessionWorkspaceDir(this.config, session.id),
      path.posix.relative(RUNNER_WORKSPACE_DIR, workingDir),
    );
    return {
      story: { storyId: story.storyId, attempt: state.attempts + 1, workingDir },
      branch: storyBranch(session.name, story.storyId),
      prdFile: path.join(hostDir, prdPathFor(session.name)),
      progressFile: path.join(hostDir, progressPathFor(session.name)),
    };
  }

  /**
   * Removes an abandoned attempt's worktree and story branch (async stories
   * US-006); nothing for an attempt that ran in the clone. Never throws.
   */
  private async abandonWorktree(session: Session, state: RunState, workspace: StoryWorkspace): Promise<void> {
    if (workspace.story === null) return;
    await this.runner.removeStoryWorktree?.(state.containerId, session.name, workspace.story.storyId);
  }

  /** The accumulated learnings, read from the data volume; `null` if absent. */
  private readProgress(
    session: Session,
    file: string = sessionProgressFile(this.config, session),
  ): string | null {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Every way this loop ends in `failed` goes through here, so the stage a
   * retry dispatches on is recorded next to the sentence the operator reads
   * (US-019).
   */
  private fail(session: Session, stage: FailureStage, message: string): Session {
    logger.warn('build failed', {
      session: session.id,
      name: session.name,
      stage,
      error: message,
    });
    this.events?.publish({ kind: 'build.failed', sessionId: session.id, name: session.name, message });
    return failSession(this.db, session.id, stage, message) ?? session;
  }

  /**
   * Puts every building session on the hold because something that is not a
   * build hit the limit (US-007).
   *
   * A PR-feedback pass runs the same agent against the same account, so its
   * refusal is the same outage {@link holdOthers} exists for — the only
   * difference is that there is no refused session of its own to skip.
   */
  async holdAll(accountId: string | null, until: string): Promise<void> {
    await this.holdOthers(null, accountId, until);
  }


  /**
   * Puts every *other* building session on the same hold (US-005).
   *
   * One account, one limit: the moment one session is refused, the rest are
   * running into the same wall a few seconds behind. Left alone they would each
   * spend their own retries discovering it, and three sessions would produce
   * three stalled stories out of one outage.
   *
   * Sessions are parked one at a time and each is fully unwound first — its
   * agent signalled, its loop given the stop timeout to finish its own
   * bookkeeping, and then reaped whether or not it took the hint — because a
   * session that goes `waiting` is one the operator can resume, and resuming
   * into a container where the last agent is still editing the workspace is the
   * collision the reap exists to prevent.
   *
   * A `building` session with no loop behind it — this server was restarted
   * under it — is parked too. There is no exec to reap, and leaving it
   * `building` would have it counted as working while nothing is.
   */
  private async holdOthers(
    refusedId: string | null,
    accountId: string | null,
    until: string,
  ): Promise<void> {
    for (const session of listSessions(this.db, { status: 'building' })) {
      if (session.id === refusedId) continue;
      const state = this.runs.get(session.id);
      const account = state?.accountId ?? runningClaudeAccountId(this.db, session);
      if (account !== accountId) continue;
      if (state === undefined) {
        this.park(session, null, until);
        continue;
      }
      await this.holdRun(session, state, until);
    }
  }

  /** Takes one live run off the agent and parks it on `until` (US-005). */
  private async holdRun(session: Session, state: RunState, until: string): Promise<void> {
    state.holdUntil = until;
    try {
      await this.runner.stop(session.id, state.containerId);
    } catch (cause) {
      logger.warn('could not signal a build agent for the usage-limit hold', {
        session: session.id,
        error: describe(cause),
      });
    }
    // The loop parks itself when it sees `holdUntil`; this is only how long we
    // are prepared to wait for it to get there.
    await settle(state.finished, this.config.buildStopTimeoutMs);
    await this.runner.reap(session.id, state.containerId);

    // Normally the loop has already parked it. A run that outlasted the stop
    // timeout has not, and must not be left `building` on a held account.
    const current = getSession(this.db, session.id) ?? session;
    if (current.status === 'building') this.park(current, state, until);
  }

  /**
   * Parks the run on the usage-limit hold: `waiting` until `until`, container
   * and all (US-004).
   *
   * The refused iteration is given back to the cap — it produced nothing, and a
   * limit the operator cannot control must not eat into the run's budget — and
   * the story's attempt count is left exactly where it stood, so the session
   * resumes on the same story with the same retries in hand. `prd.md` is not
   * touched either: the story keeps the status it has, `in-progress` included.
   *
   * Nothing is torn down. The container stays up, which is what lets the resume
   * continue rather than restart, and is why a `waiting` session goes on
   * counting against the concurrency cap (US-003).
   */
  private park(session: Session, state: RunState | null, until: string, redo = true): Session {
    if (state !== null) {
      // The iteration the hold interrupted is run again; the dependency
      // analysis (async stories US-005) was never one, so it costs nothing.
      if (redo) state.iteration -= 1;
      // Kept for the resume (US-006), which continues this run rather than
      // starting a new one. The `RunState` is dropped the moment the loop
      // unwinds, so this is the only thing that remembers where it got to.
      this.parked.set(session.id, {
        iteration: state.iteration,
        attempts: state.attempts,
        storyId: state.storyId,
        maxIterations: state.maxIterations,
        startedAt: state.startedAt,
      });
    }
    logger.warn('build held: the agent was refused for Claude’s usage limit', {
      session: session.id,
      name: session.name,
      story: state?.storyId ?? null,
      attempts: state?.attempts ?? 0,
      until,
    });
    this.events?.publish({ kind: 'build.waiting', sessionId: session.id, name: session.name, until });
    return (
      updateSession(this.db, session.id, {
        status: 'waiting',
        waitingUntil: until,
        // Not a failure, so no stage: this is a pause with a sentence on it,
        // and the session page reads that sentence rather than an error.
        lastError: holdMessage(until),
        failureStage: null,
      }) ?? session
    );
  }

  /**
   * Ends the run without failing it. The PRD is re-read first: an agent that
   * was signalled mid-story may still have finished the previous one, and the
   * file — not the row the loop wrote before starting it — is the truth about
   * what is done.
   *
   * A session parked on the usage-limit hold ends here too (US-009): stopping
   * it is the operator saying they do not want it back when the hold lifts, so
   * the expiry, the message the park wrote and the counters the resume would
   * have continued from all go with it. What was committed stays committed,
   * exactly as for a build stopped mid-iteration.
   */
  private returnToReady(session: Session): Session {
    if (!STOPPABLE_STATUSES.includes(session.status)) return session;
    try {
      this.readPrd(session);
    } catch (cause) {
      logger.warn('could not re-read the PRD while stopping the build', {
        session: session.id,
        error: describe(cause),
      });
    }
    this.parked.delete(session.id);
    return (
      updateSession(this.db, session.id, {
        status: 'ready',
        failureStage: null,
        waitingUntil: null,
        // The hold's sentence is the park's own bookkeeping and would read as a
        // standing complaint on a session that is now plainly ready; anything a
        // *building* session was carrying is left where it is.
        ...(session.status === 'waiting' ? { lastError: null } : {}),
      }) ?? session
    );
  }

  private requireSession(sessionId: string): Session {
    const session = getSession(this.db, sessionId);
    if (session === null) {
      throw new BuildError(404, 'session_not_found', 'No such session.');
    }
    return session;
  }

  private toView(session: Session): BuildView {
    const state = this.runs.get(session.id);
    const document = readPrdDocument(
      sessionPrdFile(this.config, session),
      prdPathFor(session.name),
    );
    return {
      sessionId: session.id,
      sessionName: session.name,
      status: session.status,
      running: state !== undefined,
      iteration: state?.iteration ?? 0,
      maxIterations: state?.maxIterations ?? iterationCap(remainingStories(listStories(this.db, session.id))),
      currentStoryId: state?.storyId ?? null,
      attempts: state?.attempts ?? 0,
      stories: listStories(this.db, session.id),
      prd: document.status,
      lastError: session.lastError,
      failureStage: session.failureStage,
      agentTimeoutMs: getAgentTimeoutMs(this.db, this.config),
      buildModel: getBuildModel(this.db),
      startedAt: state?.startedAt ?? null,
      queued: getQueuedBuild(this.db, 'session', session.id) !== null,
      queuePosition: buildQueuePosition(this.db, 'session', session.id),
      activeBuilds: this.slotsInUse().length,
      maxConcurrentBuilds: getMaxConcurrentSessions(this.db, this.config),
      decision: this.decisionView(session),
      decisionTimeoutMs: this.decisions?.timeoutMs ?? null,
    };
  }

  /**
   * The question this session is waiting on (decisions US-005).
   *
   * `waiting` is the difference between a question and a record of one: a row
   * whose agent has gone — the server was restarted under it — is still shown,
   * because what was asked is worth reading, but the page offers no answer box
   * for it. The expiry is computed rather than stored: it is the moment the
   * agent's own wait runs out, and that is `asked_at` plus the timeout both
   * ends were given.
   */
  private decisionView(session: Session): DecisionView | null {
    const open = this.decisions?.open(session.id) ?? null;
    if (open === null) return null;
    const waiting = this.decisions?.isWaiting(session.id) === true;
    const timeoutMs = this.decisions?.timeoutMs ?? null;
    return {
      id: open.id,
      question: open.question,
      options: open.options,
      context: open.context,
      recommendation: open.recommendation,
      storyId: open.storyId,
      askedAt: open.askedAt,
      waitingUntil:
        waiting && timeoutMs !== null ? new Date(Date.parse(open.askedAt) + timeoutMs).toISOString() : null,
      waiting,
    };
  }

  /**
   * "Answer": the operator's decision, written into the container the blocked
   * agent is reading, and onto the row (decisions US-006).
   *
   * Refused rather than silently dropped when there is nothing waiting: an
   * answer typed into a question whose agent has gone would read as accepted
   * and change nothing.
   */
  async answerDecision(sessionId: string, answer: string): Promise<BuildView> {
    const session = this.requireSession(sessionId);
    if (this.decisions === null) {
      throw new BuildError(409, 'decisions_unavailable', 'This server cannot relay answers to a build agent.');
    }
    const text = answer.trim();
    if (text === '') {
      throw new BuildError(400, 'decision_answer_empty', 'Write the decision before sending it.');
    }
    if (text.length > MAX_DECISION_ANSWER_CHARS) {
      throw new BuildError(
        400,
        'decision_answer_too_long',
        `Keep the answer under ${String(MAX_DECISION_ANSWER_CHARS)} characters; it is a decision, not a document.`,
      );
    }
    if (!this.decisions.isWaiting(sessionId)) {
      throw new BuildError(
        409,
        'decision_not_open',
        `"${session.name}" is not waiting for a decision any more.`,
      );
    }

    let answered: Decision | null;
    try {
      answered = await this.decisions.answer(sessionId, text);
    } catch (cause) {
      throw new BuildError(502, 'decision_answer_failed', describe(cause));
    }
    if (answered === null) {
      throw new BuildError(
        409,
        'decision_not_open',
        `"${session.name}" is not waiting for a decision any more.`,
      );
    }
    return this.toView(getSession(this.db, sessionId) ?? session);
  }
}

export function createBuildService(
  config: Config,
  db: Database,
  containers: SessionContainers,
  runner: AgentRunner,
  completion: BuildCompletion = new MarkSessionFinished(db),
  logs: BuildLogs = new NullBuildLogs(),
  hold: UsageLimitHold = new UsageLimitHold(db),
  events: VoiceEventSink | null = null,
  decisions: DecisionWatcher | null = null,
): BuildService {
  return new BuildService(config, db, containers, runner, completion, logs, hold, events, decisions);
}

/**
 * The story as the prompt needs it: the row knows its id, title and priority,
 * but only the parsed PRD has the description and the acceptance criteria the
 * agent is actually asked to satisfy.
 */
function promptStory(story: Story, parsed: ParsedPrd | null): PrdStory {
  const fromFile = parsed?.stories.find((candidate) => candidate.id === story.storyId);
  return (
    fromFile ?? {
      id: story.storyId,
      title: story.title,
      description: '',
      priority: story.priority,
      status: story.status,
      acceptanceCriteria: [],
      line: 0,
    }
  );
}

/**
 * The one sentence the log, the session and the operator all read about a
 * hold. It names the limit and the moment work resumes, because those are the
 * two things someone looking at a paused build wants to know.
 */
/** The advisor an iteration launches with, and what became of the stored one. */
interface AdvisorChoice {
  /** What goes on the argv; `null` passes no `--advisor` at all. */
  readonly model: AdvisorModel | null;
  /** The log line owed to the operator, or `null` when nothing was dropped. */
  readonly dropped: string | null;
}

/**
 * The advisor the iteration launches with, dropping one the CLI would refuse
 * (US-007).
 *
 * The settings page cannot save a model the CLI refuses as an advisor
 * (US-006), but a row can outlive the rule that rejected it: a value saved
 * before Haiku was excluded, or a family dropped from a later runner image.
 * That does not degrade an iteration — `--advisor` is validated at launch, so
 * the CLI exits 1 before the agent does any work, and the story burns a retry
 * on a wall it cannot climb. Dropping the advisor costs the run a second
 * opinion; keeping it costs the run the iteration, so the check is made once
 * more here, against the value about to be used.
 *
 * An advisor weaker than the build model is *not* one of those cases and is
 * not dropped: the CLI warns on stderr — `"sonnet" cannot advise
 * "claude-opus-5" … The advisor will not be used for the main model.` — and
 * runs the iteration to completion. The warning lands in the build log like
 * any other stderr line, which is the operator's cue to change the pair.
 *
 * Nothing is repaired in the database: the operator's saved intent stays where
 * they put it, and the log says why it was not honoured this time.
 */
function advisorFor(db: Database): AdvisorChoice {
  const stored = getStoredAdvisorModel(db);
  if (stored === null) return { model: null, dropped: null };

  if (!isAdvisorModel(stored)) {
    return {
      model: null,
      dropped:
        `chief-web: running this iteration without an advisor — Claude Code does not accept ${stored} ` +
        `as one, and would refuse to start rather than run without it. Choose ${ADVISOR_MODELS.join(' or ')} ` +
        'on the settings page.',
    };
  }
  return { model: stored, dropped: null };
}

/**
 * The question, in the live log (decisions US-004).
 *
 * Whoever is watching the log is watching it because they want to know what
 * the agent is doing, and this is the one thing it is doing that it needs them
 * for. The options and the recommendation go in too: the answer can be typed
 * into the card on the session page without reading anything else.
 */
function decisionMessage(decision: Decision): string {
  const options =
    decision.options.length === 0
      ? ''
      : `\nOptions: ${decision.options.map((option, index) => `(${String(index + 1)}) ${option}`).join(' ')}`;
  const recommendation = decision.recommendation === null ? '' : `\nIt would choose: ${decision.recommendation}`;
  return (
    `[chief-web] The agent is waiting for your decision: ${decision.question}${options}${recommendation}\n` +
    'Answer it on the session page. Nothing is lost while it waits: the iteration’s clock is stopped, ' +
    'and the agent carries on with the most conservative option if nobody answers.'
  );
}

/** The pid file and log section of the dependency analysis: before iteration 1. */
const ANALYSIS_ITERATION = 0;

/** The analysis agent's own fixed budget (async stories US-005). */
export const DEPENDENCY_ANALYSIS_TIMEOUT_MS = 30 * 60_000;

/** `Dependency plan: agent`, or `Dependency plan: fallback (<reason>)`. */
function planHeadline(source: DependencyPlanSource, reason: string | null): string {
  return source === 'agent' ? 'Dependency plan: agent' : `Dependency plan: fallback (${reason ?? 'no reason given'})`;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function holdMessage(until: string): string {
  return (
    'Claude’s usage limit was reached, so this build is held until ' +
    `${until}. No retry and no iteration were spent on it: the session resumes ` +
    'on the same story by itself once the hold lifts.'
  );
}

/**
 * What a session is told when it asks to build during a hold (US-005).
 *
 * It names the moment work resumes, because the session is not being refused
 * so much as deferred: it is in the queue, and the pump starts it there.
 */
function queuedForHoldMessage(session: Session, until: string): string {
  return (
    'Claude’s usage limit was reached, so no build can be started until ' +
    `${until}. "${session.name}" has been put in the build queue instead and ` +
    'starts by itself once the hold lifts.'
  );
}

/**
 * What a held session is told when the hold lifts but there is no slot for it
 * (US-006): it is not being held any more, it is queued, and it keeps its place.
 */
function queuedAfterHoldMessage(session: Session): string {
  return (
    'Claude’s usage limit has lifted, but every build slot is taken, so ' +
    `"${session.name}" is in the build queue and resumes on the story it was on ` +
    'as soon as a slot frees.'
  );
}

function prdBrokenMessage(snapshot: PrdSnapshot): string {
  const errors = snapshot.status.errors
    .map((error) => (error.line > 0 ? `line ${String(error.line)}: ${error.message}` : error.message))
    .join('; ');
  return (
    `${snapshot.status.path} can no longer be read, so the build cannot tell which stories are ` +
    `done. Fix the file and start the build again${errors === '' ? '.' : ` — ${errors}`}`
  );
}

function stalledMessage(story: Story, attempts: number, result: AgentResult): string {
  const how = result.timedOut
    ? 'the agent was still running after its time limit and was cut short (the limit is on the ' +
      'settings page)'
    : `the agent exited with code ${String(result.exitCode ?? 'unknown')}`;
  const tail = result.output.trim();
  return (
    `${story.storyId} ("${story.title}") made no progress in ${String(attempts)} attempts: ` +
    `no commit was made and its status in prd.md did not change. On the last attempt ${how}.` +
    (tail === '' ? '' : `\n\n${tail}`)
  );
}

/** Waits for `promise`, but never longer than `timeoutMs`. */
async function settle(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
