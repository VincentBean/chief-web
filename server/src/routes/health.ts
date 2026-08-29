import { Router } from 'express';

/**
 * Liveness probe. Deliberately unauthenticated (see FR-2) so Docker health
 * checks and reverse proxies can reach it before the operator has logged in.
 */
export function createHealthRouter(): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  return router;
}
