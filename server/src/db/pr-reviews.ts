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
 * Code reviews started by hand on an open pull request.
 *
 * One row per pull request rather than per pass, like `pr_runs`: the workspace
 * and the clone hang off the id, so a second review of the same pull request
 * reuses the clone instead of starting over. The row records what the *last*
 * pass did — where it got to, what it posted — and nothing older; the reviews
 * themselves live on GitHub.
 */

export const PR_REVIEW_STATUSES = ['pending', 'running', 'finished', 'failed'] as const;
export type PrReviewStatus = (typeof PR_REVIEW_STATUSES)[number];

/** Where a `failed` review failed. */
export const PR_REVIEW_FAILURE_STAGES = [
  /** The pull request's head branch could not be checked out. */
  'checkout',
  /** The pass stalled, ran out of time, or was refused. */
  'agent',
  /** The agent ran but left no usable findings document. */
  'findings',
  /** GitHub refused the review. */
  'publish',
  /** The review's container disappeared under it. */
  'container_lost',
] as const;
export type PrReviewFailureStage = (typeof PR_REVIEW_FAILURE_STAGES)[number];

/** What the UI calls a stage, in the operator's words. */
export function prReviewFailureStageLabel(stage: PrReviewFailureStage): string {
  switch (stage) {
    case 'checkout':
      return 'the checkout';
    case 'agent':
      return 'the agent';
    case 'findings':
      return 'the agent’s findings';
    case 'publish':
      return 'posting to GitHub';
    case 'container_lost':
      return 'the container';
  }
}

