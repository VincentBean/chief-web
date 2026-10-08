import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { type Database, deleteSetting, getSetting, nowIso, setSetting, withTransaction } from '../db/index.js';

/**
 * The single install-wide agent API token (send-to-chief US-001), which lets a
 * local coding agent send work to chief-web.
 *
 * Only the token's SHA-256 digest is stored, so the plaintext exists exactly
 * once: in the return value of `generateToken()`. A plain digest rather than
 * scrypt is enough here because the token is 32 random bytes, not a
 * human-chosen password — there is nothing to brute-force.
 */

export const TOKEN_PREFIX = 'chief_';
const TOKEN_BYTES = 32;

export interface TokenStatus {
  configured: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

/**
 * Creates a new token, replacing any existing one (which stops verifying at
 * once), and returns its plaintext. The caller must show it and forget it.
 */
export function generateToken(db: Database): string {
  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  withTransaction(db, () => {
    setSetting(db, 'agent_api_token_hash', digest(token));
    setSetting(db, 'agent_api_token_created_at', nowIso());
    deleteSetting(db, 'agent_api_token_last_used_at');
  });
  return token;
}

/**
 * Whether `presented` is the configured token, compared in constant time.
 * A match records the moment as the token's last use.
 */
export function verifyToken(db: Database, presented: string): boolean {
  if (presented === '') return false;
  const stored = getSetting(db, 'agent_api_token_hash');
  if (stored === null) return false;

  const expected = Buffer.from(stored, 'hex');
  const actual = Buffer.from(digest(presented), 'hex');
  // A corrupted row decodes to the wrong length, which timingSafeEqual throws on.
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return false;

  setSetting(db, 'agent_api_token_last_used_at', nowIso());
  return true;
}

/** Removes the token and its timestamps; a no-op when none is configured. */
export function revokeToken(db: Database): void {
  withTransaction(db, () => {
    deleteSetting(db, 'agent_api_token_hash');
    deleteSetting(db, 'agent_api_token_created_at');
    deleteSetting(db, 'agent_api_token_last_used_at');
  });
}

/** What the operator may know about the token — never the hash itself. */
export function tokenStatus(db: Database): TokenStatus {
  return {
    configured: getSetting(db, 'agent_api_token_hash') !== null,
    createdAt: getSetting(db, 'agent_api_token_created_at'),
    lastUsedAt: getSetting(db, 'agent_api_token_last_used_at'),
  };
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
