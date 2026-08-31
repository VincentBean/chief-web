import { deleteSetting, getSetting, setSetting } from '../db/index.js';
import type { Database } from '../db/index.js';

/**
 * The global usage-limit hold (US-002).
 *
 * When the CLI refuses work because the account has hit its usage limit
 * (US-001), no session can make progress: the limit is on the account, not on
 * the build. So the answer to "are we held, and until when?" has to be one
 * answer that the loop, the scheduler and the UI all read, rather than each
 * keeping a timer of its own and disagreeing about when work may resume.
 *
 * The expiry lives in the `settings` table because a restart in the middle of
 * a hold would otherwise resume every session straight back into the limit and
 * burn a retry on each. Reads go to the row every time, so a hold armed by one
 * part of the process is visible to the rest immediately.
 */

/**
 * How long a single limit hit parks agent work for.
 *
 * The CLI's rolling window is longer than this, but it also tells us nothing
 * useful about where in the window we are, so we wait an hour and try again:
 * long enough not to hammer the limit, short enough that a session that could
 * have resumed does not sit idle all evening.
 */
export const USAGE_LIMIT_HOLD_MS = 60 * 60 * 1000;

/**
 * The one place that knows whether agent work is currently held.
 *
 * Every method takes the current time as an optional argument so callers that
 * have a clock — and tests, which drive one explicitly — can pass it, while
 * ordinary callers just ask.
 */
export class UsageLimitHold {
  constructor(private readonly db: Database) {}

  /**
   * Holds agent work for {@link USAGE_LIMIT_HOLD_MS} from `now` and returns the
   * ISO expiry.
   *
   * Arming during an existing hold keeps whichever expiry is later. A second
   * limit hit arriving a few minutes into a hold must never shorten it — that
   * would walk the wait back towards zero every time a session retried.
   */
  arm(now: Date = new Date()): string {
    const armed = new Date(now.getTime() + USAGE_LIMIT_HOLD_MS);
    const current = this.expiryAt(now);
    const expiry = current !== null && current > armed ? current : armed;
    const iso = expiry.toISOString();
    setSetting(this.db, 'claude_limit_until', iso);
    return iso;
  }

  /** The expiry while a hold is active, `null` once it has passed. */
  until(now: Date = new Date()): string | null {
    const expiry = this.expiryAt(now);
    return expiry === null ? null : expiry.toISOString();
  }

  /** Whether agent work is held at `now`. */
  active(now: Date = new Date()): boolean {
    return this.expiryAt(now) !== null;
  }

  /** Lifts the hold, whether or not one was in force. */
  clear(): void {
    deleteSetting(this.db, 'claude_limit_until');
  }

  /**
   * The stored expiry if it is still in the future, `null` otherwise.
   *
   * A row left behind by an earlier process reads as no hold at all rather
   * than as an expired one, so nothing has to sweep the table: the next `arm`
   * overwrites it, and until then it is simply ignored.
   */
  private expiryAt(now: Date): Date | null {
    const raw = getSetting(this.db, 'claude_limit_until');
    if (raw === null) return null;
    const expiry = Date.parse(raw);
    if (Number.isNaN(expiry) || expiry <= now.getTime()) return null;
    return new Date(expiry);
  }
}
