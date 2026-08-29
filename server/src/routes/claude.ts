import { type Response, Router } from 'express';

import { ClaudeError, type ClaudeService } from '../claude/index.js';

/**
 * Claude Code authentication (US-008).
 *
 * `GET /api/claude` answers "is Claude signed in, and is a login in progress?";
 * `POST /api/claude/login` starts the temporary login container and returns the
 * terminal to attach to; `DELETE /api/claude/login` tears it down and re-checks
 * the credentials, which is how the status indicator updates as soon as the
 * login terminal is closed.
 */
export function createClaudeRouter(claude: ClaudeService): Router {
  const router = Router();

  // `?refresh=1` skips the cached probe result — used after a login.
  router.get('/claude', (req, res) => {
    claude
      .state(isTruthy(req.query['refresh']))
      .then((state) => res.status(200).json(state))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.post('/claude/login', (_req, res) => {
    claude
      .startLogin()
      .then((state) => res.status(201).json(state))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.delete('/claude/login', (_req, res) => {
    claude
      .stopLogin()
      .then((state) => res.status(200).json(state))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function isTruthy(value: unknown): boolean {
  return value === '1' || value === 'true' || value === '';
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof ClaudeError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'claude_request_failed', message: String(cause) });
}
