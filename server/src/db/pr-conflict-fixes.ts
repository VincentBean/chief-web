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
 * Merge-conflict resolutions run on an open pull request.
 *
 * One row per pull request rather than per attempt, like `pr_reviews`: the row
 * is the live record of the last fix and nothing older, so starting a fix on a
 * pull request that already has one replaces the run instead of accumulating
 * duplicates. The resolutions themselves live on the pull request's branch.
 *
 * The head and base SHAs the conflict was seen at are part of that record: a
 * `failed` row is what stops the poller retrying, and it stops it only while
 * the pull request still sits on those two commits.
 */

export const PR_CONFLICT_FIX_STATUSES = ['running', 'succeeded', 'failed'] as const;
export type PrConflictFixStatus = (typeof PR_CONFLICT_FIX_STATUSES)[number];

/** Where a `failed` fix failed. */
export const PR_CONFLICT_FIX_FAILURE_STAGES = [
  /** The pull request's head branch could not be checked out. */
  'checkout',
  /** Merging the base branch in failed for a reason that is not a conflict. */
  'merge',
  /** The pass stalled, ran out of time, or was refused. */
  'agent',
  /** The agent left unmerged paths or conflict markers behind. */
  'verify',
  /** GitHub refused the push. */
  'push',
  /** The fix's container disappeared under it. */
  'container_lost',
] as const;
export type PrConflictFixFailureStage = (typeof PR_CONFLICT_FIX_FAILURE_STAGES)[number];

/** What the UI calls a stage, in the operator's words. */
export function prConflictFixFailureStageLabel(stage: PrConflictFixFailureStage): string {
  switch (stage) {
    case 'checkout':
      return 'the checkout';
    case 'merge':
      return 'the merge';
    case 'agent':
      return 'the agent';
    case 'verify':
      return 'verifying the resolution';
    case 'push':
      return 'pushing to GitHub';
    case 'container_lost':
      return 'the container';
  }
}

