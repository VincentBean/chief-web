import type { AgentRunner, QueuedStart } from '../build/index.js';
import type { Config } from '../config.js';
import {
  type BuildQueueEntry,
  buildQueuePosition,
  createPrReview,
  type Database,
  findPrReview,
  getPrReview,
  getQueuedBuild,
  getRepository,
  parsePrRefId,
  type PrReview,
  type PrReviewFailureStage,
  prRefId,
  type Repository,
  updatePrReview,
} from '../db/index.js';
import { REVIEW_ATTEMPTS } from '../delivery/index.js';
import type { BuildSlots, PrRunContainers } from '../prfeedback/index.js';
import { runPrCheckout } from '../prfeedback/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import { GithubApiError } from '../lib/github.js';
import { fetchPullRequestFeedback, type PullRequestFeedback } from '../lib/github-review.js';
import { logger } from '../lib/logger.js';
import { UsageLimitHold } from '../limits/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import type {
  PublishedReview,
  ReviewPassResult,
  ReviewPublisher,
  ReviewSubject,
} from '../review/index.js';
import { GithubReviewPublisher } from '../review/index.js';
import type { SessionExecutor } from '../sessions/index.js';
import { getGithubToken } from '../settings/index.js';

/**
 * A code review started by hand on an open pull request.
 *
 * The session review (US-007) runs once, at delivery, over a branch chief-web
 * built. This is the same pass — the same prompt, the same agent, the same
 * publisher, the same `COMMENT` review on GitHub — pointed at whichever open
 * pull request the operator picked on the Pull requests page, whether or not
 * chief-web ever built it. The shape is the feedback run's, not the session's:
 * one row per pull request, a container of its own, a checkout of the head
 * branch, one agent, and then a hand-off to the feedback solver exactly as the
 * session review does it.
 *
 * It gets the session review's three attempts too: an agent is flaky for
 * reasons nobody can act on — an overloaded API, a half-written document — and
 * one such failure should not cost the operator a click and a fresh checkout.
 */

/** Where a live review is; meaningless once it is over, so it is not persisted. */
export type PrReviewPhase = 'starting' | 'checking-out' | 'reviewing' | 'publishing';

export class PrReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PrReviewError';
  }
}

/** The slice of the review pass this run drives; tests pass a stub. */
export interface PrReviewer {
  reviewInContainer(subject: ReviewSubject): Promise<ReviewPassResult>;
}

/** The slice of `PrFeedbackService` the findings are handed to. */
export interface PrReviewSolver {
  start(repositoryId: string, prNumber: number): Promise<{ readonly id: string }>;
}

/** The slice of the GitHub API a review reads; tests pass a stub. */
export interface PrReviewGateway {
  pullRequest(token: string, slug: string, number: number): Promise<PullRequestFeedback>;
}

export interface PrReviewView {
  readonly id: string;
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly status: PrReview['status'];
  /** True while *this* server is driving it. */
  readonly running: boolean;
  readonly phase: PrReviewPhase | null;
  /** How many times the review has been started by hand. */
  readonly attempt: number;
  /** Which pass of the current start is running; `null` once it is over. */
  readonly pass: number | null;
  readonly failureStage: PrReviewFailureStage | null;
  /** True while it is waiting in the build queue for a slot (US-003). */
  readonly queued: boolean;
  /** Its 1-based place in that queue, or `null` when it is not in it. */
  readonly queuePosition: number | null;
  readonly lastError: string | null;
  readonly headSha: string | null;
  readonly reviewUrl: string | null;
  readonly inlineComments: number | null;
  readonly foldedFindings: number | null;
  readonly solverMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

interface RunState {
  phase: PrReviewPhase;
  /** Which of the {@link REVIEW_ATTEMPTS} passes is running. */
  attempt: number;
  containerId: string | null;
  finished: Promise<void>;
  stopping: boolean;
}

export class PrReviewService {
  private readonly live = new Map<string, RunState>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: PrRunContainers,
    private readonly exec: SessionExecutor,
    private readonly runner: AgentRunner,
    private readonly reviewer: PrReviewer,
    private readonly publisher: ReviewPublisher,
    private readonly github: PrReviewGateway,
    private readonly slots: BuildSlots,
    private readonly token: () => string | null,
    /**
     * Where the findings go next: the same solver the session review chains
     * into. A thunk because the solver is built after this service in `app.ts`
     * for the same reason it is a thunk there; `null` for a chief-web without
     * one, and for every test that is not about the chaining.
     */
    private readonly solver: () => PrReviewSolver | null = () => null,
    private readonly hold: UsageLimitHold = new UsageLimitHold(db),
  ) {}

