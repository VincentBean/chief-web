import type { AgentRunner } from '../build/index.js';
import type { Config } from '../config.js';
import {
  type Database,
  getRepository,
  listSentryIssuesByStatus,
  type Repository,
  type SentryIssue,
  updateSentryIssue,
} from '../db/index.js';
import type { ExecSpec } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import type { PrRunContainers } from '../prfeedback/index.js';
import { RUNNER_WORKSPACE_DIR } from '../runner/index.js';
import { CONTAINER_REPO_DIR, type SessionExecutor } from '../sessions/index.js';
import { getSentryModel } from '../settings/index.js';

import { createSentryClient, SentryApiError, type SentryIssueDetails } from './client.js';
import { classificationPrompt, type Classification, parseClassification } from './prompts.js';

/**
 * Deciding which Sentry issues are worth a build session (US-006).
 *
 * Runs after every poll tick, over the `pending` rows the poller left behind.
 * One cheap `claude -p` per issue — haiku by default (US-002) — in a
 * throwaway container holding a checkout of the repository's base branch, so
 * the judgement is made against the actual code rather than against the error
 * message alone. The answer is one JSON object: fixable, and why.
 *
 * ## What bounds the cost
 *
 * Three things, because an error storm is the case this has to survive.
 * {@link MAX_ISSUES_PER_TICK} issues are classified per tick across every
 * repository, so a hundred new issues take fifty ticks rather than a hundred
 * agents; the surplus stays `pending` and is picked up later, oldest first.
 * One container is started per repository per tick and reused for all of that
 * repository's issues, so the clone is paid for once. And the container is
 * removed at the end of the tick — the workspace is keyed by the repository,
 * so the next tick reuses the clone without keeping anything running.
 *
 * ## What a failure costs
 *
 * An attempt. A container that would not start, an agent that fell over, an
 * answer that would not parse: the issue stays `pending`, its `attempts` goes
 * up, and the next tick tries again. At {@link MAX_CLASSIFY_ATTEMPTS} it
 * becomes `cannot_fix` with "classification failed", because an issue nobody
 * can classify is not an issue anybody can fix, and a row that retries forever
 * is a row that blocks the queue forever.
 *
 * A repository whose Sentry link was removed — or an install whose token was
 * removed — is not a failure. Its issues are skipped, untouched, and wait for
 * the link to come back.
 */

/** Per tick, across every repository. An error storm must not become a fleet. */
export const MAX_ISSUES_PER_TICK = 2;

/** Failed attempts at classifying one issue before it is given up on. */
export const MAX_CLASSIFY_ATTEMPTS = 3;

/** The explanation stored when the attempts run out; US-006 fixes the wording. */
export const CLASSIFICATION_FAILED = 'classification failed';

/**
 * How long one classification agent gets.
 *
 * Not the build loop's timeout: this is one read-only question to a small
 * model, and a run that has spent five minutes on it is stuck rather than
 * thorough. Deliberately not a setting — nothing an operator would tune.
 */
export const CLASSIFY_TIMEOUT_MS = 300_000;

/** The slice of {@link import('./client.js').SentryClient} a classification needs. */
export interface SentryDetailsGateway {
  getIssueDetails(org: string, issueId: string): Promise<SentryIssueDetails>;
}

/** Null means "Sentry is not set up"; see the sync's factory, same reasoning. */
export type SentryDetailsFactory = (db: Database) => SentryDetailsGateway | null;

/** What the poller calls once its own pass is done. */
export interface SentryClassifier {
  /** One pass over the pending issues. Returns how many were classified. */
  classifyPending(): Promise<number>;
}

/** Checks the base branch out, from scratch or over whatever a past tick left. */
const CHECKOUT_SCRIPT = `set -e
if [ -d "$CHIEF_REPO_DIR/.git" ]; then
    echo "chief-web: reusing the existing clone at $CHIEF_REPO_DIR" >&2
else
    rm -rf "$CHIEF_REPO_DIR"
    git clone --origin origin --branch "$CHIEF_BASE_BRANCH" "$CHIEF_REPO_URL" "$CHIEF_REPO_DIR"
fi
cd "$CHIEF_REPO_DIR"
git fetch --quiet origin "$CHIEF_BASE_BRANCH"
git checkout -B "$CHIEF_BASE_BRANCH" "origin/$CHIEF_BASE_BRANCH"
git reset --hard "origin/$CHIEF_BASE_BRANCH"
git clean -fd
git rev-parse HEAD`;

/**
 * `sh -c <script>` with the checkout environment.
 *
 * Everything variable is an environment variable referenced as `"$VAR"` and
 * never interpolated into the script, exactly as session setup and the pull
 * request checkout do it: a branch name and a clone URL are configuration, not
 * shell syntax.
 */