export interface PrConflictFix {
  readonly id: string;
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** The commit the head branch was on when the conflict was seen. */
  readonly headSha: string;
  /** The commit the base branch was on when the conflict was seen. */
  readonly baseSha: string;
  readonly status: PrConflictFixStatus;
  readonly attempts: number;
  readonly failureStage: PrConflictFixFailureStage | null;
  readonly lastError: string | null;
  readonly containerId: string | null;
  /** The merge commit a succeeded fix pushed; `null` until one is pushed. */
  readonly mergeSha: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePrConflictFixInput {
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly baseSha: string;
}

export interface UpdatePrConflictFixInput {
  readonly prUrl?: string;
  readonly prTitle?: string;
  readonly headBranch?: string;
  readonly baseBranch?: string;
  readonly headSha?: string;
  readonly baseSha?: string;
  readonly status?: PrConflictFixStatus;
  readonly attempts?: number;
  readonly failureStage?: PrConflictFixFailureStage | null;
  readonly lastError?: string | null;
  readonly containerId?: string | null;
  readonly mergeSha?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

const COLUMNS: Record<keyof UpdatePrConflictFixInput, string> = {
  prUrl: 'pr_url',
  prTitle: 'pr_title',
  headBranch: 'head_branch',
  baseBranch: 'base_branch',
  headSha: 'head_sha',
  baseSha: 'base_sha',
  status: 'status',
  attempts: 'attempts',
  failureStage: 'failure_stage',
  lastError: 'last_error',
  containerId: 'container_id',
  mergeSha: 'merge_sha',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

function stageOf(row: Row): PrConflictFixFailureStage | null {
  const value = nullableText(row, 'failure_stage');
  if (value === null) return null;
  if (!(PR_CONFLICT_FIX_FAILURE_STAGES as readonly string[]).includes(value)) {
    throw new Error(`Unexpected value for column "failure_stage": ${JSON.stringify(value)}`);
  }
  return value as PrConflictFixFailureStage;
}

export function mapPrConflictFix(row: Row): PrConflictFix {
  return {
    id: text(row, 'id'),
    repositoryId: text(row, 'repository_id'),
    prNumber: integer(row, 'pr_number'),
    prUrl: text(row, 'pr_url'),
    prTitle: text(row, 'pr_title'),
    headBranch: text(row, 'head_branch'),
    baseBranch: text(row, 'base_branch'),
    headSha: text(row, 'head_sha'),
    baseSha: text(row, 'base_sha'),
    status: enumeration(row, 'status', PR_CONFLICT_FIX_STATUSES),
    attempts: integer(row, 'attempts'),
    failureStage: stageOf(row),
    lastError: nullableText(row, 'last_error'),
    containerId: nullableText(row, 'container_id'),
    mergeSha: nullableText(row, 'merge_sha'),
    startedAt: nullableText(row, 'started_at'),
    finishedAt: nullableText(row, 'finished_at'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

/**
 * Starts a fix run for a pull request: a fresh row, or the pull request's
 * existing row wound back to the start of a run.
 *
 * Winding back is the point. A pull request keeps one row, so what a previous
 * run left on it — the attempts it spent, the stage it failed at, the merge it
 * pushed — must not leak into the new run's retry budget. The caller decides
 * *whether* to start (a `failed` row on the same two SHAs means don't); once it
 * has, the row describes the run now in flight.
 */
export function createPrConflictFix(
  db: Database,
  input: CreatePrConflictFixInput,
): PrConflictFix {
  const existing = findPrConflictFix(db, input.repositoryId, input.prNumber);
  const now = nowIso();
  const fix: PrConflictFix = {
    id: existing?.id ?? randomUUID(),
    repositoryId: input.repositoryId,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    prTitle: input.prTitle,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    headSha: input.headSha,
    baseSha: input.baseSha,
    status: 'running',
    attempts: 0,
    failureStage: null,
    lastError: null,
    containerId: null,
    mergeSha: null,
    startedAt: null,
    finishedAt: null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  if (existing !== null) {
    db.prepare(
      `UPDATE pr_conflict_fixes
          SET pr_url = ?, pr_title = ?, head_branch = ?, base_branch = ?, head_sha = ?,
              base_sha = ?, status = ?, attempts = ?, failure_stage = NULL, last_error = NULL,
              container_id = NULL, merge_sha = NULL, started_at = NULL, finished_at = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(
      fix.prUrl,
      fix.prTitle,
      fix.headBranch,
      fix.baseBranch,
      fix.headSha,
      fix.baseSha,
      fix.status,
      fix.attempts,
      fix.updatedAt,
      fix.id,
    );
    return fix;
  }

  db.prepare(
    `INSERT INTO pr_conflict_fixes
       (id, repository_id, pr_number, pr_url, pr_title, head_branch, base_branch, head_sha,
        base_sha, status, attempts, failure_stage, last_error, container_id, merge_sha,
        started_at, finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fix.id,
    fix.repositoryId,
    fix.prNumber,
    fix.prUrl,
    fix.prTitle,
    fix.headBranch,
    fix.baseBranch,
    fix.headSha,
    fix.baseSha,
    fix.status,
    fix.attempts,
    fix.failureStage,
    fix.lastError,
    fix.containerId,
    fix.mergeSha,
    fix.startedAt,
    fix.finishedAt,
    fix.createdAt,
    fix.updatedAt,
  );

  return fix;
}

export function getPrConflictFix(db: Database, id: string): PrConflictFix | null {
  const row = db.prepare('SELECT * FROM pr_conflict_fixes WHERE id = ?').get(id);
  return row ? mapPrConflictFix(row) : null;
}

export function findPrConflictFix(
  db: Database,
  repositoryId: string,
  prNumber: number,
): PrConflictFix | null {
  const row = db
    .prepare('SELECT * FROM pr_conflict_fixes WHERE repository_id = ? AND pr_number = ?')
    .get(repositoryId, prNumber);
  return row ? mapPrConflictFix(row) : null;
}

export function listPrConflictFixes(db: Database): PrConflictFix[] {
  return db
    .prepare('SELECT * FROM pr_conflict_fixes ORDER BY updated_at DESC')
    .all()
    .map(mapPrConflictFix);
}

/**
 * Fixes holding a build slot right now.
 *
 * Counted into the build loop's free-slot arithmetic next to the reviews and
 * the feedback runs: a fix is one more `claude -p` in one more container.
 */
export function countActivePrConflictFixes(db: Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM pr_conflict_fixes WHERE status = 'running'")
    .get();
  return row ? integer(row, 'count') : 0;
}

/**
 * Whether a fix stands in the way of trying the pull request again.
 *
 * A `failed` fix is only a standing failure while the pull request has not
 * moved: once either side's SHA changes the conflict is a different one, so the
 * failure is stale and the pull request earns a fresh run (the churn this
 * causes on a busy base branch is deliberate — see the PRD).
 */
export function hasStandingFailure(
  fix: PrConflictFix,
  headSha: string,
  baseSha: string,
): boolean {
  return fix.status === 'failed' && fix.headSha === headSha && fix.baseSha === baseSha;
}

export function updatePrConflictFix(
  db: Database,
  id: string,
  input: UpdatePrConflictFixInput,
): PrConflictFix | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = input[key as keyof UpdatePrConflictFixInput];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return getPrConflictFix(db, id);

  assignments.push('updated_at = ?');
  values.push(nowIso(), id);

  const result = db
    .prepare(`UPDATE pr_conflict_fixes SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return changeCount(result) === 0 ? null : getPrConflictFix(db, id);
}

export function deletePrConflictFix(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM pr_conflict_fixes WHERE id = ?').run(id)) > 0;
}