  status(reviewId: string): PrReviewView {
    const review = getPrReview(this.db, reviewId);
    if (review === null) throw new PrReviewError(404, 'pr_review_not_found', 'No such review.');
    return this.view(review);
  }

  find(repositoryId: string, prNumber: number): PrReviewView | null {
    const review = findPrReview(this.db, repositoryId, prNumber);
    return review === null ? null : this.view(review);
  }

  /**
   * Starts a review, or takes a place in the unified build queue (US-003).
   *
   * Every refusal that can be made without spending anything is made first:
   * the cheap checks come before a container — or even a GitHub call — exists.
   * A full pool is no longer one of them. The review is queued instead, and the
   * pump starts it the moment a slot frees, so nobody has to press the button a
   * second time.
   */
  async start(repositoryId: string, prNumber: number): Promise<PrReviewView> {
    const repository = getRepository(this.db, repositoryId);
    if (repository === null) {
      throw new PrReviewError(404, 'repository_not_found', 'No such repository.');
    }
    if (!isValidGithubSlug(repository.githubSlug)) {
      throw new PrReviewError(
        400,
        'invalid_github_slug',
        `"${repository.githubSlug}" is not a GitHub owner/repo slug.`,
      );
    }

    const token = this.token();
    if (token === null) {
      throw new PrReviewError(
        400,
        'github_token_missing',
        'No GitHub token is configured, so the review cannot be posted.',
      );
    }

    const existing = findPrReview(this.db, repositoryId, prNumber);
    if (existing !== null && this.live.has(existing.id)) {
      throw new PrReviewError(
        409,
        'review_already_active',
        'That pull request is already being reviewed.',
      );
    }
    // Already waiting for a slot: this request *is* the one in the queue, not
    // a second one. Answered before the GitHub read, so leaning on the button
    // costs nothing at all.
    const refId = prRefId(repositoryId, prNumber);
    if (existing !== null && getQueuedBuild(this.db, 'pr-review', refId) !== null) {
      return this.view(existing);
    }

    const held = this.hold.until();
    if (held !== null) {
      throw new PrReviewError(
        409,
        'usage_limit_hold',
        'Claude’s usage limit was reached, so no agent can be started until ' +
          `${held}. Nothing was done to #${String(prNumber)}; start the review again after that time.`,
      );
    }

    // Claimed before the pull request is read, so the slot this review was
    // offered is still its own when the read comes back, and the pump cannot
    // hand the same one to the entry behind it in the meantime. `null` means
    // there was nothing to claim: this review is going to queue.
    const slot = this.slots.freeSlots() > 0 ? this.slots.claimStart('pr-review', refId) : null;
    try {
      return await this.begin(repository, prNumber, token, slot !== null);
    } finally {
      // The row says `running` by now, which is what the cap counts; a review
      // that queued or was refused never took the slot in the first place.
      if (slot !== null) slot();
    }
  }

  /**
   * The half of {@link start} that costs something: the pull request is read,
   * and the review either starts or joins the queue.
   */
  private async begin(
    repository: Repository,
    prNumber: number,
    token: string,
    hasSlot: boolean,
  ): Promise<PrReviewView> {
    const pull = await this.readPullRequest(token, repository.githubSlug, prNumber);
    if (pull.state !== 'OPEN') {
      throw new PrReviewError(
        409,
        'pull_request_not_open',
        `Pull request #${String(prNumber)} is ${pull.state.toLowerCase()}, so there is nothing to review.`,
      );
    }
    if (pull.fromFork) {
      // The clone is made with this repository's deploy key over SSH, and the
      // branch under review lives on a repository that key cannot read.
      throw new PrReviewError(
        409,
        'pull_request_from_fork',
        `The head branch "${pull.headRef}" of #${String(prNumber)} lives on another repository, ` +
          `which ${repository.name}'s deploy key cannot read.`,
      );
    }

    const review = createPrReview(this.db, {
      repositoryId: repository.id,
      prNumber,
      prUrl: pull.url,
      prTitle: pull.title,
      headBranch: pull.headRef,
      baseBranch: pull.baseRef,
    });
    if (this.live.has(review.id)) {
      throw new PrReviewError(
        409,
        'review_already_active',
        'That pull request is already being reviewed.',
      );
    }
    if (!hasSlot) return this.queue(review);

    const started =
      updatePrReview(this.db, review.id, {
        status: 'running',
        attempt: review.attempt + 1,
        failureStage: null,
        lastError: null,
        solverMessage: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }) ?? review;

    const state: RunState = {
      phase: 'starting',
      attempt: 0,
      containerId: null,
      finished: Promise.resolve(),
      stopping: false,
    };
    this.live.set(review.id, state);
    state.finished = this.drive(started, repository.sshUrl, repository.githubSlug, token, pull, state)
      .catch((cause: unknown) => {
        logger.error('pull request review crashed', { review: review.id, error: String(cause) });
        this.fail(review.id, 'agent', String(cause));
      })
      .finally(() => {
        this.live.delete(review.id);
        void this.containers.removePrRun(review.id);
        // Whatever was waiting for a build slot can have this one back.
        void this.slots.pump();
      });

    return this.status(review.id);
  }

