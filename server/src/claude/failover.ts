/**
 * Failover to the least-used account (multiple accounts US-015).
 *
 * When the account a piece of work launches on is held by its usage limit,
 * the work does not have to wait for it: any other signed-in account with room
 * left can carry it. This module only *chooses* that account — pure, so the
 * rules can be tested without a database, a clock or a usage endpoint. The
 * hold (`limits/hold.ts`) feeds it the accounts, their usage and the holds.
 */

/**
 * Failover never moves work onto an account whose 5-hour window is above this
 * percentage: it would hit the same wall within minutes and arm a second hold
 * on its way, leaving two accounts idle instead of one.
 */
export const FAILOVER_MAX_FIVE_HOUR_UTILIZATION = 95;

/** One rolling window, as far as the choice cares. */
export interface FailoverUsageWindow {
  readonly utilization: number;
}

/** An account's plan usage; a `null` window (or no answer at all) is unknown. */
export interface FailoverUsage {
  readonly fiveHour: FailoverUsageWindow | null;
  readonly sevenDay: FailoverUsageWindow | null;
}

/** One account the work could fail over to. */
export interface FailoverCandidate {
  readonly id: string;
  /** Display order; the last tie-break. */
  readonly position: number;
  /** Signed in: an account with no credentials can carry nothing. */
  readonly authenticated: boolean;
  /** `null` while nothing has been fetched (or the account has no plan usage). */
  readonly usage: FailoverUsage | null;
}

/** An account's hold, as `UsageLimitHold.list()` reports it. */
export interface FailoverHold {
  readonly accountId: string;
  /** ISO expiry, `null` when the account is not held. */
  readonly until: string | null;
}

/**
 * The account held work should continue on: among the signed-in accounts that
 * are not held at `now` and whose 5-hour window is at most
 * {@link FAILOVER_MAX_FIVE_HOUR_UTILIZATION}, the one with the lowest 5-hour
 * utilization, ties broken by the lower 7-day utilization and then by
 * `position`. An unknown window counts as 0 — an account that has not been
 * measured yet is not one to avoid. `null` when no account qualifies.
 */
export function pickFailoverAccount(
  accounts: readonly FailoverCandidate[],
  holds: readonly FailoverHold[],
  now: Date = new Date(),
): string | null {
  const held = new Set(
    holds
      .filter((hold) => hold.until !== null && Date.parse(hold.until) > now.getTime())
      .map((hold) => hold.accountId),
  );
  let best: { id: string; fiveHour: number; sevenDay: number; position: number } | null = null;
  for (const account of failoverEligible(accounts, held)) {
    const candidate = {
      id: account.id,
      fiveHour: fiveHourOf(account),
      sevenDay: account.usage?.sevenDay?.utilization ?? 0,
      position: account.position,
    };
    if (candidate.fiveHour > FAILOVER_MAX_FIVE_HOUR_UTILIZATION) continue;
    if (
      best === null ||
      candidate.fiveHour < best.fiveHour ||
      (candidate.fiveHour === best.fiveHour &&
        (candidate.sevenDay < best.sevenDay ||
          (candidate.sevenDay === best.sevenDay && candidate.position < best.position)))
    ) {
      best = candidate;
    }
  }
  return best?.id ?? null;
}

/**
 * The signed-in, unheld accounts — the ones failover would consider before the
 * utilization ceiling. Exported so the caller can tell "no other account" from
 * "every other account is too close to its limit" when it logs why work waits.
 */
export function failoverEligible(
  accounts: readonly FailoverCandidate[],
  held: ReadonlySet<string>,
): FailoverCandidate[] {
  return accounts.filter((account) => account.authenticated && !held.has(account.id));
}

/** The 5-hour utilization the choice uses: unknown counts as 0. */
export function fiveHourOf(account: FailoverCandidate): number {
  return account.usage?.fiveHour?.utilization ?? 0;
}
