import type { Config } from '../config.js';
import {
  type Database,
  getSession,
  latestRecurringTaskRunSession,
  listDueRecurringTasks,
  listUnsettledRecurringTaskOccurrences,
  nowIso,
  type RecurringTask,
  type RecurringTaskOccurrence,
  type RecurringTaskOutcome,
  recordRecurringTaskOccurrence,
  recurringTaskOccurrenceForSession,
  type Session,
  type SessionStatus,
  updateRecurringTask,
  updateRecurringTaskOccurrence,
} from '../db/index.js';
import { nextCronRun } from '../lib/cron.js';
import { logger } from '../lib/logger.js';
import { writeSessionFile } from '../orchestrator/index.js';
import { prdPathFor } from '../prd/index.js';
import { hasOpenPullRequest, pullRequestNumberOf } from '../prsync/index.js';
import type { CreateSessionRequest, ReadyResult, SessionSetupView } from '../sessions/index.js';
import { generatedPrd, runSessionName } from './prd.js';

/**
 * Firing a recurring task into a session (US-004).
 *
 * One occurrence is one ordinary session: the same creation, the same
 * container, the same clone, the same queue and the same build loop a person
 * would have driven by hand. Everything this class adds sits either side of
 * that pipeline — the generated PRD that replaces the planning step in front of
 * it, and the occurrence row that follows the run to its end behind it.
 *
 * An occurrence that would overlap the previous one is not fired at all
 * (US-005): while the last run is still on its way, or still has a pull
 * request nobody has merged or closed, the moment passes as a `skipped` row
 * in the history instead. That is what keeps an hourly task whose runs take
 * two hours from stacking sessions, and unreviewed pull requests from the
 * same task from piling up behind each other.
 *
 * `next_run_at` is spent the moment a task fires, before anything can fail.
 * That is what makes a run that takes three hours, or a firing that is refused
 * outright, cost exactly one occurrence: the timestamp has already moved on to
 * the next one the expression names, counted from now — so downtime costs a
 * task one catch-up fire and never one per hour it was down.
 */

/** The slice of `SessionService` (US-010) firing a task needs. */
export interface RecurringTaskSessions {
  create(request: CreateSessionRequest): Promise<SessionSetupView>;
  markReady(id: string): Promise<ReadyResult>;
}

/** The slice of `BuildService` (US-013/US-018) a fired run is handed to. */
export interface RecurringTaskBuilds {
  start(sessionId: string): Promise<unknown>;
}

/** What the scheduler's tick calls; `RecurringTaskRunner` is the real one. */
export interface RecurringTaskFiring {
  /** Fires every due task, at most once each. Returns how many fired. */
  fireDue(now?: string): Promise<number>;
  /** Settles the occurrences whose runs have since ended. Returns how many. */
  settle(): number;
}

