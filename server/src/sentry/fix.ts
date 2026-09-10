import fs from 'node:fs';
import path from 'node:path';

import { BuildError } from '../build/index.js';
import type { Config } from '../config.js';
import {
  type Database,
  getRepository,
  getSentryIssue,
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
import { fixBatchPrd, fixBatchSessionName } from './prd.js';

/**
 * Turning a batch of approved Sentry issues into one build session (US-006).
 *
 * Nothing here scans for work. The only way in is
 * {@link SentryFixService.createFixSession}, which is handed an explicit list
 * of issue ids by the operator's "Create fix session" API — the poll tick ends
 * at a proposed plan and never reaches this file. That is the whole point of
 * the approval flow: a pull request exists because somebody asked for it, not
 * because an error fired.
 *
 * ## Why one session for the whole batch
 *
 * Because a session is a pull request and a review. Ten issues fixed one at a
 * time cost ten of each, and a reviewer reading ten near-identical pull
 * requests reads none of them properly. One session takes the batch as one
 * PRD, a story per issue in the order the operator ticked them, and delivers
 * the lot as a single branch.
 *
 * The session itself is nothing special: the repository's default base branch,
 * code review on so the existing review + PR-feedback pipeline runs, a
 * generated `prd.md` holding the approved plan and everything Sentry knows
 * about each error, "Mark ready", and then the very call the Start button
 * makes. From that point on the slot cap, the queue, the delivery and the pull
 * request are the ones every other session gets.
 *
 * ## Why the start is made here
 *
 * Because nothing else would ever make it. "Mark ready" only fires a schedule
 * the session slept through, and these sessions are created without one; the
 * scheduler's tick only fires sessions that have a `scheduled_start_at`; and
 * the build queue only drains sessions that have a `queued_at`, which nothing
 * but `BuildService.start` sets. A fix session that was merely marked ready
 * would sit at `ready` for good, with its issues stuck on `working` and the
 * completion pass waiting on a build that never began.
 *
 * ## Why there is no cap here
 *
 * There is one on either side. The API caps a batch at ten ids, and the build
 * queue decides how many sessions run at once. A second cap in the middle
 * would only leave sessions un-created while slots sat empty.
 *
 * ## Exactly one session per issue
 *
 * Every issue of the batch leaves `approved` for `working` in the same beat
 * the session is created, so a second call naming any of them finds an issue
 * that already has one — and the whole request is refused rather than half of
 * it built, because half a batch is not what was asked for.
 *
 * ## Failure
 *
 * All or nothing, and never destructive. A missing deploy key, a clone that
 * was refused, a PRD that would not write: the error is logged, every issue of
 * the batch keeps the status it came in with and one more attempt against it,
 * and the operator can press the button again. At {@link MAX_FIX_ATTEMPTS} an
 * issue becomes `cannot_fix` with the failure named, so the Sentry tab says
 * what went wrong rather than "nothing happened". A session that was created
 * before the failure is deleted, so the retry starts clean — and because
 * `session_id` is `ON DELETE SET NULL`, an issue is unlinked by the deletion
 * itself.
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

/**
 * The slice of the build loop (US-013) a ready fix session is handed to.
 *
 * Exactly what the Start button calls, so everything after it — the slot cap,
 * the FIFO queue, the usage-limit hold — treats a fix session on the same terms
 * as one an operator started by hand.
 */
export interface FixBuildService {
  start(sessionId: string): Promise<unknown>;
}

/** The session the batch became: what the API answers the operator with. */
export interface FixSessionCreated {
  readonly ok: true;
  readonly session: { readonly id: string; readonly name: string };
}

/**
 * Nothing was created, and the reason why in words an operator can act on.
 *
 * Whether the refusal counted against the issues' attempts is deliberately not
 * said here: it is on the rows, which the Sentry tab is showing anyway.
 */
export interface FixSessionRefused {
  readonly ok: false;
  readonly reason: string;
}

export type FixSessionResult = FixSessionCreated | FixSessionRefused;

/** What the operator's "Create fix session" API (US-006) calls. */
export interface SentryFixer {
  /**
   * One session for exactly the issues named, or nothing at all. An id nothing
   * is known about is skipped — the API is what refuses one — but everything
   * else is all-or-nothing: the batch is one session, one PRD and one pull
   * request, so half of it is never built.
   */
  createFixSession(issueIds: string[]): Promise<FixSessionResult>;
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

/** One issue of the batch, once Sentry has been asked what it knows about it. */
interface BatchEntry {
  readonly issue: SentryIssue;
  readonly details: SentryIssueDetails;
}

export class SentryFixService implements SentryFixer {
  constructor(
    private readonly config: Pick<Config, 'workspacesDir'>,
    private readonly db: Database,
    private readonly sessions: FixSessionService,
    private readonly builds: FixBuildService,
    private readonly clients: SentryDetailsFactory = createSentryClient,
  ) {}

  async createFixSession(issueIds: string[]): Promise<FixSessionResult> {
    // The caller's order is kept — it is the order the operator ticked the
    // rows in, and so the order the stories are fixed in — but an id named
    // twice is one issue, not two stories.
    const wanted = [...new Set(issueIds)];
    const asked = wanted
      .map((id) => getSentryIssue(this.db, id))
      .filter((issue): issue is SentryIssue => issue !== null);
    if (asked.length === 0) return refused('none of the issues named exist any more');

    // Belt and braces: the API refuses anything that is not `approved`, and an
    // issue with a session left `approved` long ago.
    const already = asked.filter((issue) => issue.sessionId !== null);
    if (already.length > 0) {
      return refused(
        `${shortIds(already).join(', ')} already has a fix session; nothing was created`,
      );
    }

    // One batch is one branch, so it is one repository. The API says so with a
    // 400; this is what keeps the invariant true for any other caller.
    const [first] = asked;
    if (first === undefined) return refused('none of the issues named exist any more');
    if (asked.some((issue) => issue.repositoryId !== first.repositoryId)) {
      return refused('a fix session covers one repository, and these issues span several');
    }

    const repository = getRepository(this.db, first.repositoryId);
    // A repository that is gone, or whose Sentry link was removed, is not a
    // failure of these issues: they wait, untouched, for the link to come back.
    if (repository === null) return refused('the repository these issues belong to is gone');
    const org = repository.sentryOrg;
    if (org === null || repository.sentryProject === null) {
      return refused('the repository is no longer linked to a Sentry project');
    }

    // Only now, so a call with nothing to do never looks the token up.
    const client = this.clients(this.db);
    if (client === null) {
      logger.debug('a Sentry fix session cannot be created: no Sentry token is configured', {
        asked: asked.length,
      });
      return refused('no Sentry token is configured');
    }

    return this.createFor(asked, repository, org, client);
  }

  /** The whole batch, in one session. All of it or none of it. */
  private async createFor(
    issues: readonly SentryIssue[],
    repository: Repository,
    org: string,
    client: SentryDetailsGateway,
  ): Promise<FixSessionResult> {
    const batch: BatchEntry[] = [];
    for (const issue of issues) {
      try {
        batch.push({ issue, details: await client.getIssueDetails(org, issue.sentryIssueId) });
      } catch (cause) {
        if (isTransient(cause)) {
          // Sentry is down or has had enough of us. Nothing about these issues
          // is in question, so they keep their attempts and the operator can
          // ask again in a minute.
          logger.warn('a Sentry issue could not be read for its fix session', {
            issue: issue.shortId,
            error: describe(cause),
          });
          return refused(`Sentry could not be read: ${describe(cause)}`);
        }
        return this.failed(
          issues,
          `${issue.shortId} could not be read from Sentry: ${describe(cause)}`,
        );
      }
    }

    const name = this.sessionName(repository.id, shortIds(issues));

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
      return this.failed(issues, describe(cause));
    }

    if (!setup.setup.ok) {
      // The row exists but its clone does not, so there is nothing to build in
      // and nothing to write a PRD into.
      await this.discard(setup.session.id);
      return this.failed(issues, `the repository could not be cloned: ${setup.setup.message}`);
    }

    const session = { id: setup.session.id, name: setup.session.name };
    try {
      writeSessionPrd(
        this.config,
        session,
        fixBatchPrd({
          sessionName: session.name,
          // The plan is the one on the row: the classifier's proposal, or the
          // operator's rewrite of it, whichever was approved.
          issues: batch.map((entry) => ({ details: entry.details, plan: entry.issue.plan })),
        }),
      );
    } catch (cause) {
      await this.discard(session.id);
      return this.failed(issues, `the generated PRD could not be written: ${describe(cause)}`);
    }

    let ready: ReadyResult;
    try {
      ready = await this.sessions.markReady(session.id);
    } catch (cause) {
      await this.discard(session.id);
      return this.failed(issues, `the session could not be marked ready: ${describe(cause)}`);
    }
    if (!ready.ok) {
      // chief-web generated this PRD, so a PRD that does not parse is a bug
      // here rather than something an operator can fix — say so with the line
      // numbers, and let the attempts run out.
      await this.discard(session.id);
      return this.failed(
        issues,
        `the generated PRD did not parse: ${ready.prd.errors.map((error) => error.message).join(' ')}`,
      );
    }

    // The one thing "Mark ready" does not do: put the session in the build
    // queue. This is the Start button's own call, so the cap, the queue and the
    // hold answer it exactly as they answer a hand-started session.
    try {
      await this.builds.start(session.id);
    } catch (cause) {
      if (!queuedForHold(cause)) {
        await this.discard(session.id);
        return this.failed(issues, `the fix session could not be started: ${describe(cause)}`);
      }
      // Claude's usage limit is on (US-005). The refusal came *after* the
      // session was put in the queue, and the pump hands it a slot the moment
      // the hold lifts, so there is nothing to undo and nothing to retry.
      logger.info('a Sentry fix session is waiting behind Claude’s usage limit', {
        issues: shortIds(issues),
        session: session.id,
      });
    }

    // Only here: from now on every issue of the batch is `working` and the
    // completion pass is the only thing that touches it again.
    for (const issue of issues) {
      updateSentryIssue(this.db, issue.id, {
        sessionId: session.id,
        status: 'working',
        attempts: 0,
      });
    }
    logger.info('a fix session was created for a batch of Sentry issues', {
      issues: shortIds(issues),
      repository: repository.id,
      session: session.id,
      name: session.name,
      stories: ready.stories.length,
    });
    return { ok: true, session };
  }

  /** `sentry-proj-123` or `sentry-batch-20260909`, plus a suffix if it is taken. */
  private sessionName(repositoryId: string, batch: readonly string[]): string {
    const taken = new Set(listSessions(this.db, { repositoryId }).map((session) => session.name));
    return fixBatchSessionName(batch, taken);
  }

  /**
   * Throws away a session created for a batch that then failed, so the retry
   * starts from nothing. Best effort: a deletion that fails leaves a pending
   * session an operator can see and remove, which is better than a batch that
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
   * One failed attempt, against every issue of the batch. They keep the status
   * they came in with, so the operator can press the button again, until the
   * attempts run out — at which point an issue is given up on with the failure
   * named. `attempts` is the counter the classification pass reset to zero when
   * it said the issue was fixable.
   */
  private failed(issues: readonly SentryIssue[], reason: string): FixSessionRefused {
    const given: string[] = [];
    for (const issue of issues) {
      const attempts = issue.attempts + 1;
      if (attempts >= MAX_FIX_ATTEMPTS) {
        updateSentryIssue(this.db, issue.id, {
          status: 'cannot_fix',
          explanation: fixSessionFailedExplanation(reason),
          attempts,
        });
        given.push(issue.shortId);
        continue;
      }
      updateSentryIssue(this.db, issue.id, { attempts });
    }
    logger.error('a fix session could not be created for a batch of Sentry issues', {
      issues: shortIds(issues),
      error: reason,
      ...(given.length === 0 ? {} : { givenUpOn: given }),
    });
    return refused(reason);
  }
}

/** Nothing was created; this is why. */
function refused(reason: string): FixSessionRefused {
  return { ok: false, reason };
}

function shortIds(issues: readonly SentryIssue[]): string[] {
  return issues.map((issue) => issue.shortId);
}

/**
 * Did the start refuse only because Claude's usage limit is being served?
 *
 * That is not a failure of the session: `BuildService.start` enqueues it
 * before it throws, so it is already exactly where a full server would have
 * left it, and the pump starts it from there.
 */
function queuedForHold(cause: unknown): boolean {
  return cause instanceof BuildError && cause.code === 'usage_limit_hold';
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
  builds: FixBuildService,
  clients: SentryDetailsFactory = createSentryClient,
): SentryFixService {
  return new SentryFixService(config, db, sessions, builds, clients);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
