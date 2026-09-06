import {
  changeCount,
  type Database,
  enumeration,
  integer,
  nowIso,
  type Row,
  text,
} from './sqlite.js';

/**
 * What a queue entry points at (US-001).
 *
 * One queue holds every action that waits for a build slot, so the pump can
 * take the head without asking what kind it is. `ref_id` is whatever the kind
 * needs to find its work again: a session id for `session`, and
 * `<repositoryId>:<prNumber>` for the two pull-request kinds.
 */
export const BUILD_QUEUE_KINDS = ['session', 'pr-review', 'pr-feedback'] as const;

export type BuildQueueKind = (typeof BUILD_QUEUE_KINDS)[number];

export interface BuildQueueEntry {
  readonly id: number;
  readonly kind: BuildQueueKind;
  readonly refId: string;
  readonly queuedAt: string;
}

export interface EnqueueBuildInput {
  readonly kind: BuildQueueKind;
  readonly refId: string;
  /** Defaults to now; passed in only by migrations and tests. */
  readonly queuedAt?: string;
}

/** The reference a pull-request queue entry is stored under. */
export function prRefId(repositoryId: string, prNumber: number): string {
  return `${repositoryId}:${String(prNumber)}`;
}

/** Splits a {@link prRefId} back up; `null` when it is not one. */
export function parsePrRefId(refId: string): { repositoryId: string; prNumber: number } | null {
  const at = refId.lastIndexOf(':');
  if (at <= 0) return null;
  const prNumber = Number.parseInt(refId.slice(at + 1), 10);
  if (!Number.isInteger(prNumber)) return null;
  return { repositoryId: refId.slice(0, at), prNumber };
}

function mapEntry(row: Row): BuildQueueEntry {
  return {
    id: integer(row, 'id'),
    kind: enumeration(row, 'kind', BUILD_QUEUE_KINDS),
    refId: text(row, 'ref_id'),
    queuedAt: text(row, 'queued_at'),
  };
}

/**
 * Puts an action at the back of the queue, or leaves it exactly where it is.
 *
 * Idempotent on `(kind, ref_id)`: pressing "start" twice, or an automatic
 * trigger firing again, must never send something that is already waiting to
 * the back of the queue.
 */
export function enqueueBuild(db: Database, input: EnqueueBuildInput): BuildQueueEntry {
  const existing = getQueuedBuild(db, input.kind, input.refId);
  if (existing !== null) return existing;

  db.prepare('INSERT INTO build_queue (kind, ref_id, queued_at) VALUES (?, ?, ?)').run(
    input.kind,
    input.refId,
    input.queuedAt ?? nowIso(),
  );
  const entry = getQueuedBuild(db, input.kind, input.refId);
  if (entry === null) throw new Error(`Could not queue ${input.kind} ${input.refId}`);
  return entry;
}

export function getQueuedBuild(
  db: Database,
  kind: BuildQueueKind,
  refId: string,
): BuildQueueEntry | null {
  const row = db.prepare('SELECT * FROM build_queue WHERE kind = ? AND ref_id = ?').get(kind, refId);
  return row ? mapEntry(row) : null;
}

/** Drops one entry by its own id — what the pump does with the head. */
export function removeBuildQueueEntry(db: Database, id: number): boolean {
  return changeCount(db.prepare('DELETE FROM build_queue WHERE id = ?').run(id)) > 0;
}

/** Drops what a referent has waiting, if anything — "leave queue" and cancels. */
export function removeQueuedBuild(db: Database, kind: BuildQueueKind, refId: string): boolean {
  return (
    changeCount(db.prepare('DELETE FROM build_queue WHERE kind = ? AND ref_id = ?').run(kind, refId)) >
    0
  );
}

/**
 * The whole queue, oldest first, with no priority between kinds.
 *
 * The id is the tie-break, so two entries queued in the same millisecond still
 * have a total order every reader agrees on; {@link buildQueuePosition} counts
 * with exactly the same comparison.
 */
export function listBuildQueue(db: Database): BuildQueueEntry[] {
  return db
    .prepare('SELECT * FROM build_queue ORDER BY queued_at ASC, id ASC')
    .all()
    .map(mapEntry);
}

/**
 * Where a referent stands in that queue, 1-based — the "#2" the UI shows — or
 * `null` when it is not queued. Counted in SQL rather than from a list, so the
 * dashboard's per-row view costs two small reads instead of the whole queue.
 */
export function buildQueuePosition(
  db: Database,
  kind: BuildQueueKind,
  refId: string,
): number | null {
  const entry = getQueuedBuild(db, kind, refId);
  if (entry === null) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM build_queue
        WHERE queued_at < :queued_at OR (queued_at = :queued_at AND id <= :id)`,
    )
    .get({ ':queued_at': entry.queuedAt, ':id': entry.id });
  return row ? integer(row, 'count') : null;
}

export function countQueuedBuilds(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM build_queue').get();
  return row ? integer(row, 'count') : 0;
}
