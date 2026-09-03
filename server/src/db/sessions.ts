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

export const SESSION_STATUSES = [
  'pending',
  'ready',
  'building',
  /** Held by Claude's usage limit: the container and the build slot are kept. */
  'waiting',
  'failed',
  /** The build ran to the end; terminal for a session that opened no PR. */
  'finished',
  /**
   * The build is done and its pull request is open on GitHub, not merged yet
   * (US-001). `pr_url` is set. The sync leaves the session here until GitHub
   * reports the PR merged (`merged`) or closed unmerged (back to `finished`).
   */
  'pr-open',
  /**
   * That pull request was merged on GitHub — terminal, and the one status
   * nothing transitions out of. The build container is removed on the way in,
   * because nothing will ever need it again.
   */
  'merged',
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PR_TARGET_BRANCHES = ['develop', 'main'] as const;
export type PrTargetBranch = (typeof PR_TARGET_BRANCHES)[number];

/**
 * Where a `failed` session failed (US-019).
 *
 * Every path to `failed` records one of these next to the human-readable
 * `last_error`, because the stage is what decides how a retry resumes: an
 * `agent`, `prd` or `container_lost` failure is retried by starting the loop
 * again at the first story that is not done, while `push`, `pull_request`
 * and `review` re-run only the delivery of work that is already committed.
 *
 * A clone or setup failure is deliberately not in this list: it leaves the
 * session `pending` with a "Retry setup" action (US-010), never `failed`.
 */
export const FAILURE_STAGES = [
  /** One headless `claude -p` iteration: stalled, timed out, or would not run. */
  'agent',
  /** `prd.md` could no longer be read, so the loop cannot tell what is done. */
  'prd',
  /** `git push` of the feature branch. */
  'push',
  /** Opening the pull request at GitHub. */
  'pull_request',
  /**
   * The automatic code review of the pull request (US-006). The branch is
   * pushed and the pull request is open by the time it runs, so it is a
   * delivery stage: a retry re-runs the review and nothing else.
   */
  'review',
  /** The session's container disappeared while it was building (US-009). */
  'container_lost',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

/** What the UI calls a stage, in the operator's words. */
export function failureStageLabel(stage: FailureStage): string {
  switch (stage) {
    case 'agent':
      return 'the agent';
    case 'prd':
      return 'the PRD';
    case 'push':
      return 'the push';
    case 'pull_request':
      return 'the pull request';
    case 'review':
      return 'the code review';
    case 'container_lost':
      return 'the container';
  }
}

/**
 * The stages that come after the build (US-006): the work is committed, so a
 * retry re-runs delivery from the step that failed and never the story loop.
 */
export function isDeliveryStage(
  stage: FailureStage | null,
): stage is 'push' | 'pull_request' | 'review' {
  return stage === 'push' || stage === 'pull_request' || stage === 'review';
}

/** Session names are slugs: letters, numbers, hyphens and underscores. */
export const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface Session {
  readonly id: string;
  readonly repositoryId: string;
  readonly name: string;
  readonly status: SessionStatus;
  readonly baseBranch: string;
  readonly featureBranch: string;
  readonly prTargetBranch: PrTargetBranch;
  /** UTC ISO timestamp the build should start at, or null when unscheduled. */
  readonly scheduledStartAt: string | null;
  /** UTC ISO timestamp the session entered the FIFO build queue (US-018). */
  readonly queuedAt: string | null;
  readonly containerId: string | null;
  readonly prUrl: string | null;
  readonly lastError: string | null;
  /** Which step failed, whenever the status is `failed` (US-019). */
  readonly failureStage: FailureStage | null;
  /**
   * UTC ISO timestamp a `waiting` session may resume at — the far end of the
   * usage-limit hold (US-003) — and null for every other status.
   */
  readonly waitingUntil: string | null;
  /**
   * Whether the pull request this session opens should get an automatic code
   * review (US-003). Stored as 0/1; false for every session created before the
   * feature existed.
   */
  readonly codeReview: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSessionInput {
  readonly repositoryId: string;
  readonly name: string;
  readonly baseBranch: string;
  readonly prTargetBranch: PrTargetBranch;
  /** Defaults to `chief/<name>`, mirroring chief's branch convention. */
  readonly featureBranch?: string;
  readonly status?: SessionStatus;
  readonly scheduledStartAt?: string | null;
  /** Defaults to false: a session asks for a review only when it says so. */
  readonly codeReview?: boolean;
}

export interface UpdateSessionInput {
  readonly name?: string;
  readonly status?: SessionStatus;
  readonly baseBranch?: string;
  readonly featureBranch?: string;
  readonly prTargetBranch?: PrTargetBranch;
  readonly scheduledStartAt?: string | null;
  readonly queuedAt?: string | null;
  readonly containerId?: string | null;
  readonly prUrl?: string | null;
  readonly lastError?: string | null;
  readonly failureStage?: FailureStage | null;
  readonly waitingUntil?: string | null;
  readonly codeReview?: boolean;
}

export interface ListSessionsFilter {
  readonly repositoryId?: string;
  readonly status?: SessionStatus;
}

const COLUMNS: Record<keyof UpdateSessionInput, string> = {
  name: 'name',
  status: 'status',
  baseBranch: 'base_branch',
  featureBranch: 'feature_branch',
  prTargetBranch: 'pr_target_branch',
  scheduledStartAt: 'scheduled_start_at',
  queuedAt: 'queued_at',
  containerId: 'container_id',
  prUrl: 'pr_url',
  lastError: 'last_error',
  failureStage: 'failure_stage',
  waitingUntil: 'waiting_until',
  codeReview: 'code_review',
};

export function isValidSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.test(name);
}

function assertValidSessionName(name: string): void {
  if (!isValidSessionName(name)) {
    throw new Error(
      `Invalid session name "${name}": use letters, numbers, hyphens and underscores only`,
    );
  }
}

/** SQLite has no boolean type; flags are stored as 0/1 integers. */
function sqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

export function featureBranchFor(name: string): string {
  return `chief/${name}`;
}

function failureStageOf(row: Row): FailureStage | null {
  const value = nullableText(row, 'failure_stage');
  if (value === null) return null;
  if (!(FAILURE_STAGES as readonly string[]).includes(value)) {
    throw new Error(`Unexpected value for column "failure_stage": ${JSON.stringify(value)}`);
  }
  return value as FailureStage;
}

export function mapSession(row: Row): Session {
  return {
    id: text(row, 'id'),
    repositoryId: text(row, 'repository_id'),
    name: text(row, 'name'),
    status: enumeration(row, 'status', SESSION_STATUSES),
    baseBranch: text(row, 'base_branch'),
    featureBranch: text(row, 'feature_branch'),
    prTargetBranch: enumeration(row, 'pr_target_branch', PR_TARGET_BRANCHES),
    scheduledStartAt: nullableText(row, 'scheduled_start_at'),
    queuedAt: nullableText(row, 'queued_at'),
    containerId: nullableText(row, 'container_id'),
    prUrl: nullableText(row, 'pr_url'),
    lastError: nullableText(row, 'last_error'),
    failureStage: failureStageOf(row),
    waitingUntil: nullableText(row, 'waiting_until'),
    codeReview: integer(row, 'code_review') === 1,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function createSession(db: Database, input: CreateSessionInput): Session {
  assertValidSessionName(input.name);

  const now = nowIso();
  const session: Session = {
    id: randomUUID(),
    repositoryId: input.repositoryId,
    name: input.name,
    status: input.status ?? 'pending',
    baseBranch: input.baseBranch,
    featureBranch: input.featureBranch ?? featureBranchFor(input.name),
    prTargetBranch: input.prTargetBranch,
    scheduledStartAt: input.scheduledStartAt ?? null,
    queuedAt: null,
    containerId: null,
    prUrl: null,
    lastError: null,
    failureStage: null,
    waitingUntil: null,
    codeReview: input.codeReview ?? false,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO sessions
       (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
        scheduled_start_at, queued_at, container_id, pr_url, last_error, failure_stage,
        waiting_until, code_review, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.repositoryId,
    session.name,
    session.status,
    session.baseBranch,
    session.featureBranch,
    session.prTargetBranch,
    session.scheduledStartAt,
    session.queuedAt,
    session.containerId,
    session.prUrl,
    session.lastError,
    session.failureStage,
    session.waitingUntil,
    sqlBoolean(session.codeReview),
    session.createdAt,
    session.updatedAt,
  );

  return session;
}

export function getSession(db: Database, id: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? mapSession(row) : null;
}

export function listSessions(db: Database, filter: ListSessionsFilter = {}): Session[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filter.repositoryId !== undefined) {
    conditions.push('repository_id = :repository_id');
    params[':repository_id'] = filter.repositoryId;
  }
  if (filter.status !== undefined) {
    conditions.push('status = :status');
    params[':status'] = filter.status;
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM sessions${where} ORDER BY updated_at DESC`)
    .all(params)
    .map(mapSession);
}

/**
 * Sessions waiting for a build slot, oldest first — the FIFO queue of US-018.
 *
 * The id is the tie-break, so two sessions queued in the same millisecond still
 * have a total order and every reader agrees on it; {@link queuePosition}
 * counts with exactly the same comparison.
 */
export function listQueuedSessions(db: Database): Session[] {
  return db
    .prepare('SELECT * FROM sessions WHERE queued_at IS NOT NULL ORDER BY queued_at ASC, id ASC')
    .all()
    .map(mapSession);
}

/**
 * Where a session stands in that queue, 1-based — the "#2" the UI shows — or
 * `null` when it is not queued. Counted in SQL rather than from a list, so the
 * dashboard's per-session view costs one row instead of the whole queue.
 */
export function queuePosition(
  db: Database,
  session: Pick<Session, 'id' | 'queuedAt'>,
): number | null {
  if (session.queuedAt === null) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sessions
        WHERE queued_at IS NOT NULL
          AND (queued_at < :queued_at OR (queued_at = :queued_at AND id <= :id))`,
    )
    .get({ ':queued_at': session.queuedAt, ':id': session.id });
  return row ? integer(row, 'count') : null;
}

/**
 * Sessions held by Claude's usage limit whose hold has run out (US-006).
 *
 * Ordered the way they will be resumed, and tie-broken on the id exactly as
 * {@link listQueuedSessions} is: a hold parks every session on the same
 * expiry, so without the tie-break "their existing order" would be no order
 * at all — and the sessions that do not fit under the concurrency cap go on
 * that very queue, where the same comparison has to agree.
 *
 * A `waiting` row with no expiry is due immediately: nothing is holding it.
 */
export function listDueWaitingSessions(db: Database, now: string = nowIso()): Session[] {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE status = 'waiting' AND (waiting_until IS NULL OR waiting_until <= ?)
        ORDER BY waiting_until ASC, id ASC`,
    )
    .all(now)
    .map(mapSession);
}

/**
 * Every session held by Claude's usage limit, whether or not its hold has run
 * out (US-008).
 *
 * "Resume now" ends the hold before the hour is up, so the sessions it brings
 * back are exactly the ones {@link listDueWaitingSessions} is still refusing.
 * They come back in the same order, for the same reason: whatever does not fit
 * under the concurrency cap goes on the build queue, where the comparison has
 * to agree.
 */
export function listWaitingSessions(db: Database): Session[] {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE status = 'waiting'
        ORDER BY waiting_until ASC, id ASC`,
    )
    .all()
    .map(mapSession);
}

/** Ready sessions whose scheduled start time has passed (US-017). */
export function listDueScheduledSessions(db: Database, now: string = nowIso()): Session[] {
  return db
    .prepare(
      `SELECT * FROM sessions
        WHERE status = 'ready' AND scheduled_start_at IS NOT NULL AND scheduled_start_at <= ?
        ORDER BY scheduled_start_at ASC`,
    )
    .all(now)
    .map(mapSession);
}

/**
 * Whether a schedule was missed: its moment passed while the session was still
 * `pending`, so nothing started it (US-017). The session has to be marked ready
 * before it can build, and doing so starts it there and then.
 */
export function isScheduleMissed(
  session: Pick<Session, 'status' | 'scheduledStartAt'>,
  now: string = nowIso(),
): boolean {
  return (
    session.status === 'pending' &&
    session.scheduledStartAt !== null &&
    session.scheduledStartAt <= now
  );
}

export function countSessionsByStatus(db: Database, status: SessionStatus): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE status = ?').get(status);
  return row ? integer(row, 'count') : 0;
}

export function countSessionsForRepository(db: Database, repositoryId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM sessions WHERE repository_id = ?')
    .get(repositoryId);
  return row ? integer(row, 'count') : 0;
}

/** Applies the provided fields only; returns the updated row, or null if absent. */
export function updateSession(
  db: Database,
  id: string,
  patch: UpdateSessionInput,
): Session | null {
  if (patch.name !== undefined) assertValidSessionName(patch.name);

  const assignments: string[] = [];
  const params: Record<string, string | number | null> = { ':id': id, ':updated_at': nowIso() };

  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = patch[field as keyof UpdateSessionInput];
    if (value === undefined) continue;
    assignments.push(`${column} = :${column}`);
    params[`:${column}`] = typeof value === 'boolean' ? sqlBoolean(value) : value;
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = :updated_at');
    db.prepare(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = :id`).run(params);
  }

  return getSession(db, id);
}

/**
 * Moves a session to `failed` with both halves of the diagnosis: the sentence
 * the operator reads, and the stage a retry resumes from (US-019). Every path
 * to `failed` goes through here, so neither half can be forgotten.
 */
export function failSession(
  db: Database,
  id: string,
  stage: FailureStage,
  message: string,
): Session | null {
  return updateSession(db, id, { status: 'failed', lastError: message, failureStage: stage });
}

/** Deletes a session and, by cascade, its stories. */
export function deleteSession(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM sessions WHERE id = ?').run(id)) > 0;
}
