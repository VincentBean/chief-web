import { claudeLimitKey, deleteSetting, getSetting, listClaudeAccounts, setSetting } from '../db/index.js';
import type { Database } from '../db/index.js';
import { claudeAccountSignedIn } from '../settings/index.js';
import type { VoiceEventSink } from '../voice/events.js';
import {
  FAILOVER_MAX_FIVE_HOUR_UTILIZATION,
  type FailoverCandidate,
  type FailoverUsage,
  failoverEligible,
  fiveHourOf,
  pickFailoverAccount,
} from '../claude/failover.js';
import { logger } from '../lib/logger.js';

/**
 * The usage-limit hold (US-002), per Claude account since multiple accounts
 * US-014: a limit hit pauses only the account that hit it.
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
 * The slice of a Claude usage answer (`claude/usage.ts`, US-005) that can arm
 * a hold: each window's utilization and reset time, `null` when unreported.
 */
export interface CappedUsage {
  readonly fiveHour: { readonly utilization: number; readonly resetsAt: string | null } | null;
  readonly sevenDay: { readonly utilization: number; readonly resetsAt: string | null } | null;
}

/** Where each account's plan usage is read from (`ClaudeUsageService`, US-005). */
export interface FailoverUsageReader {
  usage(accountId: string): FailoverUsage | null;
}

/**
 * Where work owned by an account launches (multiple accounts US-015): the
 * account itself while it is not held, else the failover account, else
 * nowhere — the work waits until `waitingUntil`.
 */
export interface LaunchRoute {
  /** The account to launch on; the owner itself while the work waits. */
  readonly accountId: string | null;
  /** True when `accountId` is a failover account rather than the owner. */
  readonly failover: boolean;
  /** The owner's hold expiry while no account can take the work, else `null`. */
  readonly waitingUntil: string | null;
}

/** One account's hold, as `GET /api/limits/hold` lists it. */
export interface AccountHold {
  readonly accountId: string;
  /** ISO expiry while held, `null` otherwise. */
  readonly until: string | null;
}

/**
 * The one place that knows which Claude accounts are currently held.
 *
 * A usage limit belongs to an account (multiple accounts US-014), so every
 * question is asked of one: `accountId` may be `null` — the effective account
 * of an install with no accounts at all — and a `null` account is never held.
 *
 * Every method takes the current time as an optional argument so callers that
 * have a clock — and tests, which drive one explicitly — can pass it, while
 * ordinary callers just ask.
 */
export class UsageLimitHold {
  constructor(
    private readonly db: Database,
    /**
     * Voice background events (voice US-015): told when *every* signed-in
     * account becomes held — the moment work as a whole stops — not when one
     * account is held while others carry on, nor when a hold is extended.
     */
    private readonly events: VoiceEventSink | null = null,
    /**
     * Plan usage for picking a failover account (US-015). Without one every
     * window is unknown, which the choice counts as 0.
     */
    private readonly usage: FailoverUsageReader | null = null,
  ) {}

  /** Why work on an account last waited, so the log says it once, not every tick. */
  private readonly waitReasons = new Map<string, string>();

  /**
   * Where work owned by `accountId` — the effective account of a session, a
   * recurring task or a PR run — launches at `now` (multiple accounts US-015):
   * the account itself while it is not held; else the least-used other
   * account (`pickFailoverAccount`); else it waits on its own hold, as it did
   * before failover existed.
   */
  route(accountId: string | null, now: Date = new Date()): LaunchRoute {
    const until = this.until(accountId, now);
    if (accountId === null || until === null) {
      if (accountId !== null) this.waitReasons.delete(accountId);
      return { accountId, failover: false, waitingUntil: null };
    }
    const accounts = this.failoverCandidates();
    const holds = this.list(now);
    const failover = pickFailoverAccount(accounts, holds, now);
    if (failover !== null) {
      this.waitReasons.delete(accountId);
      return { accountId: failover, failover: true, waitingUntil: null };
    }
    this.logWait(accountId, until, accounts, holds, now);
    return { accountId, failover: false, waitingUntil: until };
  }

  /** The account work owned by `accountId` launches on now (see {@link route}). */
  launchAccount(accountId: string | null, now: Date = new Date()): string | null {
    return this.route(accountId, now).accountId;
  }

  /**
   * The expiry work owned by `accountId` waits for: its hold, but only while
   * no other account can take the work over (US-015). `null` when it may go.
   */
  waitingUntil(accountId: string | null, now: Date = new Date()): string | null {
    return this.route(accountId, now).waitingUntil;
  }

  private failoverCandidates(): FailoverCandidate[] {
    return listClaudeAccounts(this.db).map((account) => ({
      id: account.id,
      position: account.position,
      authenticated: claudeAccountSignedIn(account),
      usage: this.usage?.usage(account.id) ?? null,
    }));
  }

  /** Says once per change why held work has nowhere to fail over to. */
  private logWait(
    accountId: string,
    until: string,
    accounts: readonly FailoverCandidate[],
    holds: readonly AccountHold[],
    now: Date,
  ): void {
    const held = new Set(
      holds
        .filter((hold) => hold.until !== null && Date.parse(hold.until) > now.getTime())
        .map((hold) => hold.accountId),
    );
    const eligible = failoverEligible(accounts, held);
    const reason =
      eligible.length === 0
        ? 'no other signed-in account is free of a usage-limit hold'
        : `every other account is above ${FAILOVER_MAX_FIVE_HOUR_UTILIZATION}% of its 5-hour window`;
    if (this.waitReasons.get(accountId) === reason) return;
    this.waitReasons.set(accountId, reason);
    logger.info('held claude account has no failover; its work waits', {
      account: accountId,
      until,
      reason,
      candidates: eligible.map((account) => ({ id: account.id, fiveHour: fiveHourOf(account) })),
    });
  }

