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
 * Runs that process a pull request's review feedback (US-021).
 *
 * One row per pull request rather than per attempt: the workspace, the clone
 * and the per-thread record all hang off it, so a re-run after a partial
 * success resumes instead of starting over.
 */

export const PR_RUN_STATUSES = ['pending', 'running', 'finished', 'failed'] as const;
export type PrRunStatus = (typeof PR_RUN_STATUSES)[number];

/**
 * Where a `failed` run failed.
 *
 * `reply` sits after `push` on purpose, the same way `pull_request` sits after
 * `push` for a session: a run that failed there has already delivered its fix,
 * so retrying it must re-run only the answering, never the agent.
 */
export const PR_FAILURE_STAGES = [
  /** The review threads could not be read from GitHub. */
  'feedback',
  /** The pull request's head branch could not be checked out. */
  'checkout',
  /** The pass stalled, ran out of time, or made no commit for work it claimed. */
  'agent',
  /** The outcome file was missing or unusable, so nothing is describable. */
  'outcome',
  /** `git push` of the head branch. */
  'push',
  /** The push landed but GitHub refused a reply or a resolve. */
  'reply',
  /** The run's container disappeared under it. */
  'container_lost',
] as const;
export type PrFailureStage = (typeof PR_FAILURE_STAGES)[number];

/** What the UI calls a stage, in the operator's words. */
export function prFailureStageLabel(stage: PrFailureStage): string {
  switch (stage) {
    case 'feedback':
      return 'reading the comments';
    case 'checkout':
      return 'the checkout';
    case 'agent':
      return 'the agent';
    case 'outcome':
      return 'the agent’s report';
    case 'push':
      return 'the push';
    case 'reply':
      return 'answering on GitHub';
    case 'container_lost':
      return 'the container';
  }
}

