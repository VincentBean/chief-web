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
  withTransaction,
} from './sqlite.js';
import { isValidSessionName, PR_TARGET_BRANCHES, type PrTargetBranch } from './sessions.js';

/**
 * Recurring tasks (US-001): a stored prompt plus a cron expression, from which
 * the scheduler spawns one ordinary session per due occurrence.
 *
 * The definition and its history are two tables. `recurring_tasks` is what the
 * user edits; `recurring_task_occurrences` is one row per moment the task came
 * due — including the ones that create no session at all, because a skip is as
 * much a part of the history as a run that opened a pull request.
 */

/** What became of one occurrence. */
export const RECURRING_TASK_OUTCOMES = [
  /** A session was created and the build was queued; not over yet. */
  'started',
  /** The occurrence was not fired — the previous run is still in the way. */
  'skipped',
  /** Firing itself failed: the container was refused, the clone did not land. */
  'fire-failed',
  /** The run finished with commits, and a pull request is open for them. */
  'pr-opened',
  /** The run finished having changed nothing, so no pull request was opened. */
  'clean',
  /** The run failed somewhere in the build or the delivery. */
  'failed',
] as const;
export type RecurringTaskOutcome = (typeof RECURRING_TASK_OUTCOMES)[number];

/** What the UI calls an outcome, in the operator's words. */
export function recurringTaskOutcomeLabel(outcome: RecurringTaskOutcome): string {
  switch (outcome) {
    case 'started':
      return 'running';
    case 'skipped':
      return 'skipped';
    case 'fire-failed':
      return 'could not start';
    case 'pr-opened':
      return 'pull request opened';
    case 'clean':
      return 'nothing to change';
    case 'failed':
      return 'failed';
  }
}

/**
 * Task names use the session alphabet: every run is named
 * `<name>-<YYYYMMDD-HHmm>`, which has to stay a legal session name.
 */
export function isValidRecurringTaskName(name: string): boolean {
  return isValidSessionName(name);
}

function assertValidRecurringTaskName(name: string): void {
  if (!isValidRecurringTaskName(name)) {
    throw new Error(
      `Invalid recurring task name "${name}": use letters, numbers, hyphens and underscores only`,
    );
  }
}

export interface RecurringTask {
  readonly id: string;
  readonly repositoryId: string;
  readonly name: string;
  /** What the run is asked to do; embedded verbatim in the generated PRD. */
  readonly prompt: string;
  /** Five-field cron, evaluated in the server's timezone. */
  readonly cronExpression: string;
  readonly baseBranch: string;
  readonly prTarget: PrTargetBranch;
  readonly runCodeReview: boolean;
  readonly paused: boolean;
  /**
   * UTC ISO moment the next occurrence is due, and null when nothing is
   * scheduled — where pausing leaves a task until it is resumed.
   */
  readonly nextRunAt: string | null;
  /**
   * Denormalized mirror of the newest occurrence's outcome. Never set by hand:
   * {@link recordRecurringTaskOccurrence} and
   * {@link updateRecurringTaskOccurrence} keep it in step with the history.
   */
  readonly lastOutcome: RecurringTaskOutcome | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRecurringTaskInput {
  readonly repositoryId: string;
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression: string;
  readonly baseBranch: string;
  readonly prTarget: PrTargetBranch;
  /** Defaults to false: a task asks for a review only when it says so. */
  readonly runCodeReview?: boolean;
  /** Defaults to false; a task created paused simply never comes due. */
  readonly paused?: boolean;
  /** The first occurrence, computed from the cron expression by the caller. */
  readonly nextRunAt?: string | null;
}

export interface UpdateRecurringTaskInput {
  readonly name?: string;
  readonly prompt?: string;
  readonly cronExpression?: string;
  readonly baseBranch?: string;
  readonly prTarget?: PrTargetBranch;
  readonly runCodeReview?: boolean;
  readonly paused?: boolean;
  readonly nextRunAt?: string | null;
}

export interface ListRecurringTasksFilter {
  readonly repositoryId?: string;
  readonly paused?: boolean;
}

const TASK_COLUMNS: Record<keyof UpdateRecurringTaskInput, string> = {
  name: 'name',
  prompt: 'prompt',
  cronExpression: 'cron_expression',
  baseBranch: 'base_branch',
  prTarget: 'pr_target',
  runCodeReview: 'run_code_review',
  paused: 'paused',
  nextRunAt: 'next_run_at',
};

/** SQLite has no boolean type; flags are stored as 0/1 integers. */
function sqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}

