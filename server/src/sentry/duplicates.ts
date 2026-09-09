import {
  type Database,
  listSentryDuplicatesOf,
  type SentryIssue,
  updateSentryIssue,
} from '../db/index.js';
import { logger } from '../lib/logger.js';

/**
 * Putting the issues folded into a dead original back into the pipeline
 * (US-007).
 *
 * An issue that was recognised as a duplicate of another one (US-006) has no
 * session of its own: it is waiting on the original's fix and nothing else. So
 * when the original reaches `cannot_fix`, every `duplicate` row pointing at it
 * has to be released — nothing else ever moves a `duplicate` row, and
 * `listSentryIssuesAwaitingResolve` only picks up the duplicates of a `fixed`
 * original, so a row left folded into a dead one is a real bug lost for good.
 *
 * It lives here, on its own, because an original can reach `cannot_fix` by two
 * routes that share no code:
 * {@link import('./complete.js').SentryCompletionService} closes a `working`
 * issue whose fix session ended without a merge, and
 * {@link import('./fix.js').SentryFixService} closes a `queued` issue whose
 * session could not be created {@link import('./fix.js').MAX_FIX_ATTEMPTS}
 * times. Both statuses are duplicate candidates, so both endings can strand
 * folded rows, and both call this.
 *
 * Releasing is deliberately not a re-queue: a `pending` row goes back through
 * {@link import('./classify.js').MAX_ISSUES_PER_TICK}, so five duplicates
 * released at once become at most two classifications on the next tick rather
 * than five build sessions at once. `attempts` goes back to zero and the
 * explanation is cleared, so the next classification starts from nothing; the
 * row keeps its `signature`, which describes the error rather than the verdict.
 */
export function releaseDuplicates(db: Database, issue: SentryIssue, explanation: string): void {
  for (const duplicate of listSentryDuplicatesOf(db, issue.id)) {
    updateSentryIssue(db, duplicate.id, {
      status: 'pending',
      duplicateOf: null,
      explanation: null,
      attempts: 0,
    });
    logger.info('a duplicate Sentry issue was released: the issue it repeats was given up on', {
      issue: duplicate.shortId,
      duplicateOf: issue.shortId,
      explanation,
    });
  }
}