  /**
   * Signals the agent, or — for a review that is still waiting for a slot —
   * takes it out of the queue before it ever starts (US-003). Nothing is
   * posted for a stopped review either way.
   */
  async stop(reviewId: string): Promise<PrReviewView> {
    const state = this.live.get(reviewId);
    if (state === undefined) return this.cancelQueued(reviewId);
    state.stopping = true;
    if (state.containerId !== null) await this.runner.stop(reviewId, state.containerId);
    await settle(state.finished, this.config.buildStopTimeoutMs);
    return this.status(reviewId);
  }

  /** Resolves when the review is no longer driving anything; used by tests. */
  async whenIdle(reviewId: string): Promise<void> {
    await this.live.get(reviewId)?.finished;
  }

  /**
   * How the pump starts a queued review (US-003).
   *
   * Handed to `BuildService.registerStart` in `app.ts` rather than imported
   * there, because the build loop sits below this service: it owns the queue,
   * this owns what a `pr-review` entry means.
   */
  starter(): QueuedStart {
    return {
      // A repository deleted while the review waited takes its pull requests
      // with it; the entry is dropped rather than started.
      exists: (entry) => this.reference(entry) !== null,
      isRunning: (entry) => {
        const review = this.queuedReview(entry);
        return review !== null && this.live.has(review.id);
      },
      start: async (entry) => {
        const ref = this.reference(entry);
        if (ref === null) {
          throw new Error(`"${entry.refId}" no longer names a pull request that can be reviewed.`);
        }
        // The same call the operator made, with the same parameters: the pull
        // request is read afresh, so the review runs against whatever has been
        // pushed to it since it was asked for.
        await this.start(ref.repositoryId, ref.prNumber);
      },
      onFailed: (entry, message) => {
        const review = this.queuedReview(entry);
        // Somewhere the operator will see it: the review's own row on the pull
        // requests page. Saying nothing would be a review that quietly never
        // happened.
        if (review !== null) {
          this.fail(
            review.id,
            'agent',
            `The queued review could not be started, so it left the queue: ${message}`,
          );
        }
      },
    };
  }

  /** Puts the review in the unified queue and answers with where it stands. */
  private queue(review: PrReview): PrReviewView {
    const entry = this.slots.enqueue('pr-review', prRefId(review.repositoryId, review.prNumber));
    // Whatever the last pass left behind is history: this review is going to
    // run again, and `pending` is what the UI reads as "nothing to show yet".
    const waiting =
      updatePrReview(this.db, review.id, {
        status: 'pending',
        failureStage: null,
        lastError: null,
        solverMessage: null,
        startedAt: null,
        finishedAt: null,
      }) ?? review;
    logger.info('pull request review queued: every build slot is in use', {
      review: review.id,
      repository: review.repositoryId,
      number: review.prNumber,
      queuedAt: entry.queuedAt,
    });
    return this.view(waiting);
  }

  /** Takes a review that has not started out of the queue; a no-op otherwise. */
  private cancelQueued(reviewId: string): PrReviewView {
    const review = getPrReview(this.db, reviewId);
    if (review === null) throw new PrReviewError(404, 'pr_review_not_found', 'No such review.');
    if (!this.slots.leaveQueue('pr-review', prRefId(review.repositoryId, review.prNumber))) {
      return this.view(review);
    }

    logger.info('a queued pull request review was cancelled', {
      review: review.id,
      repository: review.repositoryId,
      number: review.prNumber,
    });
    return this.view(
      updatePrReview(this.db, review.id, {
        status: 'pending',
        lastError: 'Cancelled before it started.',
      }) ?? review,
    );
  }

  /** The pull request an entry points at, or `null` when it is gone. */
  private reference(entry: BuildQueueEntry): { repositoryId: string; prNumber: number } | null {
    const ref = parsePrRefId(entry.refId);
    if (ref === null) return null;
    return getRepository(this.db, ref.repositoryId) === null ? null : ref;
  }

