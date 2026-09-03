import type { Config } from '../config.js';
import {
  type Database,
  getRepository,
  listSessions,
  type Session,
  type SessionStatus,
  updateSession,
} from '../db/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import { fetchPullRequestState, GithubApiError, type PullRequestState } from '../lib/github.js';
import { logger } from '../lib/logger.js';
import { getGithubToken, getPrSyncIntervalMs } from '../settings/index.js';

/**
 * Keeping the sessions with a pull request in step with GitHub (US-003).
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
 * ## The sessions it looks at
 *
 * `pr-open` is where a delivered session sits, but it is not the only status
 * with a pull request behind it (US-007): a draft is open from the moment the
 * delivery created it, and the session spends the review in `reviewing` and
 * the feedback run in `fixing` before it ever reaches `pr-open`. Somebody who
 * closes or merges that draft in the meantime has said what they think of it,
 * so those two statuses are synced exactly like `pr-open` — the alternative
 * is a session that keeps reviewing a pull request nobody can merge and then
 * lands in `pr-open` behind a closed one.
 *
 * The review or feedback run that is still in flight is not stopped: it is
 * abandoned, and whatever it does next is harmless. A delivery that finishes
 * after the sync moved the session on sees it — {@link DeliveryService} does
 * not overwrite a `merged` session — and one that finishes just before the
 * next tick is corrected by that tick, because the sync remembers nothing and
 * simply reads the status column again.
 *
 * ## Rate limit
 *
 * One `GET /repos/{slug}/pulls/{number}` per synced session per tick — the
 * response's `merged` flag is the authoritative answer, and listing a
 * repository's *open* pull requests cannot give it, because an absent pull
 * request is equally consistent with "merged" and "closed unmerged".
 *
 * At the default 15-minute interval that is 4 requests per hour per open pull
 * request: 40/hour with ten of them, against a 5000/hour token budget. A tick
 * with no such session costs nothing at all — not even the token lookup —
 * so an installation that has never opened a pull request never touches GitHub.
 *
 * The interval is the operator's dial on that budget (US-004): 15 minutes by
 * default, settable per installation on the settings page, and re-read before
 * every wait so a change needs no restart.
 *
 * ## Cleanup
 *
 * A session that reaches `merged` also loses its container (US-005): the work
 * is on `origin` and merged, so nothing will ever want that container again,
 * and leaving it idling costs memory and a disk layer for as long as the
 * installation runs. The workspace is deliberately *not* touched — that is
 * only ever the session-deletion path (US-012).
 */

/**
 * The statuses a session's pull request is asked about in (US-007).
 *
 * `reviewing` and `fixing` are in here because the draft is already open in
 * both of them, so an external merge or close has to be seen there too — and
 * because a session whose pull request is gone must not be left running a
 * review chain that can only end in `pr-open` behind it.
 */
const SYNCED_STATUSES = ['pr-open', 'reviewing', 'fixing'] as const satisfies readonly SessionStatus[];

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

/**
 * The slice of the orchestrator (US-009) the merge cleanup drives: remove the
 * session's container, keep its workspace. `SessionOrchestrator` satisfies it
 * structurally, and a test passes a stub.
 */
export interface SessionContainerCleanup {
  remove(sessionId: string): Promise<void>;
}

