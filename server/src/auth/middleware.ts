import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { AuthService } from './service.js';

/** Path the SPA serves its login form on; exempt from authentication. */
export const LOGIN_PATH = '/login';

/**
 * Guards the JSON API: unauthenticated requests get `401` rather than a
 * redirect, so `fetch` callers can react without following HTML.
 */
export function requireApiAuth(auth: AuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (auth.isAuthenticated(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}

/**
 * Guards page navigations: unauthenticated requests are redirected to the
 * login page, which the SPA renders. Static assets are served unauthenticated
 * because the login page itself is part of the same bundle.
 */
export function requirePageAuth(auth: AuthService): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === LOGIN_PATH || auth.isAuthenticated(req)) {
      next();
      return;
    }
    res.redirect(302, LOGIN_PATH);
  };
}

/** Cookies are only marked `Secure` when the request itself arrived over TLS. */
export function isSecureRequest(req: Request): boolean {
  return req.protocol === 'https';
}