export class RecurringTaskRunner implements RecurringTaskFiring {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    /**
     * Read lazily because the session service is built *after* the scheduler —
     * it needs the scheduler itself, to honour a missed schedule the moment a
     * session is marked ready. Nothing here is called before the first tick,
     * by which time the circle is closed.
     */
    private readonly sessions: () => RecurringTaskSessions | null,
    private readonly builds: RecurringTaskBuilds,
  ) {}

  async fireDue(now: string = nowIso()): Promise<number> {
    let due: RecurringTask[];
    try {
      due = listDueRecurringTasks(this.db, now);
    } catch (cause) {
      // A database that cannot be read is not evidence that nothing is due.
      logger.warn('could not read the due recurring tasks', { error: describe(cause) });
      return 0;
    }
    if (due.length === 0) return 0;

    const sessions = this.sessions();
    if (sessions === null) {
      logger.warn('recurring tasks are due but the session service is not wired yet', {
        due: due.length,
      });
      return 0;
    }

    let fired = 0;
    for (const task of due) {
      if (await this.fire(task, sessions, now)) fired += 1;
    }
    return fired;
  }

  /**
   * Reads the outcome of every run that is still open off its session.
   *
   * A run ends minutes or hours after the tick that fired it, possibly on the
   * other side of a restart, so nothing about it is remembered in memory: the
   * `started` row and the session's own status are the whole record, and this
   * is the pass that joins them.
   */
  settle(): number {
    let open: RecurringTaskOccurrence[];
    try {
      open = listUnsettledRecurringTaskOccurrences(this.db);
    } catch (cause) {
      logger.warn('could not read the running recurring task occurrences', {
        error: describe(cause),
      });
      return 0;
    }

    let settled = 0;
    for (const occurrence of open) {
      // A run whose session was deleted has no outcome left to read; the
      // occurrence must still stop saying "running", or the task's last
      // outcome would claim a run that no longer exists.
      const session = occurrence.sessionId === null ? null : getSession(this.db, occurrence.sessionId);
      const result = settlementOf(session);
      if (result === null) continue;

      try {
        updateRecurringTaskOccurrence(this.db, occurrence.id, result);
      } catch (cause) {
        logger.warn('could not settle a recurring task occurrence', {
          occurrence: occurrence.id,
          error: describe(cause),
        });
        continue;
      }
      logger.info('recurring task run settled', {
        task: occurrence.recurringTaskId,
        session: occurrence.sessionId,
        outcome: result.outcome,
      });
      settled += 1;
    }
    return settled;
  }

  /**
   * One occurrence, from due to queued.
   *
   * Every exit that is not a running build records why: a refused container, a
   * clone that did not land and a PRD that could not be written are all
   * `fire-failed`, and none of them is retried before the next occurrence the
   * expression names. The half-created session is left exactly as an
   * interactive one would be — `pending`, with its reason on it and the usual
   * "Retry setup".
   */
  private async fire(
    task: RecurringTask,
    sessions: RecurringTaskSessions,
    now: string,
  ): Promise<boolean> {
    const firedAt = new Date(now);
    if (!this.reschedule(task, firedAt)) return false;

    // Asked after the reschedule, so a skipped occurrence costs the task the
    // same one slot a fired one does and the next one is already booked.
    const skip = this.skipReason(task);
    if (skip !== null) return this.skipped(task, now, skip);

    const name = runSessionName(task.name, firedAt);
    logger.info('recurring task firing', { task: task.id, name: task.name, run: name });

    let created: SessionSetupView;
    try {
      created = await sessions.create({
        repositoryId: task.repositoryId,
        name,
        baseBranch: task.baseBranch,
        prTargetBranch: task.prTarget,
        codeReview: task.runCodeReview,
        recurringTaskId: task.id,
      });
    } catch (cause) {
      return this.fireFailed(task, now, describe(cause), null);
    }

    const run = created.session;
    if (!created.setup.ok) return this.fireFailed(task, now, created.setup.message, run.id);

    try {
      writeSessionFile(this.config, run.id, prdPathFor(run.name), generatedPrd(task, run.name));
    } catch (cause) {
      return this.fireFailed(
        task,
        now,
        `The generated PRD could not be written into the run's workspace: ${describe(cause)}`,
        run.id,
      );
    }

    let ready: ReadyResult;
    try {
      ready = await sessions.markReady(run.id);
    } catch (cause) {
      return this.fireFailed(task, now, describe(cause), run.id);
    }
    if (!ready.ok) {
      const errors = ready.prd.errors.map((error) => error.message).join(' ');
      return this.fireFailed(task, now, `The generated PRD did not parse: ${errors}`, run.id);
    }

    // Written before the build is asked for, so a crash between the two leaves
    // a run that is visible in the history rather than one nothing knows about.
    const occurrence = this.record(task, now, 'started', null, run.id);

    try {
      await this.builds.start(run.id);
    } catch (cause) {
      // A start refused for want of a slot — or by the usage-limit hold, which
      // does the same thing — has queued the session, and the queue is what
      // starts it. Anything else really did fail to fire.
      const current = getSession(this.db, run.id);
      if (current === null || current.queuedAt === null) {
        const reason = `The build of "${run.name}" could not be started: ${describe(cause)}`;
        this.settleAs(occurrence, 'fire-failed', reason);
        logger.warn('recurring task run could not be built', {
          task: task.id,
          session: run.id,
          error: describe(cause),
        });
        return false;
      }
    }

    logger.info('recurring task fired', { task: task.id, session: run.id, run: run.name });
    return true;
  }

  /**
   * Why this occurrence must not fire, or null when it may.
   *
   * A database that cannot be read is not an answer either way, and refusing
   * to run a task because of it would quietly stop the schedule; the task is
   * fired, exactly as it would be with no previous run at all.
   */
  private skipReason(task: RecurringTask): string | null {
    try {
      const previous = latestRecurringTaskRunSession(this.db, task.id);
      const occurrence =
        previous === null ? null : recurringTaskOccurrenceForSession(this.db, previous.id);
      return skipReasonFor(previous, occurrence?.outcome ?? null);
    } catch (cause) {
      logger.warn('could not read the previous run of a recurring task', {
        task: task.id,
        error: describe(cause),
      });
      return null;
    }
  }

  /**
   * Records an occurrence that never became a run.
   *
   * There is no session to point at — the whole point is that the previous
   * one is still the current one — so the run that is in the way is named in
   * the reason instead, which is what the task's history shows.
   */
  private skipped(task: RecurringTask, now: string, reason: string): boolean {
    logger.info('recurring task occurrence skipped', {
      task: task.id,
      name: task.name,
      reason,
    });
    this.record(task, now, 'skipped', reason, null);
    return false;
  }

  /**
   * Moves `next_run_at` on before anything else happens, and says whether the
   * task may fire at all. An expression that stopped naming a next occurrence
   * leaves the task unscheduled with the reason in its history, rather than
   * due at every tick for the rest of the day.
   */
  private reschedule(task: RecurringTask, firedAt: Date): boolean {
    const next = nextCronRun(task.cronExpression, firedAt);
    updateRecurringTask(this.db, task.id, {
      nextRunAt: next === null ? null : next.toISOString(),
    });
    if (next !== null) return true;

    this.fireFailed(
      task,
      firedAt.toISOString(),
      `"${task.cronExpression}" no longer names a next occurrence, so this task was left unscheduled. Fix its schedule to start it again.`,
      null,
    );
    return false;
  }

  private fireFailed(
    task: RecurringTask,
    now: string,
    reason: string,
    sessionId: string | null,
  ): boolean {
    logger.warn('recurring task could not be fired', {
      task: task.id,
      name: task.name,
      session: sessionId,
      error: reason,
    });
    this.record(task, now, 'fire-failed', reason, sessionId);
    return false;
  }

  private record(
    task: RecurringTask,
    occurredAt: string,
    outcome: RecurringTaskOutcome,
    detail: string | null,
    sessionId: string | null,
  ): RecurringTaskOccurrence | null {
    try {
      return recordRecurringTaskOccurrence(this.db, {
        recurringTaskId: task.id,
        occurredAt,
        outcome,
        detail,
        sessionId,
      });
    } catch (cause) {
      // The history is the record of what happened, not what makes it happen;
      // a row that cannot be written must not take the run down with it.
      logger.warn('could not record a recurring task occurrence', {
        task: task.id,
        outcome,
        error: describe(cause),
      });
      return null;
    }
  }

  private settleAs(
    occurrence: RecurringTaskOccurrence | null,
    outcome: RecurringTaskOutcome,
    detail: string,
  ): void {
    if (occurrence === null) return;
    try {
      updateRecurringTaskOccurrence(this.db, occurrence.id, { outcome, detail });
    } catch (cause) {
      logger.warn('could not update a recurring task occurrence', {
        occurrence: occurrence.id,
        error: describe(cause),
      });
    }
  }
}