export interface PrReview {
  readonly id: string;
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly status: PrReviewStatus;
  readonly failureStage: PrReviewFailureStage | null;
  readonly attempt: number;
  readonly containerId: string | null;
  /** The commit the review was read at. */
  readonly headSha: string | null;
  /** The posted review's `html_url`; `null` until a pass has posted one. */
  readonly reviewUrl: string | null;
  readonly inlineComments: number | null;
  readonly foldedFindings: number | null;
  /** What became of the hand-off to the feedback run; `null` when none was tried. */
  readonly solverMessage: string | null;
  readonly lastError: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePrReviewInput {
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface UpdatePrReviewInput {
  readonly prUrl?: string;
  readonly prTitle?: string;
  readonly headBranch?: string;
  readonly baseBranch?: string;
  readonly status?: PrReviewStatus;
  readonly failureStage?: PrReviewFailureStage | null;
  readonly attempt?: number;
  readonly containerId?: string | null;
  readonly headSha?: string | null;
  readonly reviewUrl?: string | null;
  readonly inlineComments?: number | null;
  readonly foldedFindings?: number | null;
  readonly solverMessage?: string | null;
  readonly lastError?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

const COLUMNS: Record<keyof UpdatePrReviewInput, string> = {
  prUrl: 'pr_url',
  prTitle: 'pr_title',
  headBranch: 'head_branch',
  baseBranch: 'base_branch',
  status: 'status',
  failureStage: 'failure_stage',
  attempt: 'attempt',
  containerId: 'container_id',
  headSha: 'head_sha',
  reviewUrl: 'review_url',
  inlineComments: 'inline_comments',
  foldedFindings: 'folded_findings',
  solverMessage: 'solver_message',
  lastError: 'last_error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

function stageOf(row: Row): PrReviewFailureStage | null {
  const value = nullableText(row, 'failure_stage');
  if (value === null) return null;
  if (!(PR_REVIEW_FAILURE_STAGES as readonly string[]).includes(value)) {
    throw new Error(`Unexpected value for column "failure_stage": ${JSON.stringify(value)}`);
  }
  return value as PrReviewFailureStage;
}

function nullableInteger(row: Row, column: string): number | null {
  const value = (row as Record<string, unknown>)[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') {
    throw new Error(`Unexpected value for column "${column}": ${JSON.stringify(value)}`);
  }
  return value;
}

export function mapPrReview(row: Row): PrReview {
  return {
    id: text(row, 'id'),
    repositoryId: text(row, 'repository_id'),
    prNumber: integer(row, 'pr_number'),
    prUrl: text(row, 'pr_url'),
    prTitle: text(row, 'pr_title'),
    headBranch: text(row, 'head_branch'),
    baseBranch: text(row, 'base_branch'),
    status: enumeration(row, 'status', PR_REVIEW_STATUSES),
    failureStage: stageOf(row),
    attempt: integer(row, 'attempt'),
    containerId: nullableText(row, 'container_id'),
    headSha: nullableText(row, 'head_sha'),
    reviewUrl: nullableText(row, 'review_url'),
    inlineComments: nullableInteger(row, 'inline_comments'),
    foldedFindings: nullableInteger(row, 'folded_findings'),
    solverMessage: nullableText(row, 'solver_message'),
    lastError: nullableText(row, 'last_error'),
    startedAt: nullableText(row, 'started_at'),
    finishedAt: nullableText(row, 'finished_at'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

/** Creates the review row, or returns the one this pull request already has. */
export function createPrReview(db: Database, input: CreatePrReviewInput): PrReview {
  const existing = findPrReview(db, input.repositoryId, input.prNumber);
  if (existing !== null) {
    return (
      updatePrReview(db, existing.id, {
        prUrl: input.prUrl,
        prTitle: input.prTitle,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
      }) ?? existing
    );
  }

  const now = nowIso();
  const review: PrReview = {
    id: randomUUID(),
    repositoryId: input.repositoryId,
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    prTitle: input.prTitle,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch,
    status: 'pending',
    failureStage: null,
    attempt: 0,
    containerId: null,
    headSha: null,
    reviewUrl: null,
    inlineComments: null,
    foldedFindings: null,
    solverMessage: null,
    lastError: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO pr_reviews
       (id, repository_id, pr_number, pr_url, pr_title, head_branch, base_branch, status,
        failure_stage, attempt, container_id, head_sha, review_url, inline_comments,
        folded_findings, solver_message, last_error, started_at, finished_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    review.id,
    review.repositoryId,
    review.prNumber,
    review.prUrl,
    review.prTitle,
    review.headBranch,
    review.baseBranch,
    review.status,
    review.failureStage,
    review.attempt,
    review.containerId,
    review.headSha,
    review.reviewUrl,
    review.inlineComments,
    review.foldedFindings,
    review.solverMessage,
    review.lastError,
    review.startedAt,
    review.finishedAt,
    review.createdAt,
    review.updatedAt,
  );

  return review;
}

export function getPrReview(db: Database, id: string): PrReview | null {
  const row = db.prepare('SELECT * FROM pr_reviews WHERE id = ?').get(id);
  return row ? mapPrReview(row) : null;
}

export function findPrReview(
  db: Database,
  repositoryId: string,
  prNumber: number,
): PrReview | null {
  const row = db
    .prepare('SELECT * FROM pr_reviews WHERE repository_id = ? AND pr_number = ?')
    .get(repositoryId, prNumber);
  return row ? mapPrReview(row) : null;
}

export function listPrReviews(db: Database): PrReview[] {
  return db
    .prepare('SELECT * FROM pr_reviews ORDER BY updated_at DESC')
    .all()
    .map(mapPrReview);
}

/**
 * Reviews holding a build slot right now.
 *
 * Counted into the build loop's free-slot arithmetic next to the feedback
 * runs: a review is one more `claude -p` in one more container, and the cap is
 * on agents, not on sessions.
 */
export function countActivePrReviews(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM pr_reviews WHERE status = 'running'").get();
  return row ? integer(row, 'count') : 0;
}

export function updatePrReview(
  db: Database,
  id: string,
  input: UpdatePrReviewInput,
): PrReview | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = input[key as keyof UpdatePrReviewInput];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return getPrReview(db, id);

  assignments.push('updated_at = ?');
  values.push(nowIso(), id);

  const result = db
    .prepare(`UPDATE pr_reviews SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return changeCount(result) === 0 ? null : getPrReview(db, id);
}

export function deletePrReview(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM pr_reviews WHERE id = ?').run(id)) > 0;
}
