import { type Response, Router } from 'express';

import { BuildError, type BuildService } from '../build/index.js';

/**
 * The build loop of a session (US-013) and its place in the queue (US-018).
 *
 * Three verbs on one resource: read the state the session page polls, start the
 * loop, stop it. `POST` is additionally behind `requireClaudeAuth`, mounted in
 * `app.ts` ahead of this router — a build *is* a `claude`. It answers 200 with
 * a queued view when the concurrency cap is reached: the start was accepted,
 * the slot is what is missing, and `DELETE .../queue` gives the place back.
 */
export function createBuildRouter(builds: BuildService): Router {
  const router = Router();

  router.get('/sessions/:id/build', (req, res) => {
    try {
      res.status(200).json(builds.status(req.params.id));
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  router.post('/sessions/:id/build', (req, res) => {
    builds
      .start(req.params.id)
      .then((view) => res.status(200).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.delete('/sessions/:id/queue', (req, res) => {
    try {
      res.status(200).json(builds.dequeue(req.params.id));
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  router.delete('/sessions/:id/build', (req, res) => {
    builds
      .stop(req.params.id)
      .then((view) => res.status(200).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof BuildError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'build_request_failed', message: String(cause) });
}
