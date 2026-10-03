/**
 * An exec timeout whose clock can be stopped.
 *
 * {@link DockerApi.streamExec}'s own `timeoutMs` is one `setTimeout` armed at
 * the start of the command, which is right for every caller but one: a build
 * iteration that has asked the operator for a decision
 * (`build/decisions.ts`) is *deliberately* blocked, and the minutes it spends
 * waiting for an answer are not minutes it spent working. Charging them to the
 * iteration budget would reap an agent that did nothing wrong, and reap it
 * precisely when the answer it was waiting for had just arrived.
 *
 * So the budget is handed over as one of these instead. It counts down only
 * while it is running: {@link pause} stops the clock, {@link resume} starts it
 * again with whatever was left, and the agent is cut off at the same number of
 * *working* minutes however long the question took to answer.
 */
export class ExecDeadline {
  /** Budget not yet spent, as of {@link startedAt}. */
  private remaining: number;
  /** When the running clock was last started; `null` while paused. */
  private startedAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private onExpire: (() => void) | null = null;
  private expired = false;

  constructor(
    readonly timeoutMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.remaining = timeoutMs;
  }

  /**
   * Starts the clock and calls `onExpire` once the budget runs out. Returns
   * the function that stops it for good — the command finished, one way or
   * another — which is safe to call twice.
   */
  start(onExpire: () => void): () => void {
    this.onExpire = onExpire;
    this.arm();
    return () => {
      this.onExpire = null;
      this.disarm();
    };
  }

  /** True once `onExpire` has fired; the budget cannot be resumed after that. */
  get hasExpired(): boolean {
    return this.expired;
  }

  /** True while the clock is counting down. */
  get isRunning(): boolean {
    return this.startedAt !== null;
  }

  /** Budget left, in milliseconds; never negative. */
  get remainingMs(): number {
    return Math.max(0, this.remaining - (this.startedAt === null ? 0 : this.now() - this.startedAt));
  }

  /**
   * Stops the clock. A pause while the command is not running yet, or after it
   * has expired, does nothing — there is no budget left to protect.
   */
  pause(): void {
    if (this.expired || this.startedAt === null) return;
    this.remaining = this.remainingMs;
    this.startedAt = null;
    this.disarm();
  }

  /** Starts the clock again with what was left of the budget. */
  resume(): void {
    if (this.expired || this.startedAt !== null || this.onExpire === null) return;
    this.arm();
  }

  private arm(): void {
    this.startedAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startedAt = null;
      this.remaining = 0;
      this.expired = true;
      const expire = this.onExpire;
      this.onExpire = null;
      expire?.();
    }, this.remaining);
    // The budget runs to hours. It is a cap on an exec, not a reason to keep
    // the process alive: the server has its listener, and a shutdown has
    // nothing useful to do about an iteration it is abandoning anyway.
    this.timer.unref();
  }

  private disarm(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
