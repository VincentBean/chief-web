import { type Response, Router } from 'express';

import { ClaudeError, type ClaudeService } from '../claude/index.js';

/**
 * Claude Code authentication (US-008).
 *
 * `GET /api/claude` answers "is Claude signed in, and is a login in progress?".
 *
 * Signing in is per account (multiple accounts US-003): `POST
 * /api/claude/accounts` adds an account and opens its login terminal, `POST
 * /api/claude/accounts/:id/login` signs an existing account in again, and
 * `DELETE /api/claude/accounts/:id/login` tears the login down and re-probes
 * that account, which is how the status indicator updates as soon as the login
 * terminal is closed. Only one login is open at a time.
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

  router.post('/claude/accounts', (_req, res) => {
    claude
      .createAccountLogin()
      .then((view) => res.status(201).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.post('/claude/accounts/:id/login', (req, res) => {
    claude
      .startLogin(req.params.id)
      .then((view) => res.status(201).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.delete('/claude/accounts/:id/login', (req, res) => {
    claude
      .stopLogin(req.params.id)
      .then((view) => res.status(200).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function isTruthy(value: unknown): boolean {
  return value === '1' || value === 'true' || value === '';
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof ClaudeError) {
    res
      .status(cause.status)
      .json({ ...cause.details, error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'claude_request_failed', message: String(cause) });
}
