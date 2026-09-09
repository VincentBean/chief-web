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
 * ## A session is a batch (US-007)
 *
 * Several issues share one `session_id` — one branch, one pull request, one set
 * of stories — so the pass walks sessions rather than issues, and the session's
 * end decides every issue pointing at it. That makes a batch all-or-nothing:
 * a merge fixes all of them, and each of the three bad ends gives up on all of
 * them with the same explanation. Nothing here reads a story's own
 * `**Status:**` out of the PRD; whether the agent ticked a story off is a
 * question for the pull request's review, not a reason to close one issue of a
 * merged batch differently from its neighbours.
 *
 * Only the local transition is shared, though. Resolving is still per issue:
 * each carries its own `resolve_upstream` flag and its own Sentry call, so one
 * issue's failing call costs that issue a tick and leaves the rest of its batch
 * reported.
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
   * Every issue a session is supposed to be fixing, one batch at a time.
   * Returns how many of them reached a terminal status — purely local work, so
   * it runs whether or not Sentry is reachable or even configured.
   */
  private trackWorking(): number {
    let ended = 0;
    for (const batch of bySession(listSentryIssuesByStatus(this.db, 'working'))) {
      ended += this.trackBatch(batch);
    }
    return ended;
  }

  /**
   * One batch: every working issue that shares a `session_id`. Returns how many
   * of them reached a terminal status, which is either all of them or none.
   */
  private trackBatch(batch: SentryIssue[]): number {
    // The one link they share, read off the first — that is what grouped them.
    const sessionId = batch[0]?.sessionId ?? null;
    // `ON DELETE SET NULL`: the rows outlived the session that was fixing them,
    // and nothing is going to pick that work back up on its own. A link
    // pointing at nothing is not reachable through the foreign key, but means
    // exactly what a null one does.
    const session = sessionId === null ? null : getSession(this.db, sessionId);
    if (session === null) return this.cannotFix(batch, SESSION_DELETED);

    switch (session.status) {
      case 'merged':
        return this.fixed(batch, session);
      case 'failed':
        return this.cannotFix(
          batch,
          failedSessionExplanation(session.failureStage, session.lastError),
        );
      case 'finished':
        // The pull request sync puts a session back here when its pull request
        // was closed unmerged; a build that opened none ends here too.
        return this.cannotFix(batch, closedPullRequestExplanation(session.prUrl));
      default:
        // Still queued, building, waiting, reviewing or open: nothing to say.
        return 0;
    }
  }

  /**
   * The merge, for every issue of the batch (US-007). The session's outcome is
   * the whole answer: one branch behind one pull request fixed all of them
   * together, so nothing here reads a story's own status out of the PRD — a
   * story the agent left `todo` is a code review's problem, not a reason to
   * leave one issue of a merged batch open.
   *
   * Only the rows are written here — Sentry is told in the resolve pass, so
   * that a failing API call is a retry rather than a lost fix.
   * `resolveUpstream` is what puts each issue on that pass's list, and each is
   * reported on its own.
   */
  private fixed(batch: SentryIssue[], session: Session): number {
    for (const issue of batch) {
      updateSentryIssue(this.db, issue.id, {
        status: 'fixed',
        explanation: null,
        attempts: 0,
        resolveUpstream: true,
      });
    }
    logger.info('Sentry issues were fixed by a merged pull request', {
      issues: batch.map((issue) => issue.shortId),
      session: session.id,
      name: session.name,
      prUrl: session.prUrl,
    });
    return batch.length;
  }

  /** The other three ends, which cost every issue of the batch alike. */
  private cannotFix(batch: SentryIssue[], explanation: string): number {
    for (const issue of batch) {
      updateSentryIssue(this.db, issue.id, { status: 'cannot_fix', explanation, attempts: 0 });
    }
    logger.info('Sentry issues were given up on: their fix session ended without a merge', {
      issues: batch.map((issue) => issue.shortId),
      session: batch[0]?.sessionId ?? null,
      explanation,
    });
    return batch.length;
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

/**
 * The working issues grouped into batches, one per `session_id`, in the order
 * the rows came back. Every issue whose link is null shares the last group:
 * they have no session between them, but they all end the same way and there is
 * no session to look up for any of them.
 */
function bySession(issues: SentryIssue[]): SentryIssue[][] {
  const batches = new Map<string | null, SentryIssue[]>();
  for (const issue of issues) {
    const batch = batches.get(issue.sessionId);
    if (batch === undefined) batches.set(issue.sessionId, [issue]);
    else batch.push(issue);
  }
  return [...batches.values()];
}
