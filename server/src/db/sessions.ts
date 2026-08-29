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

export const SESSION_STATUSES = ['pending', 'ready', 'building', 'failed', 'finished'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PR_TARGET_BRANCHES = ['develop', 'main'] as const;
export type PrTargetBranch = (typeof PR_TARGET_BRANCHES)[number];

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

export function featureBranchFor(name: string): string {
  return `chief/${name}`;
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
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO sessions
       (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
        scheduled_start_at, queued_at, container_id, pr_url, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** Sessions waiting for a build slot, oldest first — the FIFO queue of US-018. */
export function listQueuedSessions(db: Database): Session[] {
  return db
    .prepare('SELECT * FROM sessions WHERE queued_at IS NOT NULL ORDER BY queued_at ASC')
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
  const params: Record<string, string | null> = { ':id': id, ':updated_at': nowIso() };

  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = patch[field as keyof UpdateSessionInput];
    if (value === undefined) continue;
    assignments.push(`${column} = :${column}`);
    params[`:${column}`] = value;
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = :updated_at');
    db.prepare(`UPDATE sessions SET ${assignments.join(', ')} WHERE id = :id`).run(params);
  }

  return getSession(db, id);
}

/** Deletes a session and, by cascade, its stories. */
export function deleteSession(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM sessions WHERE id = ?').run(id)) > 0;
}
