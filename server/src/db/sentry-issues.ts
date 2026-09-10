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
 * `pending` → fetched, awaiting classification. `planned` → judged fixable
 * and carrying a proposed fix plan, awaiting the operator's decision.
 * `approved` → the operator said yes, awaiting a session someone asks for.
 * `working` → a session is building the fix. `fixed` → that session's pull
 * request was merged. `cannot_fix` → the classifier said no, the operator
 * rejected the plan, or the fix never landed; always with an explanation.
 */
export const SENTRY_ISSUE_STATUSES = [
  'pending',
  'planned',
  'approved',
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
  /** The proposed fix plan the operator judges; NULL until one is written. */
  readonly plan: string | null;
  /** When the classifier wrote {@link plan}; NULL while there is none. */
  readonly planProposedAt: string | null;
  /** When the operator approved or rejected that plan; NULL while undecided. */
  readonly planDecidedAt: string | null;
  /** The build session working on the fix; NULL once that session is deleted. */
  readonly sessionId: string | null;
  /**
   * Whether Sentry is owed a resolve call for this issue. Set when the fix
   * lands and when an operator rejects the plan, and deliberately separate
   * from *why* it is owed, so the resolve pass never has to read `status`.
   */
  readonly resolveUpstream: boolean;
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
  readonly plan?: string | null;
  readonly planProposedAt?: string | null;
  readonly planDecidedAt?: string | null;
  readonly sessionId?: string | null;
  readonly resolveUpstream?: boolean;
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
  plan: 'plan',
  planProposedAt: 'plan_proposed_at',
  planDecidedAt: 'plan_decided_at',
  sessionId: 'session_id',
  resolveUpstream: 'resolve_upstream',
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
    plan: nullableText(row, 'plan'),
    planProposedAt: nullableText(row, 'plan_proposed_at'),
    planDecidedAt: nullableText(row, 'plan_decided_at'),
    sessionId: nullableText(row, 'session_id'),
    resolveUpstream: integer(row, 'resolve_upstream') !== 0,
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
    plan: null,
    planProposedAt: null,
    planDecidedAt: null,
    sessionId: null,
    resolveUpstream: false,
    resolvedInSentry: false,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO sentry_issues
       (id, repository_id, sentry_issue_id, short_id, title, culprit, permalink, level,
        event_count, first_seen, last_seen, status, explanation, plan, plan_proposed_at,
        plan_decided_at, session_id, resolve_upstream, resolved_in_sentry, attempts,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    issue.plan,
    issue.planProposedAt,
    issue.planDecidedAt,
    issue.sessionId,
    issue.resolveUpstream ? 1 : 0,
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
 * The issues Sentry is owed a resolve call for, oldest first (US-008).
 *
 * Two flags rather than a status: `resolve_upstream` records that the call is
 * owed -- the fix landed, or the operator rejected the plan -- and
 * `resolved_in_sentry` records that it has been made. Neither is a status,
 * because the local decision stands whatever Sentry says: a resolve call that
 * failed leaves the issue where it is and merely keeps it on this list until a
 * later tick gets through.
 */
export function listSentryIssuesAwaitingResolve(db: Database): SentryIssue[] {
  return db
    .prepare(
      'SELECT * FROM sentry_issues WHERE resolve_upstream = 1 AND resolved_in_sentry = 0 ' +
        'ORDER BY created_at ASC',
    )
    .all()
    .map(mapSentryIssue);
}
