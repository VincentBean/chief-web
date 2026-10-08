import { Router } from 'express';

import type { LoginRateLimiter } from '../auth/index.js';
import type { Database } from '../db/index.js';
import { matchRemote } from './match.js';
import { requireAgentToken } from './middleware.js';

/**
 * The agent API, mounted at `/api/agent` (send-to-chief US-004). Every route
 * on it requires the bearer token, and the token reaches nothing else: the
 * router answers unknown paths itself instead of falling through to the
 * cookie-guarded routes.
 */
export function createAgentRouter(db: Database, attempts: LoginRateLimiter): Router {
  const router = Router();

  router.use(requireAgentToken(db, attempts));

  // Agent routes (US-005 to US-007) go here, after the guard.

  // Which chief-web repository a local checkout's `origin` belongs to (US-005).
  router.get('/repositories/match', (req, res) => {
    const remote = typeof req.query.remote === 'string' ? req.query.remote : '';
    const match = matchRemote(db, remote);
    switch (match.kind) {
      case 'invalid':
        res.status(400).json({
          error: 'invalid_remote',
          message: 'Pass the git remote URL as ?remote=, e.g. git@github.com:owner/repo.git.',
        });
        return;
      case 'none':
        res.status(404).json({
          error: 'repository_not_found',
          message: `No chief-web repository matches ${remote}. Add it in chief-web first.`,
        });
        return;
      case 'many':
        res.status(409).json({
          error: 'ambiguous_repository',
          repositories: match.repositories.map(({ id, name }) => ({ id, name })),
        });
        return;
      case 'one': {
        const { id, name, githubSlug, defaultBaseBranch, openPullRequestDefault } = match.repository;
        res.json({ repository: { id, name, githubSlug, defaultBaseBranch, openPullRequestDefault } });
        return;
      }
    }
  });

  // Same body as the app's unknown-API fallback.
  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}
