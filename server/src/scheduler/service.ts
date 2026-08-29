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
 * `building` (see `BuildService.start`), so a build that is later stopped or
 * fails can never be restarted by a leftover schedule; and a fire that could
 * not be honoured clears it too, with the reason on the session, rather than
 * retrying it every interval for the rest of the day.
 */

/** The slice of the build loop (US-013) the scheduler drives. */
export interface ScheduledBuilds {
  start(sessionId: string): Promise<unknown>;
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
    return started;
  }

  private async startSession(session: Session): Promise<boolean> {
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
): SchedulerService {
  return new SchedulerService(config, db, builds);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
