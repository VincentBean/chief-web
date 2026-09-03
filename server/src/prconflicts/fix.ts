import type { AgentRunner } from '../build/index.js';
import type { Config } from '../config.js';
import {
  createPrConflictFix,
  type Database,
  deletePrConflictFix,
  findPrConflictFix,
  getPrConflictFix,
  getRepository,
  type PrConflictFix,
  type PrConflictFixFailureStage,
  updatePrConflictFix,
} from '../db/index.js';
import { runPush } from '../delivery/index.js';
import { logger } from '../lib/logger.js';
import { isUsageLimitRefusal, UsageLimitHold } from '../limits/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import type { BuildSlots, PrRunContainers } from '../prfeedback/index.js';
import { runPrCheckout } from '../prfeedback/index.js';
import type { SessionExecutor } from '../sessions/index.js';
import { getAgentTimeoutMs, getBuildModel } from '../settings/index.js';
import { abortMerge, isNonFastForward, runBaseMerge, verifyResolution } from './merge.js';
import { conflictResolutionPrompt } from './prompts.js';
import type { ConflictedPullRequest, ConflictFixStarter } from './service.js';

/**
 * Resolving one conflicted pull request and pushing the result (US-005).
 *
 * The scan (US-003) decides *which* pull request; this is what is done about
 * it. The shape is the feedback run's — one row per pull request, a container
 * of its own through the same `prfeedback` machinery, a checkout pinned to the
 * head the scan saw, one agent — with the order of operations turned around:
 * a feedback run asks the agent to commit and then checks what it committed,
 * while a fix run never lets the agent near git at all. chief-web merges,
 * chief-web stages, chief-web commits, chief-web pushes; the agent edits files
 * and that is the whole of its authority.
 *
 * ## Three ways a run can end
 *
 * - **succeeded** — the merge commit is on `origin`, the pull request is
 *   mergeable again.
 * - **failed** — the resolution could not be trusted, or something broke. The
 *   merge is aborted, nothing is pushed, and the attempt is spent: the row
 *   stands as a failure until either SHA moves (US-006's retry budget is
 *   counted on the same `attempts` column).
 * - **abandoned** — the branch moved underneath the run, so everything this
 *   run knows is about a commit that is no longer the head. Nothing is marked
 *   failed and no attempt is spent; the row is dropped, and the next tick sees
 *   the pull request afresh at whatever it is now.
 */

/** Why a fix could not be started. The scan logs these and tries again later. */
export type ConflictFixRefusal =
  | 'repository_not_found'
  | 'fix_already_active'
  | 'no_free_slot'
  | 'usage_limit_hold';

export class ConflictFixError extends Error {
  constructor(
    readonly code: ConflictFixRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ConflictFixError';
  }
}

/** Where a live fix is; meaningless once it is over, so it is not persisted. */
export type ConflictFixPhase =
  | 'starting'
  | 'checking-out'
  | 'merging'
  | 'resolving'
  | 'verifying'
  | 'pushing';

interface RunState {
  phase: ConflictFixPhase;
  containerId: string | null;
  finished: Promise<unknown>;
}

/** How a run ended, for the log and for the tests. */
export type ConflictFixOutcome = 'succeeded' | 'failed' | 'abandoned';