function outcomeOf(row: Row, column: string): RecurringTaskOutcome | null {
  const value = nullableText(row, column);
  if (value === null) return null;
  if (!(RECURRING_TASK_OUTCOMES as readonly string[]).includes(value)) {
    throw new Error(`Unexpected value for column "${column}": ${JSON.stringify(value)}`);
  }
  return value as RecurringTaskOutcome;
}

export function mapRecurringTask(row: Row): RecurringTask {
  return {
    id: text(row, 'id'),
    repositoryId: text(row, 'repository_id'),
    name: text(row, 'name'),
    prompt: text(row, 'prompt'),
    cronExpression: text(row, 'cron_expression'),
    baseBranch: text(row, 'base_branch'),
    prTarget: enumeration(row, 'pr_target', PR_TARGET_BRANCHES),
    runCodeReview: integer(row, 'run_code_review') === 1,
    paused: integer(row, 'paused') === 1,
    nextRunAt: nullableText(row, 'next_run_at'),
    lastOutcome: outcomeOf(row, 'last_outcome'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function createRecurringTask(
  db: Database,
  input: CreateRecurringTaskInput,
): RecurringTask {
  assertValidRecurringTaskName(input.name);

  const now = nowIso();
  const task: RecurringTask = {
    id: randomUUID(),
    repositoryId: input.repositoryId,
    name: input.name,
    prompt: input.prompt,
    cronExpression: input.cronExpression,
    baseBranch: input.baseBranch,
    prTarget: input.prTarget,
    runCodeReview: input.runCodeReview ?? false,
    paused: input.paused ?? false,
    nextRunAt: input.nextRunAt ?? null,
    lastOutcome: null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO recurring_tasks
       (id, repository_id, name, prompt, cron_expression, base_branch, pr_target,
        run_code_review, paused, next_run_at, last_outcome, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.repositoryId,
    task.name,
    task.prompt,
    task.cronExpression,
    task.baseBranch,
    task.prTarget,
    sqlBoolean(task.runCodeReview),
    sqlBoolean(task.paused),
    task.nextRunAt,
    task.lastOutcome,
    task.createdAt,
    task.updatedAt,
  );

  return task;
}

export function getRecurringTask(db: Database, id: string): RecurringTask | null {
  const row = db.prepare('SELECT * FROM recurring_tasks WHERE id = ?').get(id);
  return row ? mapRecurringTask(row) : null;
}

/** The other half of `UNIQUE (repository_id, name)`: what a create checks. */
export function getRecurringTaskByName(
  db: Database,
  repositoryId: string,
  name: string,
): RecurringTask | null {
  const row = db
    .prepare('SELECT * FROM recurring_tasks WHERE repository_id = ? AND name = ?')
    .get(repositoryId, name);
  return row ? mapRecurringTask(row) : null;
}

export function listRecurringTasks(
  db: Database,
  filter: ListRecurringTasksFilter = {},
): RecurringTask[] {
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filter.repositoryId !== undefined) {
    conditions.push('repository_id = :repository_id');
    params[':repository_id'] = filter.repositoryId;
  }
  if (filter.paused !== undefined) {
    conditions.push('paused = :paused');
    params[':paused'] = sqlBoolean(filter.paused);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM recurring_tasks${where} ORDER BY name ASC, id ASC`)
    .all(params)
    .map(mapRecurringTask);
}

/**
 * Tasks whose next occurrence has come due — the scheduler's whole query.
 *
 * A paused task is never due, and neither is one with no next occurrence at
 * all. The id is the tie-break so two tasks due in the same millisecond still
 * have a total order every reader agrees on.
 */
export function listDueRecurringTasks(db: Database, now: string = nowIso()): RecurringTask[] {
  return db
    .prepare(
      `SELECT * FROM recurring_tasks
        WHERE paused = 0 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC`,
    )
    .all(now)
    .map(mapRecurringTask);
}

export function countRecurringTasksForRepository(db: Database, repositoryId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM recurring_tasks WHERE repository_id = ?')
    .get(repositoryId);
  return row ? integer(row, 'count') : 0;
}

/** Applies the provided fields only; returns the updated row, or null if absent. */
export function updateRecurringTask(
  db: Database,
  id: string,
  patch: UpdateRecurringTaskInput,
): RecurringTask | null {
  if (patch.name !== undefined) assertValidRecurringTaskName(patch.name);

  const assignments: string[] = [];
  const params: Record<string, string | number | null> = { ':id': id, ':updated_at': nowIso() };

  for (const [field, column] of Object.entries(TASK_COLUMNS)) {
    const value = patch[field as keyof UpdateRecurringTaskInput];
    if (value === undefined) continue;
    assignments.push(`${column} = :${column}`);
    params[`:${column}`] = typeof value === 'boolean' ? sqlBoolean(value) : value;
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = :updated_at');
    db.prepare(`UPDATE recurring_tasks SET ${assignments.join(', ')} WHERE id = :id`).run(params);
  }

  return getRecurringTask(db, id);
}

/**
 * Deletes a task and, by cascade, its occurrence history. The sessions it
 * already spawned are left alone: their `recurring_task_id` is nulled by the
 * foreign key, and they stay ordinary sessions on the dashboard (FR-11).
 */
export function deleteRecurringTask(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM recurring_tasks WHERE id = ?').run(id)) > 0;
}

/* -------------------------------------------------------------- occurrences */

export interface RecurringTaskOccurrence {
  readonly id: number;
  readonly recurringTaskId: string;
  /** UTC ISO moment the task came due. */
  readonly occurredAt: string;
  readonly outcome: RecurringTaskOutcome;
  /** The skip reason, the failure, or the pull request link. */
  readonly detail: string | null;
  /** The session this occurrence spawned; null for a skip or a fire failure. */
  readonly sessionId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecordOccurrenceInput {
  readonly recurringTaskId: string;
  readonly outcome: RecurringTaskOutcome;
  readonly detail?: string | null;
  readonly sessionId?: string | null;
  /** Defaults to now; the scheduler passes the moment it decided. */
  readonly occurredAt?: string;
}

export interface UpdateOccurrenceInput {
  readonly outcome?: RecurringTaskOutcome;
  readonly detail?: string | null;
  readonly sessionId?: string | null;
}

const OCCURRENCE_COLUMNS: Record<keyof UpdateOccurrenceInput, string> = {
  outcome: 'outcome',
  detail: 'detail',
  sessionId: 'session_id',
};

export function mapRecurringTaskOccurrence(row: Row): RecurringTaskOccurrence {
  return {
    id: integer(row, 'id'),
    recurringTaskId: text(row, 'recurring_task_id'),
    occurredAt: text(row, 'occurred_at'),
    outcome: enumeration(row, 'outcome', RECURRING_TASK_OUTCOMES),
    detail: nullableText(row, 'detail'),
    sessionId: nullableText(row, 'session_id'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

/**
 * Points the task's `last_outcome` at its newest occurrence — the one write
 * that keeps the denormalized mirror honest. Called after every occurrence
 * insert and update, including updates to a row that is no longer the newest,
 * which is why it re-reads rather than copying the outcome it was handed.
 */
function syncLastOutcome(db: Database, recurringTaskId: string): void {
  const row = db
    .prepare(
      `SELECT outcome FROM recurring_task_occurrences
        WHERE recurring_task_id = ?
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
    )
    .get(recurringTaskId);
  const outcome = row ? enumeration(row, 'outcome', RECURRING_TASK_OUTCOMES) : null;
  db.prepare('UPDATE recurring_tasks SET last_outcome = ?, updated_at = ? WHERE id = ?').run(
    outcome,
    nowIso(),
    recurringTaskId,
  );
}

/**
 * Writes one occurrence and mirrors it onto the task's `last_outcome`.
 *
 * Both writes happen in one transaction, so the mirror can never disagree with
 * the history. Like every transaction here it is not re-entrant: never call
 * this from inside another {@link withTransaction}.
 */
export function recordRecurringTaskOccurrence(
  db: Database,
  input: RecordOccurrenceInput,
): RecurringTaskOccurrence {
  const now = nowIso();
  return withTransaction(db, () => {
    const result = db
      .prepare(
        `INSERT INTO recurring_task_occurrences
           (recurring_task_id, occurred_at, outcome, detail, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.recurringTaskId,
        input.occurredAt ?? now,
        input.outcome,
        input.detail ?? null,
        input.sessionId ?? null,
        now,
        now,
      );

    syncLastOutcome(db, input.recurringTaskId);

    const id = Number(result.lastInsertRowid);
    const occurrence = getRecurringTaskOccurrence(db, id);
    if (!occurrence) throw new Error('The occurrence disappeared immediately after insertion.');
    return occurrence;
  });
}

export function getRecurringTaskOccurrence(
  db: Database,
  id: number,
): RecurringTaskOccurrence | null {
  const row = db.prepare('SELECT * FROM recurring_task_occurrences WHERE id = ?').get(id);
  return row ? mapRecurringTaskOccurrence(row) : null;
}

/** A task's history, newest first — the order the detail page reads it in. */
export function listRecurringTaskOccurrences(
  db: Database,
  recurringTaskId: string,
  limit?: number,
): RecurringTaskOccurrence[] {
  const clause = limit === undefined ? '' : ' LIMIT :limit';
  const params: Record<string, string | number> = { ':recurring_task_id': recurringTaskId };
  if (limit !== undefined) params[':limit'] = limit;

  return db
    .prepare(
      `SELECT * FROM recurring_task_occurrences
        WHERE recurring_task_id = :recurring_task_id
        ORDER BY occurred_at DESC, id DESC${clause}`,
    )
    .all(params)
    .map(mapRecurringTaskOccurrence);
}

/** The newest occurrence, which is what `last_outcome` mirrors. */
export function latestRecurringTaskOccurrence(
  db: Database,
  recurringTaskId: string,
): RecurringTaskOccurrence | null {
  return listRecurringTaskOccurrences(db, recurringTaskId, 1)[0] ?? null;
}

/**
 * Settles an occurrence: the `started` row a firing wrote becomes `pr-opened`,
 * `clean` or `failed` once the run is over. Re-mirrors `last_outcome`, so the
 * task list follows a run to its end without a second call.
 *
 * Not re-entrant, for the same reason {@link recordRecurringTaskOccurrence}
 * is not.
 */
export function updateRecurringTaskOccurrence(
  db: Database,
  id: number,
  patch: UpdateOccurrenceInput,
): RecurringTaskOccurrence | null {
  const existing = getRecurringTaskOccurrence(db, id);
  if (!existing) return null;

  const assignments: string[] = [];
  const params: Record<string, string | number | null> = { ':id': id, ':updated_at': nowIso() };

  for (const [field, column] of Object.entries(OCCURRENCE_COLUMNS)) {
    const value = patch[field as keyof UpdateOccurrenceInput];
    if (value === undefined) continue;
    assignments.push(`${column} = :${column}`);
    params[`:${column}`] = value;
  }
  if (assignments.length === 0) return existing;

  assignments.push('updated_at = :updated_at');
  return withTransaction(db, () => {
    db.prepare(
      `UPDATE recurring_task_occurrences SET ${assignments.join(', ')} WHERE id = :id`,
    ).run(params);
    syncLastOutcome(db, existing.recurringTaskId);
    return getRecurringTaskOccurrence(db, id);
  });
}
