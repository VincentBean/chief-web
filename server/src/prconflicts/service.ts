import type { Config } from '../config.js';
import {
  type Database,
  deletePrConflictFix,
  findPrConflictFix,
  findPrReview,
  findPrRun,
  hasStandingFailure,
  listRepositories,
  type Repository,
} from '../db/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import {
  fetchPullRequestMergeability,
  GithubApiError,
  type PullRequestMergeability,
} from '../lib/github.js';
import {
  listOpenPullRequestsAcross,
  type OpenPullRequest,
  type RepositoryPullRequests,
} from '../lib/github-review.js';
import { logger } from '../lib/logger.js';
import { getConflictFixEnabled, getGithubToken, getPrConflictIntervalMs } from '../settings/index.js';

/**
 * Watching open pull requests for merge conflicts (US-003).
 *
 * The same philosophy as `PrSyncService`: nothing is remembered between ticks.
 * A conflict that appeared while the stack was down is simply what the first
 * tick after boot finds, and a restart in the middle of a scan loses nothing —
 * every decision is made again from the listing, GitHub's mergeability verdict
 * and the rows already in the database.
 *
 * A tick decides, and only decides. What it does with a conflicted pull
 * request is a {@link ConflictFixStarter} handed in from outside (US-005);
 * without one it logs the conflict and moves on, which is the whole of this
 * story.
 *
 * ## What is a candidate
 *
 * Two filters run on the *listing*, before GitHub is asked anything else:
 *
 * - the head branch must start with `chief/`, because the fixer only ever
 *   touches chief-web's own branches and never a colleague's pull request;
 * - the head must not be on a fork, because the resolution is pushed with this
 *   repository's deploy key, which cannot write to one — the same rule
 *   `prfeedback/service.ts` enforces at the start of a run.
 *
 * `draft` is deliberately not a filter: a draft pull request conflicts exactly
 * as badly as any other, and the operator asked for it to be fixed too.
 *
 * ## Rate limit
 *
 * One `GET /repos/{slug}/pulls` per connected repository per tick, plus one
 * `GET /repos/{slug}/pulls/{number}` per candidate — the listing does not carry
 * mergeability, GitHub only computes it on the single pull request endpoint,
 * which is exactly why the two filters above run first. At the 30-minute
 * default with three repositories and ten candidates that is 26 requests an
 * hour against a 5000/hour budget.
 *
 * A tick with no connected repository, or one whose repositories have no open
 * pull requests, costs nothing beyond the listing — and with no repositories at
 * all, not even the token lookup.
 *
 * ## Failure
 *
 * Nothing here ever marks anything failed. GitHub being unreachable says
 * nothing about a pull request's mergeability, so an unreachable listing ends
 * the tick and one repository's error, or one pull request's, costs that
 * repository or that pull request this tick and nothing more. The next tick
 * asks again.
 */

/** Only chief-web's own branches are ever touched (FR-2). */
export const CHIEF_BRANCH_PREFIX = 'chief/';

/** The slice of the GitHub API the scan needs; tests pass a stub. */
export interface ConflictScanGateway {
  list(token: string, slugs: readonly string[]): Promise<RepositoryPullRequests[]>;
  mergeability(token: string, slug: string, number: number): Promise<PullRequestMergeability>;
}

/** The production gateway: the real REST API at the configured base URL. */
export class GithubConflictScan implements ConflictScanGateway {
  constructor(private readonly config: Pick<Config, 'githubApiUrl'>) {}

  list(token: string, slugs: readonly string[]): Promise<RepositoryPullRequests[]> {
    return listOpenPullRequestsAcross(token, this.config.githubApiUrl, slugs);
  }

  mergeability(token: string, slug: string, number: number): Promise<PullRequestMergeability> {
    return fetchPullRequestMergeability(token, this.config.githubApiUrl, slug, number);
  }
}

/**
 * A conflicted pull request the scan found, with everything a fix run needs:
 * the identity of the pull request, and the two commits the conflict was seen
 * at — which are what the checkout pins to and what the "don't retry until the
 * pull request changes" rule keys on.
 */
