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
}

export class ReviewStep {
  constructor(
    private readonly reviewer: SessionReviewer,
    private readonly publisher: ReviewPublisher,
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
        return { ok: true, attempts: attempt, message: postedMessage(published), published };
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
    };
  }
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