/**
 * What a run's session says became of it, or `null` while it is still going.
 *
 * `reviewing` and `fixing` are deliberately not settled: the pull request
 * exists, but the delivery is still working on it, and an occurrence that
 * already read `pull request opened` would stop the history following the run
 * to its actual end.
 */
export function settlementOf(
  session: Session | null,
): { outcome: RecurringTaskOutcome; detail: string } | null {
  if (session === null) {
    return { outcome: 'failed', detail: 'The run’s session was deleted before it finished.' };
  }
  switch (session.status) {
    case 'failed':
      return { outcome: 'failed', detail: session.lastError ?? 'The run failed.' };
    case 'finished':
    case 'pr-open':
    case 'merged':
      return session.prUrl === null
        ? { outcome: 'clean', detail: 'The run finished without opening a pull request.' }
        : { outcome: 'pr-opened', detail: session.prUrl };
    default:
      return null;
  }
}

/**
 * The statuses a run has not reached an outcome in yet (US-005).
 *
 * A task whose runs take longer than the gap between its occurrences would
 * otherwise stack sessions on top of each other — an hourly task with
 * two-hour runs ending up with two containers, two clones and two branches of
 * the same work in flight. `waiting` is in here because a run held by Claude's
 * usage limit has kept its container and its slot: it is paused, not over.
 */
