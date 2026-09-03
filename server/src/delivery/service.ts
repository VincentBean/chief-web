import type { BuildCompletion } from '../build/index.js';
import type { Config } from '../config.js';
import {
  type Database,
  failSession,
  type FailureStage,
  getRepository,
  getSession,
  listStories,
  type Session,
  type SessionStatus,
  type Story,
  updateSession,
} from '../db/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import { markPullRequestReadyForReview, type ReadyForReview } from '../lib/github-review.js';
import {
  GithubApiError,
  type OpenedPullRequest,
  openPullRequest,
  type PullRequest,
  type PullRequestInput,
} from '../lib/github.js';
import { logger } from '../lib/logger.js';
import type { ReviewTarget } from '../review/index.js';
import type { SessionContainers, SessionExecutor } from '../sessions/index.js';
import { getGithubToken } from '../settings/index.js';
import { pullRequestBody, pullRequestNumber, pullRequestTitle } from './pull-request.js';
import { type PushResult, runPush } from './push.js';
import type { ReviewStep } from './review-step.js';

/**
 * Delivering a finished session: push, pull request, then — for a session with
 * `codeReview` on — the code review (US-014, US-009).
 *
 * This is the {@link BuildCompletion} the build loop hands over to when every
 * story is done, and it is also its own endpoint — a delivery that failed on
 * the remote or at GitHub is retried on its own, without rerunning a single
 * story, because the work is already committed and nothing about it needs
 * doing again.
 *
 * The loop additionally calls {@link DeliveryService.push} after every story it
 * completes, so `origin` is never more than one story behind what the container
 * has. Those pushes are best-effort: the branch is a mirror of local commits,
 * so a remote that is briefly unavailable must not throw away a build that is
 * otherwise going fine. The push on completion is the one that has to work, and
 * its failure is what fails the session.
 */

/** A failure with the HTTP status and code the route should answer with. */
export class DeliveryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

/** The slice of the GitHub API this service needs; tests pass a stub. */
export interface PullRequestOpener {
  open(token: string, input: PullRequestInput): Promise<OpenedPullRequest>;
  /**
   * Undrafts a pull request by its GraphQL node id (US-003). Idempotent: a
   * pull request that is already ready is a success, not a failure.
   */
  markReady(token: string, pullRequestId: string): Promise<ReadyForReview>;
}

/**
 * The production opener: the real REST API at the configured base URL, plus
 * the one GraphQL mutation REST has no equivalent for.
 */
export class GithubPullRequests implements PullRequestOpener {
  constructor(private readonly config: Pick<Config, 'githubApiUrl' | 'githubGraphqlUrl'>) {}

  open(token: string, input: PullRequestInput): Promise<OpenedPullRequest> {
    return openPullRequest(token, this.config.githubApiUrl, input);
  }

  markReady(token: string, pullRequestId: string): Promise<ReadyForReview> {
    return markPullRequestReadyForReview(token, this.config.githubGraphqlUrl, pullRequestId);
  }
}

/** What a delivery — automatic or retried — answers with. */
export interface DeliveryResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly prUrl: string | null;
  /** True when an open pull request already existed and was adopted. */
  readonly adopted: boolean;
  /** Machine-readable reason; `ok` when nothing went wrong. */
  readonly code: DeliveryCode;
  readonly message: string;
  /** git's output when the push is what failed; empty otherwise. */
  readonly stderr: string;
}

export type DeliveryCode =
  | 'ok'
  | 'container_unavailable'
  | 'push_failed'
  | 'github_token_missing'
  | 'repository_missing'
  | 'invalid_github_slug'
  | 'pull_request_failed'
  | 'review_failed';

/**
 * Which of the three steps each failure belongs to (US-019, US-009). It is what
 * a retry dispatches on: every stage re-runs the delivery and nothing else, but
 * the operator is told which part to go and fix — the remote, GitHub, or the
 * review — and a `review` failure is the one that re-runs *only* the review.
 */
const FAILURE_STAGE_OF: Record<Exclude<DeliveryCode, 'ok'>, FailureStage> = {
  container_unavailable: 'push',
  push_failed: 'push',
  github_token_missing: 'pull_request',
  repository_missing: 'pull_request',
  invalid_github_slug: 'pull_request',
  pull_request_failed: 'pull_request',
  review_failed: 'review',
};