  /**
   * Holds `accountId` until `expiry` — by default {@link USAGE_LIMIT_HOLD_MS}
   * from `now`, or the reset time of a capped usage window — and returns the
   * ISO expiry in force afterwards.
   *
   * Arming during an existing hold keeps whichever expiry is later. A second
   * limit hit arriving a few minutes into a hold must never shorten it — that
   * would walk the wait back towards zero every time a session retried.
   *
   * A `null` account — a run with no account behind it, which cannot really
   * have started — gets the expiry back without anything being held.
   */
  arm(accountId: string | null, now: Date = new Date(), expiry?: Date): string {
    const armed = expiry ?? new Date(now.getTime() + USAGE_LIMIT_HOLD_MS);
    if (accountId === null) return armed.toISOString();
    const wasAllHeld = this.allHeld(now);
    const current = this.expiryAt(accountId, now);
    const effective = current !== null && current > armed ? current : armed;
    const iso = effective.toISOString();
    setSetting(this.db, claudeLimitKey(accountId), iso);
    if (!wasAllHeld && this.allHeld(now)) {
      this.events?.publish({ kind: 'limits.hold', until: this.earliestExpiry(now) ?? iso });
    }
    return iso;
  }

  /**
   * Arms the account's hold from its plan usage (multiple accounts US-014):
   * a window at 100% means every launch on the account would be refused, and
   * the window's `resetsAt` says exactly when that stops — so the hold runs to
   * that time rather than the fixed hour. With both windows capped the later
   * reset wins (both have to lift). Returns the expiry in force, or `null`
   * when no window is capped with a future reset.
   */
  armForUsage(accountId: string, usage: CappedUsage, now: Date = new Date()): string | null {
    let resetsAt: Date | null = null;
    for (const window of [usage.fiveHour, usage.sevenDay]) {
      if (window === null || window.utilization < 100 || window.resetsAt === null) continue;
      const at = Date.parse(window.resetsAt);
      if (Number.isNaN(at) || at <= now.getTime()) continue;
      if (resetsAt === null || at > resetsAt.getTime()) resetsAt = new Date(at);
    }
    return resetsAt === null ? null : this.arm(accountId, now, resetsAt);
  }

  /** The account's expiry while its hold is active, `null` once it has passed. */
  until(accountId: string | null, now: Date = new Date()): string | null {
    const expiry = this.expiryAt(accountId, now);
    return expiry === null ? null : expiry.toISOString();
  }

  /** Whether the account's work is held at `now`. */
  active(accountId: string | null, now: Date = new Date()): boolean {
    return this.expiryAt(accountId, now) !== null;
  }

  /** Lifts the account's hold, whether or not one was in force. */
  clear(accountId: string): void {
    deleteSetting(this.db, claudeLimitKey(accountId));
  }

  /** Lifts every account's hold ("Resume now" with no account named, US-008). */
  clearAll(): void {
    for (const account of listClaudeAccounts(this.db)) this.clear(account.id);
  }

  /** Every account, in display order, with its expiry (`null` when not held). */
  list(now: Date = new Date()): AccountHold[] {
    return listClaudeAccounts(this.db).map((account) => ({
      accountId: account.id,
      until: this.until(account.id, now),
    }));
  }

  /**
   * Whether every signed-in account is held — the only state in which no agent
   * work can start anywhere. With no signed-in account at all nothing is held:
   * that is a sign-in problem, not a usage limit.
   */
  allHeld(now: Date = new Date()): boolean {
    const signedIn = this.signedIn();
    return signedIn.length > 0 && signedIn.every((id) => this.active(id, now));
  }

  /**
   * When the first hold on a signed-in account lifts, `null` when none is held.
   * Signed-out accounts are left out: a hold lifting on an account nothing can
   * run on frees nothing.
   */
  earliestExpiry(now: Date = new Date()): string | null {
    let earliest: Date | null = null;
    for (const id of this.signedIn()) {
      const expiry = this.expiryAt(id, now);
      if (expiry !== null && (earliest === null || expiry < earliest)) earliest = expiry;
    }
    return earliest === null ? null : earliest.toISOString();
  }

  /**
   * The global hold as it was before accounts (US-002): the earliest expiry
   * while every signed-in account is held, `null` while any can still work.
   * What the sidebar's `HoldClock` and the voice overview show.
   */
  allHeldUntil(now: Date = new Date()): string | null {
    return this.allHeld(now) ? this.earliestExpiry(now) : null;
  }

  private signedIn(): string[] {
    return listClaudeAccounts(this.db)
      .filter(claudeAccountSignedIn)
      .map((account) => account.id);
  }

  /**
   * The stored expiry if it is still in the future, `null` otherwise.
   *
   * A row left behind by an earlier process reads as no hold at all rather
   * than as an expired one, so nothing has to sweep the table: the next `arm`
   * overwrites it, and until then it is simply ignored.
   */
  private expiryAt(accountId: string | null, now: Date): Date | null {
    if (accountId === null) return null;
    const raw = getSetting(this.db, claudeLimitKey(accountId));
    if (raw === null) return null;
    const expiry = Date.parse(raw);
    if (Number.isNaN(expiry) || expiry <= now.getTime()) return null;
    return new Date(expiry);
  }
}
