/**
 * Recognising a Claude usage-limit refusal (US-001).
 *
 * When the account behind the CLI has hit its rolling usage limit, `claude -p`
 * does not do the work: it prints a refusal and exits non-zero. That looks
 * exactly like an iteration that achieved nothing, so the build loop calls it
 * stalled and burns a retry. This module is the one place that tells the two
 * apart; every caller asks it rather than matching text of its own.
 *
 * It is a pure function on purpose — no clock, no database, no container — so
 * the patterns can be tested exhaustively, the same way the loop's decisions in
 * `build/loop.ts` are.
 */

/** What the loop observed about the agent run it is asking about. */
export interface AgentRunOutcome {
  /** The agent's exit status; `null` when it was killed rather than exited. */
  readonly exitCode: number | null;
  /** Whatever the agent printed, already collected. */
  readonly output: string;
  /** The agent ran past its timeout and was cut off. */
  readonly timedOut: boolean;
}

/**
 * The refusal wordings we know about, matched case-insensitively against the
 * agent's output. This array is the only place these patterns live.
 *
 * The wording is the CLI's to change, so the list is deliberately broad: a
 * false positive costs one wasted hour of waiting, a false negative costs a
 * failed session and a human pressing Retry.
 */
export const USAGE_LIMIT_PATTERNS: readonly RegExp[] = [
  /** The CLI's own refusal, usually followed by a reset time. */
  /claude ai usage limit reached/i,
  /** The same message with the product name dropped or reworded around it. */
  /usage limit reached/i,
  /** The rolling window this feature exists for, however it is punctuated. */
  /5[-\s]?hour limit/i,
  /**
   * A rate-limit refusal only counts when it also says when it lets up —
   * `rate limit` on its own shows up in plenty of output an agent merely read.
   */
  /rate limit[\s\S]{0,200}?(reset|resets|resume|resumes|try again|retry after|available again)/i,
];

/**
 * Whether an agent run ended in a usage-limit refusal.
 *
 * A timeout stays a timeout: an iteration cut off by the agent timeout keeps
 * its existing US-019 handling, whatever the truncated output happens to say.
 * A clean exit is never a limit hit either — an agent that finished its story
 * after quoting the phrase out of a file it read has still done the work.
 */
export function isUsageLimitRefusal(result: AgentRunOutcome): boolean {
  if (result.timedOut) return false;
  if (result.exitCode === 0) return false;
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(result.output));
}
