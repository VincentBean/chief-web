import type { Session } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type {
  PublishedReview,
  ReviewPassResult,
  ReviewPublisher,
  ReviewTarget,
} from '../review/index.js';

/**
 * The code review as one step of the delivery, retries included (US-009).
 *
 * The review is the only part of a delivery that runs an agent, and an agent
 * is the only part that is flaky for reasons nobody can act on — a stalled
 * `claude -p`, a document that came back half-written, a GitHub call that
 * timed out. So this step is the one that gets attempts: three of them, each a
 * complete pass (run the agent, then post what it found), and only the third
 * failure is allowed to fail the session.
 *
 * Everything before it — the push and the pull request — is *not* re-done by
 * those attempts. They already succeeded; the pull request exists and its URL
 * is on the session before the first attempt starts, so a review that never
 * works still leaves the operator with the pull request it was for.
 */

/** The slice of the review pass this step drives; tests pass a stub. */
export interface SessionReviewer {
  review(session: Session): Promise<ReviewPassResult>;
}

/**
 * The slice of `PrFeedbackService` this step chains into (US-011).
 *
 * Structural on purpose: `prfeedback` already imports this module's package
 * for its push, so naming the class here would close an import cycle. The real
 * service satisfies it as it stands — this is the same `start` the
 * PullRequests page's button calls, with no second implementation behind it.
 */
export interface FeedbackSolver {
  start(repositoryId: string, prNumber: number): Promise<{ readonly id: string }>;
}

/** What the chained solver run did; `null` when none was attempted. */
export interface SolverOutcome {
  /** The run row's id, or `null` when the start was refused. */
  readonly runId: string | null;
  /** The refusal's code, as the PullRequests page shows it; `null` on success. */
  readonly code: string | null;
  /** The sentence appended to the delivery's own message. */
  readonly message: string;
}

/** How many complete passes a review gets before the session fails. */
export const REVIEW_ATTEMPTS = 3;

export interface ReviewStepResult {
  readonly ok: boolean;
  /** How many passes were actually run, successful one included. */
  readonly attempts: number;
  /** What the operator reads: the outcome, or every attempt's reason. */
  readonly message: string;
  /** What was posted; `null` whenever this failed. */
  readonly published: PublishedReview | null;
  /**
   * The solver run started for the findings (US-011): `null` when there was
   * nothing to solve, when this chief-web has no solver, or when the review
   * itself failed.
   */
  readonly solver: SolverOutcome | null;
}

export class ReviewStep {
  constructor(
    private readonly reviewer: SessionReviewer,
    private readonly publisher: ReviewPublisher,
    /**
     * Where the findings go next (US-011). A thunk because the solver is built
     * *after* the delivery this step belongs to — it needs the build loop's
     * slot cap, and the build loop needs the delivery — so there is nothing to
     * hand over at construction time. `null` for a chief-web that cannot run
     * one, and for every test that is not about the chaining.
     */
    private readonly solver: () => FeedbackSolver | null = () => null,
  ) {}

  /**
   * Reviews `session`'s pull request and posts the result, retrying a failed
   * attempt. Never throws: a failure here is a session state the operator
   * retries, not an exception the delivery has to survive.
   */
  async run(session: Session, token: string, target: ReviewTarget): Promise<ReviewStepResult> {
    const reasons: string[] = [];

    for (let attempt = 1; attempt <= REVIEW_ATTEMPTS; attempt += 1) {
      const pass = await this.reviewer.review(session);

      if (!pass.ok || pass.report === null) {
        reasons.push(`Attempt ${String(attempt)}: ${pass.message}`);
        // A usage limit is the one failure a second attempt walks straight
        // back into: the account is out, not the pass. Spending the remaining
        // attempts on it only delays the same message.
        if (pass.code === 'usage_limit') break;
        continue;
      }

      try {
        const published = await this.publisher.publish(token, target, pass.report);
        logger.info('code review posted', {
          session: session.id,
          repository: target.slug,
          number: target.number,
          attempt,
          inlineComments: published.inlineComments,
          foldedFindings: published.foldedFindings,
        });
        // The findings are on the pull request now, so the solver can be
        // pointed at them exactly as the operator would from the PullRequests
        // page. Whatever it answers, this attempt succeeded.
        const solver = await this.startSolver(session, target, pass.report.findings.length);
        const message = postedMessage(published);
        return {
          ok: true,
          attempts: attempt,
          message: solver === null ? message : `${message} ${solver.message}`,
          published,
          solver,
        };
      } catch (cause) {
        reasons.push(
          `Attempt ${String(attempt)}: the review could not be posted to GitHub: ${describe(cause)}`,
        );
      }
    }

    const attempts = reasons.length;
    return {
      ok: false,
      attempts,
      message:
        `The code review failed after ${String(attempts)} attempt${attempts === 1 ? '' : 's'}. ` +
        'The pull request is open and unchanged; retrying runs the review again and nothing else.' +
        `\n\n${reasons.join('\n')}`,
      published: null,
      solver: null,
    };
  }

  /**
   * Hands the findings to the existing PR-feedback solver.
   *
   * Never throws and never fails the session: the review is posted either way,
   * and a refusal here — a full server, a closed pull request, a missing token
   * — is the same refusal the operator would have read on the PullRequests
   * page, so it is logged with its code and reported, not raised.
   */
  private async startSolver(
    session: Session,
    target: ReviewTarget,
    findings: number,
  ): Promise<SolverOutcome | null> {
    // Nothing was flagged, so there is nothing to solve. Starting a run here
    // would spend a container on a pull request with no unresolved feedback,
    // which the solver refuses anyway.
    if (findings === 0) return null;
    const solver = this.solver();
    if (solver === null) return null;

    try {
      const run = await solver.start(session.repositoryId, target.number);
      logger.info('code review findings handed to the feedback solver', {
        session: session.id,
        repository: target.slug,
        number: target.number,
        run: run.id,
      });
      return {
        runId: run.id,
        code: null,
        message: `A run was started on #${String(target.number)} to work on them.`,
      };
    } catch (cause) {
      const refusal = refusalOf(cause);
      logger.warn('the code review could not start a feedback run', {
        session: session.id,
        repository: target.slug,
        number: target.number,
        code: refusal.code,
        error: refusal.message,
      });
      return {
        runId: null,
        code: refusal.code,
        message: `No run was started to work on them: ${refusal.message}`,
      };
    }
  }
}

/**
 * The code and message a refusal is surfaced with. `PrFeedbackError` and
 * `GithubApiError` both carry a `code`; anything else is a crash, which the
 * route would have answered 500 for.
 */
function refusalOf(cause: unknown): { code: string; message: string } {
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : 'feedback_run_failed';
  return { code, message: describe(cause) };
}

/** The sentence a delivery adds to its own once the review is up. */
export function postedMessage(published: PublishedReview): string {
  const total = published.inlineComments + published.foldedFindings;
  if (total === 0) return 'The code review found nothing to comment on.';
  return (
    `The code review posted ${String(total)} finding${total === 1 ? '' : 's'}` +
    (published.foldedFindings === 0
      ? '.'
      : ` (${String(published.foldedFindings)} in the review body).`)
  );
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
