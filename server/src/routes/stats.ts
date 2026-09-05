import { Router } from 'express';

import type { Config } from '../config.js';
import { type Database, readStats, type Stats } from '../db/index.js';
import { type HostLoad, readHostLoad } from '../lib/host.js';
import type { UsageLimitHold } from '../limits/index.js';
import { getMaxConcurrentSessions } from '../settings/index.js';

/** Everything the overview page shows in one answer. */
export interface StatsView extends Stats {
  readonly generatedAt: string;
  readonly builds: {
    /** Sessions holding a build slot: building, or held by the usage limit. */
    readonly active: number;
    /** Sessions waiting in the FIFO build queue. */
    readonly queued: number;
    readonly max: number;
  };
  /** Claude's usage-limit hold, if one is in force. */
  readonly hold: { readonly until: string | null };
  /** CPU and memory of the machine chief-web runs on. */
  readonly host: HostLoad;
}

/**
 * `GET /stats`: the overview page's numbers.
 *
 * Polled like the session list. Every part of it is a small aggregate over the
 * database — nothing here asks Docker or GitHub — so a page re-reading it every
 * few seconds costs about what the session list does.
 */
export function createStatsRouter(db: Database, config: Config, hold: UsageLimitHold): Router {
  const router = Router();

  router.get('/stats', (req, res) => {
    const raw = req.query['days'];
    const days = typeof raw === 'string' ? Number.parseInt(raw, 10) : 14;
    const stats = readStats(db, Number.isInteger(days) ? Math.min(90, Math.max(1, days)) : 14);
    const queued = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE queued_at IS NOT NULL').get() as {
      n: number | bigint;
    };
    const view: StatsView = {
      ...stats,
      generatedAt: new Date().toISOString(),
      builds: {
        active: stats.sessions.byStatus.building + stats.sessions.byStatus.waiting,
        queued: Number(queued.n),
        max: getMaxConcurrentSessions(db, config),
      },
      hold: { until: hold.until() },
      host: readHostLoad(),
    };
    res.status(200).json(view);
  });

  return router;
}
