import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { describeRetryAfter, type LoginRateLimiter } from '../auth/index.js';
import type { Database } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { verifyToken } from './token.js';

/**
 * The one body every refused bearer request gets — missing header, malformed
 * header, wrong token, or no token configured at all — so a caller cannot tell
 * whether a token exists.
 */
const UNAUTHORIZED = { error: 'unauthorized', message: 'Missing or invalid API token.' } as const;

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * Guards the agent API (send-to-chief US-004): only `Authorization: Bearer
 * <token>` with the configured token gets through. The login cookie is not
 * accepted here, and this guard is mounted for `/api/agent` only, so the token
 * never reaches a cookie-only route.
 *
 * Failures are throttled per client IP with a limiter of their own (the same
 * kind that guards the sign-in form); a success clears the client's record.
 */
export function requireAgentToken(db: Database, attempts: LoginRateLimiter): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const client = req.ip ?? 'unknown';

    // Checked before the token is looked at, so a throttled caller learns nothing.
    const verdict = attempts.check(client);
    if (!verdict.allowed) {
      logger.warn('throttled agent API request', { ip: client, retryAfter: verdict.retryAfterSeconds });
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      res.status(429).json({
        error: 'too_many_attempts',
        message: `Too many failed API token attempts. Try again in ${describeRetryAfter(verdict.retryAfterSeconds)}.`,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return;
    }

    const presented = BEARER.exec(req.get('authorization') ?? '')?.[1];
    if (presented === undefined || !verifyToken(db, presented)) {
      attempts.recordFailure(client);
      logger.warn('rejected agent API request', { ip: client });
      res.status(401).json(UNAUTHORIZED);
      return;
    }

    attempts.clear(client);
    next();
  };
}
