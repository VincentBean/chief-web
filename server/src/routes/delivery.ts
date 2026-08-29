import { type Response, Router } from 'express';

import { DeliveryError, type DeliveryService } from '../delivery/index.js';

/**
 * Retrying the push and the pull request of a finished session (US-014).
 *
 * The build loop delivers by itself, so this endpoint exists for the one case
 * the loop cannot handle: a session whose stories are all done but whose push
 * or pull request failed. It re-attempts *only* that step — nothing is rebuilt
 * and no story is run again.
 *
 * A push or GitHub failure is answered `200 { ok: false, … }` with git's stderr
 * or GitHub's message, exactly like session setup (US-010): it is something the
 * operator has to read, not a failed request. Wrong *state* is still a 409.
 */
export function createDeliveryRouter(delivery: DeliveryService): Router {
  const router = Router();

  router.post('/sessions/:id/delivery', (req, res) => {
    delivery
      .retry(req.params.id)
      .then((result) => res.status(200).json(result))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof DeliveryError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'delivery_request_failed', message: String(cause) });
}
