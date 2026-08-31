import type { Config } from '../config.js';
import {
  type Database,
  getSession,
  listDueScheduledSessions,
  nowIso,
  type Session,
  updateSession,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { UsageLimitHold } from '../limits/index.js';

/**
 * Scheduled session starts (US-017).
 *
 * A schedule is a column, not a timer: `sessions.scheduled_start_at` is the
 * whole of it, and this service is only the thing that keeps looking at it.
 * That is what makes it survive a restart — the catch-up on boot is the same
 * query as every other tick, with no notion of "while we were down" — and it
 * is why a schedule can be changed from the API without anything here having
 * to be told.
 *
 * Schedules are one-shot. The timestamp is spent the moment its session enters
 * `building` — or the build queue (US-018), which is the same promise honoured
 * as far as the cap allows — so a build that is later stopped or fails can
 * never be restarted by a leftover schedule; and a fire that could not be
 * honoured clears it too, with the reason on the session, rather than retrying
 * it every interval for the rest of the day.
 *
 * The same tick drives that queue, for the same reason: `queued_at` is a
 * column, so the sessions waiting for a slot when the stack went down are
 * simply waiting for one now.
 */

/** The slice of the build loop (US-013) the scheduler drives. */
export interface ScheduledBuilds {
  start(sessionId: string): Promise<unknown>;
  /**
   * Resumes the sessions parked on Claude's usage limit whose hold has run out
   * (US-006). The tick is already the thing watching the clock, so it is what
   * notices the hour is up; the build service decides what fits under the cap.
   */
  resumeHeld(now?: string): Promise<unknown>;
  /**
   * Gives any free build slot to the head of the FIFO queue (US-018). The
   * queue is a column too, so the same tick that catches up on schedules is
   * what picks it up again after a restart.
   */
  pump(): Promise<unknown>;
}

/** What a scheduler offers its callers; `SchedulerService` is the real one. */
export interface SessionScheduler {
  /** Catches up on anything already due, then polls. Idempotent. */
  start(): void;
  stop(): void;
  /** One pass: starts every `ready` session that is due. Returns how many. */
  tick(now?: string): Promise<number>;
  /** Starts one session's due schedule now; false when it has none. */
  fire(sessionId: string): Promise<boolean>;
}

export class SchedulerService implements SessionScheduler {
  private timer: NodeJS.Timeout | null = null;
  /** The tick in flight, if any: a fire starts a container and can outlast the interval. */
  private ticking: Promise<number> | null = null;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly builds: ScheduledBuilds,
    /** The global usage-limit hold (US-002), read before anything is fired. */
    private readonly hold: UsageLimitHold = new UsageLimitHold(db),
  ) {}

  start(): void {
    if (this.timer !== null) return;
    // Anything whose moment passed while the stack was down is simply due now.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.schedulerIntervalMs);
    // The HTTP listener is what keeps the process alive; the scheduler must
    // never be the reason it does.
    this.timer.unref();
    logger.info('session scheduler started', { intervalMs: this.config.schedulerIntervalMs });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick(now: string = nowIso()): Promise<number> {
    const inFlight = this.ticking;
    if (inFlight !== null) return inFlight;

    const run = this.runTick(now).finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }

  async fire(sessionId: string): Promise<boolean> {
    const session = getSession(this.db, sessionId);
    if (session === null || session.status !== 'ready') return false;
    if (session.scheduledStartAt === null || session.scheduledStartAt > nowIso()) return false;
    return this.startSession(session);
  }

  private async runTick(now: string): Promise<number> {
    // Held sessions first (US-006). They are mid-story and never gave their
    // build slots back, so resuming them cannot take a slot from a schedule —
    // whereas a schedule fired first could take one from them.
    try {
      await this.builds.resumeHeld(now);
    } catch (cause) {
      logger.warn('could not resume the builds held by Claude’s usage limit', {
        error: describe(cause),
      });
    }

    let due: Session[];
    try {
      due = listDueScheduledSessions(this.db, now);
    } catch (cause) {
      // A database that cannot be read is not evidence that nothing is due;
      // the next tick asks again.
      logger.warn('could not read scheduled sessions', { error: describe(cause) });
      return 0;
    }

    let started = 0;
    for (const session of due) {
      if (await this.startSession(session)) started += 1;
    }

    // Whatever did not fit under the concurrency cap is queued rather than
    // started (US-018); this is also the heartbeat that gets the queue moving
    // again after a restart, when no run of this process ever ended to free a
    // slot.
    try {
      await this.builds.pump();
    } catch (cause) {
      logger.warn('could not start the next queued build', { error: describe(cause) });
    }
    return started;
  }

  private async startSession(session: Session): Promise<boolean> {
    // Claude's usage limit is on the account, so a start now would be refused
    // within seconds and the schedule would be spent on that refusal (US-005).
    // Left where it is, the timestamp is simply still due when the hold lifts,
    // and the very next tick honours it — which is the same catch-up this
    // service already does after a restart.
    const until = this.hold.until();
    if (until !== null) {
      logger.info('scheduled start held by Claude’s usage limit', {
        session: session.id,
        name: session.name,
        scheduledStartAt: session.scheduledStartAt,
        until,
      });
      return false;
    }

    logger.info('scheduled start firing', {
      session: session.id,
      name: session.name,
      scheduledStartAt: session.scheduledStartAt,
    });

    try {
      await this.builds.start(session.id);
      return true;
    } catch (cause) {
      const reason = describe(cause);
      updateSession(this.db, session.id, {
        scheduledStartAt: null,
        lastError:
          `The build scheduled for ${session.scheduledStartAt ?? 'now'} could not be started, ` +
          `so the schedule was cleared: ${reason}`,
      });
      logger.warn('scheduled start failed', {
        session: session.id,
        name: session.name,
        error: reason,
      });
      return false;
    }
  }
}

export function createScheduler(
  config: Config,
  db: Database,
  builds: ScheduledBuilds,
  hold: UsageLimitHold = new UsageLimitHold(db),
): SchedulerService {
  return new SchedulerService(config, db, builds, hold);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
