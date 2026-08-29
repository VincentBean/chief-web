import { Router } from 'express';

import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { fetchGithubUser, GithubApiError } from '../lib/github.js';
import {
  type AppSettingsUpdate,
  getGithubToken,
  MAX_CONCURRENT_SESSIONS,
  MIN_CONCURRENT_SESSIONS,
  readAppSettings,
  updateAppSettings,
} from '../settings/index.js';

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

/**
 * Global settings (US-004): the GitHub Personal Access Token used to open pull
 * requests, and the build concurrency cap.
 *
 * The token is write-only over the API — `GET /api/settings` returns only its
 * last four characters, and no other response ever includes it.
 */
export function createSettingsRouter(db: Database, config: Config): Router {
  const router = Router();

  router.get('/settings', (_req, res) => {
    res.status(200).json(readAppSettings(db, config));
  });

  router.put('/settings', (req, res) => {
    const parsed = parseUpdate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }

    res.status(200).json(updateAppSettings(db, config, parsed));
  });

  // Proves the token works and tells the operator which account it belongs to.
  // Accepts a token in the body so it can be checked *before* it is saved.
  router.post('/settings/github/validate', (req, res) => {
    const candidate = parseCandidateToken(req.body);
    if (candidate !== null && 'error' in candidate) {
      res.status(400).json(candidate);
      return;
    }

    const token = candidate?.token ?? getGithubToken(db);
    if (token === null) {
      res.status(400).json({
        error: 'github_token_missing',
        message: 'Save a GitHub token first, or enter one to validate.',
      });
      return;
    }

    fetchGithubUser(token, config.githubApiUrl)
      .then((user) => {
        res.status(200).json({ login: user.login });
      })
      .catch((cause: unknown) => {
        if (cause instanceof GithubApiError) {
          // Never 401: that is reserved for *our* expired session cookie, and
          // the SPA redirects to /login when it sees one.
          const status = cause.code === 'github_unreachable' ? 502 : 400;
          res.status(status).json({ error: cause.code, message: cause.message });
          return;
        }
        res.status(500).json({ error: 'validation_failed', message: String(cause) });
      });
  });

  return router;
}

function parseUpdate(body: unknown): AppSettingsUpdate | Invalid {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  const update: { githubToken?: string | null; maxConcurrentSessions?: number } = {};

  if ('githubToken' in input && input['githubToken'] !== undefined) {
    const raw = input['githubToken'];
    if (raw === null) {
      // Explicit removal; an omitted field leaves the stored token untouched.
      update.githubToken = null;
    } else if (typeof raw !== 'string') {
      return { error: 'invalid_github_token', message: 'The token must be a string.' };
    } else {
      const token = raw.trim();
      if (token === '') {
        return {
          error: 'invalid_github_token',
          message: 'The token must not be empty. Send null to remove the stored token.',
        };
      }
      update.githubToken = token;
    }
  }

  if ('maxConcurrentSessions' in input && input['maxConcurrentSessions'] !== undefined) {
    const raw = input['maxConcurrentSessions'];
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < MIN_CONCURRENT_SESSIONS ||
      raw > MAX_CONCURRENT_SESSIONS
    ) {
      return {
        error: 'invalid_max_concurrent_sessions',
        message: `Max concurrent sessions must be a whole number between ${MIN_CONCURRENT_SESSIONS} and ${MAX_CONCURRENT_SESSIONS}.`,
      };
    }
    update.maxConcurrentSessions = raw;
  }

  return update;
}

/** `null` means "no token supplied — validate the stored one". */
function parseCandidateToken(body: unknown): { token: string } | Invalid | null {
  if (body === undefined || body === null) return null;
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }
  const raw = (body as Record<string, unknown>)['token'];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    return { error: 'invalid_github_token', message: 'The token must be a string.' };
  }
  const token = raw.trim();
  return token === '' ? null : { token };
}
