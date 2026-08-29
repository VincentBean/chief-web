import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for the single shared operator password (US-003).
 *
 * scrypt from `node:crypto` is used rather than a native bcrypt/argon2 binding
 * so the runtime image stays free of compiled dependencies (see the database
 * layer for the same reasoning).
 */

/** Stored as `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>` so parameters can evolve. */
const SCHEME = 'scrypt';
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const hash = derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return [
    SCHEME,
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/** Constant-time check of `password` against a hash produced by `hashPassword`. */
export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelism)) {
    return false;
  }

  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = derive(password, salt, cost, blockSize, parallelism, expected.length);
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/** Constant-time comparison of two plaintext secrets of arbitrary length. */
export function secretsMatch(a: string, b: string): boolean {
  // Comparing digests keeps this constant-time even when the lengths differ,
  // which `timingSafeEqual` refuses to handle (it throws on unequal buffers).
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** A URL-safe random password, used when `CHIEF_WEB_PASSWORD` is not set. */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function derive(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelism: number,
  keyLength: number = KEY_LENGTH,
): Buffer {
  return scryptSync(password, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelism,
    // scrypt's default 32 MB memory cap is below what N=16384, r=8 needs.
    maxmem: 64 * 1024 * 1024,
  });
}
