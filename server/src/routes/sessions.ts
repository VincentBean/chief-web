import { type Response, Router } from 'express';

import { PR_TARGET_BRANCHES, type PrTargetBranch, SESSION_NAME_PATTERN } from '../db/index.js';
import {
  type CreateSessionRequest,
  SessionError,
  type SessionService,
} from '../sessions/index.js';

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

const MAX_SESSION_NAME_LENGTH = 60;
const MAX_BRANCH_LENGTH = 255;

/**
 * Sessions (US-010).
 *
 * Creating one and retrying its setup answer with the same body — the session
 * plus the outcome of the clone — because a failed clone is a *successful*
 * request whose result the operator has to read, exactly like the repository
 * connection test. `POST /sessions` is additionally behind `requireClaudeAuth`,
 * mounted in `app.ts` ahead of this router.
 */
export function createSessionsRouter(sessions: SessionService): Router {
  const router = Router();

  router.get('/sessions', (req, res) => {
    const repositoryId = req.query['repositoryId'];
    if (repositoryId !== undefined && typeof repositoryId !== 'string') {
      res
        .status(400)
        .json({ error: 'invalid_repository_id', message: 'repositoryId must be a string.' });
      return;
    }
    res.status(200).json({ sessions: sessions.list(repositoryId) });
  });

  router.get('/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (session === null) {
      res.status(404).json({ error: 'session_not_found', message: 'No such session.' });
      return;
    }
    res.status(200).json(session);
  });

  router.post('/sessions', (req, res) => {
    const parsed = parseCreate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }

    sessions
      .create(parsed)
      .then((result) => res.status(201).json(result))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  // "Retry setup": re-runs the clone against the same workspace.
  router.post('/sessions/:id/setup', (req, res) => {
    sessions
      .setup(req.params.id)
      .then((result) => res.status(200).json(result))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  // The parsed story list of a ready session (US-012).
  router.get('/sessions/:id/stories', (req, res) => {
    try {
      res.status(200).json({ stories: sessions.stories(req.params.id) });
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  // "Mark ready". A PRD that does not parse answers 200 with `ok: false`; a
  // session whose schedule passed while it was pending is started here and
  // then, which is why this is the one transition that awaits (US-017).
  router.post('/sessions/:id/ready', (req, res) => {
    sessions
      .markReady(req.params.id)
      .then((result) => res.status(200).json(result))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  // Sets, changes or clears the scheduled start of a pending or ready session
  // (US-017). `scheduledStartAt: null` is how a schedule is removed; omitting
  // it is a mistake worth naming rather than a no-op.
  router.put('/sessions/:id/schedule', (req, res) => {
    const parsed = parseSchedule(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }
    try {
      res.status(200).json(sessions.setSchedule(req.params.id, parsed.scheduledStartAt));
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  // Turns the automatic code review on or off (US-003). Refused once the
  // session is finished, when the pull request has already been delivered.
  router.put('/sessions/:id/code-review', (req, res) => {
    const parsed = parseCodeReview(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }
    try {
      res.status(200).json(sessions.setCodeReview(req.params.id, parsed.codeReview));
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  // "Back to planning": the same transition in reverse.
  router.delete('/sessions/:id/ready', (req, res) => {
    try {
      res.status(200).json(sessions.backToPlanning(req.params.id));
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  // Deletes the session, its container and its workspace (US-015). Mounted
  // after `/sessions/:id/ready` and `/sessions/:id/setup`, which are longer
  // paths and therefore unaffected. Nothing on the remote is touched.
  router.delete('/sessions/:id', (req, res) => {
    sessions
      .delete(req.params.id)
      .then(() => res.status(204).end())
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof SessionError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'session_request_failed', message: String(cause) });
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

function validateName(name: string): Invalid | null {
  if (name.length > MAX_SESSION_NAME_LENGTH) {
    return {
      error: 'invalid_session_name',
      message: `The session name must be at most ${MAX_SESSION_NAME_LENGTH} characters.`,
    };
  }
  if (!SESSION_NAME_PATTERN.test(name)) {
    return {
      error: 'invalid_session_name',
      message:
        'Use letters, numbers, hyphens and underscores only — the name becomes the feature branch and the workspace directory.',
    };
  }
  return null;
}

/** Git forbids whitespace and a handful of metacharacters in ref names. */
function validateBranch(branch: string): Invalid | null {
  if (branch.length > MAX_BRANCH_LENGTH || /[\s~^:?*[\\]/.test(branch) || branch.startsWith('-')) {
    return { error: 'invalid_base_branch', message: 'That is not a valid git branch name.' };
  }
  return null;
}

/**
 * The browser sends an instant, not a wall-clock time: the datetime picker is
 * read in the visitor's timezone and converted before it is sent, so anything
 * that is not a real timestamp is a bug worth rejecting rather than guessing at.
 */
function parseScheduledStart(raw: string): string | Invalid {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return {
      error: 'invalid_scheduled_start',
      message: 'The scheduled start must be an ISO-8601 timestamp.',
    };
  }
  return parsed.toISOString();
}

/** The body of `PUT /sessions/:id/schedule`. */
function parseSchedule(body: unknown): { scheduledStartAt: string | null } | Invalid {
  const badBody = invalidBody(body);
  if (badBody) return badBody;
  const input = body as Record<string, unknown>;

  if (!('scheduledStartAt' in input)) {
    return {
      error: 'invalid_scheduled_start',
      message: 'scheduledStartAt is required; send null to clear the schedule.',
    };
  }

  const raw = input['scheduledStartAt'];
  if (raw === null || raw === '') return { scheduledStartAt: null };
  if (typeof raw !== 'string') {
    return {
      error: 'invalid_scheduled_start',
      message: 'scheduledStartAt must be an ISO-8601 timestamp, or null to clear the schedule.',
    };
  }

  const parsed = parseScheduledStart(raw.trim());
  return typeof parsed === 'object' ? parsed : { scheduledStartAt: parsed };
}

/** The body of `PUT /sessions/:id/code-review`. */
function parseCodeReview(body: unknown): { codeReview: boolean } | Invalid {
  const badBody = invalidBody(body);
  if (badBody) return badBody;
  const input = body as Record<string, unknown>;

  const codeReview = optionalBoolean(input, 'codeReview');
  if (typeof codeReview === 'object') return codeReview;
  if (codeReview === undefined) {
    return { error: 'invalid_code_review', message: 'codeReview is required.' };
  }
  return { codeReview };
}

/** `undefined` when the field is absent; an `Invalid` when it is not a boolean. */
function optionalBoolean(
  input: Record<string, unknown>,
  field: string,
): boolean | undefined | Invalid {
  if (!(field in input) || input[field] === undefined || input[field] === null) return undefined;
  const raw = input[field];
  if (typeof raw !== 'boolean') {
    return { error: 'invalid_code_review', message: `${field} must be a boolean.` };
  }
  return raw;
}

function parseCreate(body: unknown): CreateSessionRequest | Invalid {
  const badBody = invalidBody(body);
  if (badBody) return badBody;
  const input = body as Record<string, unknown>;

  const repositoryId = optionalString(input, 'repositoryId', 'invalid_repository_id');
  if (typeof repositoryId === 'object') return repositoryId;
  if (repositoryId === undefined) {
    return { error: 'invalid_repository_id', message: 'A repository is required.' };
  }

  const name = optionalString(input, 'name', 'invalid_session_name');
  if (typeof name === 'object') return name;
  if (name === undefined) {
    return { error: 'invalid_session_name', message: 'A session name is required.' };
  }
  const badName = validateName(name);
  if (badName) return badName;

  // Omitted means "whatever the repository's default base branch is"; the
  // service resolves it, so the two can never disagree.
  const baseBranch = optionalString(input, 'baseBranch', 'invalid_base_branch');
  if (typeof baseBranch === 'object') return baseBranch;
  if (baseBranch !== undefined) {
    const badBranch = validateBranch(baseBranch);
    if (badBranch) return badBranch;
  }

  const target = optionalString(input, 'prTargetBranch', 'invalid_pr_target_branch');
  if (typeof target === 'object') return target;
  if (target !== undefined && !isPrTarget(target)) {
    return {
      error: 'invalid_pr_target_branch',
      message: `The PR target must be one of: ${PR_TARGET_BRANCHES.join(', ')}.`,
    };
  }

  const scheduled = optionalString(input, 'scheduledStartAt', 'invalid_scheduled_start');
  if (typeof scheduled === 'object') return scheduled;
  let scheduledStartAt: string | null = null;
  if (scheduled !== undefined) {
    const parsed = parseScheduledStart(scheduled);
    if (typeof parsed === 'object') return parsed;
    scheduledStartAt = parsed;
  }

  const codeReview = optionalBoolean(input, 'codeReview');
  if (typeof codeReview === 'object') return codeReview;

  return {
    repositoryId,
    name,
    prTargetBranch: target ?? 'main',
    scheduledStartAt,
    codeReview: codeReview ?? false,
    ...(baseBranch === undefined ? {} : { baseBranch }),
  };
}

function isPrTarget(value: string): value is PrTargetBranch {
  return (PR_TARGET_BRANCHES as readonly string[]).includes(value);
}