export class PrConflictFixService implements ConflictFixStarter {
  private readonly live = new Map<string, RunState>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: PrRunContainers,
    private readonly exec: SessionExecutor,
    private readonly runner: AgentRunner,
    /**
     * The build loop's slot cap, shared with the feedback runs and the reviews
     * (US-018): a fix is one more agent in one more container, and the host
     * has as many of those as the operator said and no more.
     */
    private readonly slots: BuildSlots,
    /** The global usage-limit hold, honoured exactly as `prreview` does. */
    private readonly hold: UsageLimitHold = new UsageLimitHold(db),
  ) {}

  /**
   * Starts a fix run, after every refusal that can be made without spending
   * anything: the cheap checks come before a container exists.
   *
   * A refusal is thrown rather than swallowed, because the scan is the one that
   * decides what to do about it — and what it does is nothing, until the next
   * tick. That *is* the queue: a fix that cannot have a build slot now is
   * simply started on a later pass, so a busy host is never oversubscribed.
   */
  async start(pull: ConflictedPullRequest): Promise<void> {
    const repository = getRepository(this.db, pull.repositoryId);
    if (repository === null) {
      throw new ConflictFixError('repository_not_found', 'No such repository.');
    }

    const existing = findPrConflictFix(this.db, pull.repositoryId, pull.prNumber);
    if (existing !== null && this.live.has(existing.id)) {
      throw new ConflictFixError(
        'fix_already_active',
        `A conflict fix is already running on #${String(pull.prNumber)}.`,
      );
    }
    if (this.slots.freeSlots() <= 0) {
      throw new ConflictFixError(
        'no_free_slot',
        'Every build slot is in use, so the conflict fix waits for the next scan.',
      );
    }
    const held = this.hold.until();
    if (held !== null) {
      throw new ConflictFixError(
        'usage_limit_hold',
        `Claude’s usage limit was reached, so no agent can be started until ${held}. ` +
          `Nothing was done to #${String(pull.prNumber)}.`,
      );
    }

    const fix = createPrConflictFix(this.db, {
      repositoryId: pull.repositoryId,
      prNumber: pull.prNumber,
      prUrl: pull.prUrl,
      prTitle: pull.prTitle,
      headBranch: pull.headBranch,
      baseBranch: pull.baseBranch,
      headSha: pull.headSha,
      baseSha: pull.baseSha,
    });
    if (this.live.has(fix.id)) {
      throw new ConflictFixError(
        'fix_already_active',
        `A conflict fix is already running on #${String(pull.prNumber)}.`,
      );
    }

    const started =
      updatePrConflictFix(this.db, fix.id, {
        status: 'running',
        attempts: fix.attempts + 1,
        failureStage: null,
        lastError: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }) ?? fix;

    const state: RunState = { phase: 'starting', containerId: null, finished: Promise.resolve() };
    this.live.set(fix.id, state);
    state.finished = this.drive(started, repository.sshUrl, pull, state)
      .catch((cause: unknown) => {
        logger.error('conflict fix run crashed', { fix: fix.id, error: describe(cause) });
        this.fail(fix.id, 'agent', describe(cause));
      })
      .finally(() => {
        this.live.delete(fix.id);
        void this.containers.removePrRun(fix.id);
        // Whatever was waiting for a build slot can have this one back.
        void this.slots.pump();
      });
  }

  /** The fix this server is driving for a pull request, if any. */
  running(repositoryId: string, prNumber: number): boolean {
    const fix = findPrConflictFix(this.db, repositoryId, prNumber);
    return fix !== null && this.live.has(fix.id);
  }

  /** Where a live run is, for the UI; `null` once it is over. */
  phase(fixId: string): ConflictFixPhase | null {
    return this.live.get(fixId)?.phase ?? null;
  }

  /** Resolves when the run is no longer driving anything; used by tests. */
  async whenIdle(fixId: string): Promise<void> {
    await this.live.get(fixId)?.finished;
  }

  private async drive(
    fix: PrConflictFix,
    repoUrl: string,
    pull: ConflictedPullRequest,
    state: RunState,
  ): Promise<ConflictFixOutcome> {
    state.phase = 'starting';
    let container: SessionContainerView;
    try {
      container = await this.containers.startPrRun({
        id: fix.id,
        prNumber: fix.prNumber,
        repositoryId: fix.repositoryId,
      });
    } catch (cause) {
      this.fail(fix.id, 'container_lost', `The container could not be started: ${describe(cause)}`);
      return 'failed';
    }
    state.containerId = container.id;
    updatePrConflictFix(this.db, fix.id, { containerId: container.id });

    state.phase = 'checking-out';
    const checkout = await runPrCheckout(this.exec, container.id, {
      repoUrl,
      headBranch: fix.headBranch,
      expectedHeadSha: fix.headSha,
      timeoutMs: this.config.sessionSetupTimeoutMs,
    });
    if (checkout.code === 'head_moved') {
      // Someone pushed to the branch between the scan and this checkout. The
      // conflict this run was started for is about a commit that is no longer
      // the head, so there is nothing here to fail — the next tick reads the
      // new head and decides again.
      return this.abandon(fix, `The head branch moved to ${short(checkout.headSha)} before the fix started.`);
    }
    if (!checkout.ok) {
      this.fail(fix.id, 'checkout', `${checkout.message}\n${checkout.stderr}`.trim());
      return 'failed';
    }

    const merge = { baseBranch: fix.baseBranch, timeoutMs: this.config.sessionSetupTimeoutMs };

    state.phase = 'merging';
    const attempt = await runBaseMerge(this.exec, container.id, merge);
    if (attempt.code === 'failed') {
      await abortMerge(this.exec, container.id, merge);
      this.fail(fix.id, 'merge', `${attempt.message}\n${attempt.stderr}`.trim());
      return 'failed';
    }

    // A merge that came out clean needs no agent and no verification: git has
    // already made the commit. That happens when GitHub's verdict was stale or
    // somebody resolved the conflict in between — and the commit is still
    // worth pushing, because it is what makes the pull request mergeable.
    if (attempt.code === 'conflicted') {
      const resolved = await this.resolve(fix, container.id, pull, attempt.files, state);
      if (resolved !== null) return resolved;

      state.phase = 'verifying';
      const verified = await verifyResolution(this.exec, container.id, {
        ...merge,
        files: attempt.files,
      });
      if (!verified.ok) {
        // Nothing about this working tree may reach the pull request: put the
        // branch back and let the failure stand.
        await abortMerge(this.exec, container.id, merge);
        this.fail(fix.id, 'verify', `${verified.message}\n${verified.stderr}`.trim());
        return 'failed';
      }
    }

    state.phase = 'pushing';
    const push = await runPush(this.exec, container.id, {
      featureBranch: fix.headBranch,
      timeoutMs: this.config.pushTimeoutMs,
    });
    if (!push.ok) {
      if (isNonFastForward(push.stderr)) {
        // The branch grew a commit while this run was working. Force-pushing
        // over it is the one thing chief-web will not do, and the merge it
        // built is against a head that no longer exists — so the run is
        // abandoned rather than failed, and the next tick starts a fresh one
        // against the new head.
        return this.abandon(fix, `The push was rejected because "${fix.headBranch}" moved on.`);
      }
      await abortMerge(this.exec, container.id, merge);
      this.fail(fix.id, 'push', `${push.message}\n${push.stderr}`.trim());
      return 'failed';
    }

    const mergeSha = await this.runner.headSha(container.id);
    updatePrConflictFix(this.db, fix.id, {
      status: 'succeeded',
      mergeSha,
      failureStage: null,
      lastError: null,
      finishedAt: new Date().toISOString(),
    });
    logger.info('a pull request’s merge conflicts were resolved and pushed', {
      fix: fix.id,
      repository: fix.repositoryId,
      prNumber: fix.prNumber,
      headBranch: fix.headBranch,
      baseBranch: fix.baseBranch,
      mergeSha,
    });
    return 'succeeded';
  }

  /**
   * The agent's turn: the one part of a fix run chief-web does not do itself.
   *
   * Returns `null` when the agent is done and the resolution may be checked,
   * or the outcome when the run ended here instead.
   */
  private async resolve(
    fix: PrConflictFix,
    containerId: string,
    pull: ConflictedPullRequest,
    files: readonly string[],
    state: RunState,
  ): Promise<ConflictFixOutcome | null> {
    state.phase = 'resolving';
    const timeoutMs = getAgentTimeoutMs(this.db, this.config);
    const result = await this.runner.run({
      sessionId: fix.id,
      containerId,
      // A fix is one agent, not a loop; the number only has to name the pid
      // file the reap below aims at.
      iteration: 1,
      prompt: conflictResolutionPrompt({
        slug: pull.slug,
        number: fix.prNumber,
        title: fix.prTitle,
        // The description is what says why this pull request exists, which is
        // most of what deciding between two hunks needs.
        body: pull.prBody,
        headBranch: fix.headBranch,
        baseBranch: fix.baseBranch,
        files,
        timeoutMs,
      }),
      timeoutMs,
      model: getBuildModel(this.db),
    });

    if (isUsageLimitRefusal(result)) {
      // The account is out of usage, not the pull request out of sense: hold
      // the whole server the way a review does, leave the branch as it was,
      // and let the next scan after the hold lifts start again.
      const until = this.hold.arm();
      await this.runner.reap(fix.id, containerId);
      await abortMerge(this.exec, containerId, {
        baseBranch: fix.baseBranch,
        timeoutMs: this.config.sessionSetupTimeoutMs,
      });
      this.fail(
        fix.id,
        'agent',
        'Claude’s usage limit was reached, so the conflict was not resolved and agent work ' +
          `is held until ${until}. Nothing was pushed.`,
      );
      await this.slots.holdAll(until);
      return 'failed';
    }
    if (result.timedOut) {
      // The timeout closed chief-web's end of the exec and nothing else: the
      // agent is still in there with the half-merged tree under it, and the
      // checks below read that tree.
      await this.runner.reap(fix.id, containerId);
    }
    // A stalled or crashed agent is not judged on its exit code: the working
    // tree is the only evidence that counts, and verification reads it next.
    return null;
  }

  /**
   * Ends a run without blaming the pull request for it.
   *
   * The row is dropped rather than left `running`, for two reasons: a `running`
   * row is what the scan skips on, so a run abandoned mid-flight would hide the
   * pull request from every future tick; and abandonment only ever happens
   * because the head moved, which means the next run starts from different
   * SHAs and a wound-back row anyway.
   */
  private abandon(fix: PrConflictFix, why: string): ConflictFixOutcome {
    deletePrConflictFix(this.db, fix.id);
    logger.info('a conflict fix was abandoned because the pull request moved', {
      fix: fix.id,
      repository: fix.repositoryId,
      prNumber: fix.prNumber,
      reason: why,
    });
    return 'abandoned';
  }

  private fail(fixId: string, stage: PrConflictFixFailureStage, message: string): void {
    // A run abandoned earlier has no row left to fail; the crash handler and
    // the pipeline both come through here, so the check belongs here too.
    if (getPrConflictFix(this.db, fixId) === null) return;
    updatePrConflictFix(this.db, fixId, {
      status: 'failed',
      failureStage: stage,
      lastError: message.slice(0, 8000),
      finishedAt: new Date().toISOString(),
    });
    logger.warn('a pull request conflict fix failed', { fix: fixId, stage });
  }
}

/** The production wiring: the shared orchestrator, agent runner and slot cap. */
export function createPrConflictFixService(
  config: Config,
  db: Database,
  containers: PrRunContainers,
  exec: SessionExecutor,
  runner: AgentRunner,
  slots: BuildSlots,
  hold: UsageLimitHold = new UsageLimitHold(db),
): PrConflictFixService {
  return new PrConflictFixService(config, db, containers, exec, runner, slots, hold);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function short(sha: string | null): string {
  return sha === null ? 'another commit' : sha.slice(0, 7);
}
