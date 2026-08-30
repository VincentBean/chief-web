/**
 * Sliding-window throttle for failed sign-in attempts.
 *
 * `POST /api/auth/login` is the only route an unauthenticated caller can
 * reach, and the shared password it guards is root-equivalent on the host (see
 * the security model), so unlimited guessing is the weakest link in the whole
 * design. Refusing early also spares the event loop: verifying against the
 * stored hash costs a synchronous scrypt, which an unthrottled attacker can
 * use to stall the single-threaded server.
 *
 * Only *failures* are counted, and a success clears the record, so an operator
 * who types their password correctly never uses up an attempt.
 *
 * The state is in memory on purpose: it is worth nothing after a restart, and
 * a restart is exactly the escape hatch an operator locked out by someone
 * else's guessing needs.
 */

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Whole seconds until the next attempt is allowed; `0` when allowed. */
  readonly retryAfterSeconds: number;
}

export interface LoginRateLimiter {
  /** Whether `key` may attempt a sign-in now. Records nothing. */
  check(key: string, now?: number): RateLimitVerdict;
  /** Counts one failed attempt against `key`. */
  recordFailure(key: string, now?: number): void;
  /** Forgets `key`'s failures, e.g. after a successful sign-in. */
  clear(key: string): void;
}

export interface LoginRateLimitOptions {
  /** Failures allowed within `windowMs` before attempts are refused. */
  readonly maxAttempts: number;
  readonly windowMs: number;
  /** Clients tracked at once; the least recently seen is evicted beyond this. */
  readonly maxKeys?: number;
}

const ALLOWED: RateLimitVerdict = { allowed: true, retryAfterSeconds: 0 };

/** Enough for any plausible operator, small enough that a flood cannot grow memory. */
const DEFAULT_MAX_KEYS = 1024;

export function createLoginRateLimiter(options: LoginRateLimitOptions): LoginRateLimiter {
  const { maxAttempts, windowMs } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;

  // Insertion-ordered, and every touch re-inserts, so the first entry is always
  // the least recently seen — which is the one eviction takes.
  const failures = new Map<string, number[]>();

  /** `key`'s failures still inside the window, dropping the ones that aged out. */
  const recent = (key: string, now: number): readonly number[] => {
    const timestamps = failures.get(key);
    if (timestamps === undefined) return [];

    const live = timestamps.filter((at) => at > now - windowMs);
    failures.delete(key);
    if (live.length > 0) failures.set(key, live);
    return live;
  };

  const evict = (now: number): void => {
    if (failures.size <= maxKeys) return;

    for (const [key, timestamps] of failures) {
      const last = timestamps[timestamps.length - 1] ?? 0;
      if (last <= now - windowMs) failures.delete(key);
    }
    while (failures.size > maxKeys) {
      const oldest = failures.keys().next();
      if (oldest.done === true) break;
      failures.delete(oldest.value);
    }
  };

  return {
    check(key, now = Date.now()) {
      const live = recent(key, now);
      if (live.length < maxAttempts) return ALLOWED;

      // The window slides off the oldest failure still counted, so that is when
      // an attempt frees up.
      const oldest = live[0] ?? now;
      const retryAfterMs = oldest + windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    },

    recordFailure(key, now = Date.now()) {
      const live = recent(key, now);
      failures.delete(key);
      failures.set(key, [...live, now]);
      evict(now);
    },

    clear(key) {
      failures.delete(key);
    },
  };
}

/** "in 30 seconds" / "in 15 minutes", for the message the login form shows. */
export function describeRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
