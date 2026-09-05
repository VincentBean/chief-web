import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import {
  type Database,
  getRepository,
  listSentryIssuesByStatus,
  listSessions,
  type PrTargetBranch,
  type Repository,
  type SentryIssue,
  updateSentryIssue,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { giveToRunner, sessionRepoDir } from '../orchestrator/index.js';
import { prdDirFor } from '../prd/index.js';
import type { CreateSessionRequest, ReadyResult, SessionSetupView } from '../sessions/index.js';
import { sessionPrdFile } from '../sessions/index.js';

import { createSentryClient, SentryApiError, type SentryIssueDetails } from './client.js';
import type { SentryDetailsFactory, SentryDetailsGateway } from './classify.js';
import { fixPrd, fixSessionBaseName, uniqueFixSessionName } from './prd.js';

/**
 * Turning a fixable Sentry issue into a build session (US-007).
 *
 * Runs after the classification pass, over the `queued` rows it left behind.
 * Each one becomes a real session: the repository's default base branch, code
 * review on so the existing review + PR-feedback pipeline runs, a generated
 * `prd.md` holding everything Sentry knows about the error, and "Mark ready",
 * which is what puts it in the ordinary build queue. From that point on nothing
 * about it is special — the scheduler, the slot cap, the delivery and the pull
 * request are the ones every other session gets.
 *
 * ## Why there is no cap here
 *
 * There is one upstream. {@link import('./classify.js').MAX_ISSUES_PER_TICK}
 * decides how many issues reach `queued` per tick, and the build queue decides
 * how many sessions run at once. A second cap in the middle would only leave
 * sessions un-created while slots sat empty.
 *
 * ## Exactly one session per issue
 *
 * The row leaves `queued` in the same beat the session is created, so the next
 * tick's `listSentryIssuesByStatus(db, 'queued')` no longer returns it. An issue
 * that somehow still carries a `session_id` is skipped outright rather than
 * given a second one.
 *
 * ## Failure
 *
 * Per issue, and never destructive. A missing deploy key, a clone that was
 * refused, a PRD that would not write: the error is logged, the issue stays
 * `queued` with one more attempt against it, and the next tick tries again. At
 * {@link MAX_FIX_ATTEMPTS} it becomes `cannot_fix` with the failure named, so
 * the Sentry tab says what went wrong rather than "nothing happened". A session
 * that was created before the failure is deleted, so the retry starts clean —
 * and because `session_id` is `ON DELETE SET NULL`, the issue is unlinked by
 * the deletion itself.
 */

/** Failed attempts at building a fix session before the issue is given up on. */
export const MAX_FIX_ATTEMPTS = 3;

/** Where a fix session's pull request goes when the base branch is neither. */
export const DEFAULT_PR_TARGET_BRANCH: PrTargetBranch = 'main';

/** The explanation stored when the attempts run out; names what failed. */
export function fixSessionFailedExplanation(reason: string): string {
  return `No fix session could be created for this issue: ${reason}`;
}

/** The slice of {@link import('../sessions/index.js').SessionService} this drives. */
export interface FixSessionService {
  create(request: CreateSessionRequest): Promise<SessionSetupView>;
  markReady(id: string): Promise<ReadyResult>;
  delete(id: string): Promise<void>;
}

/** What the poller calls once the classification pass is done. */
export interface SentryFixer {
  /** One pass over the queued issues. Returns how many sessions were created. */
  createFixSessions(): Promise<number>;
}

/**
 * Where a pull request opened by a fix session goes.
 *
 * The `sessions` table CHECKs `pr_target_branch` to `develop` or `main`, so a
 * repository whose base branch is neither — a release branch, a fork's `master`
 * — cannot have its own branch named here. `main` is the answer then: it is the
 * one of the two that every repository has, and a pull request opened against
 * the wrong branch is visible and re-targetable, while a session that could not
 * be created is not.
 */
export function prTargetBranchFor(baseBranch: string): PrTargetBranch {
  return baseBranch === 'develop' || baseBranch === 'main' ? baseBranch : DEFAULT_PR_TARGET_BRANCH;
}

const PRD_DIR_MODE = 0o755;
const PRD_DIR_FALLBACK_MODE = 0o777;
const PRD_FILE_FALLBACK_MODE = 0o666;

/**
 * Writes `.chief/prds/<session>/prd.md` into the session's clone.
 *
 * The server is root in Docker and the agent is uid 1000, so a file the server
 * creates is one the agent cannot rewrite — and the build loop rewrites this
 * one on every story it starts. Each directory the write has to create, and the
 * file itself, is therefore handed to the runner exactly as the workspace and
 * the staged deploy key are. The build loop's own `**Status:**` write gets this
 * for free by rewriting in place; a brand new file has to ask.
 */
export function writeSessionPrd(
  config: Pick<Config, 'workspacesDir'>,
  session: { id: string; name: string },
  content: string,
): string {
  const repoDir = sessionRepoDir(config, session.id);
  let dir = repoDir;
  for (const segment of prdDirFor(session.name).split('/')) {
    dir = path.join(dir, segment);
    fs.mkdirSync(dir, { recursive: true, mode: PRD_DIR_MODE });
    giveToRunner(dir, PRD_DIR_FALLBACK_MODE);
  }

  const file = sessionPrdFile(config, session);
  fs.writeFileSync(file, content);
  giveToRunner(file, PRD_FILE_FALLBACK_MODE);
  return file;
}

export class SentryFixService implements SentryFixer {
  constructor(
    private readonly config: Pick<Config, 'workspacesDir'>,
    private readonly db: Database,
    private readonly sessions: FixSessionService,
    private readonly clients: SentryDetailsFactory = createSentryClient,
  ) {}

  async createFixSessions(): Promise<number> {
    const queued = listSentryIssuesByStatus(this.db, 'queued');
    if (queued.length === 0) return 0;

    // Only now, so an install with nothing queued never looks the token up.
    const client = this.clients(this.db);
    if (client === null) {
      logger.debug('sentry fix sessions cannot be created: no Sentry token is configured', {
        queued: queued.length,
      });
      return 0;
    }

    let created = 0;
    for (const issue of queued) {
      if (issue.sessionId !== null) {
        // Belt and braces: the status alone already keeps a second tick away.
        logger.warn('a queued Sentry issue already has a session; leaving it alone', {
          issue: issue.shortId,
          session: issue.sessionId,
        });
        continue;
      }
      const repository = getRepository(this.db, issue.repositoryId);
      // A repository that is gone, or whose Sentry link was removed, is not a
      // failure of this issue: it waits, untouched, for the link to come back.
      if (repository === null) continue;
      if (repository.sentryOrg === null || repository.sentryProject === null) continue;

      if (await this.createFor(issue, repository, client)) created += 1;
    }
    return created;
  }

  /** One issue. Returns whether it left `queued` with a session behind it. */
  private async createFor(
    issue: SentryIssue,
    repository: Repository,
    client: SentryDetailsGateway,
  ): Promise<boolean> {
    const org = repository.sentryOrg;
    if (org === null) return false;

    let details: SentryIssueDetails;
    try {
      details = await client.getIssueDetails(org, issue.sentryIssueId);
    } catch (cause) {
      if (isTransient(cause)) {
        // Sentry is down or has had enough of us. Nothing about this issue is
        // in question, so it keeps its attempts and waits for the next tick.
        logger.warn('a Sentry issue could not be read for its fix session', {
          issue: issue.shortId,
          error: describe(cause),
        });
        return false;
      }
      this.failed(issue, `the issue could not be read from Sentry: ${describe(cause)}`);
      return false;
    }

    const name = this.sessionName(repository.id, issue.shortId);

    let setup: SessionSetupView;
    try {
      setup = await this.sessions.create({
        repositoryId: repository.id,
        name,
        baseBranch: repository.defaultBaseBranch,
        prTargetBranch: prTargetBranchFor(repository.defaultBaseBranch),
        // The whole point of the pipeline: the pull request this session opens
        // goes through the existing automatic review and PR-feedback chain
        // without anybody asking for it.
        codeReview: true,
      });
    } catch (cause) {
      // A missing deploy key, a name the database refused: nothing was created.
      this.failed(issue, describe(cause));
      return false;
    }

    if (!setup.setup.ok) {
      // The row exists but its clone does not, so there is nothing to build in
      // and nothing to write a PRD into.
      await this.discard(setup.session.id);
      this.failed(issue, `the repository could not be cloned: ${setup.setup.message}`);
      return false;
    }

    const session = { id: setup.session.id, name: setup.session.name };
    try {
      writeSessionPrd(
        this.config,
        session,
        fixPrd({ sessionName: session.name, details, explanation: issue.explanation }),
      );
    } catch (cause) {
      await this.discard(session.id);
      this.failed(issue, `the generated PRD could not be written: ${describe(cause)}`);
      return false;
    }

    let ready: ReadyResult;
    try {
      ready = await this.sessions.markReady(session.id);
    } catch (cause) {
      await this.discard(session.id);
      this.failed(issue, `the session could not be marked ready: ${describe(cause)}`);
      return false;
    }
    if (!ready.ok) {
      // chief-web generated this PRD, so a PRD that does not parse is a bug
      // here rather than something an operator can fix — say so with the line
      // numbers, and let the attempts run out.
      await this.discard(session.id);
      this.failed(
        issue,
        `the generated PRD did not parse: ${ready.prd.errors.map((error) => error.message).join(' ')}`,
      );
      return false;
    }

    // Only here, and in one write: from now on the issue is `working` and no
    // tick will look at it again.
    updateSentryIssue(this.db, issue.id, {
      sessionId: session.id,
      status: 'working',
      attempts: 0,
    });
    logger.info('a fix session was created for a Sentry issue', {
      issue: issue.shortId,
      repository: repository.id,
      session: session.id,
      name: session.name,
      stories: ready.stories.length,
    });
    return true;
  }

  /** `sentry-proj-123`, or the first free numeric suffix after it. */
  private sessionName(repositoryId: string, shortId: string): string {
    const taken = new Set(
      listSessions(this.db, { repositoryId }).map((session) => session.name),
    );
    return uniqueFixSessionName(fixSessionBaseName(shortId), taken);
  }

  /**
   * Throws away a session created for an issue that then failed, so the retry
   * starts from nothing. Best effort: a deletion that fails leaves a pending
   * session an operator can see and remove, which is better than an issue that
   * never gets another attempt.
   */
  private async discard(sessionId: string): Promise<void> {
    try {
      await this.sessions.delete(sessionId);
    } catch (cause) {
      logger.warn('a half-created Sentry fix session could not be deleted', {
        session: sessionId,
        error: describe(cause),
      });
    }
  }

  /**
   * One failed attempt. The issue stays `queued` and comes back on the next
   * tick until the attempts run out, at which point it is given up on with the
   * failure named — `attempts` is the counter the classification pass reset to
   * zero when it said the issue was fixable.
   */
  private failed(issue: SentryIssue, reason: string): void {
    const attempts = issue.attempts + 1;
    if (attempts >= MAX_FIX_ATTEMPTS) {
      updateSentryIssue(this.db, issue.id, {
        status: 'cannot_fix',
        explanation: fixSessionFailedExplanation(reason),
        attempts,
      });
      logger.error('a Sentry issue was given up on after repeated session failures', {
        issue: issue.shortId,
        attempts,
        error: reason,
      });
      return;
    }
    updateSentryIssue(this.db, issue.id, { attempts });
    logger.error('a fix session could not be created for a Sentry issue', {
      issue: issue.shortId,
      attempts,
      error: reason,
    });
  }
}

/**
 * Is this a Sentry failure that says nothing about the issue? Same reasoning as
 * the classifier's: an hour of Sentry trouble must not burn three attempts.
 */
function isTransient(cause: unknown): boolean {
  return (
    cause instanceof SentryApiError &&
    (cause.code === 'sentry_rate_limited' || cause.code === 'sentry_unreachable')
  );
}

export function createSentryFixer(
  config: Pick<Config, 'workspacesDir'>,
  db: Database,
  sessions: FixSessionService,
  clients: SentryDetailsFactory = createSentryClient,
): SentryFixService {
  return new SentryFixService(config, db, sessions, clients);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
