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
import { GithubApiError, type OpenedPullRequest, openPullRequest, type PullRequestInput } from '../lib/github.js';
import { logger } from '../lib/logger.js';
import type { SessionContainers, SessionExecutor } from '../sessions/index.js';
import { getGithubToken } from '../settings/index.js';
import { pullRequestBody, pullRequestTitle } from './pull-request.js';
import { type PushResult, runPush } from './push.js';

/**
 * Delivering a finished session: push, then pull request (US-014).
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
}

/** The production opener: the real REST API at the configured base URL. */
export class GithubPullRequests implements PullRequestOpener {
  constructor(private readonly config: Pick<Config, 'githubApiUrl'>) {}

  open(token: string, input: PullRequestInput): Promise<OpenedPullRequest> {
    return openPullRequest(token, this.config.githubApiUrl, input);
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
  | 'pull_request_failed';

/**
 * Which of the two steps each failure belongs to (US-019). It is what a retry
 * dispatches on: both stages re-run the delivery and nothing else, but the
 * operator is told which half to go and fix — the remote, or GitHub.
 */
const FAILURE_STAGE_OF: Record<Exclude<DeliveryCode, 'ok'>, FailureStage> = {
  container_unavailable: 'push',
  push_failed: 'push',
  github_token_missing: 'pull_request',
  repository_missing: 'pull_request',
  invalid_github_slug: 'pull_request',
  pull_request_failed: 'pull_request',
};

export class DeliveryService implements BuildCompletion {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly exec: SessionExecutor,
    private readonly pullRequests: PullRequestOpener,
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

    return this.deliver(session, stories);
  }

  /**
   * Push, then pull request, then the session's final state. The session ends
   * `finished` with its pull request URL, or `failed` with the reason — git's
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

    const finished = updateSession(this.db, session.id, {
      status: 'finished',
      prUrl: opened.pullRequest.url,
      lastError: null,
      failureStage: null,
    });

    logger.info(opened.adopted ? 'pull request adopted' : 'pull request opened', {
      session: session.id,
      name: session.name,
      repository: repository.githubSlug,
      head: session.featureBranch,
      base: session.prTargetBranch,
      number: opened.pullRequest.number,
      url: opened.pullRequest.url,
    });

    return {
      ok: true,
      sessionId: session.id,
      status: finished?.status ?? 'finished',
      prUrl: opened.pullRequest.url,
      adopted: opened.adopted,
      code: 'ok',
      message: opened.adopted
        ? `Pushed "${session.featureBranch}"; pull request #${String(opened.pullRequest.number)} was already open and has been adopted.`
        : `Pushed "${session.featureBranch}" and opened pull request #${String(opened.pullRequest.number)}.`,
      stderr: '',
    };
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
): DeliveryService {
  return new DeliveryService(config, db, containers, exec, pullRequests);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
