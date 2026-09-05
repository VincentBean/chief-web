import {
  type Database,
  type FailureStage,
  failureStageLabel,
  getRepository,
  getSession,
  listSentryIssuesAwaitingResolve,
  listSentryIssuesByStatus,
  type SentryIssue,
  type Session,
  updateSentryIssue,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { pullRequestNumberOf } from '../prsync/index.js';

import { createSentryClient, SentryApiError } from './client.js';

/**
 * The back of the Sentry pipeline (US-008): what became of the fix, and
 * telling Sentry about it.
 *
 * A watcher over the `working` rows rather than a hook inside
 * {@link import('../prsync/service.js').PrSyncService.syncSession}, for three
 * reasons. The state is columns, as everywhere else here: the session's status
 * *is* the answer, so a merge that happened while the stack was down is simply
 * what the first pass after boot finds, and nothing has to be remembered
 * between ticks. A session can also end without the pull request sync ever
 * touching it — a `failed` build, a deleted session — and a hook on the sync
 * would never see those. And the resolve call needs a retry loop anyway, which
 * is a tick; having the transition and the retry on the same beat means an
 * issue can only ever be one tick away from being right.
 *
 * ## The three ends of a fix session
 *
 * `merged` is the only good one: the pull request landed, so the issue is
 * `fixed` and Sentry is told. `failed` and `finished` are the two bad ones —
 * the build gave up, or its pull request was closed without merging — and both
 * make the issue `cannot_fix` with an explanation naming what actually
 * happened, because "cannot fix" with no reason is indistinguishable from a bug
 * in chief-web. A session that is anywhere else is still working, and is left
 * alone.
 *
 * A `working` issue whose `session_id` is NULL is the fourth end: the session
 * was deleted, and `ON DELETE SET NULL` kept the issue while taking the link.
 * Nothing is building that fix any more, and nothing ever will, so the issue is
 * closed with exactly that said.
 *
 * ## Resolving, and why it is a flag
 *
 * `resolved_in_sentry` is not a status. The pull request is merged whatever
 * Sentry's API does, so a resolve call that failed may not cost the issue its
 * `fixed` status — it stays on {@link listSentryIssuesAwaitingResolve} and the
 * next tick tries again, for as long as it takes. That is also why the resolve
 * pass runs over *every* unresolved `fixed` row rather than only over the ones
 * this pass just marked: a retry and a first attempt are the same work.
 */

/** The slice of {@link import('./client.js').SentryClient} this needs. */
export interface SentryResolveGateway {
  resolveIssue(org: string, issueId: string): Promise<void>;
}

/** Null means "Sentry is not set up"; see the sync's factory, same reasoning. */
export type SentryResolveFactory = (db: Database) => SentryResolveGateway | null;

/** What the poller calls once the fix-session pass is done. */
export interface SentryCompleter {
  /** One pass over the working and unresolved issues. Returns how many ended. */
  trackCompletions(): Promise<number>;
}

/** Said of an issue whose session was deleted out from under it. */
export const SESSION_DELETED = 'session was deleted';

/** Why a `failed` session could not fix the issue, in the operator's words. */
export function failedSessionExplanation(
  stage: FailureStage | null,
  lastError: string | null,
): string {
  const where = stage === null ? '' : ` at ${failureStageLabel(stage)} stage`;
  const why = lastError === null || lastError.trim() === '' ? '' : `: ${lastError.trim()}`;
  return `build session failed${where}${why}`;
}

/** Why a `finished` session did not fix the issue: its pull request is gone. */
export function closedPullRequestExplanation(prUrl: string | null): string {
  const number = prUrl === null ? null : pullRequestNumberOf(prUrl);
  if (number === null) return 'build session ended without opening a pull request';
  return `PR #${number} closed without merging`;
}

export class SentryCompletionService implements SentryCompleter {
  constructor(
    private readonly db: Database,
    private readonly clients: SentryResolveFactory = createSentryClient,
  ) {}

  async trackCompletions(): Promise<number> {
    const ended = this.trackWorking();
    // After the transitions rather than before them, so an issue that reached
    // `fixed` in this very pass is resolved in the same tick it was merged.
    await this.resolveFixed();
    return ended;
  }

  /**
   * Every issue a session is supposed to be fixing. Returns how many of them
   * reached a terminal status — purely local work, so it runs whether or not
   * Sentry is reachable or even configured.
   */
  private trackWorking(): number {
    let ended = 0;
    for (const issue of listSentryIssuesByStatus(this.db, 'working')) {
      if (this.trackIssue(issue)) ended += 1;
    }
    return ended;
  }

  /** One working issue. Returns whether it reached a terminal status. */
  private trackIssue(issue: SentryIssue): boolean {
    if (issue.sessionId === null) {
      // `ON DELETE SET NULL`: the row outlived the session that was fixing it,
      // and nothing is going to pick that work back up on its own.
      return this.cannotFix(issue, SESSION_DELETED);
    }

    const session = getSession(this.db, issue.sessionId);
    if (session === null) {
      // Not reachable through the foreign key, but a link pointing at nothing
      // means exactly what a null one does.
      return this.cannotFix(issue, SESSION_DELETED);
    }

    switch (session.status) {
      case 'merged':
        return this.fixed(issue, session);
      case 'failed':
        return this.cannotFix(
          issue,
          failedSessionExplanation(session.failureStage, session.lastError),
        );
      case 'finished':
        // The pull request sync puts a session back here when its pull request
        // was closed unmerged; a build that opened none ends here too.
        return this.cannotFix(issue, closedPullRequestExplanation(session.prUrl));
      default:
        // Still queued, building, waiting, reviewing or open: nothing to say.
        return false;
    }
  }

  /**
   * The merge. Only the status is written here — Sentry is told in the resolve
   * pass, so that a failing API call is a retry rather than a lost fix.
   */
  private fixed(issue: SentryIssue, session: Session): boolean {
    updateSentryIssue(this.db, issue.id, { status: 'fixed', explanation: null, attempts: 0 });
    logger.info('a Sentry issue was fixed by a merged pull request', {
      issue: issue.shortId,
      session: session.id,
      name: session.name,
      prUrl: session.prUrl,
    });
    return true;
  }

  private cannotFix(issue: SentryIssue, explanation: string): boolean {
    updateSentryIssue(this.db, issue.id, { status: 'cannot_fix', explanation, attempts: 0 });
    logger.info('a Sentry issue was given up on: its fix session ended without a merge', {
      issue: issue.shortId,
      session: issue.sessionId,
      explanation,
    });
    return true;
  }

  /**
   * Tells Sentry about every fix that has landed and not been reported yet.
   *
   * Nothing here may ever write a status: the issue is `fixed` before the call
   * is made and stays `fixed` whatever the call does. The only write is the
   * flag, and only on success — which is what makes the whole pass a retry
   * loop that costs one request per unreported fix per tick and nothing at all
   * once they are all through.
   */
  private async resolveFixed(): Promise<void> {
    const pending = listSentryIssuesAwaitingResolve(this.db);
    if (pending.length === 0) return;

    // Only now, so an install with nothing to report never looks the token up.
    const client = this.clients(this.db);
    if (client === null) {
      logger.debug('fixed Sentry issues cannot be resolved: no Sentry token is configured', {
        issues: pending.length,
      });
      return;
    }

    for (const issue of pending) await this.resolve(issue, client);
  }

  /** One resolve call. A failure leaves the row exactly as it was. */
  private async resolve(issue: SentryIssue, client: SentryResolveGateway): Promise<void> {
    const repository = getRepository(this.db, issue.repositoryId);
    const org = repository?.sentryOrg ?? null;
    if (org === null) {
      // The project was unlinked, or the repository is gone. The fix stands;
      // there is simply nobody to tell until the link comes back.
      logger.debug('a fixed Sentry issue has no linked organisation to resolve it in', {
        issue: issue.shortId,
        repository: issue.repositoryId,
      });
      return;
    }

    try {
      await client.resolveIssue(org, issue.sentryIssueId);
    } catch (cause) {
      // One issue's failed call costs that issue this tick and nothing else:
      // it stays `fixed` and unreported, and the next tick tries again.
      logger.warn('a fixed Sentry issue could not be resolved in Sentry', {
        issue: issue.shortId,
        org,
        error: describe(cause),
        code: cause instanceof SentryApiError ? cause.code : undefined,
        retryAfterMs: cause instanceof SentryApiError ? cause.retryAfterMs : undefined,
      });
      return;
    }

    updateSentryIssue(this.db, issue.id, { resolvedInSentry: true });
    logger.info('a fixed Sentry issue was resolved in Sentry', {
      issue: issue.shortId,
      org,
    });
  }
}

export function createSentryCompleter(
  db: Database,
  clients: SentryResolveFactory = createSentryClient,
): SentryCompletionService {
  return new SentryCompletionService(db, clients);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