  /** The row an entry names, when a pass has already made one. */
  private queuedReview(entry: BuildQueueEntry): PrReview | null {
    const ref = this.reference(entry);
    return ref === null ? null : findPrReview(this.db, ref.repositoryId, ref.prNumber);
  }

  private async drive(
    review: PrReview,
    repoUrl: string,
    slug: string,
    token: string,
    pull: PullRequestFeedback,
    state: RunState,
  ): Promise<void> {
    state.phase = 'starting';
    let container: SessionContainerView;
    try {
      container = await this.containers.startPrRun({
        id: review.id,
        prNumber: review.prNumber,
        repositoryId: review.repositoryId,
      });
    } catch (cause) {
      this.fail(review.id, 'container_lost', `The container could not be started: ${String(cause)}`);
      return;
    }
    state.containerId = container.id;
    updatePrReview(this.db, review.id, { containerId: container.id });

    state.phase = 'checking-out';
    const checkout = await runPrCheckout(this.exec, container.id, {
      repoUrl,
      headBranch: review.headBranch,
      expectedHeadSha: pull.headSha,
      timeoutMs: this.config.sessionSetupTimeoutMs,
    });
    if (!checkout.ok) {
      this.fail(review.id, 'checkout', `${checkout.message}\n${checkout.stderr}`.trim());
      return;
    }
    updatePrReview(this.db, review.id, { headSha: checkout.headSha });
    if (state.stopping) return this.stopped(review.id);

    // The same three complete attempts the session review gets: run the
    // agent, then post what it found. A pass that fell over — an overloaded
    // API, a document that came back half-written, a GitHub call that timed
    // out — costs a fresh look at the diff, not the whole review. The branch
    // stays checked out in the same container throughout.
    const reasons: string[] = [];
    // Where the most recent attempt failed: the stage the operator reads first.
    let lastStage: PrReviewFailureStage = 'agent';
    let published: PublishedReview | null = null;
    let findings = 0;
    for (let attempt = 1; attempt <= REVIEW_ATTEMPTS; attempt += 1) {
      state.phase = 'reviewing';
      state.attempt = attempt;
      const pass = await this.reviewer.reviewInContainer({
        id: review.id,
        name: `${slug}#${String(review.prNumber)}`,
        containerId: container.id,
        targetBranch: review.baseBranch,
        featureBranch: review.headBranch,
      });
      if (state.stopping) return this.stopped(review.id);
      if (pass.code === 'usage_limit') {
        // The account is out, not the pull request: the next attempt walks
        // straight back into the same wall, so hold the whole server, as a
        // feedback run does, and leave this one to be started again after.
        const until = this.hold.arm();
        reasons.push(`Attempt ${String(attempt)}: ${pass.message}`);
        this.fail(
          review.id,
          'agent',
          'Claude’s usage limit was reached, so the review was stopped before it could ' +
            `finish and agent work is held until ${until}. Nothing was posted — start the ` +
            `review again once the hold lifts.\n\n${reasons.join('\n')}`,
        );
        await this.slots.holdAll(until);
        return;
      }
      if (!pass.ok || pass.report === null) {
        lastStage = pass.code === 'invalid_findings' ? 'findings' : 'agent';
        reasons.push(`Attempt ${String(attempt)}: ${pass.message}\n${pass.output}`.trim());
        logger.warn('pull request review attempt failed', {
          review: review.id,
          attempt,
          code: pass.code,
        });
        continue;
      }

      state.phase = 'publishing';
      try {
        published = await this.publisher.publish(
          token,
          { slug, number: review.prNumber },
          pass.report,
        );
        findings = pass.report.findings.length;
        break;
      } catch (cause) {
        const message = cause instanceof GithubApiError ? cause.message : String(cause);
        lastStage = 'publish';
        reasons.push(
          `Attempt ${String(attempt)}: the review could not be posted to GitHub: ${message}`,
        );
        logger.warn('pull request review attempt failed', {
          review: review.id,
          attempt,
          code: 'publish',
        });
      }
    }
    if (published === null) {
      const attempts = reasons.length;
      this.fail(
        review.id,
        lastStage,
        `The code review failed after ${String(attempts)} attempt${attempts === 1 ? '' : 's'}. ` +
          'Nothing was posted; starting the review again runs it afresh.' +
          `\n\n${reasons.join('\n')}`,
      );
      return;
    }

    logger.info('pull request review posted', {
      review: review.id,
      repository: slug,
      number: review.prNumber,
      inlineComments: published.inlineComments,
      foldedFindings: published.foldedFindings,
    });

    // Finished before the hand-off, so the solver's own slot check sees this
    // review's slot given back rather than still held.
    updatePrReview(this.db, review.id, {
      status: 'finished',
      reviewUrl: published.url === '' ? null : published.url,
      inlineComments: published.inlineComments,
      foldedFindings: published.foldedFindings,
      finishedAt: new Date().toISOString(),
    });

    const solverMessage = await this.handOff(review, slug, findings);
    if (solverMessage !== null) updatePrReview(this.db, review.id, { solverMessage });
  }

