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
 * `duplicate` → classified as the same underlying defect as another issue that
 * is already being worked on; no session of its own.
 */
export const SENTRY_ISSUE_STATUSES = [
  'pending',
  'queued',
  'working',
  'fixed',
  'cannot_fix',
  'duplicate',
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
  /** The issue this one duplicates, once it is classified `duplicate` (US-002). */
  readonly duplicateOf: string | null;
  /** The classifier's normalised fingerprint of the defect, used for matching. */
  readonly signature: string | null;
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
  readonly duplicateOf?: string | null;
  readonly signature?: string | null;
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
  duplicateOf: 'duplicate_of',
  signature: 'signature',
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
    duplicateOf: nullableText(row, 'duplicate_of'),
    signature: nullableText(row, 'signature'),
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
 * fixed must not fall back to `pending` because it fired one more event. The
 * same holds for `duplicate_of` and `signature`: a classification is about the
 * defect, and survives every later poll of the issue it was made about.
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
    duplicateOf: null,
    signature: null,
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

/**
 * How far back a `fixed` issue still counts as work that is "in flight".
 *
 * Deliberately wide: a slow-burning error can resurface weeks after its fix
 * merged, and re-fixing it costs a whole build session. The cost of the width
 * is weaker candidates reaching the shortlist, which the score threshold and
 * the model's own conservative tie-break are there to absorb.
 */
export const DUPLICATE_LOOKBACK_DAYS = 30;

/**
 * The most candidates one classification will score, newest activity first: a
 * repository with a long history must not make the scoring pass unbounded.
 */
const DUPLICATE_CANDIDATE_LIMIT = 50;

export interface ListSentryDuplicateCandidatesOptions {
  /** The issue being classified; nothing can be a duplicate of itself. */
  readonly excludeId: string;
}

/**
 * The issues in a repository that count as already being worked on, and so are
 * worth comparing a freshly fetched issue against (US-002).
 *
 * `queued` and `working` are in flight by definition; `fixed` stays a candidate
 * for `DUPLICATE_LOOKBACK_DAYS` after its last change. `pending` is excluded
 * because nothing is being spent on it yet, `cannot_fix` because pointing a new
 * issue at a dead end helps no one, and `duplicate` because the row it points
 * at is the real work — chains of duplicates would only blur the target.
 */
export function listSentryDuplicateCandidates(
  db: Database,
  repositoryId: string,
  options: ListSentryDuplicateCandidatesOptions,
): SentryIssue[] {
  const cutoff = new Date(
    Date.now() - DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  return db
    .prepare(
      `SELECT * FROM sentry_issues
        WHERE repository_id = ?
          AND id <> ?
          AND (status IN ('queued', 'working') OR (status = 'fixed' AND updated_at >= ?))
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(repositoryId, options.excludeId, cutoff, DUPLICATE_CANDIDATE_LIMIT)
    .map(mapSentryIssue);
}

/**
 * The `duplicate` rows folded into one issue (US-007).
 *
 * The pointer is only ever one hop deep — the classifier resolves a candidate
 * that is itself a duplicate to its root before writing — so this is the whole
 * set of issues waiting on that one fix, not the first level of a tree.
 * Ordered oldest first, the same order everything else here reports a queue in.
 */
export function listSentryDuplicatesOf(db: Database, issueId: string): SentryIssue[] {
  return db
    .prepare(
      "SELECT * FROM sentry_issues WHERE status = 'duplicate' AND duplicate_of = ? " +
        'ORDER BY created_at ASC',
    )
    .all(issueId)
    .map(mapSentryIssue);
}
