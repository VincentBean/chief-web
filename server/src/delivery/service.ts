import type { BuildCompletion } from '../build/index.js';
import type { Config } from '../config.js';
import {
  type Database,
  failSession,
  type FailureStage,
  getPrRun,
  getRepository,
  getSession,
  listStories,
  type PrRun,
  prFailureStageLabel,
  type Session,
  type SessionStatus,
  type Story,
  updateSession,
} from '../db/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import { markPullRequestReadyForReview, type ReadyForReview } from '../lib/github-review.js';
import {
  findPullRequest,
  GithubApiError,
  type OpenedPullRequest,
  openPullRequest,
  type PullRequest,
  type PullRequestInput,
} from '../lib/github.js';
import { logger } from '../lib/logger.js';
import { UsageLimitHold } from '../limits/index.js';
import type { ReviewTarget } from '../review/index.js';
import type { SessionContainers, SessionExecutor } from '../sessions/index.js';
import { getGithubToken } from '../settings/index.js';
import { type CommitCount, countBranchCommits } from './commits.js';
import { pullRequestBody, pullRequestNumber, pullRequestTitle } from './pull-request.js';
import { type PushResult, runPush } from './push.js';
import type { ReviewStep, SolverOutcome } from './review-step.js';

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
 * A recurring task's run (US-006) is the one session that can end here without
 * a pull request at all: when it committed nothing, there is no branch worth
 * publishing and nothing GitHub would open a pull request for, so the session
 * finishes `finished` with no `pr_url` and the occurrence records it as
 * `clean`. Every other session delivers exactly as it always has.
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
   * The open pull request for a head → base pair, or `null` when there is
   * none. The review-stage retry has a URL and no node id (US-006), so this is
   * how it finds the pull request it has to undraft.
   */
  find(
    token: string,
    input: Pick<PullRequestInput, 'slug' | 'head' | 'base'>,
  ): Promise<PullRequest | null>;
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

  find(
    token: string,
    input: Pick<PullRequestInput, 'slug' | 'head' | 'base'>,
  ): Promise<PullRequest | null> {
    return findPullRequest(token, this.config.githubApiUrl, input);
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
  /**
   * The run committed nothing, so it finished without a push, a pull request
   * or a review (US-006). A success, and a different one from `ok`: there is
   * no pull request to link to and nothing for anyone to look at.
   */
  | 'clean'
  | 'container_unavailable'
  | 'push_failed'
  | 'github_token_missing'
  | 'repository_missing'
  | 'invalid_github_slug'
  | 'pull_request_failed'
  | 'review_failed'
  | 'feedback_failed'
  | 'usage_limit_hold';

/**
 * Which of the three steps each failure belongs to (US-019, US-009). It is what
 * a retry dispatches on: every stage re-runs the delivery and nothing else, but
 * the operator is told which part to go and fix — the remote, GitHub, or the
 * review — and a `review` failure is the one that re-runs *only* the review.
 */
/** The codes that really are a failure: not `ok`, `clean` or the hold. */
type DeliveryFailureCode = Exclude<DeliveryCode, 'ok' | 'clean' | 'usage_limit_hold'>;

const FAILURE_STAGE_OF: Record<DeliveryFailureCode, FailureStage> = {
  container_unavailable: 'push',
  push_failed: 'push',
  github_token_missing: 'pull_request',
  repository_missing: 'pull_request',
  invalid_github_slug: 'pull_request',
  pull_request_failed: 'pull_request',
  review_failed: 'review',
  feedback_failed: 'feedback',
};

/** What waiting for the feedback run left the delivery with (US-006). */
interface FeedbackOutcome {
  /** The sentence added to the delivery's message; `null` when there is none. */
  readonly message: string | null;
  /** Why the session must fail at the `feedback` stage; `null` when it must not. */
  readonly failure: string | null;
}

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
    /**
     * The global usage-limit hold (US-004). The review runs an agent, so it can
     * be refused for the same reason a build iteration can, and the answer is
     * the same one: hold agent work and park the session rather than fail it.
     */
    private readonly hold: UsageLimitHold = new UsageLimitHold(db),
  ) {}

  /**
   * The push the loop does after each completed story. Best-effort by design:
   * it never throws and never changes the session's state, so a remote hiccup
   * costs the run nothing — the next story pushes the same commits again.
   */
  async push(session: Session): Promise<void> {
    // A scheduled run that has committed nothing so far must not create the
    // branch on `origin` either (US-006): `git push -u` publishes the ref even
    // when it is still the base commit, and a nightly check that found nothing
    // would leave a branch behind every night.
    if (await this.committedNothing(session)) {
      logger.info('nothing committed yet on the scheduled run, so nothing to push', {
        session: session.id,
        branch: session.featureBranch,
      });
      return;
    }

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
    // A run that committed nothing has nothing to deliver (US-006): no branch
    // worth pushing, no pull request GitHub would accept, and nothing to
    // review. It finishes here, clean.
    const clean = await this.cleanRun(session);
    if (clean !== null) return clean;

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
      draft: opened.pullRequest.draft,
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
      logger.info('code review started; the pull request stays a draft until it is over', {
        session: session.id,
        name: session.name,
        number: opened.pullRequest.number,
        url: opened.pullRequest.url,
      });
      const reviewed = await this.review.run(session, token, {
        slug: repository.githubSlug,
        number: opened.pullRequest.number,
      });
      if (!reviewed.ok) {
        // The account is out of usage rather than the review being broken, so
        // this is a pause, not a failure: the draft stays a draft and the
        // session waits for the hold to lift (US-006).
        if (reviewed.code === 'usage_limit') return this.held(session, opened, reviewed.message);
        // Everything else has spent its attempts. The pull request is not
        // getting any more of chief-web's attention, so it is released before
        // the session is failed — a session nobody looks at again must never
        // leave a draft behind (US-006).
        const stranded = await this.readyForReview(session, token, opened.pullRequest);
        return this.failed(session, 'review_failed', {
          message: sentences(reviewed.message, stranded),
          stderr: '',
        });
      }
      // The review is posted by the time the step answers `ok` — publishing is
      // what makes an attempt succeed — so the comment is on the pull request
      // before anything below runs. What may still be outstanding is the
      // feedback run the findings were handed to: the draft is held until that
      // is over (US-005), and released straight away when there was none
      // (US-004).
      const fixed = await this.awaitFeedbackRun(session, reviewed.solver);
      // The undraft comes first whether or not the run went well: a failed run
      // is still a pull request a human has to look at, and the failure below
      // is what makes that a retryable `feedback` stage (US-006).
      const undrafted = await this.readyForReview(session, token, opened.pullRequest);
      if (undrafted !== null) {
        return this.failed(session, 'pull_request_failed', { message: undrafted, stderr: '' });
      }
      if (fixed.failure !== null) {
        return this.failed(session, 'feedback_failed', {
          message: sentences(delivered, reviewed.message, fixed.failure),
          stderr: '',
        });
      }
      return this.finish(
        session,
        opened.pullRequest.url,
        opened.adopted,
        sentences(delivered, reviewed.message, fixed.message),
      );
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
   * The delivery of a run that changed nothing, or `null` when there is real
   * work to deliver (US-006).
   *
   * Only asked of a recurring task's run: a session a person planned and
   * watched build is theirs to finish, and an empty branch there is a
   * surprise they should see as the "No commits between …" failure GitHub
   * answers with. A scheduled run is the opposite — nobody is watching, a
   * nightly check that finds nothing is the *expected* result, and pushing a
   * branch and opening an empty pull request for it every night is exactly
   * the noise this feature exists to avoid.
   *
   * Nothing is skipped on a guess. A count git could not give, a container
   * that would not start, and a session that somehow already has a pull
   * request all fall through to the ordinary delivery, where a real failure is
   * reported as one.
   */
  private async cleanRun(session: Session): Promise<DeliveryResult | null> {
    if (session.prUrl !== null) return null;
    if (!(await this.committedNothing(session))) return null;

    logger.info('scheduled run finished clean: nothing was committed, so no pull request', {
      session: session.id,
      name: session.name,
      branch: session.featureBranch,
      base: session.baseBranch,
    });

    const message =
      `"${session.name}" committed nothing on "${session.featureBranch}", so the branch was not ` +
      'pushed and no pull request was opened.';
    const updated = updateSession(this.db, session.id, {
      status: 'finished',
      lastError: null,
      failureStage: null,
    });

    return {
      ok: true,
      sessionId: session.id,
      status: updated?.status ?? 'finished',
      prUrl: null,
      adopted: false,
      code: 'clean',
      message,
      stderr: '',
    };
  }

  /**
   * Whether this is a scheduled run whose feature branch is still exactly its
   * base branch (US-006).
   *
   * Asked of nothing else: an interactive session pushes and opens its pull
   * request the way it always has, and this question is not even put to git
   * for one. Anything git could not answer — a refused container, a range it
   * could not resolve, output that is not a number — is `false`, so the only
   * thing that skips a push is a count that really came back zero.
   */
  private async committedNothing(session: Session): Promise<boolean> {
    if (session.recurringTaskId === null) return false;

    let count: CommitCount;
    try {
      const container = await this.containers.start(session);
      count = await countBranchCommits(this.exec, container.id, {
        baseBranch: session.baseBranch,
        featureBranch: session.featureBranch,
        timeoutMs: this.config.pushTimeoutMs,
      });
    } catch (cause) {
      // The push this precedes starts the same container and reports the same
      // failure properly, so there is nothing to add here.
      logger.warn('could not count the commits of a scheduled run', {
        session: session.id,
        error: describe(cause),
      });
      return false;
    }

    if (!count.known) {
      logger.warn('the commits of a scheduled run could not be counted; delivering it as usual', {
        session: session.id,
        branch: session.featureBranch,
        error: count.message,
      });
      return false;
    }
    return count.commits === 0;
  }

  /**
   * Waits for the feedback run the review handed its findings to (US-005).
   *
   * This is what keeps the pull request a draft while chief-web fixes its own
   * review: the run pushes commits and answers the threads it was started for,
   * and a pull request marked ready in the middle of that is one a human reads
   * half-answered. So the session sits in `fixing` until the run's row reaches
   * a state that is not `running` — `finished`, `failed`, or back to
   * `pending` because somebody stopped it.
   *
   * Answers the sentence to add to the delivery's message and, when the run
   * did not work out, the sentence that fails the session at the `feedback`
   * stage (US-006). Both are `null` when there was nothing to wait for: a
   * review that flagged nothing, or a chief-web with no solver.
   *
   * A refusal is not waited for — there is no run to wait for — but it is
   * still read: `no_unresolved_feedback` means the findings were all
   * body-only and there is genuinely nothing to fix, which is a success, while
   * every other refusal is the run this delivery needed not happening, and
   * fails the session so the operator can retry it (US-006).
   *
   * Exactly one review → fix pass runs either way: nothing here re-reviews
   * what the run pushed (FR-14).
   */
  private async awaitFeedbackRun(
    session: Session,
    solver: SolverOutcome | null,
  ): Promise<FeedbackOutcome> {
    if (solver === null) return { message: null, failure: null };
    if (solver.runId === null) {
      if (solver.code === 'no_unresolved_feedback') return { message: null, failure: null };
      return { message: null, failure: solver.message };
    }

    updateSession(this.db, session.id, { status: 'fixing' });
    logger.info('waiting for the feedback run on the review findings', {
      session: session.id,
      run: solver.runId,
    });

    const run = await this.whenFeedbackRunSettles(solver.runId);
    if (run === null) {
      // The row was deleted under us, which is a thing the PullRequests page
      // can do. There is nothing left to wait for and nothing to report.
      return { message: null, failure: null };
    }

    logger.info('the feedback run on the review findings is over', {
      session: session.id,
      run: run.id,
      status: run.status,
      stage: run.failureStage,
    });

    if (run.status === 'finished') {
      return { message: 'Its feedback run has finished.', failure: null };
    }
    if (run.status === 'failed') {
      const stage = run.failureStage === null ? '' : ` at ${prFailureStageLabel(run.failureStage)}`;
      return {
        message: null,
        failure:
          `Its feedback run failed${stage}: ${run.lastError ?? 'no reason was recorded'}. The ` +
          'pull request has been marked ready for review all the same; retrying runs the ' +
          'feedback on it again.',
      };
    }
    // Stopped by hand, which is the operator saying the fixes are not wanted
    // rather than anything having gone wrong. The pull request is released and
    // the session finishes.
    return { message: 'Its feedback run was stopped.', failure: null };
  }

  /**
   * Polls the run's row until it is no longer `running`, answering the row it
   * settled on — or `null` when the row is gone.
   *
   * The row is the signal because it is the only one that survives everything:
   * the service that drives the run keeps its progress in memory, so a poll is
   * also what a run driven by a restarted server would be watched with. `start`
   * writes `running` before it answers, so a first read that says anything else
   * means the run is already over.
   */
  private async whenFeedbackRunSettles(runId: string): Promise<PrRun | null> {
    for (;;) {
      const run = getPrRun(this.db, runId);
      if (run === null || run.status !== 'running') return run;
      await pause(this.config.feedbackRunPollMs);
    }
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
    const merged = this.takenOver(session);
    if (merged !== null) {
      return {
        ok: true,
        sessionId: session.id,
        status: merged.status,
        prUrl: merged.prUrl ?? prUrl,
        adopted,
        code: 'ok',
        message: sentences(message, MERGED_MEANWHILE),
        stderr: '',
      };
    }

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
    updateSession(this.db, session.id, { status: 'reviewing' });
    logger.info('code review restarted; the pull request stays a draft until it is over', {
      session: session.id,
      name: session.name,
      number,
      url: prUrl,
    });
    const reviewed = await this.review.run(session, token, target);
    if (!reviewed.ok) {
      if (reviewed.code === 'usage_limit') return this.held(session, null, reviewed.message);
      const stranded = await this.undraft(session, token, repository.githubSlug);
      return this.failed(session, 'review_failed', {
        message: sentences(reviewed.message, stranded),
        stderr: '',
      });
    }
    // The same chain the automatic delivery does: a retried review that found
    // something hands it to a feedback run, the session is not done until that
    // run is (US-005), and the pull request is released afterwards either way
    // (US-006). The one difference is where the node id comes from — this path
    // has a URL — so the pull request is looked up rather than remembered.
    const fixed = await this.awaitFeedbackRun(session, reviewed.solver);
    const undrafted = await this.undraft(session, token, repository.githubSlug);
    if (undrafted !== null) {
      return this.failed(session, 'pull_request_failed', { message: undrafted, stderr: '' });
    }
    if (fixed.failure !== null) {
      return this.failed(session, 'feedback_failed', {
        message: sentences(reviewed.message, fixed.failure),
        stderr: '',
      });
    }
    return this.finish(session, prUrl, true, sentences(reviewed.message, fixed.message));
  }

  /**
   * Undrafts the session's pull request when all that is known about it is
   * which branch it is for (US-006).
   *
   * The retry paths reach the undraft with a URL rather than with the pull
   * request GitHub answered the create with, and the mutation takes nothing
   * but a node id — so the open pull request for this session's head → base is
   * looked up first, exactly as the delivery does when it adopts one. A pull
   * request that is no longer open is nothing to fail over: it was merged or
   * closed while the review ran, and neither leaves a draft behind.
   */
  private async undraft(session: Session, token: string, slug: string): Promise<string | null> {
    let pullRequest: PullRequest | null;
    try {
      pullRequest = await this.pullRequests.find(token, {
        slug,
        head: session.featureBranch,
        base: session.prTargetBranch,
      });
    } catch (cause) {
      const detail = cause instanceof GithubApiError ? cause.message : describe(cause);
      return `The pull request could not be looked up to mark it ready for review: ${detail}`;
    }
    if (pullRequest === null) {
      logger.info('no open pull request left to mark ready for review', {
        session: session.id,
        branch: session.featureBranch,
      });
      return null;
    }
    return this.readyForReview(session, token, pullRequest);
  }

  /**
   * Parks the session on the global usage-limit hold instead of failing it
   * (US-006).
   *
   * A review refused for the account's usage limit says nothing about the pull
   * request: there is no failure to report and nothing for the operator to fix,
   * so this matches what a refused build iteration does — arm the hold, put the
   * session in `waiting` with the expiry, and let the scheduler's resume walk
   * it back through the delivery once the hour is up. The pull request stays a
   * draft on purpose: the review that gates it has not happened yet.
   */
  private held(
    session: Session,
    opened: OpenedPullRequest | null,
    reason: string,
  ): DeliveryResult {
    const until = this.hold.arm();
    logger.warn('delivery held: the review agent was refused for Claude’s usage limit', {
      session: session.id,
      name: session.name,
      until,
      error: reason,
    });
    const updated = updateSession(this.db, session.id, {
      status: 'waiting',
      waitingUntil: until,
      // A pause rather than a failure, so no stage: the session page reads the
      // sentence below instead of offering a retry for something unbroken.
      lastError: heldMessage(until),
      failureStage: null,
    });

    return {
      ok: false,
      sessionId: session.id,
      status: updated?.status ?? 'waiting',
      prUrl: updated?.prUrl ?? session.prUrl,
      adopted: opened?.adopted ?? false,
      code: 'usage_limit_hold',
      message: `${reason}\n\n${heldMessage(until)}`,
      stderr: '',
    };
  }

  /**
   * The session's current row when the pull request sync has already moved it
   * to `merged` (US-007), or null while the session is still this delivery's
   * to write.
   *
   * The chain the delivery walks — draft, review, feedback run — can outlast
   * the pull request it is about: somebody can merge or close the draft from
   * GitHub at any point in it, and the sync writes that down. The review work
   * in flight is simply abandoned, but its *result* must not be: a merge is
   * the last word on a pull request, and putting the session back to
   * `pr-open` (or into `failed`) after it would only be corrected by the next
   * tick, or not at all.
   *
   * Only `merged` is guarded. A pull request closed unmerged puts the session
   * in `finished`, which is also where a retried delivery legitimately starts
   * from, so there is nothing here to tell those two apart — and the next tick
   * closes that window by reading the same closed pull request again.
   */
  private takenOver(session: Session): Session | null {
    const current = getSession(this.db, session.id);
    return current !== null && current.status === 'merged' ? current : null;
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
    code: DeliveryFailureCode,
    detail: { message: string; stderr: string },
  ): DeliveryResult {
    const merged = this.takenOver(session);
    if (merged !== null) {
      // Whatever went wrong was work on a pull request that has since been
      // merged: failing the session now would replace GitHub's answer with a
      // stage nobody can usefully retry (US-007).
      logger.warn('delivery failed after its pull request was merged; leaving the session merged', {
        session: session.id,
        name: session.name,
        code,
        error: detail.message,
      });
      return {
        ok: false,
        sessionId: session.id,
        status: merged.status,
        prUrl: merged.prUrl ?? session.prUrl,
        adopted: false,
        code,
        message: sentences(detail.message, MERGED_MEANWHILE),
        stderr: detail.stderr,
      };
    }

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

/** What a delivery says when GitHub merged its pull request while it ran (US-007). */
const MERGED_MEANWHILE =
  'Its pull request was merged while this ran, so the session was left merged.';

/** Joins the parts of a delivery's message, skipping the ones there were none of. */
function sentences(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' ');
}

/** What a session parked on the hold carries until it resumes (US-006). */
function heldMessage(until: string): string {
  return (
    'Claude’s usage limit was reached, so the code review of this pull request is held until ' +
    `${until}. The pull request is open as a draft and the session resumes the review by ` +
    'itself once the hold lifts.'
  );
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
