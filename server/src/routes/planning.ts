import { type Response, Router } from 'express';

import { MAX_CONTEXT_LENGTH, PlanningError, type PlanningService } from '../planning/index.js';

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

/**
 * The planning terminal of a pending session (US-011).
 *
 * `GET` is polled by the session page, so it answers the two things that change
 * on their own — whether `claude` is still running and whether `prd.md` exists
 * and parses — without touching Docker. `POST` starts the conversation (or
 * resumes it with chief's edit prompt once a PRD exists) and `DELETE` ends it.
 */
export function createPlanningRouter(planning: PlanningService): Router {
  const router = Router();

  router.get('/sessions/:id/planning', (req, res) => {
    try {
      res.status(200).json(planning.status(req.params.id));
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  router.post('/sessions/:id/planning', (req, res) => {
    const parsed = parseStart(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }

    planning
      .start(req.params.id, parsed)
      .then((view) => res.status(201).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.delete('/sessions/:id/planning', (req, res) => {
    planning
      .stop(req.params.id)
      .then((view) => res.status(200).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof PlanningError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'planning_request_failed', message: String(cause) });
}

/** The body is optional: `{}` starts planning with chief's default context. */
function parseStart(body: unknown): { context?: string } | Invalid {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }

  const raw = (body as Record<string, unknown>)['context'];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') {
    return { error: 'invalid_context', message: 'context must be a string.' };
  }
  const context = raw.trim();
  if (context.length > MAX_CONTEXT_LENGTH) {
    return {
      error: 'context_too_long',
      message: `Keep the description under ${MAX_CONTEXT_LENGTH} characters.`,
    };
  }
  return context === '' ? {} : { context };
}