export interface ConflictedPullRequest {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly slug: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly baseSha: string;
}

/**
 * What is done about a conflict. US-005 plugs the fix pipeline in here; until
 * then the scan runs with none and only reports what it found.
 */
export interface ConflictFixStarter {
  start(pull: ConflictedPullRequest): Promise<void>;
}

/** What a scan offers its callers; {@link PrConflictService} is the real one. */
export interface ConflictScan {
  /** Scans once, then polls. Idempotent. */
  start(): void;
  stop(): void;
  /** One pass over every connected repository. Returns conflicts acted on. */
  tick(): Promise<number>;
}

export class PrConflictService implements ConflictScan {
  private timer: NodeJS.Timeout | null = null;
  /** The tick in flight, if any: a slow GitHub can outlast the interval. */
  private ticking: Promise<number> | null = null;
  /** Whether the "no token" complaint has already been made, to log it once. */
  private warnedAboutToken = false;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly github: ConflictScanGateway,
    private readonly starter: ConflictFixStarter | null = null,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    // Whatever grew a conflict while the stack was down is simply what this
    // first tick finds.
    void this.tick();
    const intervalMs = this.intervalMs();
    this.arm(intervalMs);
    logger.info('pull request conflict scan started', { intervalMs, enabled: this.enabled() });
  }

  stop(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * How long the scan waits between passes (US-004).
   * `PR_CONFLICT_INTERVAL_MS` is only the default: a value saved on the
   * settings page wins, and it is read again before every wait so a change
   * needs no restart.
   */
  intervalMs(): number {
    return getPrConflictIntervalMs(this.db, this.config);
  }

  /**
   * Whether the operator has left the fixer switched on (US-004). Read at the
   * top of every tick rather than at `start()`, so switching it off stops the
   * very next tick — and, because the timer keeps running either way,
   * switching it back on needs no restart either.
   */
  enabled(): boolean {
    return getConflictFixEnabled(this.db);
  }

  /**
   * A self-re-arming timeout rather than one `setInterval`, so the interval is
   * read again before every wait — the shape US-004's settings dial needs.
   * Re-arming happens before the tick, so the cadence is the fixed one
   * `setInterval` would give and a slow tick is joined by the next rather than
   * doubling the load.
   */
  private arm(intervalMs: number): void {
    this.timer = setTimeout(() => {
      this.arm(this.intervalMs());
      void this.tick();
    }, intervalMs);
    // The HTTP listener is what keeps the process alive; the scan must never
    // be the reason it does.
    this.timer.unref();
  }

  tick(): Promise<number> {
    const inFlight = this.ticking;
    if (inFlight !== null) return inFlight;

    const run = this.runTick().finally(() => {
      this.ticking = null;
    });
    this.ticking = run;
    return run;
  }

  private async runTick(): Promise<number> {
    // Switched off means switched off: no listing, no mergeability request, no
    // token lookup, nothing written down. The timer stays armed so the scan
    // resumes on its own the moment the switch goes back.
    if (!this.enabled()) return 0;

    let repositories: Repository[];
    try {
      repositories = listRepositories(this.db);
    } catch (cause) {
      // A database that cannot be read is not evidence that nothing conflicts;
      // the next tick asks again.
      logger.warn('could not read the repositories to scan for merge conflicts', {
        error: describe(cause),
      });
      return 0;
    }

    // A row's slug is editable, so it is re-checked before every call — the
    // same guard the delivery step and the pull requests page make.
    const connected = repositories.filter((repository) =>
      isValidGithubSlug(repository.githubSlug),
    );
    // Nothing connected: not a single request, not even the token lookup.
    if (connected.length === 0) return 0;

    const token = getGithubToken(this.db);
    if (token === null) {
      if (!this.warnedAboutToken) {
        this.warnedAboutToken = true;
        logger.warn(
          'no GitHub token is configured, so open pull requests cannot be scanned for ' +
            'merge conflicts; add one on the settings page',
          { repositories: connected.length },
        );
      }
      return 0;
    }
    this.warnedAboutToken = false;

    let answers: RepositoryPullRequests[];
    try {
      answers = await this.github.list(
        token,
        connected.map((repository) => repository.githubSlug),
      );
    } catch (cause) {
      // `listOpenPullRequestsAcross` reports a per-repository failure in the
      // answer rather than by throwing, so reaching here means GitHub itself
      // is unreachable. Nothing is marked failed — the tick simply ends.
      logger.warn('could not list the open pull requests to scan for merge conflicts', {
        error: describe(cause),
        code: cause instanceof GithubApiError ? cause.code : undefined,
      });
      return 0;
    }

    const bySlug = new Map(answers.map((answer) => [answer.slug, answer]));

    // Sequential on purpose: a tick has no deadline to meet, and asking GitHub
    // one pull request at a time is the gentlest thing to do to a shared
    // budget.
    let found = 0;
    for (const repository of connected) {
      found += await this.scanRepository(repository, bySlug.get(repository.githubSlug), token);
    }
    return found;
  }

  /** One repository's pull requests. Returns how many conflicts were acted on. */
  private async scanRepository(
    repository: Repository,
    answer: RepositoryPullRequests | undefined,
    token: string,
  ): Promise<number> {
    if (answer === undefined) {
      logger.warn('no answer for a repository while scanning for merge conflicts', {
        repository: repository.id,
        slug: repository.githubSlug,
      });
      return 0;
    }
    if (answer.error !== null) {
      // One repository's bad token, renamed slug or exhausted rate limit costs
      // that repository this tick and nothing else's.
      logger.warn('could not list a repository’s open pull requests', {
        repository: repository.id,
        slug: repository.githubSlug,
        error: answer.error,
        message: answer.message,
      });
      return 0;
    }
    if (answer.truncated) {
      // The listing stopped at its page budget, so the pull requests beyond it
      // are invisible this tick. The ones we did get are still scanned.
      logger.warn('a repository’s open pull request listing was truncated, so some pull ' +
        'requests were not scanned for conflicts', {
        repository: repository.id,
        slug: repository.githubSlug,
        listed: answer.pullRequests.length,
      });
    }

    let found = 0;
    for (const pull of answer.pullRequests) {
      if (!isCandidate(pull)) continue;
      if (await this.scanPullRequest(repository, pull, token)) found += 1;
    }
    return found;
  }

  /** One candidate pull request. Returns whether a conflict was acted on. */
  private async scanPullRequest(
    repository: Repository,
    pull: OpenPullRequest,
    token: string,
  ): Promise<boolean> {
    // Before spending a request: a pull request chief-web is already working
    // on is not one to start anything else on. The check is free, so it comes
    // first.
    const active = this.activeRunOn(repository.id, pull.number);
    if (active !== null) {
      logger.debug('skipping a pull request with a chief-web run already on it', {
        repository: repository.id,
        prNumber: pull.number,
        headBranch: pull.headRef,
        run: active,
      });
      return false;
    }

    let mergeability: PullRequestMergeability;
    try {
      mergeability = await this.github.mergeability(token, repository.githubSlug, pull.number);
    } catch (cause) {
      // One pull request's failure costs that pull request this tick; the loop
      // carries on, and nothing about it is written down.
      logger.warn('could not read the mergeability of a pull request', {
        repository: repository.id,
        slug: repository.githubSlug,
        prNumber: pull.number,
        error: describe(cause),
        code: cause instanceof GithubApiError ? cause.code : undefined,
      });
      return false;
    }

    if (mergeability.mergeable === 'unknown') {
      // GitHub answers `null` and starts computing the merge in the
      // background; the answer is simply read on the next tick. Polling again
      // inside this one would spend the budget on waiting.
      logger.debug('GitHub has not computed the mergeability of a pull request yet', {
        repository: repository.id,
        prNumber: pull.number,
        mergeableState: mergeability.mergeableState,
      });
      return false;
    }

    if (mergeability.mergeable === 'clean') {
      this.clearStaleFailure(repository, pull);
      return false;
    }

    const fix = findPrConflictFix(this.db, repository.id, pull.number);
    if (fix !== null && hasStandingFailure(fix, mergeability.headSha, mergeability.baseSha)) {
      // Three attempts were already spent on exactly these two commits, and
      // the operator has been told so in the UI. Nothing has changed since, so
      // there is nothing new to try.
      logger.debug('a pull request’s conflict fix already failed on these commits', {
        repository: repository.id,
        prNumber: pull.number,
        headSha: mergeability.headSha,
        baseSha: mergeability.baseSha,
      });
      return false;
    }

    const conflicted: ConflictedPullRequest = {
      repositoryId: repository.id,
      repositoryName: repository.name,
      slug: repository.githubSlug,
      prNumber: pull.number,
      prUrl: pull.url,
      prTitle: pull.title,
      headBranch: pull.headRef,
      // The mergeability answer is the fresher of the two, and the only one
      // carrying a base SHA at all.
      baseBranch: mergeability.baseRef,
      headSha: mergeability.headSha,
      baseSha: mergeability.baseSha,
    };
    logger.info('a pull request has merge conflicts', {
      repository: repository.id,
      slug: repository.githubSlug,
      prNumber: pull.number,
      headBranch: conflicted.headBranch,
      baseBranch: conflicted.baseBranch,
      mergeableState: mergeability.mergeableState,
    });

    if (this.starter === null) return true;
    try {
      await this.starter.start(conflicted);
    } catch (cause) {
      // A fix that could not be started — no build slot, a usage-limit hold —
      // is this tick's loss and not a failure of the pull request: the next
      // tick finds the same conflict and tries again.
      logger.warn('could not start a conflict fix for a pull request', {
        repository: repository.id,
        prNumber: pull.number,
        error: describe(cause),
      });
      return false;
    }
    return true;
  }

  /**
   * The chief-web run already on this pull request, named for the log, or null
   * when there is none.
   *
   * A queued run counts as much as a started one: both end with an agent in a
   * container on that branch. The reverse race — a review starting while a fix
   * runs — is tolerated, because a review does not push code.
   */
  private activeRunOn(repositoryId: string, prNumber: number): string | null {
    const run = findPrRun(this.db, repositoryId, prNumber);
    if (run !== null && (run.status === 'running' || run.status === 'pending')) return 'feedback';

    const review = findPrReview(this.db, repositoryId, prNumber);
    if (review !== null && (review.status === 'running' || review.status === 'pending')) {
      return 'review';
    }

    const fix = findPrConflictFix(this.db, repositoryId, prNumber);
    if (fix !== null && fix.status === 'running') return 'conflict-fix';

    return null;
  }

  /**
   * A `failed` fix on a pull request GitHub now calls mergeable describes a
   * conflict that no longer exists — somebody resolved it by hand, or the base
   * moved back under it. Dropping the row takes the failure flag off the pull
   * requests page; a conflict that comes back earns a fresh run anyway, because
   * the commits it is seen at will be different ones.
   */
  private clearStaleFailure(repository: Repository, pull: OpenPullRequest): void {
    const fix = findPrConflictFix(this.db, repository.id, pull.number);
    if (fix === null || fix.status !== 'failed') return;

    deletePrConflictFix(this.db, fix.id);
    logger.info('cleared a stale conflict fix failure on a mergeable pull request', {
      repository: repository.id,
      prNumber: pull.number,
      fix: fix.id,
    });
  }
}

/**
 * Whether a listed pull request is worth a mergeability request at all
 * (FR-2, FR-3). `draft` is not consulted: a draft conflicts like any other.
 */
export function isCandidate(pull: OpenPullRequest): boolean {
  return pull.headRef.startsWith(CHIEF_BRANCH_PREFIX) && !pull.fromFork;
}

export function createPrConflictScan(
  config: Config,
  db: Database,
  starter: ConflictFixStarter | null = null,
  github: ConflictScanGateway = new GithubConflictScan(config),
): PrConflictService {
  return new PrConflictService(config, db, github, starter);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
