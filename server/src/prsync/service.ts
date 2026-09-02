import type { Config } from '../config.js';
import {
  type Database,
  getRepository,
  listSessions,
  type Session,
  updateSession,
} from '../db/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import { fetchPullRequestState, GithubApiError, type PullRequestState } from '../lib/github.js';
import { logger } from '../lib/logger.js';
import { getGithubToken } from '../settings/index.js';

/**
 * Keeping `pr-open` sessions in step with GitHub (US-003).
 *
 * The same philosophy as the scheduler: the state is a column — a session is
 * `pr-open` with a `pr_url` on it — and this service is only the thing that
 * keeps looking at it. Nothing is remembered between ticks, so a merge that
 * happened while the stack was down is simply what the first tick after boot
 * finds, and an operator who restarts the server does not lose a queue.
 *
 * The sync makes exactly three transitions and no others: a merged pull
 * request moves the session to `merged`, one closed without merging moves it
 * back to `finished` (keeping `pr_url`, so the link still works), and one that
 * is still open is left exactly where it is. In particular a session is never
 * marked `failed` here — GitHub being unreachable says nothing about the work,
 * which is committed, pushed and delivered.
 *
 * ## Rate limit
 *
 * One `GET /repos/{slug}/pulls/{number}` per `pr-open` session per tick — the
 * response's `merged` flag is the authoritative answer, and listing a
 * repository's *open* pull requests cannot give it, because an absent pull
 * request is equally consistent with "merged" and "closed unmerged".
 *
 * At the default 15-minute interval that is 4 requests per hour per open pull
 * request: 40/hour with ten of them, against a 5000/hour token budget. A tick
 * with no `pr-open` session costs nothing at all — not even the token lookup —
 * so an installation that has never opened a pull request never touches GitHub.
 */

/** The slice of the GitHub API this service needs; tests pass a stub. */
export interface PullRequestStateGateway {
  state(token: string, slug: string, number: number): Promise<PullRequestState>;
}

/** The production gateway: the real REST API at the configured base URL. */
export class GithubPullRequestStates implements PullRequestStateGateway {
  constructor(private readonly config: Pick<Config, 'githubApiUrl'>) {}

  state(token: string, slug: string, number: number): Promise<PullRequestState> {
    return fetchPullRequestState(token, this.config.githubApiUrl, slug, number);
  }
}

/** What a sync offers its callers; {@link PrSyncService} is the real one. */
export interface PullRequestSync {
  /** Catches up once, then polls. Idempotent. */
  start(): void;
  stop(): void;
  /** One pass over every `pr-open` session. Returns how many changed status. */
  tick(): Promise<number>;
}

export class PrSyncService implements PullRequestSync {
  private timer: NodeJS.Timeout | null = null;
  /** The tick in flight, if any: a slow GitHub can outlast the interval. */
  private ticking: Promise<number> | null = null;
  /** Whether the "no token" complaint has already been made, to log it once. */
  private warnedAboutToken = false;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly github: PullRequestStateGateway,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    // Whatever was merged while the stack was down is simply what this finds,
    // which is also how the US-001 backfill's `pr-open` rows get corrected.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.prSyncIntervalMs);
    // The HTTP listener is what keeps the process alive; the sync must never
    // be the reason it does.
    this.timer.unref();
    logger.info('pull request sync started', { intervalMs: this.config.prSyncIntervalMs });
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
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
    let open: Session[];
    try {
      open = listSessions(this.db, { status: 'pr-open' });
    } catch (cause) {
      // A database that cannot be read is not evidence that nothing changed;
      // the next tick asks again.
      logger.warn('could not read the sessions with an open pull request', {
        error: describe(cause),
      });
      return 0;
    }
    if (open.length === 0) return 0;

    const token = getGithubToken(this.db);
    if (token === null) {
      if (!this.warnedAboutToken) {
        this.warnedAboutToken = true;
        logger.warn(
          'no GitHub token is configured, so open pull requests cannot be synced; ' +
            'add one on the settings page',
          { sessions: open.length },
        );
      }
      return 0;
    }
    this.warnedAboutToken = false;

    // Sequential on purpose: a tick has no deadline to meet, and asking GitHub
    // one session at a time is the gentlest thing to do to a shared budget.
    let changed = 0;
    for (const session of open) {
      if (await this.syncSession(session, token)) changed += 1;
    }
    return changed;
  }

  /** One session's pull request. Returns whether its status changed. */
  private async syncSession(session: Session, token: string): Promise<boolean> {
    const target = this.targetOf(session);
    if (target === null) return false;

    let state: PullRequestState;
    try {
      state = await this.github.state(token, target.slug, target.number);
    } catch (cause) {
      // One repository's bad token, deleted pull request or exhausted rate
      // limit costs that session this tick and nothing more: the loop carries
      // on, and the session stays exactly where it is.
      logger.warn('could not read the pull request of a session', {
        session: session.id,
        name: session.name,
        prUrl: session.prUrl,
        error: describe(cause),
        code: cause instanceof GithubApiError ? cause.code : undefined,
      });
      return false;
    }

    if (state.merged) {
      updateSession(this.db, session.id, { status: 'merged' });
      logger.info('pull request merged', {
        session: session.id,
        name: session.name,
        prUrl: session.prUrl,
      });
      return true;
    }

    if (state.state === 'closed') {
      // Closed without merging: there is no distinct state for that, so the
      // session goes back to where a build with nothing open ends. `pr_url` is
      // kept deliberately — the pull request still exists and still explains
      // what happened to the branch.
      updateSession(this.db, session.id, { status: 'finished' });
      logger.info('pull request closed without merging', {
        session: session.id,
        name: session.name,
        prUrl: session.prUrl,
      });
      return true;
    }

    return false;
  }

  /**
   * The `owner/repo` and number to ask about, or null when the session cannot
   * be asked about at all.
   *
   * The slug comes from the repository row — editable, so re-checked here, the
   * same guard delivery and the pull requests page make — and the number from
   * the stored URL, which is the only record of which pull request this was.
   */
  private targetOf(session: Session): { slug: string; number: number } | null {
    if (session.prUrl === null) {
      logger.warn('a session is pr-open with no pull request URL, so it cannot be synced', {
        session: session.id,
        name: session.name,
      });
      return null;
    }

    const number = pullRequestNumberOf(session.prUrl);
    if (number === null) {
      logger.warn('could not read a pull request number from a session’s URL', {
        session: session.id,
        prUrl: session.prUrl,
      });
      return null;
    }

    const repository = getRepository(this.db, session.repositoryId);
    if (repository === null || !isValidGithubSlug(repository.githubSlug)) {
      logger.warn('a session’s repository has no usable GitHub slug, so it cannot be synced', {
        session: session.id,
        repository: session.repositoryId,
        slug: repository?.githubSlug,
      });
      return null;
    }

    return { slug: repository.githubSlug, number };
  }
}

/**
 * The number in `https://github.com/owner/repo/pull/123`, or null when the URL
 * is not one. Enterprise hosts and a trailing `/files` or `#discussion_r…` are
 * all tolerated: only the `/pull/<number>` segment is looked for.
 */
export function pullRequestNumberOf(prUrl: string): number | null {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(prUrl);
  if (match === null) return null;
  const number = Number.parseInt(match[1] ?? '', 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function createPrSync(
  config: Config,
  db: Database,
  github: PullRequestStateGateway = new GithubPullRequestStates(config),
): PrSyncService {
  return new PrSyncService(config, db, github);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