export function classifyCheckoutSpec(repoUrl: string, baseBranch: string): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', CHECKOUT_SCRIPT],
    env: [
      `CHIEF_REPO_URL=${repoUrl}`,
      `CHIEF_BASE_BRANCH=${baseBranch}`,
      `CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`,
    ],
    workingDir: RUNNER_WORKSPACE_DIR,
  };
}

/**
 * The container this repository's classifications run in.
 *
 * Keyed by the repository rather than by the tick, so the workspace — which
 * outlives the container by design — is one clone per repository instead of
 * one per tick, and the container name stays unique across repositories. The
 * `-sentry` suffix keeps it out of the way of anything keyed by a session id.
 */
export function classifyRunId(repositoryId: string): string {
  return `${repositoryId}-sentry`;
}

export class SentryClassifyService implements SentryClassifier {
  constructor(
    private readonly config: Pick<Config, 'sessionSetupTimeoutMs'>,
    private readonly db: Database,
    private readonly containers: PrRunContainers,
    private readonly exec: SessionExecutor,
    private readonly runner: AgentRunner,
    private readonly clients: SentryDetailsFactory = createSentryClient,
  ) {}

  async classifyPending(): Promise<number> {
    const pending = listSentryIssuesByStatus(this.db, 'pending');
    if (pending.length === 0) return 0;

    // Only now, so an install with nothing pending never looks the token up.
    const client = this.clients(this.db);
    if (client === null) {
      logger.debug('sentry issues cannot be classified: no Sentry token is configured', {
        pending: pending.length,
      });
      return 0;
    }

    // Oldest first — `listSentryIssuesByStatus` orders by `created_at` — and
    // capped, so the surplus of an error storm simply waits for a later tick.
    // Issues whose repository lost its link are dropped *before* the cap, so
    // an unlinked repository cannot starve everything behind it.
    const eligible: { issue: SentryIssue; repository: Repository }[] = [];
    for (const issue of pending) {
      if (eligible.length >= MAX_ISSUES_PER_TICK) break;
      const repository = getRepository(this.db, issue.repositoryId);
      if (repository === null) continue;
      if (repository.sentryOrg === null || repository.sentryProject === null) continue;
      eligible.push({ issue, repository });
    }
    if (eligible.length === 0) return 0;

    let classified = 0;
    for (const [repositoryId, batch] of groupByRepository(eligible)) {
      classified += await this.classifyRepository(repositoryId, batch, client);
    }
    return classified;
  }

  /** One repository's share of the tick, in one container. */
  private async classifyRepository(
    repositoryId: string,
    batch: { issue: SentryIssue; repository: Repository }[],
    client: SentryDetailsGateway,
  ): Promise<number> {
    const repository = batch[0]?.repository;
    if (repository === undefined) return 0;
    const runId = classifyRunId(repositoryId);

    let container: SessionContainerView;
    try {
      container = await this.containers.startPrRun({ id: runId, prNumber: 0, repositoryId });
    } catch (cause) {
      // Nothing was asked of Claude and nothing was written; every issue in
      // the batch simply spends an attempt and waits for the next tick.
      logger.error('the Sentry classification container could not be started', {
        repository: repositoryId,
        error: describe(cause),
      });
      for (const { issue } of batch) this.failed(issue, `container: ${describe(cause)}`);
      return 0;
    }

    try {
      const checkout = await this.exec.runExec(
        container.id,
        classifyCheckoutSpec(repository.sshUrl, repository.defaultBaseBranch),
        this.config.sessionSetupTimeoutMs,
      );
      if (checkout.timedOut || checkout.exitCode !== 0) {
        const detail = checkout.timedOut
          ? 'the checkout timed out'
          : `git exited ${String(checkout.exitCode)}: ${checkout.stderr.trim()}`;
        logger.error('the Sentry classification checkout failed', {
          repository: repositoryId,
          branch: repository.defaultBaseBranch,
          error: detail,
        });
        for (const { issue } of batch) this.failed(issue, `checkout: ${detail}`);
        return 0;
      }

      let classified = 0;
      for (const [index, { issue }] of batch.entries()) {
        // The pid file is keyed by run id and iteration, so each agent in this
        // container stays separately addressable; 1-based, as a build's are.
        const done = await this.classifyIssue(issue, repository, container.id, index + 1, client);
        if (done) classified += 1;
      }
      return classified;
    } finally {
      // The container goes; the workspace stays, so the next tick reuses the
      // clone instead of paying for it again.
      await this.containers.removePrRun(runId).catch((cause: unknown) => {
        logger.warn('the Sentry classification container could not be removed', {
          repository: repositoryId,
          error: describe(cause),
        });
      });
    }
  }

