import { randomUUID } from 'node:crypto';

import {
  changeCount,
  type Database,
  enumeration,
  integer,
  nowIso,
  nullableText,
  type Row,
  text,
} from './sqlite.js';

/**
 * Sentry issues chief-web is tracking, and how far each one got (US-001).
 *
 * One durable row per Sentry issue rather than one per attempt: the poller
 * sees the same issue on every tick, and the classifier, the session and the
 * merge watcher all hang off the same row, so re-seeing an issue resumes where
 * the last tick left off instead of starting over.
 */

/**
 * `pending` → fetched, awaiting classification. `queued` → judged fixable,
 * awaiting session creation. `working` → a session is building the fix.
 * `fixed` → that session's pull request was merged. `cannot_fix` → the
 * classifier said no, or the fix never landed; always with an explanation.
 */
export const SENTRY_ISSUE_STATUSES = [
  'pending',
  'queued',
  'working',
  'fixed',
  'cannot_fix',
] as const;
export type SentryIssueStatus = (typeof SENTRY_ISSUE_STATUSES)[number];

export interface SentryIssue {
  readonly id: string;
  readonly repositoryId: string;
  /** Sentry's own issue id, as a string; the poller's dedupe key. */
  readonly sentryIssueId: string;
  /** The human-facing `PROJECT-1AB` id; what session names derive from. */
  readonly shortId: string;
  readonly title: string;
  readonly culprit: string | null;
  readonly permalink: string;
  readonly level: string | null;
  readonly eventCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly status: SentryIssueStatus;
  /** Why the issue is `cannot_fix`, in the operator's words. */
  readonly explanation: string | null;
  /** The build session working on the fix; NULL once that session is deleted. */
  readonly sessionId: string | null;
  /** Whether the "resolve it upstream" call has succeeded yet. */
  readonly resolvedInSentry: boolean;
  /** Failed tries at the issue's current phase; at three it goes `cannot_fix`. */
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSentryIssueInput {
  readonly repositoryId: string;
  readonly sentryIssueId: string;
  readonly shortId: string;
  readonly title: string;
  readonly culprit?: string | null;
  readonly permalink: string;
  readonly level?: string | null;
  readonly eventCount?: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface UpdateSentryIssueInput {
  readonly shortId?: string;
  readonly title?: string;
  readonly culprit?: string | null;
  readonly permalink?: string;
  readonly level?: string | null;
  readonly eventCount?: number;
  readonly lastSeen?: string;
  readonly status?: SentryIssueStatus;
  readonly explanation?: string | null;
  readonly sessionId?: string | null;
  readonly resolvedInSentry?: boolean;
  readonly attempts?: number;
}

const COLUMNS: Record<keyof UpdateSentryIssueInput, string> = {
  shortId: 'short_id',
  title: 'title',
  culprit: 'culprit',
  permalink: 'permalink',
  level: 'level',
  eventCount: 'event_count',
  lastSeen: 'last_seen',
  status: 'status',
  explanation: 'explanation',
  sessionId: 'session_id',
  resolvedInSentry: 'resolved_in_sentry',
  attempts: 'attempts',
};

export function mapSentryIssue(row: Row): SentryIssue {
  return {
    id: text(row, 'id'),
    repositoryId: text(row, 'repository_id'),
    sentryIssueId: text(row, 'sentry_issue_id'),
    shortId: text(row, 'short_id'),
    title: text(row, 'title'),
    culprit: nullableText(row, 'culprit'),
    permalink: text(row, 'permalink'),
    level: nullableText(row, 'level'),
    eventCount: integer(row, 'event_count'),
    firstSeen: text(row, 'first_seen'),
    lastSeen: text(row, 'last_seen'),
    status: enumeration(row, 'status', SENTRY_ISSUE_STATUSES),
    explanation: nullableText(row, 'explanation'),
    sessionId: nullableText(row, 'session_id'),
    resolvedInSentry: integer(row, 'resolved_in_sentry') !== 0,
    attempts: integer(row, 'attempts'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

/**
 * Records the issue, or refreshes the row Sentry already has here.
 *
 * A refresh deliberately touches only what the last poll saw — the counts, the
 * timestamps and the title Sentry may have re-grouped — and never `status`,
 * `explanation`, `session_id` or `attempts`: an issue that is already being
 * fixed must not fall back to `pending` because it fired one more event.
 */
export function createSentryIssue(db: Database, input: CreateSentryIssueInput): SentryIssue {
  const existing = findSentryIssue(db, input.sentryIssueId);
  if (existing !== null) {
    return (
      updateSentryIssue(db, existing.id, {
        shortId: input.shortId,
        title: input.title,
        culprit: input.culprit ?? null,
        permalink: input.permalink,
        level: input.level ?? null,
        eventCount: input.eventCount ?? existing.eventCount,
        lastSeen: input.lastSeen,
      }) ?? existing
    );
  }

  const now = nowIso();
  const issue: SentryIssue = {
    id: randomUUID(),
    repositoryId: input.repositoryId,
    sentryIssueId: input.sentryIssueId,
    shortId: input.shortId,
    title: input.title,
    culprit: input.culprit ?? null,
    permalink: input.permalink,
    level: input.level ?? null,
    eventCount: input.eventCount ?? 0,
    firstSeen: input.firstSeen,
    lastSeen: input.lastSeen,
    status: 'pending',
    explanation: null,
    sessionId: null,
    resolvedInSentry: false,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO sentry_issues
       (id, repository_id, sentry_issue_id, short_id, title, culprit, permalink, level,
        event_count, first_seen, last_seen, status, explanation, session_id,
        resolved_in_sentry, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    issue.id,
    issue.repositoryId,
    issue.sentryIssueId,
    issue.shortId,
    issue.title,
    issue.culprit,
    issue.permalink,
    issue.level,
    issue.eventCount,
    issue.firstSeen,
    issue.lastSeen,
    issue.status,
    issue.explanation,
    issue.sessionId,
    issue.resolvedInSentry ? 1 : 0,
    issue.attempts,
    issue.createdAt,
    issue.updatedAt,
  );

  return issue;
}

export function getSentryIssue(db: Database, id: string): SentryIssue | null {
  const row = db.prepare('SELECT * FROM sentry_issues WHERE id = ?').get(id);
  return row ? mapSentryIssue(row) : null;
}

/** Looks the issue up by Sentry's id — what the poller dedupes on. */
export function findSentryIssue(db: Database, sentryIssueId: string): SentryIssue | null {
  const row = db.prepare('SELECT * FROM sentry_issues WHERE sentry_issue_id = ?').get(sentryIssueId);
  return row ? mapSentryIssue(row) : null;
}

/** The issue a session is fixing, if that session came from Sentry at all. */
export function findSentryIssueBySession(db: Database, sessionId: string): SentryIssue | null {
  const row = db.prepare('SELECT * FROM sentry_issues WHERE session_id = ?').get(sessionId);
  return row ? mapSentryIssue(row) : null;
}

/** Newest activity first: the order the Sentry tab lists issues in. */
export function listSentryIssues(db: Database): SentryIssue[] {
  return db.prepare('SELECT * FROM sentry_issues ORDER BY last_seen DESC').all().map(mapSentryIssue);
}

export function listSentryIssuesForRepository(db: Database, repositoryId: string): SentryIssue[] {
  return db
    .prepare('SELECT * FROM sentry_issues WHERE repository_id = ? ORDER BY last_seen DESC')
    .all(repositoryId)
    .map(mapSentryIssue);
}

/**
 * Issues waiting in one phase, oldest first — the order the classifier and the
 * session creator work through their per-tick budget in.
 */
export function listSentryIssuesByStatus(db: Database, status: SentryIssueStatus): SentryIssue[] {
  return db
    .prepare('SELECT * FROM sentry_issues WHERE status = ? ORDER BY created_at ASC')
    .all(status)
    .map(mapSentryIssue);
}

export function updateSentryIssue(
  db: Database,
  id: string,
  input: UpdateSentryIssueInput,
): SentryIssue | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = input[key as keyof UpdateSentryIssueInput];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    // SQLite has no boolean type; the flag columns are stored as 0/1.
    values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (assignments.length === 0) return getSentryIssue(db, id);

  assignments.push('updated_at = ?');
  values.push(nowIso(), id);

  const result = db
    .prepare(`UPDATE sentry_issues SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return changeCount(result) === 0 ? null : getSentryIssue(db, id);
}

export function deleteSentryIssue(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM sentry_issues WHERE id = ?').run(id)) > 0;
}

/**
 * The `fixed` issues Sentry has not been told about yet, oldest first (US-008).
 *
 * `resolved_in_sentry` is deliberately a flag rather than a status: the fix
 * landed whatever Sentry says, so a resolve call that failed must leave the
 * issue `fixed` and merely stay on this list until a later tick gets through.
 */
export function listSentryIssuesAwaitingResolve(db: Database): SentryIssue[] {
  return db
    .prepare(
      "SELECT * FROM sentry_issues WHERE status = 'fixed' AND resolved_in_sentry = 0 " +
        'ORDER BY created_at ASC',
    )
    .all()
    .map(mapSentryIssue);
}
