import { type Response, Router } from 'express';

import type { Database } from '../db/index.js';
import { PR_TARGET_BRANCHES, type PrTargetBranch } from '../db/index.js';
import {
  type CreateRecurringTaskRequest,
  createRecurringTaskFromRequest,
  deleteRecurringTaskById,
  getRecurringTaskDetailView,
  listRecurringTaskViews,
  RecurringTaskError,
  type UpdateRecurringTaskRequest,
  updateRecurringTaskFromRequest,
} from '../recurringtasks/index.js';

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

const MAX_BRANCH_LENGTH = 255;
const MAX_PROMPT_LENGTH = 10_000;

/**
 * Recurring tasks (US-003): the definitions the scheduler fires sessions from.
 *
 * The router does shape checking only — is this field a string, is that one a
 * boolean. Everything that is a rule about tasks (the name a run has to fit
 * into, the cron expression the scheduler must be able to fire, when
 * `next_run_at` is recomputed) belongs to the domain layer, so the UI and the
 * scheduler cannot drift apart. Auth is the API-wide guard in `app.ts`, the
 * same one the session routes sit behind.
 */
export function createRecurringTasksRouter(db: Database): Router {
  const router = Router();

  router.get('/recurring-tasks', (req, res) => {
    const repositoryId = req.query['repositoryId'];
    if (repositoryId !== undefined && typeof repositoryId !== 'string') {
      res
        .status(400)
        .json({ error: 'invalid_repository_id', message: 'repositoryId must be a string.' });
      return;
    }
    res.status(200).json({ recurringTasks: listRecurringTaskViews(db, repositoryId) });
  });

  router.get('/recurring-tasks/:id', (req, res) => {
    const task = getRecurringTaskDetailView(db, req.params.id);
    if (task === null) {
      res.status(404).json({ error: 'recurring_task_not_found', message: 'No such recurring task.' });
      return;
    }
    res.status(200).json(task);
  });

  router.post('/recurring-tasks', (req, res) => {
    const parsed = parseCreate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }
    try {
      res.status(201).json(createRecurringTaskFromRequest(db, parsed));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  // Edits and pause/resume are one endpoint: `paused` is a field of the task
  // like any other, and a resume that also fixed the expression should not
  // have to be two requests.
  router.put('/recurring-tasks/:id', (req, res) => {
    const parsed = parseUpdate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }
    try {
      res.status(200).json(updateRecurringTaskFromRequest(db, req.params.id, parsed));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  router.delete('/recurring-tasks/:id', (req, res) => {
    try {
      deleteRecurringTaskById(db, req.params.id);
      res.status(204).end();
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof RecurringTaskError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'recurring_task_request_failed', message: String(cause) });
}

/** `null` when the body is a usable JSON object. */
function invalidBody(body: unknown): Invalid | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }
  return null;
}

/** `undefined` when the field is absent; an `Invalid` when it is the wrong shape. */
function optionalString(
  input: Record<string, unknown>,
  field: string,
  code: string,
): string | undefined | Invalid {
  if (!(field in input) || input[field] === undefined || input[field] === null) return undefined;
  const raw = input[field];
  if (typeof raw !== 'string') return { error: code, message: `${field} must be a string.` };
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/** `undefined` when the field is absent; an `Invalid` when it is not a boolean. */
function optionalBoolean(
  input: Record<string, unknown>,
  field: string,
  code: string,
): boolean | undefined | Invalid {
  if (!(field in input) || input[field] === undefined || input[field] === null) return undefined;
  const raw = input[field];
  if (typeof raw !== 'boolean') return { error: code, message: `${field} must be a boolean.` };
  return raw;
}

/** Git forbids whitespace and a handful of metacharacters in ref names. */
function validateBranch(branch: string): Invalid | null {
  if (branch.length > MAX_BRANCH_LENGTH || /[\s~^:?*[\\]/.test(branch) || branch.startsWith('-')) {
    return { error: 'invalid_base_branch', message: 'That is not a valid git branch name.' };
  }
  return null;
}

function validatePrompt(prompt: string): Invalid | null {
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      error: 'invalid_prompt',
      message: `The prompt must be at most ${String(MAX_PROMPT_LENGTH)} characters.`,
    };
  }
  return null;
}

function isPrTarget(value: string): value is PrTargetBranch {
  return (PR_TARGET_BRANCHES as readonly string[]).includes(value);
}

/** The shared half of both bodies: everything that is editable after creation. */
interface Fields {
  readonly name?: string;
  readonly prompt?: string;
  readonly cronExpression?: string;
  readonly baseBranch?: string;
  readonly prTarget?: PrTargetBranch;
  readonly runCodeReview?: boolean;
  readonly paused?: boolean;
}

function parseFields(input: Record<string, unknown>): Fields | Invalid {
  const name = optionalString(input, 'name', 'invalid_task_name');
  if (typeof name === 'object') return name;

  const prompt = optionalString(input, 'prompt', 'invalid_prompt');
  if (typeof prompt === 'object') return prompt;
  if (prompt !== undefined) {
    const badPrompt = validatePrompt(prompt);
    if (badPrompt) return badPrompt;
  }

  const cronExpression = optionalString(input, 'cronExpression', 'invalid_cron_expression');
  if (typeof cronExpression === 'object') return cronExpression;

  const baseBranch = optionalString(input, 'baseBranch', 'invalid_base_branch');
  if (typeof baseBranch === 'object') return baseBranch;
  if (baseBranch !== undefined) {
    const badBranch = validateBranch(baseBranch);
    if (badBranch) return badBranch;
  }

  const prTarget = optionalString(input, 'prTarget', 'invalid_pr_target');
  if (typeof prTarget === 'object') return prTarget;
  if (prTarget !== undefined && !isPrTarget(prTarget)) {
    return {
      error: 'invalid_pr_target',
      message: `The PR target must be one of: ${PR_TARGET_BRANCHES.join(', ')}.`,
    };
  }

  const runCodeReview = optionalBoolean(input, 'runCodeReview', 'invalid_run_code_review');
  if (typeof runCodeReview === 'object') return runCodeReview;

  const paused = optionalBoolean(input, 'paused', 'invalid_paused');
  if (typeof paused === 'object') return paused;

  return {
    ...(name === undefined ? {} : { name }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(cronExpression === undefined ? {} : { cronExpression }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(prTarget === undefined ? {} : { prTarget }),
    ...(runCodeReview === undefined ? {} : { runCodeReview }),
    ...(paused === undefined ? {} : { paused }),
  };
}

function parseCreate(body: unknown): CreateRecurringTaskRequest | Invalid {
  const badBody = invalidBody(body);
  if (badBody) return badBody;
  const input = body as Record<string, unknown>;

  const repositoryId = optionalString(input, 'repositoryId', 'invalid_repository_id');
  if (typeof repositoryId === 'object') return repositoryId;
  if (repositoryId === undefined) {
    return { error: 'invalid_repository_id', message: 'A repository is required.' };
  }

  const fields = parseFields(input);
  if ('error' in fields) return fields;

  if (fields.name === undefined) {
    return { error: 'invalid_task_name', message: 'A task name is required.' };
  }
  if (fields.prompt === undefined) {
    return { error: 'invalid_prompt', message: 'A prompt is required.' };
  }
  if (fields.cronExpression === undefined) {
    return { error: 'invalid_cron_expression', message: 'A cron expression is required.' };
  }

  return {
    ...fields,
    repositoryId,
    name: fields.name,
    prompt: fields.prompt,
    cronExpression: fields.cronExpression,
  };
}

function parseUpdate(body: unknown): UpdateRecurringTaskRequest | Invalid {
  const badBody = invalidBody(body);
  if (badBody) return badBody;
  return parseFields(body as Record<string, unknown>);
}
