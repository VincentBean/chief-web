import { Router } from 'express';

import type { LoginRateLimiter } from '../auth/index.js';
import type { Database } from '../db/index.js';
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

  // Same body as the app's unknown-API fallback.
  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}