/** What a sync offers its callers; {@link PrSyncService} is the real one. */
export interface PullRequestSync {
  /** Catches up once, then polls. Idempotent. */
  start(): void;
  stop(): void;
  /** One pass over every session with a pull request. Returns how many changed status. */
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
    private readonly containers: SessionContainerCleanup,
    private readonly github: PullRequestStateGateway,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    // Whatever was merged while the stack was down is simply what this finds,
    // which is also how the US-001 backfill's `pr-open` rows get corrected.
    void this.tick();
    const intervalMs = this.intervalMs();
    this.arm(intervalMs);
    logger.info('pull request sync started', { intervalMs });
  }

  stop(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * How long the sync waits between polls (US-004). `PR_SYNC_INTERVAL_MS` is
   * only the default: a value saved on the settings page wins.
   */
  intervalMs(): number {
    return getPrSyncIntervalMs(this.db, this.config);
  }

  /**
   * A self-re-arming timeout rather than one `setInterval`, so the interval is
   * read from the settings again before every wait — an operator who changes it
   * on the settings page gets the new cadence from the next tick, with no
   * restart. Re-arming happens before the tick rather than after it, so the
   * cadence is the same fixed one `setInterval` gave; a tick that outlasts the
   * interval is joined by the next one rather than doubling the load.
   */
  private arm(intervalMs: number): void {
    this.timer = setTimeout(() => {
      this.arm(this.intervalMs());
      void this.tick();
    }, intervalMs);
    // The HTTP listener is what keeps the process alive; the sync must never
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
    // Before anything is asked of GitHub: the containers of sessions that are
    // already `merged` but whose cleanup did not get through last time. This
    // costs one local query when there is nothing to do, and it is what makes
    // a failed removal a delay rather than a leak.
    await this.cleanUpMerged();

    let open: Session[];
    try {
      open = SYNCED_STATUSES.flatMap((status) => listSessions(this.db, { status }));
    } catch (cause) {
      // A database that cannot be read is not evidence that nothing changed;
      // the next tick asks again.
      logger.warn('could not read the sessions with a pull request', {
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
      // The status is written first and stands whatever happens next: GitHub's
      // state is the truth, and a container that could not be removed is a
      // resource to reclaim later, not a reason to call the session unmerged.
      const merged = updateSession(this.db, session.id, { status: 'merged' }) ?? session;
      logger.info('pull request merged', {
        session: session.id,
        name: session.name,
        status: session.status,
        prUrl: session.prUrl,
      });
      await this.cleanUp(merged);
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
        status: session.status,
        prUrl: session.prUrl,
      });
      return true;
    }

    return false;
  }

  /**
   * Every `merged` session that still owns a container (US-005).
   *
   * A removal can fail — the daemon can be down, or busy — and the session is
   * `merged` by then, so the sync would never look at it again: the main pass
   * only lists sessions it has not moved yet. Sweeping the leftovers at
   * the top of every tick is the retry, and `container_id` is the record of
   * what is still owed. Startup reconciliation (US-009) reaps the same
   * containers, so this only shortens the wait on a running stack.
   */
  private async cleanUpMerged(): Promise<void> {
    let merged: Session[];
    try {
      merged = listSessions(this.db, { status: 'merged' });
    } catch (cause) {
      logger.warn('could not read the merged sessions to clean up', { error: describe(cause) });
      return;
    }
    for (const session of merged) await this.cleanUp(session);
  }

  /**
   * Throws away the build container of a merged session, keeping its workspace
   * — the clone and the `.chief/` state stay on the data volume, because only
   * deleting the session is allowed to take those.
   *
   * A session with no container is a no-op, so nothing is asked of Docker for
   * the sessions this has already cleaned. A failure is logged and swallowed
   * with `container_id` left as it was, which is both the honest record — the
   * container may well still be there — and what brings the next tick back.
   */
  private async cleanUp(session: Session): Promise<void> {
    if (session.containerId === null) return;

    try {
      await this.containers.remove(session.id);
    } catch (cause) {
      logger.warn('could not remove the container of a merged session', {
        session: session.id,
        name: session.name,
        container: session.containerId,
        error: describe(cause),
      });
      return;
    }

    // The orchestrator clears the column itself, but the sync states the
    // outcome it promised rather than relying on how the removal was done.
    updateSession(this.db, session.id, { containerId: null });
    logger.info('removed the container of a merged session', {
      session: session.id,
      name: session.name,
      container: session.containerId,
    });
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
      logger.warn('a session has no pull request URL, so it cannot be synced', {
        session: session.id,
        name: session.name,
        status: session.status,
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
  containers: SessionContainerCleanup,
  github: PullRequestStateGateway = new GithubPullRequestStates(config),
): PrSyncService {
  return new PrSyncService(config, db, containers, github);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