export class DeliveryService implements BuildCompletion {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly exec: SessionExecutor,
    private readonly pullRequests: PullRequestOpener,
    /**
     * The code review (US-009), or `null` where nothing can run one — a
     * deployment without an agent runner, and every test that is not about the
     * review. A session with `codeReview` off never reaches it either way.
     */
    private readonly review: ReviewStep | null = null,
  ) {}

  /**
   * The push the loop does after each completed story. Best-effort by design:
   * it never throws and never changes the session's state, so a remote hiccup
   * costs the run nothing — the next story pushes the same commits again.
   */
  async push(session: Session): Promise<void> {
    let result: PushResult;
    try {
      result = await this.pushBranch(session);
    } catch (cause) {
      logger.warn('could not push the feature branch after a story', {
        session: session.id,
        branch: session.featureBranch,
        error: describe(cause),
      });
      return;
    }

    if (result.ok) {
      logger.info('feature branch pushed', {
        session: session.id,
        branch: session.featureBranch,
      });
      return;
    }
    logger.warn('pushing the feature branch after a story failed; the build continues', {
      session: session.id,
      branch: session.featureBranch,
      error: result.message,
      stderr: result.stderr,
    });
  }

  /** The build loop's hand-off: push once more, then open the pull request. */
  async complete(session: Session, stories: readonly Story[]): Promise<void> {
    await this.deliver(session, stories);
  }

  /**
   * "Retry" on a session whose delivery failed: the push and the pull request
   * again, and nothing else. Every story is already committed, so there is
   * nothing to rebuild — which is exactly why this is a separate endpoint
   * rather than a restart of the loop.
   */
  async retry(sessionId: string): Promise<DeliveryResult> {
    const session = getSession(this.db, sessionId);
    if (session === null) {
      throw new DeliveryError(404, 'session_not_found', 'This session no longer exists.');
    }
    if (session.status === 'building') {
      throw new DeliveryError(
        409,
        'session_is_building',
        `"${session.name}" is still building. Stop the build first, or wait for it to finish — ` +
          'it pushes and opens the pull request itself.',
      );
    }
    if (session.status === 'pending') {
      throw new DeliveryError(
        409,
        'session_not_ready',
        `"${session.name}" is still being planned, so there is nothing to open a pull request for.`,
      );
    }

    const stories = listStories(this.db, session.id);
    const outstanding = stories.filter((story) => story.status !== 'done');
    if (stories.length === 0 || outstanding.length > 0) {
      throw new DeliveryError(
        409,
        'session_not_complete',
        stories.length === 0
          ? `"${session.name}" has no stories, so there is nothing to open a pull request for.`
          : `${String(outstanding.length)} of ${String(stories.length)} stories of "${session.name}" ` +
            'are not done yet. Start the build again to finish them; the pull request is opened ' +
            'automatically when they are.',
      );
    }

    // The review is the only step that can fail with the pull request already
    // open, so it is the only stage that resumes part-way (US-009).
    if (session.failureStage === 'review' && session.prUrl !== null) {
      return this.reviewOnly(session, session.prUrl);
    }

    return this.deliver(session, stories);
  }

  /**
   * Push, then pull request, then the session's final state. The session ends
   * `pr-open` with its pull request URL, or `failed` with the reason — git's
   * stderr or GitHub's own message — so "Retry" always has something to show.
   */
  private async deliver(session: Session, stories: readonly Story[]): Promise<DeliveryResult> {
    let push: PushResult;
    try {
      push = await this.pushBranch(session);
    } catch (cause) {
      return this.failed(session, 'container_unavailable', {
        message: `The feature branch could not be pushed: ${describe(cause)}`,
        stderr: '',
      });
    }
    if (!push.ok) {
      return this.failed(session, 'push_failed', { message: push.message, stderr: push.stderr });
    }

    const token = getGithubToken(this.db);
    if (token === null) {
      return this.failed(session, 'github_token_missing', {
        message:
          'The branch was pushed, but no GitHub token is configured, so no pull request could be ' +
          'opened. Add a token on the Settings page and retry.',
        stderr: '',
      });
    }

    const repository = getRepository(this.db, session.repositoryId);
    if (repository === null) {
      return this.failed(session, 'repository_missing', {
        message: 'The branch was pushed, but this session\'s repository no longer exists.',
        stderr: '',
      });
    }
    if (!isValidGithubSlug(repository.githubSlug)) {
      return this.failed(session, 'invalid_github_slug', {
        message:
          `The branch was pushed, but "${repository.githubSlug}" is not a GitHub owner/repo slug, ` +
          `so no pull request could be opened. Fix it on the "${repository.name}" repository.`,
        stderr: '',
      });
    }

    let opened: OpenedPullRequest;
    try {
      opened = await this.pullRequests.open(token, {
        slug: repository.githubSlug,
        head: session.featureBranch,
        base: session.prTargetBranch,
        title: pullRequestTitle(session),
        body: pullRequestBody({ session, stories, publicUrl: this.config.publicUrl }),
      });
    } catch (cause) {
      const detail = cause instanceof GithubApiError ? cause.message : describe(cause);
      return this.failed(session, 'pull_request_failed', {
        message: `The branch was pushed, but the pull request could not be opened: ${detail}`,
        stderr: '',
      });
    }

    logger.info(opened.adopted ? 'pull request adopted' : 'pull request opened', {
      session: session.id,
      name: session.name,
      repository: repository.githubSlug,
      head: session.featureBranch,
      base: session.prTargetBranch,
      number: opened.pullRequest.number,
      url: opened.pullRequest.url,
    });

    const delivered = opened.adopted
      ? `Pushed "${session.featureBranch}"; pull request #${String(opened.pullRequest.number)} was already open and has been adopted.`
      : `Pushed "${session.featureBranch}" and opened pull request #${String(opened.pullRequest.number)}.`;

    // The URL goes on the session as soon as the pull request exists, before
    // any review work: it exists from here on, whatever comes next, and a
    // session left `failed` further down the chain still has to link to it.
    updateSession(this.db, session.id, { prUrl: opened.pullRequest.url });

    if (session.codeReview && this.review !== null) {
      // The pull request is a draft and stays one while the review runs, so
      // the board says `reviewing` rather than leaving the session in
      // `building` with nothing building (US-003).
      updateSession(this.db, session.id, { status: 'reviewing' });
      const reviewed = await this.review.run(session, token, {
        slug: repository.githubSlug,
        number: opened.pullRequest.number,
      });
      if (!reviewed.ok) {
        return this.failed(session, 'review_failed', { message: reviewed.message, stderr: '' });
      }
      const undrafted = await this.readyForReview(session, token, opened.pullRequest);
      if (undrafted !== null) {
        return this.failed(session, 'pull_request_failed', { message: undrafted, stderr: '' });
      }
      return this.finish(session, opened.pullRequest.url, opened.adopted, `${delivered} ${reviewed.message}`);
    }

    // No review will run, so there is nothing to gate readiness on: the draft
    // is released straight away and the session ends exactly where it did
    // before pull requests were opened as drafts (US-003).
    const undrafted = await this.readyForReview(session, token, opened.pullRequest);
    if (undrafted !== null) {
      return this.failed(session, 'pull_request_failed', { message: undrafted, stderr: '' });
    }

    return this.finish(session, opened.pullRequest.url, opened.adopted, delivered);
  }

  /**
   * Marks the pull request ready for review, answering `null` when it is (now
   * or already) ready and the failure's message when it is not (US-003).
   *
   * Called unconditionally rather than only for a pull request we know to be a
   * draft: the mutation is idempotent — an adopted pull request somebody opened
   * by hand answers "not in the draft state", which the client reads as success
   * — and that is one behaviour fewer to get wrong than a flag read moments
   * earlier. The exception is a pull request GitHub sent no node id for: there
   * is nothing to call the mutation with, so a draft is a failure the operator
   * retries and a ready one is simply left alone.
   */
  private async readyForReview(
    session: Session,
    token: string,
    pullRequest: PullRequest,
  ): Promise<string | null> {
    if (pullRequest.nodeId === null) {
      if (!pullRequest.draft) return null;
      return (
        `Pull request #${String(pullRequest.number)} is a draft, but GitHub did not return an id ` +
        'for it, so it could not be marked ready for review.'
      );
    }

    try {
      const ready = await this.pullRequests.markReady(token, pullRequest.nodeId);
      logger.info(ready.alreadyReady ? 'pull request was already ready' : 'pull request undrafted', {
        session: session.id,
        number: pullRequest.number,
        url: pullRequest.url,
      });
      return null;
    } catch (cause) {
      const detail = cause instanceof GithubApiError ? cause.message : describe(cause);
      return (
        `The pull request is open at ${pullRequest.url}, but it could not be marked ready for ` +
        `review: ${detail}`
      );
    }
  }

  /**
   * Everything after the last step that can fail. The pull request exists, so
   * the session lands in `pr-open` rather than `finished` (US-002): the build
   * is over, but the work is not in the target branch until GitHub says the
   * pull request was merged. The PR sync is what moves the session on from
   * here — to `merged`, or back to `finished` if the pull request is closed
   * without ever being merged.
   */
  private finish(
    session: Session,
    prUrl: string,
    adopted: boolean,
    message: string,
  ): DeliveryResult {
    const delivered = updateSession(this.db, session.id, {
      status: 'pr-open',
      prUrl,
      lastError: null,
      failureStage: null,
    });

    return {
      ok: true,
      sessionId: session.id,
      status: delivered?.status ?? 'pr-open',
      prUrl,
      adopted,
      code: 'ok',
      message,
      stderr: '',
    };
  }

  /**
   * "Retry" on a session that failed at the review (US-009): the review again,
   * and only the review. The branch is pushed and the pull request is open —
   * pushing again would change nothing and re-opening it is not a thing that
   * can happen twice — so the one step that failed is the one that runs.
   */
  private async reviewOnly(session: Session, prUrl: string): Promise<DeliveryResult> {
    if (!session.codeReview) {
      // The operator switched the review off after it failed. That is an
      // answer: the session is done, and re-running a review nobody wants is
      // the one thing this must not do.
      return this.finish(
        session,
        prUrl,
        true,
        'Code review is switched off for this session, so its pull request is left open as-is.',
      );
    }
    if (this.review === null) {
      return this.failed(session, 'review_failed', {
        message: 'This chief-web cannot run code reviews, so the review could not be retried.',
        stderr: '',
      });
    }

    const token = getGithubToken(this.db);
    if (token === null) {
      return this.failed(session, 'review_failed', {
        message:
          `The pull request is open at ${prUrl}, but no GitHub token is configured, so the code ` +
          'review could not be posted. Add a token on the Settings page and retry.',
        stderr: '',
      });
    }

    const repository = getRepository(this.db, session.repositoryId);
    if (repository === null || !isValidGithubSlug(repository.githubSlug)) {
      return this.failed(session, 'review_failed', {
        message:
          `The pull request is open at ${prUrl}, but this session's repository ` +
          `${repository === null ? 'no longer exists' : `slug "${repository.githubSlug}" is not owner/repo`}, ` +
          'so the code review could not be posted.',
        stderr: '',
      });
    }

    const number = pullRequestNumber(prUrl);
    if (number === null) {
      return this.failed(session, 'review_failed', {
        message: `"${prUrl}" is not a pull request URL, so there is nothing to review.`,
        stderr: '',
      });
    }

    const target: ReviewTarget = { slug: repository.githubSlug, number };
    const reviewed = await this.review.run(session, token, target);
    if (!reviewed.ok) {
      return this.failed(session, 'review_failed', { message: reviewed.message, stderr: '' });
    }
    return this.finish(session, prUrl, true, reviewed.message);
  }

  /** Starts (or reuses) the session container and pushes from inside it. */
  private async pushBranch(session: Session): Promise<PushResult> {
    const container = await this.containers.start(session);
    return runPush(this.exec, container.id, {
      featureBranch: session.featureBranch,
      timeoutMs: this.config.pushTimeoutMs,
    });
  }

  private failed(
    session: Session,
    code: Exclude<DeliveryCode, 'ok'>,
    detail: { message: string; stderr: string },
  ): DeliveryResult {
    const stored = detail.stderr === '' ? detail.message : `${detail.message}\n\n${detail.stderr}`;
    const stage = FAILURE_STAGE_OF[code];
    const updated = failSession(this.db, session.id, stage, stored);

    logger.warn('delivery failed', {
      session: session.id,
      name: session.name,
      code,
      stage,
      error: detail.message,
    });

    return {
      ok: false,
      sessionId: session.id,
      status: updated?.status ?? 'failed',
      prUrl: updated?.prUrl ?? session.prUrl,
      adopted: false,
      code,
      message: detail.message,
      stderr: detail.stderr,
    };
  }
}

export function createDeliveryService(
  config: Config,
  db: Database,
  containers: SessionContainers,
  exec: SessionExecutor,
  pullRequests: PullRequestOpener = new GithubPullRequests(config),
  review: ReviewStep | null = null,
): DeliveryService {
  return new DeliveryService(config, db, containers, exec, pullRequests, review);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
