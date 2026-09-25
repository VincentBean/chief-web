import { Router } from 'express';

import type { BuildPoolView, BuildSlotUse, QueuedBuildView } from '../build/index.js';
import { type Database, readStats, type Stats, sumVoiceUsageSince } from '../db/index.js';
import { type HostLoad, readHostLoad } from '../lib/host.js';
import type { UsageLimitHold } from '../limits/index.js';
import { getVoiceScribeCreditsPerMin, getVoiceSettings } from '../settings/index.js';

/**
 * The build pool, as the overview page needs it (US-006).
 *
 * Narrow on purpose: the route asks the one thing that owns the cap for its
 * own accounting rather than counting rows again here, which is what makes the
 * meter and the cap the same number instead of two numbers that agree until
 * someone adds a fourth kind of agent.
 */
export interface StatsBuilds {
  pool(): BuildPoolView;
}

/** Everything the overview page shows in one answer. */
export interface StatsView extends Stats {
  readonly generatedAt: string;
  readonly builds: {
    /** Build slots in use: exactly what `freeSlots()` subtracts (US-006). */
    readonly active: number;
    /** Everything waiting in the unified FIFO build queue (US-001). */
    readonly queued: number;
    readonly max: number;
    /** `max - active`; negative when the cap was lowered under running work. */
    readonly free: number;
    /** What is holding each slot, one entry per slot in use. */
    readonly slots: readonly BuildSlotUse[];
    /** The unified queue in FIFO order, with each entry's position. */
    readonly queue: readonly QueuedBuildView[];
  };
  /** Claude's usage-limit hold, if one is in force. */
  readonly hold: { readonly until: string | null };
  /** CPU and memory of the machine chief-web runs on. */
  readonly host: HostLoad;
  /** Voice calls this calendar month (UTC), for the "Voice this month" figure (voice US-023). */
  readonly voice: VoiceMonthView;
}

export interface VoiceMonthView {
  readonly enabled: boolean;
  readonly calls: number;
  readonly minutes: number;
  /** The voice's characters, plus Scribe at its measured rate once there is one. */
  readonly elCredits: number;
  readonly orCostUsd: number;
}

/** The month's voice usage; Claude turns are left out on purpose (they cost no credits). */
export function readVoiceMonth(db: Database, now: Date): VoiceMonthView {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const sum = sumVoiceUsageSince(db, since, now.toISOString());
  const scribeRate = getVoiceScribeCreditsPerMin(db) ?? 0;
  return {
    enabled: getVoiceSettings(db).enabled,
    calls: sum.calls,
    minutes: sum.minutes,
    elCredits: Math.round(sum.elChars + (sum.scribeSeconds / 60) * scribeRate),
    orCostUsd: sum.orCostUsd,
  };
}

/**
 * `GET /stats`: the overview page's numbers.
 *
 * Polled like the session list. Every part of it is a small aggregate over the
 * database — nothing here asks Docker or GitHub — so a page re-reading it every
 * few seconds costs about what the session list does.
 */
export function createStatsRouter(
  db: Database,
  hold: UsageLimitHold,
  builds: StatsBuilds,
): Router {
  const router = Router();

  router.get('/stats', (req, res) => {
    const raw = req.query['days'];
    const days = typeof raw === 'string' ? Number.parseInt(raw, 10) : 14;
    const stats = readStats(db, Number.isInteger(days) ? Math.min(90, Math.max(1, days)) : 14);
    const pool = builds.pool();
    const view: StatsView = {
      ...stats,
      generatedAt: new Date().toISOString(),
      builds: {
        active: pool.active,
        queued: pool.queued,
        max: pool.max,
        free: pool.free,
        slots: pool.slots,
        queue: pool.queue,
      },
      hold: { until: hold.until() },
      host: readHostLoad(),
      voice: readVoiceMonth(db, new Date()),
    };
    res.status(200).json(view);
  });

  return router;
}
