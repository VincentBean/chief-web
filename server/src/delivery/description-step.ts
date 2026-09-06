import { type Database, type Session, type Story, updateSession } from '../db/index.js';
import type { DescriptionResult } from '../description/index.js';
import { logger } from '../lib/logger.js';

/**
 * The functional description as one step of the delivery (US-003).
 *
 * It sits between the commit-count guard and `openPullRequest`, and it is the
 * one step of a delivery that is allowed to fail silently: the pull request is
 * what the operator is waiting for, and a body without a description is the
 * body chief-web opened pull requests with for its whole life so far. Every
 * failure — a container that would not start, an agent that ran out of time,
 * an empty answer, and even an exception the pass was not supposed to throw —
 * is logged and turned into `null`, which {@link pullRequestBody} renders as
 * the old body exactly.
 *
 * The description it does produce is written to the session record, so a
 * delivery that is retried after the pull request failed opens it with the
 * description the first attempt already paid an agent for. The same store is
 * what keeps the description a *creation*-time thing: nothing after the pull
 * request exists reads or rewrites it.
 */

/** The slice of `DescriptionService` this step drives; tests pass a stub. */
export interface SessionDescriber {
  describe(session: Session, stories: readonly Story[]): Promise<DescriptionResult>;
}

export class DescriptionStep {
  constructor(
    private readonly describer: SessionDescriber,
    private readonly db: Database,
  ) {}

  /**
   * The description for `session`'s pull request body, or `null` when there is
   * none to be had. Never throws: see the class note.
   */
  async run(session: Session, stories: readonly Story[]): Promise<string | null> {
    const stored = (session.prDescription ?? '').trim();
    if (stored !== '') {
      logger.info('reusing the stored pull request description', {
        session: session.id,
        name: session.name,
      });
      return stored;
    }

    // The pull request already exists, so its body was written by the delivery
    // that opened it and is not rewritten here (US-003). Running the agent now
    // would spend a container on text nobody would ever read.
    if (session.prUrl !== null) {
      logger.info('the pull request already exists, so no description is generated', {
        session: session.id,
        name: session.name,
        url: session.prUrl,
      });
      return null;
    }

    let result: DescriptionResult;
    try {
      result = await this.describer.describe(session, stories);
    } catch (cause) {
      // The pass is documented never to throw; if it does anyway, that is
      // still not a reason to hold up a pull request whose branch is pushed.
      logger.warn('the pull request description pass threw; opening without one', {
        session: session.id,
        name: session.name,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }

    if (!result.ok || result.description === null) {
      logger.warn('the pull request is opened without a description', {
        session: session.id,
        name: session.name,
        code: result.code,
        error: result.message,
      });
      return null;
    }

    updateSession(this.db, session.id, { prDescription: result.description });
    return result.description;
  }
}
