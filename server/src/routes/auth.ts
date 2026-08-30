import { type Request, Router } from 'express';

import {
  type AuthService,
  describeRetryAfter,
  isSecureRequest,
  type LoginRateLimiter,
  requireApiAuth,
} from '../auth/index.js';
import { logger } from '../lib/logger.js';

/**
 * Login/logout for the single shared password (US-003).
 *
 * `POST /api/auth/login` is the only authenticated-by-nothing route besides
 * the health check; everything else here requires an existing session. It is
 * throttled per client, because it is the one door an unauthenticated caller
 * can knock on (see `auth/ratelimit.ts`).
 */
export function createAuthRouter(auth: AuthService, logins: LoginRateLimiter): Router {
  const router = Router();

  router.post('/auth/login', (req, res) => {
    const client = clientKey(req);

    // Checked before the body is read and before the password is verified, so a
    // refused attempt costs neither a scrypt nor anything an attacker controls.
    const verdict = logins.check(client);
    if (!verdict.allowed) {
      logger.warn('throttled login attempt', { ip: client, retryAfter: verdict.retryAfterSeconds });
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      res.status(429).json({
        error: 'too_many_attempts',
        message: `Too many failed sign-in attempts. Try again in ${describeRetryAfter(verdict.retryAfterSeconds)}.`,
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
      return;
    }

    const body: unknown = req.body;
    const password =
      typeof body === 'object' && body !== null && 'password' in body
        ? (body as { password: unknown }).password
        : undefined;

    // A malformed request is a bug in the caller, not a guess, so it is not
    // counted against the limit.
    if (typeof password !== 'string' || password === '') {
      res.status(400).json({ error: 'password_required' });
      return;
    }

    if (!auth.verifyPassword(password)) {
      logins.recordFailure(client);
      logger.warn('rejected login attempt', { ip: client });
      res.status(401).json({ error: 'invalid_password' });
      return;
    }

    // Signing in successfully forgives the failures before it: someone who
    // knows the password should never be locked out by their own typos.
    logins.clear(client);
    res.setHeader('Set-Cookie', auth.sessionCookie({ secure: isSecureRequest(req) }));
    res.status(200).json({ authenticated: true });
  });

  const guard = requireApiAuth(auth);

  router.post('/auth/logout', guard, (req, res) => {
    res.setHeader('Set-Cookie', auth.clearedCookie({ secure: isSecureRequest(req) }));
    res.status(200).json({ authenticated: false });
  });

  // Lets the SPA confirm the cookie is still valid; 401 means "show login".
  router.get('/auth/session', guard, (_req, res) => {
    res.status(200).json({ authenticated: true });
  });

  return router;
}

/**
 * What the limit is counted per. `req.ip` is the socket's address, since the
 * app does not trust proxy headers — so behind a reverse proxy every client
 * shares one bucket. That is the safe direction to be wrong in (it throttles
 * more, never less), and a restart clears it.
 */
function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}
