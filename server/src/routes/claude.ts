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
 *
 * The Settings accounts panel (multiple accounts US-006) also renames
 * (`PATCH /api/claude/accounts/:id`), makes default
 * (`POST /api/claude/accounts/:id/default`), re-probes
 * (`POST /api/claude/accounts/:id/check`), counts what is bound to an account
 * before removing it (`GET /api/claude/accounts/:id/bindings`) and removes it
 * (`DELETE /api/claude/accounts/:id`).
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

  router.patch('/claude/accounts/:id', (req, res) => {
    const nickname = parseNickname((req.body as { nickname?: unknown } | undefined)?.nickname);
    if (nickname === undefined) {
      res.status(400).json({
        error: 'invalid_nickname',
        message: `nickname must be a string of at most ${String(MAX_NICKNAME_LENGTH)} characters, or null.`,
      });
      return;
    }
    try {
      res.status(200).json(claude.rename(req.params.id, nickname));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  router.post('/claude/accounts/:id/default', (req, res) => {
    try {
      res.status(200).json(claude.makeDefault(req.params.id));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  router.post('/claude/accounts/:id/check', (req, res) => {
    claude
      .check(req.params.id)
      .then((view) => res.status(200).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.get('/claude/accounts/:id/bindings', (req, res) => {
    try {
      res.status(200).json(claude.bindings(req.params.id));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  router.delete('/claude/accounts/:id', (req, res) => {
    claude
      .remove(req.params.id)
      .then(() => res.status(204).end())
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

export const MAX_NICKNAME_LENGTH = 100;

/** Trimmed; blank means `null` (show the email). `undefined` when invalid. */
function parseNickname(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > MAX_NICKNAME_LENGTH) return undefined;
  return trimmed === '' ? null : trimmed;
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