/** What happened to one piece of feedback. */
export const FEEDBACK_OUTCOMES = ['addressed', 'skipped', 'unreported'] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export const FEEDBACK_KINDS = ['thread', 'review'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface PrRun {
  readonly id: string;
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly status: PrRunStatus;
  readonly failureStage: PrFailureStage | null;
  readonly attempt: number;
  readonly containerId: string | null;
  /** The commit the last successful push delivered; what replies quote. */
  readonly headSha: string | null;
  readonly lastError: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePrRunInput {
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface UpdatePrRunInput {
  readonly prUrl?: string;
  readonly prTitle?: string;
  readonly headBranch?: string;
  readonly baseBranch?: string;
  readonly status?: PrRunStatus;
  readonly failureStage?: PrFailureStage | null;
  readonly attempt?: number;
  readonly containerId?: string | null;
  readonly headSha?: string | null;
  readonly lastError?: string | null;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
}

const RUN_COLUMNS: Record<keyof UpdatePrRunInput, string> = {
  prUrl: 'pr_url',
  prTitle: 'pr_title',
  headBranch: 'head_branch',
  baseBranch: 'base_branch',
  status: 'status',
  failureStage: 'failure_stage',
  attempt: 'attempt',
  containerId: 'container_id',
  headSha: 'head_sha',
  lastError: 'last_error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

function stageOf(row: Row): PrFailureStage | null {
  const value = nullableText(row, 'failure_stage');
  if (value === null) return null;
  if (!(PR_FAILURE_STAGES as readonly string[]).includes(value)) {
    throw new Error(`Unexpected value for column "failure_stage": ${JSON.stringify(value)}`);
  }
  return value as PrFailureStage;
}

export function mapPrRun(row: Row): PrRun {
  return {
    id: text(row, 'id'),
    repositoryId: text(row, 'repository_id'),
    prNumber: integer(row, 'pr_number'),
    prUrl: text(row, 'pr_url'),
    prTitle: text(row, 'pr_title'),
    headBranch: text(row, 'head_branch'),
    baseBranch: text(row, 'base_branch'),
    status: enumeration(row, 'status', PR_RUN_STATUSES),
    failureStage: stageOf(row),
    attempt: integer(row, 'attempt'),
    containerId: nullableText(row, 'container_id'),
    headSha: nullableText(row, 'head_sha'),
    lastError: nullableText(row, 'last_error'),
    startedAt: nullableText(row, 'started_at'),
    finishedAt: nullableText(row, 'finished_at'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

/** Creates the run row, or returns the one this pull request already has. */
export function createPrRun(db: Database, input: CreatePrRunInput): PrRun {
  const existing = findPrRun(db, input.repositoryId, input.prNumber);
  if (existing !== null) {
    return (
      updatePrRun(db, existing.id, {
        prUrl: input.prUrl,
        prTitle: input.prTitle,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
      }) ?? existing
    );
  }

  const now = nowIso();
  const run: PrRun = {
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
    lastError: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO pr_runs
       (id, repository_id, pr_number, pr_url, pr_title, head_branch, base_branch, status,
        failure_stage, attempt, container_id, head_sha, last_error, started_at, finished_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    run.repositoryId,
    run.prNumber,
    run.prUrl,
    run.prTitle,
    run.headBranch,
    run.baseBranch,
    run.status,
    run.failureStage,
    run.attempt,
    run.containerId,
    run.headSha,
    run.lastError,
    run.startedAt,
    run.finishedAt,
    run.createdAt,
    run.updatedAt,
  );

  return run;
}

export function getPrRun(db: Database, id: string): PrRun | null {
  const row = db.prepare('SELECT * FROM pr_runs WHERE id = ?').get(id);
  return row ? mapPrRun(row) : null;
}

export function findPrRun(db: Database, repositoryId: string, prNumber: number): PrRun | null {
  const row = db
    .prepare('SELECT * FROM pr_runs WHERE repository_id = ? AND pr_number = ?')
    .get(repositoryId, prNumber);
  return row ? mapPrRun(row) : null;
}

export function listPrRuns(db: Database): PrRun[] {
  return db
    .prepare('SELECT * FROM pr_runs ORDER BY updated_at DESC')
    .all()
    .map(mapPrRun);
}

/**
 * Runs holding a build slot right now.
 *
 * The build loop subtracts this from its own free-slot count, so a feedback
 * pass and a Ralph loop cannot both think they have the last slot.
 */
export function countActivePrRuns(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM pr_runs WHERE status = 'running'").get();
  return row ? integer(row, 'count') : 0;
}

export function updatePrRun(db: Database, id: string, input: UpdatePrRunInput): PrRun | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(RUN_COLUMNS)) {
    const value = input[key as keyof UpdatePrRunInput];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return getPrRun(db, id);

  assignments.push('updated_at = ?');
  values.push(nowIso(), id);

  const result = db
    .prepare(`UPDATE pr_runs SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return changeCount(result) === 0 ? null : getPrRun(db, id);
}

export function deletePrRun(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM pr_runs WHERE id = ?').run(id)) > 0;
}

/* ------------------------------------------------------------------ threads */

export interface PrFeedbackThread {
  readonly id: number;
  readonly runId: string;
  /** GraphQL node id: the only thing `resolveReviewThread` accepts. */
  readonly threadId: string;
  readonly kind: FeedbackKind;
  /** The thread's *first* comment; GitHub refuses replies to replies. */
  readonly firstCommentId: number | null;
  readonly feedbackKey: string;
  readonly outcome: FeedbackOutcome | null;
  readonly summary: string | null;
  readonly repliedAt: string | null;
  readonly replyUrl: string | null;
  /** Which commit the posted reply quoted, so a re-run does not repeat it. */
  readonly repliedHeadSha: string | null;
  readonly resolvedAt: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertThreadInput {
  readonly runId: string;
  readonly threadId: string;
  readonly kind: FeedbackKind;
  readonly firstCommentId: number | null;
  readonly feedbackKey: string;
}

export interface UpdateThreadInput {
  readonly feedbackKey?: string;
  readonly firstCommentId?: number | null;
  readonly outcome?: FeedbackOutcome | null;
  readonly summary?: string | null;
  readonly repliedAt?: string | null;
  readonly replyUrl?: string | null;
  readonly repliedHeadSha?: string | null;
  readonly resolvedAt?: string | null;
  readonly error?: string | null;
}

const THREAD_COLUMNS: Record<keyof UpdateThreadInput, string> = {
  feedbackKey: 'feedback_key',
  firstCommentId: 'first_comment_id',
  outcome: 'outcome',
  summary: 'summary',
  repliedAt: 'replied_at',
  replyUrl: 'reply_url',
  repliedHeadSha: 'replied_head_sha',
  resolvedAt: 'resolved_at',
  error: 'error',
};

function outcomeOf(row: Row): FeedbackOutcome | null {
  const value = nullableText(row, 'outcome');
  if (value === null) return null;
  if (!(FEEDBACK_OUTCOMES as readonly string[]).includes(value)) {
    throw new Error(`Unexpected value for column "outcome": ${JSON.stringify(value)}`);
  }
  return value as FeedbackOutcome;
}

export function mapThread(row: Row): PrFeedbackThread {
  return {
    id: integer(row, 'id'),
    runId: text(row, 'run_id'),
    threadId: text(row, 'thread_id'),
    kind: enumeration(row, 'kind', FEEDBACK_KINDS),
    firstCommentId: nullableInteger(row, 'first_comment_id'),
    feedbackKey: text(row, 'feedback_key'),
    outcome: outcomeOf(row),
    summary: nullableText(row, 'summary'),
    repliedAt: nullableText(row, 'replied_at'),
    replyUrl: nullableText(row, 'reply_url'),
    repliedHeadSha: nullableText(row, 'replied_head_sha'),
    resolvedAt: nullableText(row, 'resolved_at'),
    error: nullableText(row, 'error'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

function nullableInteger(row: Row, column: string): number | null {
  const value = (row as Record<string, unknown>)[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') {
    throw new Error(`Unexpected value for column "${column}": ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Records a piece of feedback against a run, keeping whatever a previous run
 * already learned about it — the reply and resolve history is what makes a
 * re-run idempotent, so it must survive re-fetching the thread from GitHub.
 */
export function upsertThread(db: Database, input: UpsertThreadInput): PrFeedbackThread {
  const existing = db
    .prepare('SELECT * FROM pr_feedback_threads WHERE run_id = ? AND thread_id = ?')
    .get(input.runId, input.threadId);
  if (existing) {
    const current = mapThread(existing);
    return (
      updateThread(db, current.id, {
        feedbackKey: input.feedbackKey,
        firstCommentId: input.firstCommentId,
      }) ?? current
    );
  }

  const now = nowIso();
  db.prepare(
    `INSERT INTO pr_feedback_threads
       (run_id, thread_id, kind, first_comment_id, feedback_key, outcome, summary,
        replied_at, reply_url, replied_head_sha, resolved_at, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.runId,
    input.threadId,
    input.kind,
    input.firstCommentId,
    input.feedbackKey,
    now,
    now,
  );

  const inserted = db
    .prepare('SELECT * FROM pr_feedback_threads WHERE run_id = ? AND thread_id = ?')
    .get(input.runId, input.threadId);
  if (!inserted) throw new Error('The feedback thread disappeared immediately after insertion.');
  return mapThread(inserted);
}

export function listThreads(db: Database, runId: string): PrFeedbackThread[] {
  return db
    .prepare('SELECT * FROM pr_feedback_threads WHERE run_id = ? ORDER BY id ASC')
    .all(runId)
    .map(mapThread);
}

export function updateThread(
  db: Database,
  id: number,
  input: UpdateThreadInput,
): PrFeedbackThread | null {
  const assignments: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, column] of Object.entries(THREAD_COLUMNS)) {
    const value = input[key as keyof UpdateThreadInput];
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return getThread(db, id);

  assignments.push('updated_at = ?');
  values.push(nowIso(), id);

  const result = db
    .prepare(`UPDATE pr_feedback_threads SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...values);
  return changeCount(result) === 0 ? null : getThread(db, id);
}

export function getThread(db: Database, id: number): PrFeedbackThread | null {
  const row = db.prepare('SELECT * FROM pr_feedback_threads WHERE id = ?').get(id);
  return row ? mapThread(row) : null;
}