const RUN_IN_PROGRESS = [
  'pending',
  'ready',
  'building',
  'waiting',
] as const satisfies readonly SessionStatus[];

/**
 * Why the task's next occurrence must not fire, or null when nothing is in
 * the way. `session` is the task's most recent run, or null if it has none,
 * and `outcome` is what its occurrence recorded of the firing that made it.
 *
 * Only two things hold an occurrence back, and both are read off that one
 * session: a run that is still going, and a run whose pull request nobody has
 * merged or closed yet. Everything else — a failed run, a merged or closed
 * pull request, a run that changed nothing, a run somebody deleted, a run
 * whose firing failed, a task that has never run — lets the occurrence
 * through.
 */
export function skipReasonFor(
  session: Session | null,
  outcome: RecurringTaskOutcome | null = null,
): string | null {
  if (session === null) return null;
  if (wasAbandonedByAFailedFiring(session, outcome)) return null;

  const phrase = inProgressPhrase(session);
  if (phrase !== null) return `The previous run “${session.name}” is ${phrase}.`;

  if (hasOpenPullRequest(session)) {
    const number = session.prUrl === null ? null : pullRequestNumberOf(session.prUrl);
    const pr = number === null ? 'The pull request' : `PR #${number}`;
    return `${pr} from the previous run “${session.name}” is still open.`;
  }

  return null;
}

/**
 * Whether this run is the wreckage of a firing that failed, rather than a run
 * anything is still going to move.
 *
 * A `fire-failed` occurrence can leave a session behind — `pending` with the
 * clone error on it, or `ready` and never queued when the build was refused —
 * and nothing ever picks it up again: setup is not retried by the scheduler,
 * and `settle()` only follows the runs that started. Read as an ordinary
 * unfinished run it would answer “still being set up” to every occurrence from
 * then on, so one 3am network blip would stop a nightly task for good. It is
 * therefore not in the way: the next occurrence fires, and the failed session
 * is left exactly where it is for whoever wants to retry or delete it.
 *
 * The session's own state still has the last word. If somebody retried the
 * setup and the run is building or queued now, it is a run like any other and
 * the next occurrence waits for it.
 */
function wasAbandonedByAFailedFiring(
  session: Session,
  outcome: RecurringTaskOutcome | null,
): boolean {
  if (outcome !== 'fire-failed') return false;
  return session.status === 'pending' || (session.status === 'ready' && session.queuedAt === null);
}

/** How a run that has not finished is described, or null once it has. */
function inProgressPhrase(session: Session): string | null {
  if (!(RUN_IN_PROGRESS as readonly SessionStatus[]).includes(session.status)) return null;
  switch (session.status) {
    case 'pending':
      return 'still being set up';
    case 'ready':
      return session.queuedAt === null ? 'still waiting to be built' : 'still queued for a slot';
    case 'waiting':
      return 'still held by Claude’s usage limit';
    default:
      return 'still building';
  }
}

export function createRecurringTaskRunner(
  config: Config,
  db: Database,
  sessions: () => RecurringTaskSessions | null,
  builds: RecurringTaskBuilds,
): RecurringTaskRunner {
  return new RecurringTaskRunner(config, db, sessions, builds);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
