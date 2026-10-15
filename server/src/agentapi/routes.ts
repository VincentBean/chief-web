import { type RequestHandler, Router } from 'express';

import type { LoginRateLimiter } from '../auth/index.js';
import type { Database } from '../db/index.js';
import { respondWithFailure } from '../routes/sessions.js';
import { backToPlanningAgentSession } from './back-to-planning.js';
import { matchRemote } from './match.js';
import { requireAgentToken } from './middleware.js';
import { type AgentSessionDeps, createAgentSession, readAgentSession, sessionUrl } from './sessions.js';
import { scheduleAgentSession } from './schedule.js';
import { startAgentSession } from './start.js';

/**
 * Collaborators built after the agent router is mounted in `createApp`; each
 * is read at request time.
 */
export interface AgentRouterDeps extends AgentSessionDeps {
  /** `requireClaudeAuth`, the same guard `POST /api/sessions` sits behind. */
  readonly claudeGuard: () => RequestHandler;
}

/**
 * The agent API, mounted at `/api/agent` (send-to-chief US-004). Every route
 * on it requires the bearer token, and the token reaches nothing else: the
 * router answers unknown paths itself instead of falling through to the
 * cookie-guarded routes.
 */
export function createAgentRouter(
  db: Database,
  attempts: LoginRateLimiter,
  deps: AgentRouterDeps,
): Router {
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

  // A session with a ready-written PRD, left pending for the operator (US-006).
  router.post(
    '/sessions',
    (req, res, next) => deps.claudeGuard()(req, res, next),
    createAgentSession(db, deps),
  );

  // A session's status and where to review it (US-007).
  router.get('/sessions/:id', readAgentSession(db, deps));

  // Mark ready and start (or queue) the build (extend-api US-001). A build
  // runs `claude`, so this sits behind the same guard as creating one.
  router.post(
    '/sessions/:id/start',
    (req, res, next) => deps.claudeGuard()(req, res, next),
    (req, res) => {
      const id = String(req.params.id);
      startAgentSession(db, deps, id)
        .then((result) => {
          if (!result.ok) {
            const { status, error, message, errors } = result;
            res.status(status).json({ error, message, ...(errors === undefined ? {} : { errors }) });
            return;
          }
          const { session, outcome, queued, queuePosition, message } = result;
          res.json({
            session,
            outcome,
            queued,
            queuePosition,
            message,
            url: sessionUrl(deps.config, req, id),
          });
        })
        .catch((cause: unknown) => respondWithFailure(res, cause));
    },
  );

  // Set, change or clear (`null`) the scheduled start (extend-api US-003).
  // It starts nothing by itself, so it is not behind the Claude guard.
  router.put('/sessions/:id/schedule', scheduleAgentSession(db, deps));

  // Undo a start before the build begins (extend-api US-004). It runs no
  // `claude`, so it is not behind the Claude guard either.
  router.post('/sessions/:id/back-to-planning', backToPlanningAgentSession(db, deps));

  // Same body as the app's unknown-API fallback.
  router.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}
