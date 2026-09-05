import {
  createRecurringTask,
  type Database,
  deleteRecurringTask,
  getRecurringTask,
  getRecurringTaskByName,
  getRepository,
  getSession,
  isValidRecurringTaskName,
  listRecurringTaskOccurrences,
  listRecurringTasks,
  type PrTargetBranch,
  type RecurringTask,
  type RecurringTaskOutcome,
  recurringTaskOutcomeLabel,
  type SessionStatus,
  updateRecurringTask,
} from '../db/index.js';
import { describeCron, nextCronRun, validateCron } from '../lib/cron.js';

/**
 * Recurring task domain layer (US-003): everything the API is allowed to do to
 * a task definition, with the cron module (US-002) as the single authority on
 * what a schedule means.
 *
 * The routes parse request *shapes*; the rules that outlive any one transport
 * — the name a run has to fit into, the expression the scheduler must be able
 * to fire, when `next_run_at` is recomputed — live here.
 */

/**
 * A run is named `<task-name>-<YYYYMMDD-HHmm>`, so the stored name has to be
 * short enough that the whole thing is still a legal session name.
 */
const RUN_NAME_SUFFIX_LENGTH = '-YYYYMMDD-HHmm'.length;
/** Kept in step with the session router's own limit. */
const MAX_SESSION_NAME_LENGTH = 60;
export const MAX_RECURRING_TASK_NAME_LENGTH = MAX_SESSION_NAME_LENGTH - RUN_NAME_SUFFIX_LENGTH;

/** A failure with the HTTP status and error code the route should answer with. */
export class RecurringTaskError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RecurringTaskError';
  }
}

