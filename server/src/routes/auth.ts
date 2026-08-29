import { Router } from 'express';

import { type AuthService, isSecureRequest, requireApiAuth } from '../auth/index.js';
import { logger } from '../lib/logger.js';

/**
 * Login/logout for the single shared password (US-003).
 *
 * `POST /api/auth/login` is the only authenticated-by-nothing route besides
 * the health check; everything else here requires an existing session.
 */
export function createAuthRouter(auth: AuthService): Router {
  const router = Router();

  router.post('/auth/login', (req, res) => {
    const body: unknown = req.body;
    const password =
      typeof body === 'object' && body !== null && 'password' in body
        ? (body as { password: unknown }).password
        : undefined;

    if (typeof password !== 'string' || password === '') {
      res.status(400).json({ error: 'password_required' });
      return;
    }

    if (!auth.verifyPassword(password)) {
      logger.warn('rejected login attempt', { ip: req.ip });
      res.status(401).json({ error: 'invalid_password' });
      return;
    }

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
