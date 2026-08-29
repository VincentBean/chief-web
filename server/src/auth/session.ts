import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless, signed session tokens.
 *
 * A token carries only its expiry; there is a single operator, so there is no
 * identity to encode. Tokens are signed with a key derived from the persisted
 * session secret *and* the current credential, which means changing the
 * password (or switching between `CHIEF_WEB_PASSWORD` and the stored hash)
 * invalidates every cookie that was issued before the change.
 */

const VERSION = 'v1';

/** Derives the HMAC key for `credentialFingerprint` from the long-lived secret. */
export function deriveSigningKey(secret: string, credentialFingerprint: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(credentialFingerprint).digest();
}

export function issueSessionToken(key: Buffer, ttlMs: number, now: number = Date.now()): string {
  const payload = `${VERSION}.${now + ttlMs}`;
  return `${payload}.${sign(key, payload)}`;
}

export function verifySessionToken(key: Buffer, token: string, now: number = Date.now()): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [version, expiresAt, signature] = parts;
  if (version !== VERSION || expiresAt === undefined || signature === undefined) return false;
  if (!signaturesMatch(sign(key, `${version}.${expiresAt}`), signature)) return false;

  const expiry = Number(expiresAt);
  return Number.isFinite(expiry) && expiry > now;
}

function sign(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function signaturesMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
