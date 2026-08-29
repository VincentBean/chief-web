import { type Response, Router } from 'express';

import { BuildError } from '../build/index.js';
import { DeliveryError } from '../delivery/index.js';
import { RetryError, type RetryService } from '../recovery/index.js';

/**
 * "Retry" on a failed session (US-019).
 *
 * One endpoint for both recoveries, because which one is right is the server's
 * knowledge, not the browser's: it is decided from the stage stored when the
 * session failed. `GET` says what a retry would do — that is the button's
 * label — and `POST` does it.
 *
 * A delivery that fails again answers `200 { ok: false, … }` with git's or
 * GitHub's own words, exactly as `POST /sessions/:id/delivery` does; a wrong
 * state is a 409.
 */
export function createRetryRouter(retries: RetryService): Router {
  const router = Router();

  router.get('/sessions/:id/retry', (req, res) => {
    try {
      res.status(200).json(retries.plan(req.params.id));
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
    }
  });

  router.post('/sessions/:id/retry', (req, res) => {
    retries
      .retry(req.params.id)
      .then((result) => res.status(200).json(result))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  // The retry runs someone else's step, so it hands back someone else's
  // refusal: a build that cannot start and a delivery that is not allowed both
  // already carry the status and code the operator should see.
  if (cause instanceof RetryError || cause instanceof BuildError || cause instanceof DeliveryError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'retry_request_failed', message: String(cause) });
}
