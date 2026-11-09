/**
 * Which Claude account work runs on, when chief-web chooses: the automatic
 * choice for work that names no account, and the failover account for work
 * whose own account is held (multiple accounts US-015).
 *
 * Both rank the candidates the same way — the **drain order**:
 *
 * 1. accounts with no 7-day window first: they have no weekly quota to save,
 *    and 5-hour capacity left idle is simply lost;
 * 2. then the accounts with a 7-day window, lowest 7-day usage first, so they
 *    drain about evenly over the week;
 * 3. then accounts whose usage is unknown — not fetched yet, or not a plan
 *    login (an API-key or console account, which costs money per token);
 * 4. ties go to the lower 5-hour usage, then to the position in the list.
 *
 * This module only *chooses* — pure, so the rules can be tested without a
 * database, a clock or a usage endpoint. The hold (`limits/hold.ts`) feeds it
 * the accounts, their usage and the holds.
 */

/**
 * No account is chosen whose 5-hour window is above this percentage while
 * another one has room: it would hit the same wall within minutes and arm a
 * hold on its way. Automatic work leaves an account once it passes this, and
 * failover never moves work onto one above it.
 */
export const FAILOVER_MAX_FIVE_HOUR_UTILIZATION = 95;

/** One rolling window, as far as the choice cares. */
export interface FailoverUsageWindow {
  readonly utilization: number;
}

/**
 * An account's plan usage. A `null` window in an answer without an `error` is
 * a window the account does not have; `null` usage, or an answer carrying an
 * `error`, means nothing is known about it.
 */
export interface FailoverUsage {
  readonly fiveHour: FailoverUsageWindow | null;
  readonly sevenDay: FailoverUsageWindow | null;
  /** Why there are no numbers; absent or `null` when the endpoint answered. */
  readonly error?: string | null;
}

/** One account the work could run on. */
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
 * {@link FAILOVER_MAX_FIVE_HOUR_UTILIZATION}, `current` — the account the
 * work's container already fails over to — while it still qualifies, else the
 * first in the drain order ({@link compareDrainOrder}). An unknown 5-hour
 * window counts as 0 — an account that has not been measured yet is not one to
 * avoid. `null` when no account qualifies.
 */
export function pickFailoverAccount(
  accounts: readonly FailoverCandidate[],
  holds: readonly FailoverHold[],
  now: Date = new Date(),
  current: string | null = null,
): string | null {
  const roomy = failoverEligible(accounts, heldAt(holds, now)).filter(hasFiveHourRoom);
  if (current !== null && roomy.some((account) => account.id === current)) return current;
  return firstInDrainOrder(roomy)?.id ?? null;
}

/**
 * The account work that names none launches on (the automatic choice).
 *
 * `current` is the account the work's container already runs on, if any. It
 * is kept while it is signed in, not held, and its 5-hour window is at most
 * {@link FAILOVER_MAX_FIVE_HOUR_UTILIZATION}: moving a session means
 * recreating its container, so it stays where it is until that account is
 * nearly drained. Otherwise the first account with room in the drain order
 * ({@link compareDrainOrder}) is chosen.
 *
 * When every usable account is above the ceiling the work still runs — there
 * is no hold to wait for — on `current` if it is usable, else on the one with
 * the lowest 5-hour usage. `null` only when no signed-in account is free of a
 * hold.
 */
export function pickAutomaticAccount(
  accounts: readonly FailoverCandidate[],
  holds: readonly FailoverHold[],
  now: Date = new Date(),
  current: string | null = null,
): string | null {
  const usable = failoverEligible(accounts, heldAt(holds, now));
  const stay = usable.find((account) => account.id === current);
  if (stay !== undefined && hasFiveHourRoom(stay)) return stay.id;
  const best = firstInDrainOrder(usable.filter(hasFiveHourRoom));
  if (best !== null) return best.id;
  if (stay !== undefined) return stay.id;
  let least: FailoverCandidate | null = null;
  for (const account of usable) {
    if (
      least === null ||
      fiveHourOf(account) < fiveHourOf(least) ||
      (fiveHourOf(account) === fiveHourOf(least) && account.position < least.position)
    ) {
      least = account;
    }
  }
  return least?.id ?? null;
}

/**
 * The drain order as a comparator: negative when `a` should be used before
 * `b`. See the module comment for the rules.
 */
export function compareDrainOrder(a: FailoverCandidate, b: FailoverCandidate): number {
  return (
    drainTier(a) - drainTier(b) ||
    sevenDayOf(a) - sevenDayOf(b) ||
    fiveHourOf(a) - fiveHourOf(b) ||
    a.position - b.position
  );
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

/** The 7-day utilization the choice uses: unknown or absent counts as 0. */
function sevenDayOf(account: FailoverCandidate): number {
  return account.usage?.sevenDay?.utilization ?? 0;
}

/** 0: no 7-day window; 1: a 7-day window; 2: usage unknown. */
function drainTier(account: FailoverCandidate): number {
  const usage = account.usage;
  if (usage === null || (usage.error ?? null) !== null) return 2;
  return usage.sevenDay === null ? 0 : 1;
}

function hasFiveHourRoom(account: FailoverCandidate): boolean {
  return fiveHourOf(account) <= FAILOVER_MAX_FIVE_HOUR_UTILIZATION;
}

function firstInDrainOrder(accounts: readonly FailoverCandidate[]): FailoverCandidate | null {
  let best: FailoverCandidate | null = null;
  for (const account of accounts) {
    if (best === null || compareDrainOrder(account, best) < 0) best = account;
  }
  return best;
}

/** The ids of the accounts whose hold is still in force at `now`. */
export function heldAt(holds: readonly FailoverHold[], now: Date): Set<string> {
  return new Set(
    holds
      .filter((hold) => hold.until !== null && Date.parse(hold.until) > now.getTime())
      .map((hold) => hold.accountId),
  );
}
