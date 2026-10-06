import { type Response, Router } from 'express';

import { BuildError, type BuildService } from '../build/index.js';

/**
 * The build loop of a session (US-013) and its place in the queue (US-018).
 *
 * Four verbs on one resource: read the state the session page polls, start the
 * loop, answer the question it stopped to ask (decisions US-006), and stop it. `POST` is additionally behind `requireClaudeAuth`, mounted in
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

  /**
   * The operator's answer to the question the build agent asked (decisions
   * US-006). It is a `POST` on the build rather than a resource of its own:
   * answering is an action on a running build, and what it returns is the
   * build view the page already renders.
   */
  router.post('/sessions/:id/decision', (req, res) => {
    const answer = parseAnswer(req.body);
    if (typeof answer !== 'string') {
      res.status(400).json(answer);
      return;
    }
    builds
      .answerDecision(req.params.id, answer)
      .then((view) => res.status(200).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.delete('/sessions/:id/build', (req, res) => {
    builds
      .stop(req.params.id)
      .then((view) => res.status(200).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

/** The answer, or the refusal to show; the length cap is the service's. */
function parseAnswer(body: unknown): string | { error: string; message: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object with an `answer`.' };
  }
  const answer = (body as Record<string, unknown>)['answer'];
  if (typeof answer !== 'string') {
    return { error: 'invalid_answer', message: 'answer must be a string.' };
  }
  return answer;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof BuildError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'build_request_failed', message: String(cause) });
}