  /**
   * Hands the findings to the feedback solver, exactly as the session review
   * does. Never throws and never fails the review: the findings are on GitHub
   * either way, and a refusal here is the same one the operator would read on
   * the Pull requests page.
   */
  private async handOff(review: PrReview, slug: string, findings: number): Promise<string | null> {
    if (findings === 0) return null;
    const solver = this.solver();
    if (solver === null) return null;

    try {
      const run = await solver.start(review.repositoryId, review.prNumber);
      logger.info('pull request review findings handed to the feedback solver', {
        review: review.id,
        repository: slug,
        number: review.prNumber,
        run: run.id,
      });
      return `A run was started on #${String(review.prNumber)} to work on them.`;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn('the pull request review could not start a feedback run', {
        review: review.id,
        repository: slug,
        number: review.prNumber,
        error: message,
      });
      return `No run was started to work on them: ${message}`;
    }
  }

  private async readPullRequest(
    token: string,
    slug: string,
    prNumber: number,
  ): Promise<PullRequestFeedback> {
    try {
      return await this.github.pullRequest(token, slug, prNumber);
    } catch (cause) {
      if (cause instanceof GithubApiError) throw cause;
      throw new PrReviewError(502, 'pull_request_unreadable', String(cause));
    }
  }

  private stopped(reviewId: string): void {
    updatePrReview(this.db, reviewId, {
      status: 'pending',
      lastError: 'Stopped.',
      finishedAt: new Date().toISOString(),
    });
  }

  private fail(reviewId: string, stage: PrReviewFailureStage, message: string): void {
    updatePrReview(this.db, reviewId, {
      status: 'failed',
      failureStage: stage,
      lastError: message.slice(0, 8000),
      finishedAt: new Date().toISOString(),
    });
    logger.warn('pull request review failed', { review: reviewId, stage });
  }

  private view(review: PrReview): PrReviewView {
    const state = this.live.get(review.id);
    const queuePosition = buildQueuePosition(
      this.db,
      'pr-review',
      prRefId(review.repositoryId, review.prNumber),
    );
    return {
      id: review.id,
      repositoryId: review.repositoryId,
      prNumber: review.prNumber,
      prUrl: review.prUrl,
      prTitle: review.prTitle,
      headBranch: review.headBranch,
      baseBranch: review.baseBranch,
      status: review.status,
      running: state !== undefined,
      phase: state?.phase ?? null,
      attempt: review.attempt,
      pass: state === undefined || state.attempt === 0 ? null : state.attempt,
      failureStage: review.failureStage,
      queued: queuePosition !== null,
      queuePosition,
      lastError: review.lastError,
      headSha: review.headSha,
      reviewUrl: review.reviewUrl,
      inlineComments: review.inlineComments,
      foldedFindings: review.foldedFindings,
      solverMessage: review.solverMessage,
      startedAt: review.startedAt,
      finishedAt: review.finishedAt,
    };
  }
}

/** Resolves when `promise` settles, or after `timeoutMs`, whichever is first. */
async function settle(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/** The production wiring: the real GitHub client and the shared orchestrator. */
export function createPrReviewService(
  config: Config,
  db: Database,
  containers: PrRunContainers,
  exec: SessionExecutor,
  runner: AgentRunner,
  reviewer: PrReviewer,
  slots: BuildSlots,
  solver: () => PrReviewSolver | null,
  publisher: ReviewPublisher = new GithubReviewPublisher(config),
  github: PrReviewGateway = new GithubPrReviewGateway(config),
  hold: UsageLimitHold = new UsageLimitHold(db),
): PrReviewService {
  return new PrReviewService(
    config,
    db,
    containers,
    exec,
    runner,
    reviewer,
    publisher,
    github,
    slots,
    () => getGithubToken(db),
    solver,
    hold,
  );
}

class GithubPrReviewGateway implements PrReviewGateway {
  constructor(private readonly config: Pick<Config, 'githubGraphqlUrl'>) {}

  pullRequest(token: string, slug: string, number: number): Promise<PullRequestFeedback> {
    return fetchPullRequestFeedback(token, this.config.githubGraphqlUrl, slug, number);
  }
}