/** A task as the API returns it. */
export interface RecurringTaskView {
  readonly id: string;
  readonly repositoryId: string;
  /** Denormalised for the UI, which lists tasks across repositories. */
  readonly repositoryName: string;
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression: string;
  /**
   * The cron expression in words ("At 03:00, only on Monday"), so no client
   * has to parse cron itself. `null` only for a row whose expression stopped
   * being valid — which the API refuses to store in the first place.
   */
  readonly scheduleDescription: string | null;
  readonly baseBranch: string;
  readonly prTarget: PrTargetBranch;
  readonly runCodeReview: boolean;
  readonly paused: boolean;
  readonly nextRunAt: string | null;
  readonly lastOutcome: RecurringTaskOutcome | null;
  /** `last_outcome` in the operator's words, for the list's status column. */
  readonly lastOutcomeLabel: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The run an occurrence spawned, as much of it as the history page shows. */
export interface RecurringTaskRunView {
  readonly id: string;
  readonly name: string;
  readonly status: SessionStatus;
  readonly prUrl: string | null;
}

/** One row of a task's history. */
export interface RecurringTaskOccurrenceView {
  readonly id: number;
  readonly occurredAt: string;
  readonly outcome: RecurringTaskOutcome;
  readonly outcomeLabel: string;
  readonly detail: string | null;
  /** `null` for a skip, a fire failure, or a run that has since been deleted. */
  readonly session: RecurringTaskRunView | null;
}

/** What `GET /recurring-tasks/:id` answers with: the task plus its history. */
export interface RecurringTaskDetailView extends RecurringTaskView {
  readonly occurrences: readonly RecurringTaskOccurrenceView[];
}

export interface CreateRecurringTaskRequest {
  readonly repositoryId: string;
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression: string;
  /** Omitted means "the repository's default base branch". */
  readonly baseBranch?: string;
  readonly prTarget?: PrTargetBranch;
  readonly runCodeReview?: boolean;
  readonly paused?: boolean;
}

export interface UpdateRecurringTaskRequest {
  readonly name?: string;
  readonly prompt?: string;
  readonly cronExpression?: string;
  readonly baseBranch?: string;
  readonly prTarget?: PrTargetBranch;
  readonly runCodeReview?: boolean;
  readonly paused?: boolean;
}

export function toRecurringTaskView(db: Database, task: RecurringTask): RecurringTaskView {
  const repository = getRepository(db, task.repositoryId);
  return {
    id: task.id,
    repositoryId: task.repositoryId,
    repositoryName: repository?.name ?? 'unknown repository',
    name: task.name,
    prompt: task.prompt,
    cronExpression: task.cronExpression,
    scheduleDescription: describeCron(task.cronExpression),
    baseBranch: task.baseBranch,
    prTarget: task.prTarget,
    runCodeReview: task.runCodeReview,
    paused: task.paused,
    nextRunAt: task.nextRunAt,
    lastOutcome: task.lastOutcome,
    lastOutcomeLabel: task.lastOutcome === null ? null : recurringTaskOutcomeLabel(task.lastOutcome),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function listRecurringTaskViews(db: Database, repositoryId?: string): RecurringTaskView[] {
  const filter = repositoryId === undefined ? {} : { repositoryId };
  return listRecurringTasks(db, filter).map((task) => toRecurringTaskView(db, task));
}

/** The task plus its occurrence history, newest first; `null` if there is no such task. */
export function getRecurringTaskDetailView(
  db: Database,
  id: string,
): RecurringTaskDetailView | null {
  const task = getRecurringTask(db, id);
  if (task === null) return null;

  const occurrences = listRecurringTaskOccurrences(db, id).map((occurrence) => {
    const session = occurrence.sessionId === null ? null : getSession(db, occurrence.sessionId);
    return {
      id: occurrence.id,
      occurredAt: occurrence.occurredAt,
      outcome: occurrence.outcome,
      outcomeLabel: recurringTaskOutcomeLabel(occurrence.outcome),
      detail: occurrence.detail,
      session:
        session === null
          ? null
          : {
              id: session.id,
              name: session.name,
              status: session.status,
              prUrl: session.prUrl,
            },
    };
  });

  return { ...toRecurringTaskView(db, task), occurrences };
}

/** Rejects a name a run could not be built from, with the reason. */
function assertUsableName(name: string): void {
  if (name.length > MAX_RECURRING_TASK_NAME_LENGTH) {
    throw new RecurringTaskError(
      400,
      'invalid_task_name',
      `The task name must be at most ${String(MAX_RECURRING_TASK_NAME_LENGTH)} characters — every run is named "<name>-YYYYMMDD-HHmm" and has to stay a legal session name.`,
    );
  }
  if (!isValidRecurringTaskName(name)) {
    throw new RecurringTaskError(
      400,
      'invalid_task_name',
      'Use letters, numbers, hyphens and underscores only — the name becomes the run session and its feature branch.',
    );
  }
}

/** The cron module's own message is what a rejected expression answers with. */
function assertUsableCron(expression: string): void {
  const validation = validateCron(expression);
  if (!validation.ok) {
    throw new RecurringTaskError(400, 'invalid_cron_expression', validation.message);
  }
}

/**
 * The next occurrence as a UTC ISO string. The expression has already been
 * validated, so `null` here only means "no further occurrence ever".
 */
function firstRunAt(expression: string, from: Date = new Date()): string | null {
  return nextCronRun(expression, from)?.toISOString() ?? null;
}

function assertNameIsFree(
  db: Database,
  repositoryId: string,
  name: string,
  exceptId?: string,
): void {
  const existing = getRecurringTaskByName(db, repositoryId, name);
  if (existing !== null && existing.id !== exceptId) {
    throw new RecurringTaskError(
      409,
      'task_name_taken',
      `This repository already has a recurring task named "${name}".`,
    );
  }
}

export function createRecurringTaskFromRequest(
  db: Database,
  request: CreateRecurringTaskRequest,
): RecurringTaskView {
  assertUsableName(request.name);
  assertUsableCron(request.cronExpression);

  const repository = getRepository(db, request.repositoryId);
  if (repository === null) {
    throw new RecurringTaskError(404, 'repository_not_found', 'No such repository.');
  }
  if (request.prompt.trim() === '') {
    throw new RecurringTaskError(400, 'invalid_prompt', 'A prompt is required.');
  }
  assertNameIsFree(db, request.repositoryId, request.name);

  const paused = request.paused ?? false;
  const task = createRecurringTask(db, {
    repositoryId: request.repositoryId,
    name: request.name,
    prompt: request.prompt.trim(),
    cronExpression: request.cronExpression.trim(),
    baseBranch: request.baseBranch ?? repository.defaultBaseBranch,
    prTarget: request.prTarget ?? 'main',
    runCodeReview: request.runCodeReview ?? false,
    paused,
    // A task created paused waits for the resume to give it a schedule.
    nextRunAt: paused ? null : firstRunAt(request.cronExpression),
  });

  return toRecurringTaskView(db, task);
}

/**
 * Applies the fields the request carries and, with them, the two moments
 * `next_run_at` has to be recomputed: a changed expression (the old next run
 * belongs to an expression nobody asked for any more) and a resume (a task
 * that was paused has no schedule at all, so it is computed from now).
 *
 * Pausing clears it, which is the same "no next occurrence" the due-query
 * already skips.
 */
export function updateRecurringTaskFromRequest(
  db: Database,
  id: string,
  request: UpdateRecurringTaskRequest,
): RecurringTaskView {
  const task = getRecurringTask(db, id);
  if (task === null) {
    throw new RecurringTaskError(404, 'recurring_task_not_found', 'No such recurring task.');
  }

  if (request.name !== undefined) {
    assertUsableName(request.name);
    assertNameIsFree(db, task.repositoryId, request.name, task.id);
  }
  if (request.cronExpression !== undefined) assertUsableCron(request.cronExpression);
  if (request.prompt !== undefined && request.prompt.trim() === '') {
    throw new RecurringTaskError(400, 'invalid_prompt', 'A prompt is required.');
  }

  const cronExpression = request.cronExpression?.trim() ?? task.cronExpression;
  const paused = request.paused ?? task.paused;
  const cronChanged = cronExpression !== task.cronExpression;
  const resumed = task.paused && !paused;

  let nextRunAt: string | null | undefined;
  if (paused) nextRunAt = null;
  else if (resumed || cronChanged) nextRunAt = firstRunAt(cronExpression);

  const updated = updateRecurringTask(db, id, {
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.prompt === undefined ? {} : { prompt: request.prompt.trim() }),
    ...(request.cronExpression === undefined ? {} : { cronExpression }),
    ...(request.baseBranch === undefined ? {} : { baseBranch: request.baseBranch }),
    ...(request.prTarget === undefined ? {} : { prTarget: request.prTarget }),
    ...(request.runCodeReview === undefined ? {} : { runCodeReview: request.runCodeReview }),
    ...(request.paused === undefined ? {} : { paused: request.paused }),
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
  });
  if (updated === null) {
    throw new RecurringTaskError(404, 'recurring_task_not_found', 'No such recurring task.');
  }

  return toRecurringTaskView(db, updated);
}

/**
 * Deletes the definition and its history. The runs it already spawned are left
 * alone — the foreign key nulls their `recurring_task_id` and they stay
 * ordinary sessions on the dashboard (FR-11).
 */
export function deleteRecurringTaskById(db: Database, id: string): void {
  if (!deleteRecurringTask(db, id)) {
    throw new RecurringTaskError(404, 'recurring_task_not_found', 'No such recurring task.');
  }
}

/**
 * What `GET /api/cron/preview` answers with: an expression judged, without
 * anything being stored.
 *
 * Deliberately not an error response. The form calls this on every keystroke,
 * and half of what it sends is a half-typed expression; "0 3 * *" is a
 * question, not a failed request. `valid` is the answer, `message` is the
 * cron module's own words for why not, and both descriptions come from the
 * same place the stored task's `scheduleDescription` does.
 */
export interface CronPreview {
  /** Echoed back, so a late response can be matched to what was typed. */
  readonly expression: string;
  readonly valid: boolean;
  /** "At 03:00, only on Monday"; null when the expression is not valid. */
  readonly description: string | null;
  /** The next occurrence as a UTC ISO string, for the visitor's own clock. */
  readonly nextRunAt: string | null;
  /** Why the expression was rejected; null when it was not. */
  readonly message: string | null;
}

export function previewCron(expression: string, from: Date = new Date()): CronPreview {
  const validation = validateCron(expression);
  if (!validation.ok) {
    return {
      expression,
      valid: false,
      description: null,
      nextRunAt: null,
      message: validation.message,
    };
  }
  return {
    expression,
    valid: true,
    description: validation.description,
    // A valid expression with no further occurrence is possible (`0 0 30 2 *`
    // is refused, but a date-bound one need not recur), so this stays nullable.
    nextRunAt: firstRunAt(expression, from),
    message: null,
  };
}