  /** One issue. Returns whether it left `pending` with a real verdict. */
  private async classifyIssue(
    issue: SentryIssue,
    repository: Repository,
    containerId: string,
    iteration: number,
    client: SentryDetailsGateway,
  ): Promise<boolean> {
    const org = repository.sentryOrg;
    if (org === null) return false;

    let details: SentryIssueDetails;
    try {
      details = await client.getIssueDetails(org, issue.sentryIssueId);
    } catch (cause) {
      if (isTransient(cause)) {
        // Sentry is down or has had enough of us: nothing about this issue is
        // in question, so it keeps its attempts and waits.
        logger.warn('a Sentry issue could not be read for classification', {
          issue: issue.shortId,
          error: describe(cause),
        });
        return false;
      }
      this.failed(issue, `sentry: ${describe(cause)}`);
      return false;
    }

    const model = getSentryModel(this.db);
    const result = await this.runner.run({
      sessionId: classifyRunId(repository.id),
      containerId,
      iteration,
      prompt: classificationPrompt({ details, baseBranch: repository.defaultBaseBranch }),
      timeoutMs: CLASSIFY_TIMEOUT_MS,
      model,
    });
    if (result.timedOut) {
      // Closing the exec stream is all a timeout can do from the outside; the
      // agent is still in the container the next issue is about to exec into.
      await this.runner.reap(classifyRunId(repository.id), containerId);
      this.failed(issue, 'the classification agent ran out of time');
      return false;
    }

    const verdict = parseClassification(result.output);
    if (verdict === null) {
      this.failed(
        issue,
        result.exitCode === 0
          ? 'the classification agent answered with something that is not the JSON verdict'
          : `the classification agent exited ${String(result.exitCode)} without a verdict`,
      );
      return false;
    }

    this.record(issue, verdict, model);
    return true;
  }

  /** Writes the verdict. `attempts` is reset: the next phase counts its own. */
  private record(issue: SentryIssue, verdict: Classification, model: string): void {
    updateSentryIssue(this.db, issue.id, {
      status: verdict.fixable ? 'queued' : 'cannot_fix',
      explanation: verdict.explanation,
      attempts: 0,
    });
    logger.info('a Sentry issue was classified', {
      issue: issue.shortId,
      repository: issue.repositoryId,
      fixable: verdict.fixable,
      model,
    });
  }

  /**
   * One failed attempt. The issue stays `pending` and comes back on the next
   * tick until the attempts run out, at which point it is given up on with the
   * wording US-006 fixes so the UI can be read without guessing.
   */
  private failed(issue: SentryIssue, reason: string): void {
    const attempts = issue.attempts + 1;
    if (attempts >= MAX_CLASSIFY_ATTEMPTS) {
      updateSentryIssue(this.db, issue.id, {
        status: 'cannot_fix',
        explanation: CLASSIFICATION_FAILED,
        attempts,
      });
      logger.warn('a Sentry issue was given up on after repeated classification failures', {
        issue: issue.shortId,
        attempts,
        error: reason,
      });
      return;
    }
    updateSentryIssue(this.db, issue.id, { attempts });
    logger.warn('a Sentry issue could not be classified', {
      issue: issue.shortId,
      attempts,
      error: reason,
    });
  }
}

/** The batches, in the order the issues came: oldest repository first. */
function groupByRepository(
  eligible: { issue: SentryIssue; repository: Repository }[],
): Map<string, { issue: SentryIssue; repository: Repository }[]> {
  const batches = new Map<string, { issue: SentryIssue; repository: Repository }[]>();
  for (const entry of eligible) {
    const batch = batches.get(entry.issue.repositoryId);
    if (batch === undefined) batches.set(entry.issue.repositoryId, [entry]);
    else batch.push(entry);
  }
  return batches;
}

/**
 * Is this a Sentry failure that says nothing about the issue?
 *
 * A rate limit or an unreachable API is about the network and the minute it
 * happened in; spending one of the issue's three attempts on it would mean an
 * hour of Sentry trouble marking real errors unclassifiable.
 */
function isTransient(cause: unknown): boolean {
  return (
    cause instanceof SentryApiError &&
    (cause.code === 'sentry_rate_limited' || cause.code === 'sentry_unreachable')
  );
}

export function createSentryClassifier(
  config: Pick<Config, 'sessionSetupTimeoutMs'>,
  db: Database,
  containers: PrRunContainers,
  exec: SessionExecutor,
  runner: AgentRunner,
  clients: SentryDetailsFactory = createSentryClient,
): SentryClassifyService {
  return new SentryClassifyService(config, db, containers, exec, runner, clients);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
