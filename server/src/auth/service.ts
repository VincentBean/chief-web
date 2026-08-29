import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import type { Config } from '../config.js';
import { type Database, getSetting, setSetting } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { parseCookieHeader, serializeCookie } from './cookies.js';
import { generatePassword, hashPassword, secretsMatch, verifyPasswordHash } from './password.js';
import { deriveSigningKey, issueSessionToken, verifySessionToken } from './session.js';

/** Name of the signed session cookie. */
export const SESSION_COOKIE = 'chief_session';

/** How long a login stays valid before the operator has to sign in again. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Anything with headers: an Express request or a raw WebSocket upgrade request. */
export interface HeaderCarrier {
  readonly headers: IncomingHttpHeaders;
}

export interface AuthService {
  /** True when the request carries a valid, unexpired session cookie. */
  isAuthenticated(req: HeaderCarrier): boolean;
  /** True when `password` matches the configured shared password. */
  verifyPassword(password: string): boolean;
  /** `Set-Cookie` value establishing a new session. */
  sessionCookie(options?: { secure?: boolean }): string;
  /** `Set-Cookie` value clearing the session cookie. */
  clearedCookie(options?: { secure?: boolean }): string;
}

/**
 * Resolves the shared password and returns the service enforcing it.
 *
 * `CHIEF_WEB_PASSWORD` always wins: when it is set the stored hash is ignored
 * (and left untouched, so unsetting the variable restores the generated one).
 * When it is not set, the hash persisted in `settings` is used, and a password
 * is generated and logged on first boot.
 */
export function createAuthService(config: Config, db: Database): AuthService {
  const credential = resolveCredential(config, db);
  const key = deriveSigningKey(sessionSecret(db), credential.fingerprint);

  return {
    isAuthenticated(req) {
      const token = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
      return token !== undefined && verifySessionToken(key, token);
    },

    verifyPassword(password) {
      return credential.verify(password);
    },

    sessionCookie(options = {}) {
      return serializeCookie(SESSION_COOKIE, issueSessionToken(key, SESSION_TTL_MS), {
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
        ...(options.secure === undefined ? {} : { secure: options.secure }),
      });
    },

    clearedCookie(options = {}) {
      return serializeCookie(SESSION_COOKIE, '', {
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 0,
        ...(options.secure === undefined ? {} : { secure: options.secure }),
      });
    },
  };
}

interface Credential {
  /** Changes whenever the effective password changes, invalidating old cookies. */
  readonly fingerprint: string;
  verify(password: string): boolean;
}

function resolveCredential(config: Config, db: Database): Credential {
  if (config.password !== '') {
    return {
      fingerprint: fingerprint('env', config.password),
      verify: (password) => secretsMatch(password, config.password),
    };
  }

  let stored = getSetting(db, 'password_hash');
  if (stored === null) {
    const generated = generatePassword();
    stored = hashPassword(generated);
    setSetting(db, 'password_hash', stored);
    logger.warn(
      'no CHIEF_WEB_PASSWORD set; generated a shared password. ' +
        'Save it now — it is shown only once. Set CHIEF_WEB_PASSWORD in .env to choose your own.',
      { password: generated },
    );
  }

  const hash = stored;
  return {
    fingerprint: fingerprint('hash', hash),
    verify: (password) => verifyPasswordHash(password, hash),
  };
}

function fingerprint(source: string, value: string): string {
  return createHash('sha256').update(`${source}:${value}`).digest('hex');
}

/** The long-lived HMAC secret, generated on first boot so cookies survive restarts. */
function sessionSecret(db: Database): string {
  const existing = getSetting(db, 'session_secret');
  if (existing !== null) return existing;

  const secret = randomBytes(32).toString('base64');
  setSetting(db, 'session_secret', secret);
  return secret;
}
