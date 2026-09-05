import {
  createSentryIssue,
  type Database,
  findSentryIssue,
  listSentryLinkedRepositories,
  type Repository,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { getSentryPollIntervalMs } from '../settings/index.js';

import type { SentryClassifier } from './classify.js';
import { createSentryClient, SentryApiError, type SentryIssueSummary } from './client.js';
import type { SentryFixer } from './fix.js';

/**
 * The front of the Sentry pipeline (US-005): every linked project's unresolved
 * issues, pulled into `sentry_issues` on a timer.
 *
 * The shape is `PrSyncService`'s, for the same reasons. The state is columns —
 * a repository's `sentry_org`/`sentry_project` pair and one row per issue — so
 * nothing is remembered between ticks: errors that arrived while the stack was
 * down are simply what the first tick after boot finds, and an operator who
 * restarts the server loses no queue. That is also why `start()` ticks
 * immediately before arming the timer.
 *
 * ## What a tick may do to a row
 *
 * Exactly two things. An issue Sentry has and this database does not is
 * inserted as `pending`, which is what puts it in front of the classifier
 * (US-006). An issue that is already here has its cached upstream fields — the
 * event count, `last_seen`, and the title Sentry may have re-grouped —
 * refreshed. It never has its `status`, `explanation`, `session_id` or
 * `attempts` touched: an issue being fixed must not fall back to `pending`
 * because it fired one more event. `createSentryIssue` is what enforces that
 * split, so the poller cannot get it wrong.
 *
 * Nothing is ever deleted here. An issue resolved in Sentry stops arriving,
 * which is not evidence about the fix chief-web has in flight for it.
 *
 * ## Failure
 *
 * Per repository. A bad token, a project that was renamed, an exhausted rate
 * limit — each costs that one repository this tick, is logged, and leaves its
 * rows exactly as they were, while the rest of the tick carries on. There is
 * no partial-write to undo: a repository whose list call failed simply had no
 * issues to write.
 *
 * ## Rate limit
 *
 * One paginated `GET /projects/{org}/{project}/issues/` per linked repository
 * per tick, and nothing at all when no repository is linked or no token is
 * configured — an install that does not use Sentry never reaches the network.
 * The interval is the operator's dial (US-002), re-read before every wait so a
 * change on the settings page needs no restart.
 */

/** The slice of {@link SentryClient} a tick needs; tests pass a stub. */
export interface SentryIssueGateway {
  listUnresolvedIssues(org: string, project: string): Promise<SentryIssueSummary[]>;
}

/**
 * How a tick gets its client. Null means "Sentry is not set up", which is the
 * normal state of an install that does not use it rather than an error.
 */
export type SentryGatewayFactory = (db: Database) => SentryIssueGateway | null;

/** What the poller offers its callers; {@link SentrySyncService} is the real one. */
export interface SentrySync {
  /** Catches up once, then polls. Idempotent. */
  start(): void;
  stop(): void;
  /** One pass over every linked repository. Returns how many issues were new. */
  tick(): Promise<number>;
}

/**
 * Sentry's own word for an issue nobody has acted on. Anything else — the
 * `resolved` and `ignored` an operator has already ruled on — is dropped
 * rather than inserted, even though `query=is:unresolved` means it should
 * never have arrived.
 */
const UNRESOLVED = 'unresolved';

export class SentrySyncService implements SentrySync {
  private timer: NodeJS.Timeout | null = null;
  /** The tick in flight, if any: a slow Sentry can outlast the interval. */
  private ticking: Promise<number> | null = null;
  /** Whether "there is nothing to poll" has been said, to say it only once. */
  private loggedIdle = false;

  constructor(
    private readonly db: Database,
    private readonly clients: SentryGatewayFactory = createSentryClient,
    /**
     * What is done with the `pending` rows a tick leaves behind (US-006).
     *
     * Hung off the poller rather than given a timer of its own because the two
     * are the same beat: an issue is worth classifying exactly once it has
     * arrived, and a second timer would either race this one or idle behind
     * it. Null for a chief-web without one, and for every test that is about
     * the polling rather than the judging.
     */
    private readonly classifier: SentryClassifier | null = null,
    /**
     * What is done with the `queued` rows the classifier leaves behind
     * (US-007): a build session each, seeded with a generated PRD. Hung off the
     * same beat for the same reason the classifier is — an issue is worth a
     * session exactly once it has been judged fixable, which happened moments
     * ago in this very tick.
     */
    private readonly fixer: SentryFixer | null = null,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    // Whatever fired while the stack was down is simply what this finds.
    void this.tick();
    const intervalMs = this.intervalMs();
    this.arm(intervalMs);
    logger.info('sentry issue sync started', { intervalMs });
  }

  stop(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** How long the poller waits between ticks (US-002); settings-driven. */
  intervalMs(): number {
    return getSentryPollIntervalMs(this.db);
  }

  /**
   * A self-re-arming timeout rather than one `setInterval`, so the interval is
   * read from the settings again before every wait — an operator who changes it
   * on the settings page gets the new cadence from the next tick, with no
   * restart. Re-arming happens before the tick rather than after it, so the
   * cadence is the fixed one `setInterval` would have given; a tick that
   * outlasts the interval is joined by the next one rather than doubling the
   * load on Sentry.
   */
  private arm(intervalMs: number): void {
    this.timer = setTimeout(() => {
      this.arm(this.intervalMs());
      void this.tick();
    }, intervalMs);
    // The HTTP listener is what keeps the process alive; the poller must never
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
    let linked: Repository[];
    try {
      linked = listSentryLinkedRepositories(this.db);
    } catch (cause) {
      // A database that cannot be read is not evidence that nothing fired;
      // the next tick asks again.
      logger.warn('could not read the repositories linked to a Sentry project', {
        error: describe(cause),
      });
      return 0;
    }
    if (linked.length === 0) return this.idle('no repository is linked to a Sentry project');

    // Only now, so an install with nothing linked never even looks the token up.
    const client = this.clients(this.db);
    if (client === null) {
      return this.idle('no Sentry token is configured', { repositories: linked.length });
    }
    this.loggedIdle = false;

    // Sequential on purpose: a tick has no deadline to meet, and asking Sentry
    // one project at a time is the gentlest thing to do to a shared budget.
    let inserted = 0;
    for (const repository of linked) inserted += await this.syncRepository(repository, client);

    // After the poll rather than during it: an issue this pass inserted is one
    // the classifier should see in the same beat, and a repository whose list
    // call failed has left nothing new to judge.
    await this.classify();
    // And the rows *that* pass leaves behind: a fixable issue with no session
    // is one nothing is happening to, whether it was queued a second ago or
    // three ticks back.
    await this.createFixSessions();
    return inserted;
  }

  /**
   * The classification pass, which must never be able to fail a poll: the rows
   * are already written, and a classifier that threw has left every one of
   * them `pending`, which is exactly where the next tick expects them.
   */
  private async classify(): Promise<void> {
    if (this.classifier === null) return;
    try {
      await this.classifier.classifyPending();
    } catch (cause) {
      logger.error('the Sentry issue classification pass failed', { error: describe(cause) });
    }
  }

  /**
   * The fix-session pass, which must never be able to fail a poll either: an
   * issue whose session could not be created is still `queued`, which is
   * exactly where the next tick expects it.
   */
  private async createFixSessions(): Promise<void> {
    if (this.fixer === null) return;
    try {
      await this.fixer.createFixSessions();
    } catch (cause) {
      logger.error('the Sentry fix session pass failed', { error: describe(cause) });
    }
  }

  /** One repository's issues. Returns how many of them were new here. */
  private async syncRepository(
    repository: Repository,
    client: SentryIssueGateway,
  ): Promise<number> {
    const { sentryOrg: org, sentryProject: project } = repository;
    // Both are non-null by the query that produced this row; narrowing them is
    // what lets the call below stay typed without a cast.
    if (org === null || project === null) return 0;

    let issues: SentryIssueSummary[];
    try {
      issues = await client.listUnresolvedIssues(org, project);
    } catch (cause) {
      // One project's bad token, renamed slug or exhausted rate limit costs
      // that repository this tick and nothing more: the loop carries on, and
      // every row this repository owns stays exactly as it was.
      logger.error('could not read the unresolved Sentry issues of a repository', {
        repository: repository.id,
        name: repository.name,
        org,
        project,
        error: describe(cause),
        code: cause instanceof SentryApiError ? cause.code : undefined,
        retryAfterMs: cause instanceof SentryApiError ? cause.retryAfterMs : undefined,
      });
      return 0;
    }

    let inserted = 0;
    for (const issue of issues) {
      // Sentry was asked for unresolved issues only; an issue that says it is
      // resolved or ignored anyway has been ruled on by somebody, and starting
      // a pipeline on it would be arguing with them.
      if (issue.status !== null && issue.status !== UNRESOLVED) continue;

      const known = findSentryIssue(this.db, issue.id) !== null;
      try {
        createSentryIssue(this.db, {
          repositoryId: repository.id,
          sentryIssueId: issue.id,
          shortId: issue.shortId,
          title: issue.title,
          culprit: issue.culprit,
          permalink: issue.permalink,
          level: issue.level,
          eventCount: issue.count,
          firstSeen: issue.firstSeen,
          lastSeen: issue.lastSeen,
        });
      } catch (cause) {
        // One unwritable row — a repository deleted mid-tick, say — is not a
        // reason to drop the rest of the page.
        logger.warn('could not record a Sentry issue', {
          repository: repository.id,
          issue: issue.shortId,
          error: describe(cause),
        });
        continue;
      }
      if (!known) inserted += 1;
    }

    if (inserted > 0) {
      logger.info('new Sentry issues recorded', {
        repository: repository.id,
        name: repository.name,
        inserted,
        seen: issues.length,
      });
    }
    return inserted;
  }

  /**
   * Nothing to poll. Said once at debug and then not again until something
   * changes: an install that does not use Sentry ticks forever, and its log
   * should not fill with the fact.
   */
  private idle(reason: string, meta: Record<string, unknown> = {}): number {
    if (!this.loggedIdle) {
      this.loggedIdle = true;
      logger.debug(`sentry issue sync has nothing to do: ${reason}`, meta);
    }
    return 0;
  }
}

export function createSentrySync(
  db: Database,
  clients: SentryGatewayFactory = createSentryClient,
  classifier: SentryClassifier | null = null,
  fixer: SentryFixer | null = null,
): SentrySyncService {
  return new SentrySyncService(db, clients, classifier, fixer);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
