import { type Database, integer, type Row, text } from './sqlite.js';
import { SESSION_STATUSES, type SessionStatus } from './sessions.js';

/**
 * The numbers behind the overview page: what the server is doing right now and
 * what it has done lately. Every query here is an aggregate over a handful of
 * indexed rows, so the page can poll it as freely as it polls the session list.
 */

/** Stories done, sessions finished and sessions created on one calendar day (UTC). */
export interface DayActivity {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  readonly storiesDone: number;
  readonly sessionsFinished: number;
  readonly sessionsCreated: number;
}

export interface RepositoryStats {
  readonly repositoryId: string;
  readonly name: string;
  readonly sessions: number;
  readonly storiesDone: number;
  readonly storiesTotal: number;
  readonly finished: number;
  readonly failed: number;
  readonly active: number;
}

export interface Stats {
  readonly sessions: {
    readonly total: number;
    readonly byStatus: Record<SessionStatus, number>;
  };
  readonly stories: {
    readonly total: number;
    readonly done: number;
    readonly inProgress: number;
    readonly todo: number;
  };
  readonly prRuns: {
    readonly total: number;
    readonly running: number;
    readonly finished: number;
    readonly failed: number;
  };
  /** Sessions that opened a pull request, all time. */
  readonly pullRequestsOpened: number;
  /** Oldest to newest, one entry per day, `days` long. */
  readonly activity: readonly DayActivity[];
  readonly repositories: readonly RepositoryStats[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Counts rows grouped by the first `length` characters of a timestamp column. */
function countByDay(
  db: Database,
  sql: string,
  since: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db.prepare(sql).all(since) as Row[]) {
    counts.set(text(row, 'day'), integer(row, 'n'));
  }
  return counts;
}

export function readStats(db: Database, days = 14, now: Date = new Date()): Stats {
  const byStatus = Object.fromEntries(
    SESSION_STATUSES.map((status) => [status, 0]),
  ) as Record<SessionStatus, number>;
  let total = 0;
  for (const row of db
    .prepare('SELECT status, COUNT(*) AS n FROM sessions GROUP BY status')
    .all() as Row[]) {
    const status = text(row, 'status') as SessionStatus;
    const n = integer(row, 'n');
    if (status in byStatus) byStatus[status] = n;
    total += n;
  }

  const storyRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status = 'in-progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN status = 'todo' THEN 1 ELSE 0 END) AS todo
       FROM stories`,
    )
    .get() as Row;

  const prRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'finished' THEN 1 ELSE 0 END) AS finished,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM pr_runs`,
    )
    .get() as Row;

  const prOpened = db
    .prepare('SELECT COUNT(*) AS n FROM sessions WHERE pr_url IS NOT NULL')
    .get() as Row;

  // Activity window: `days` calendar days ending today, in UTC. A story's
  // `updated_at` is the moment its status last changed, which for a done
  // story is when the loop marked it done.
  const start = new Date(now.getTime() - (days - 1) * DAY_MS);
  const since = `${dayOf(start)}T00:00:00.000Z`;
  const storiesDone = countByDay(
    db,
    `SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS n
       FROM stories WHERE status = 'done' AND updated_at >= ? GROUP BY day`,
    since,
  );
  const finished = countByDay(
    db,
    `SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS n
       FROM sessions WHERE status = 'finished' AND updated_at >= ? GROUP BY day`,
    since,
  );
  const created = countByDay(
    db,
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
       FROM sessions WHERE created_at >= ? GROUP BY day`,
    since,
  );
  const activity: DayActivity[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = dayOf(new Date(start.getTime() + i * DAY_MS));
    activity.push({
      day,
      storiesDone: storiesDone.get(day) ?? 0,
      sessionsFinished: finished.get(day) ?? 0,
      sessionsCreated: created.get(day) ?? 0,
    });
  }

  const repositories = (
    db
      .prepare(
        `SELECT
           r.id AS id,
           r.name AS name,
           COUNT(DISTINCT s.id) AS sessions,
           SUM(CASE WHEN s.status = 'finished' THEN 1 ELSE 0 END) AS finished,
           SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN s.status IN ('building', 'waiting') THEN 1 ELSE 0 END) AS active,
           (SELECT COUNT(*) FROM stories st JOIN sessions ss ON ss.id = st.session_id
              WHERE ss.repository_id = r.id AND st.status = 'done') AS stories_done,
           (SELECT COUNT(*) FROM stories st JOIN sessions ss ON ss.id = st.session_id
              WHERE ss.repository_id = r.id) AS stories_total
         FROM repositories r
         LEFT JOIN sessions s ON s.repository_id = r.id
         GROUP BY r.id
         ORDER BY r.name COLLATE NOCASE`,
      )
      .all() as Row[]
  ).map((row) => ({
    repositoryId: text(row, 'id'),
    name: text(row, 'name'),
    sessions: integer(row, 'sessions'),
    storiesDone: integer(row, 'stories_done'),
    storiesTotal: integer(row, 'stories_total'),
    // SUM over no rows is NULL.
    finished: nullableCount(row, 'finished'),
    failed: nullableCount(row, 'failed'),
    active: nullableCount(row, 'active'),
  }));

  return {
    sessions: { total, byStatus },
    stories: {
      total: integer(storyRow, 'total'),
      done: nullableCount(storyRow, 'done'),
      inProgress: nullableCount(storyRow, 'in_progress'),
      todo: nullableCount(storyRow, 'todo'),
    },
    prRuns: {
      total: integer(prRow, 'total'),
      running: nullableCount(prRow, 'running'),
      finished: nullableCount(prRow, 'finished'),
      failed: nullableCount(prRow, 'failed'),
    },
    pullRequestsOpened: integer(prOpened, 'n'),
    activity,
    repositories,
  };
}

function nullableCount(row: Row, column: string): number {
  const value = row[column];
  if (value === null || value === undefined) return 0;
  return integer(row, column);
}
