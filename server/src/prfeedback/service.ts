import fs from 'node:fs';
import path from 'node:path';

import type { AgentRunner, QueuedStart } from '../build/index.js';
import type { Config } from '../config.js';
import {
  type BuildQueueEntry,
  type BuildQueueKind,
  buildQueuePosition,
  createPrRun,
  type Database,
  type FeedbackKind,
  findPrRun,
  getPrRun,
  getQueuedBuild,
  getRepository,
  listThreads,
  parsePrRefId,
  type PrFailureStage,
  type PrFeedbackThread,
  type PrRun,
  prRefId,
  type Repository,
  updatePrRun,
  updateThread,
  upsertThread,
} from '../db/index.js';
import { runPush } from '../delivery/index.js';
import { isValidGithubSlug } from '../lib/git-url.js';
import { GithubApiError } from '../lib/github.js';
import {
  fetchPullRequestFeedback,
  type PullRequestFeedback,
  replyToReviewThread,
  resolveReviewThread,
  type ReviewThread,
} from '../lib/github-review.js';
import { logger } from '../lib/logger.js';
import { isUsageLimitRefusal, UsageLimitHold } from '../limits/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import { sessionWorkspaceDir } from '../orchestrator/index.js';
import type { SessionExecutor } from '../sessions/index.js';
import { getAgentTimeoutMs, getBuildModel, getGithubToken } from '../settings/index.js';
import { runPrCheckout } from './checkout.js';
import { parseOutcome } from './outcome.js';
import { CONTAINER_OUTCOME_PATH, type FeedbackItem, prFeedbackPrompt } from './prompts.js';

/**
 * One pass over a pull request's review feedback (US-021).
 *
 * A much smaller thing than the build loop: no stories, no PRD, no iteration
 * cap and no retries — one agent invocation, then a verification that decides
 * whether anything may be said on GitHub.
 *
 * The order below is the design. The push happens before a single reply,
 * because a reply saying "fixed in abc1234" when `abc1234` is not on the remote
 * is a lie this codebase would rather not tell.
 */

/** Where a live run is; meaningless once it is over, so it is not persisted. */
export type PrRunPhase =
  | 'starting'
  | 'fetching-feedback'
  | 'checking-out'
  | 'running-agent'
  | 'pushing'
  | 'replying';

export class PrFeedbackError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PrFeedbackError';
  }
}

/**
 * The slice of the build loop a PR run drives: the concurrency cap it shares
 * (US-018), the unified queue it waits in when that cap is reached (US-003),
 * and the usage-limit hold it can trigger for it (US-007).
 *
 * Narrow on purpose: the services above the build loop depend on this
 * interface rather than on `BuildService`, so the dependency keeps pointing
 * one way now that they queue as well as count.
 */
export interface BuildSlots {
  freeSlots(): number;
  pump(): Promise<void>;
  /** Parks every building session on `until` after this run was refused. */
  holdAll(until: string): Promise<void>;
  /** Puts work at the back of the unified FIFO queue, or leaves it where it is. */
  enqueue(kind: BuildQueueKind, refId: string): BuildQueueEntry;
  /** Takes work back out of that queue; false when it was not in it. */
  leaveQueue(kind: BuildQueueKind, refId: string): boolean;
  /**
   * Counts a start that has not reached the database yet against the cap until
   * the returned function is called. Every start path claims here first, so two
   * of them cannot hand the same free slot to two agents.
   */
  claimStart(kind: BuildQueueKind, refId: string): () => void;
}

/** The slice of the orchestrator a run drives; the real one satisfies it. */
export interface PrRunContainers {
  startPrRun(run: {
    id: string;
    prNumber: number;
    repositoryId: string;
  }): Promise<SessionContainerView>;
  removePrRun(runId: string): Promise<void>;
}

/** The slice of the GitHub API a run drives; tests pass a stub. */
export interface PrFeedbackGateway {
  feedback(token: string, slug: string, number: number): Promise<PullRequestFeedback>;
  reply(
    token: string,
    slug: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number; url: string }>;
  resolve(token: string, threadId: string): Promise<{ isResolved: boolean }>;
}

export interface PrThreadView {
  readonly threadId: string;
  readonly key: string;
  readonly kind: FeedbackKind;
  readonly path: string | null;
  readonly line: number | null;
  readonly outcome: string | null;
  readonly summary: string | null;
  readonly replied: boolean;
  readonly replyUrl: string | null;
  readonly resolved: boolean;
  readonly error: string | null;
}

export interface PrRunView {
  readonly id: string;
  readonly repositoryId: string;
  readonly prNumber: number;
  readonly prUrl: string;
  readonly prTitle: string;
  readonly headBranch: string;
  readonly status: PrRun['status'];
  /** True while *this* server is driving it. */
  readonly running: boolean;
  readonly phase: PrRunPhase | null;
  readonly attempt: number;
  readonly failureStage: PrFailureStage | null;
  /** True while it is waiting in the build queue for a slot (US-004). */
  readonly queued: boolean;
  /** Its 1-based place in that queue, or `null` when it is not in it. */
  readonly queuePosition: number | null;
  readonly lastError: string | null;
  readonly headSha: string | null;
  readonly threads: readonly PrThreadView[];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

interface RunState {
  phase: PrRunPhase;
  containerId: string | null;
  finished: Promise<void>;
  stopping: boolean;
}

/** How far a thread's line may be from its comment before we call it unknown. */
const MAX_SUMMARY_CHARS = 400;

export class PrFeedbackService {
  private readonly live = new Map<string, RunState>();
  private readonly starting = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: PrRunContainers,
    private readonly exec: SessionExecutor,
    private readonly runner: AgentRunner,
    private readonly github: PrFeedbackGateway,
    private readonly slots: BuildSlots,
    private readonly token: () => string | null,
    /**
     * The global usage-limit hold (US-002), shared with the build loop through
     * the `settings` row behind it: a pass refused here holds the builds too,
     * and a build refused there keeps this run from starting into the wall.
     */
    private readonly hold: UsageLimitHold = new UsageLimitHold(db),
  ) {}

  status(runId: string): PrRunView {
    const run = getPrRun(this.db, runId);
    if (run === null) throw new PrFeedbackError(404, 'pr_run_not_found', 'No such run.');
    return this.view(run);
  }

  find(repositoryId: string, prNumber: number): PrRunView | null {
    const run = findPrRun(this.db, repositoryId, prNumber);
    return run === null ? null : this.view(run);
  }

  list(): PrRunView[] {
    return this.db
      .prepare('SELECT id FROM pr_runs')
      .all()
      .map((row) => this.status((row as { id: string }).id));
  }

  /**
   * Starts a pass, or takes a place in the unified build queue (US-004).
   *
   * Every refusal that can be made without spending anything is made first:
   * the cheap checks come before a container — or even a GitHub read — exists.
   * A full pool is no longer one of them. The pass is queued instead, and the
   * pump starts it the moment a slot frees, so nobody has to press the button
   * a second time. The automatic hand-offs — the delivery's review and the
   * pull request review's — come through this same door, so they queue on a
   * full server exactly as a hand-started pass does.
   */
  async start(repositoryId: string, prNumber: number): Promise<PrRunView> {
    const repository = getRepository(this.db, repositoryId);
    if (repository === null) {
      throw new PrFeedbackError(404, 'repository_not_found', 'No such repository.');
    }
    if (!isValidGithubSlug(repository.githubSlug)) {
      throw new PrFeedbackError(
        400,
        'invalid_github_slug',
        `"${repository.githubSlug}" is not a GitHub owner/repo slug.`,
      );
    }

    const token = this.token();
    if (token === null) {
      throw new PrFeedbackError(
        400,
        'github_token_missing',
        'No GitHub token is configured, so the comments cannot be read or answered.',
      );
    }

    const existing = findPrRun(this.db, repositoryId, prNumber);
    if (existing !== null && this.live.has(existing.id)) {
      throw new PrFeedbackError(409, 'run_already_active', 'That pull request is already running.');
    }
    // Already waiting for a slot: this request *is* the one in the queue, not
    // a second one. Answered before the GitHub read, so leaning on the button
    // — or a second review handing over the same findings — costs nothing.
    const refId = prRefId(repositoryId, prNumber);
    if (existing !== null && getQueuedBuild(this.db, 'pr-feedback', refId) !== null) {
      return this.view(existing);
    }
    // Starting a pass on a held account would spend a container, a checkout and
    // a GitHub read on an agent that is going to be refused the moment it runs
    // (US-007). The queue is no help against a hold — the pump would walk into
    // the same wall — so it is refused outright, and named the moment it is
    // worth asking again.
    const held = this.hold.until();
    if (held !== null) {
      throw new PrFeedbackError(409, 'usage_limit_hold', heldStartMessage(prNumber, held));
    }

    // Claimed before the feedback is read, so the slot this pass was offered is
    // still its own when the read comes back, and the pump cannot hand the same
    // one to the entry behind it in the meantime. `null` means there was
    // nothing to claim: this pass is going to queue.
    const slot = this.slots.freeSlots() > 0 ? this.slots.claimStart('pr-feedback', refId) : null;
    try {
      return await this.begin(repository, prNumber, token, slot !== null);
    } finally {
      // The row says `running` by now, which is what the cap counts; a pass
      // that queued or was refused never took the slot in the first place.
      if (slot !== null) slot();
    }
  }

  /**
   * The half of {@link start} that costs something: the feedback is read, and
   * the pass either starts or joins the queue.
   */
  private async begin(
    repository: Repository,
    prNumber: number,
    token: string,
    hasSlot: boolean,
  ): Promise<PrRunView> {
    const repositoryId = repository.id;
    const feedback = await this.readFeedback(token, repository.githubSlug, prNumber);
    if (feedback.state !== 'OPEN') {
      throw new PrFeedbackError(
        409,
        'pull_request_not_open',
        `Pull request #${String(prNumber)} is ${feedback.state.toLowerCase()}, so there is nothing to push to.`,
      );
    }
    if (feedback.fromFork) {
      // The deploy key grants write to this repository and nothing else, so a
      // fix could be committed and never delivered. "Allow edits by
      // maintainers" does not help: it is granted to user accounts and
      // exercised against the fork's remote, which a deploy key cannot
      // authenticate to.
      throw new PrFeedbackError(
        409,
        'pull_request_from_fork',
        `The head branch "${feedback.headRef}" of #${String(prNumber)} lives on another repository. ` +
          `chief-web pushes with ${repository.name}'s deploy key, which cannot write there.`,
      );
    }

    const items = this.itemsOf(feedback);
    if (items.length === 0) {
      throw new PrFeedbackError(
        409,
        'no_unresolved_feedback',
        'There is no unresolved review feedback on that pull request.',
      );
    }

    const run = createPrRun(this.db, {
      repositoryId,
      prNumber,
      prUrl: feedback.url,
      prTitle: feedback.title,
      headBranch: feedback.headRef,
      baseBranch: feedback.baseRef,
    });

    if (this.starting.has(run.id)) {
      throw new PrFeedbackError(409, 'run_already_active', 'That pull request is already running.');
    }
    if (!hasSlot) return this.queue(run);
    this.starting.add(run.id);

    const started = updatePrRun(this.db, run.id, {
      status: 'running',
      attempt: run.attempt + 1,
      failureStage: null,
      lastError: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });

    const state: RunState = {
      phase: 'starting',
      containerId: null,
      finished: Promise.resolve(),
      stopping: false,
    };
    this.live.set(run.id, state);
    state.finished = this.drive(started ?? run, repository.sshUrl, repository.githubSlug, token, feedback, items, state)
      .catch((cause: unknown) => {
        logger.error('pull request feedback run crashed', {
          run: run.id,
          error: String(cause),
        });
        this.fail(run.id, 'agent', String(cause));
      })
      .finally(() => {
        this.live.delete(run.id);
        this.starting.delete(run.id);
        void this.containers.removePrRun(run.id);
        // Whatever was waiting for a build slot can have this one back.
        void this.slots.pump();
      });

    return this.status(run.id);
  }

  /**
   * Signals the agent, or — for a pass that is still waiting for a slot —
   * takes it out of the queue before it ever starts (US-004). Anything already
   * committed and pushed is kept either way.
   */
  async stop(runId: string): Promise<PrRunView> {
    const state = this.live.get(runId);
    if (state === undefined) return this.cancelQueued(runId);
    state.stopping = true;
    if (state.containerId !== null) await this.runner.stop(runId, state.containerId);
    await settle(state.finished, this.config.buildStopTimeoutMs);
    return this.status(runId);
  }

  /** Resolves when the run is no longer driving anything; used by tests. */
  async whenIdle(runId: string): Promise<void> {
    await this.live.get(runId)?.finished;
  }

  /**
   * How the pump starts a queued pass (US-004).
   *
   * Handed to `BuildService.registerStart` in `app.ts` rather than imported
   * there, because the build loop sits below this service: it owns the queue,
   * this owns what a `pr-feedback` entry means.
   */
  starter(): QueuedStart {
    return {
      // A repository deleted while the pass waited takes its pull requests with
      // it; the entry is dropped rather than started.
      exists: (entry) => this.reference(entry) !== null,
      isRunning: (entry) => {
        const run = this.queuedRun(entry);
        return run !== null && this.live.has(run.id);
      },
      start: async (entry) => {
        const ref = this.reference(entry);
        if (ref === null) {
          throw new Error(`"${entry.refId}" no longer names a pull request that can be worked on.`);
        }
        // The same call that was made when it was queued, with the same
        // parameters: the feedback is read afresh, so the pass answers whatever
        // is still unresolved rather than what was unresolved an hour ago.
        await this.start(ref.repositoryId, ref.prNumber);
      },
      onFailed: (entry, message) => {
        const run = this.queuedRun(entry);
        // Somewhere the operator will see it: the run's own row on the pull
        // requests page. Saying nothing would be a pass that quietly never
        // happened.
        if (run !== null) {
          this.fail(
            run.id,
            'feedback',
            `The queued run could not be started, so it left the queue: ${message}`,
          );
        }
      },
    };
  }

  /** Puts the pass in the unified queue and answers with where it stands. */
  private queue(run: PrRun): PrRunView {
    const entry = this.slots.enqueue('pr-feedback', prRefId(run.repositoryId, run.prNumber));
    // Whatever the last pass left behind is history: this run is going to start
    // again, and `pending` is what the UI reads as "nothing to show yet". The
    // threads are deliberately kept — they are the record of what earlier
    // passes already answered, which is what makes a re-run resume.
    const waiting =
      updatePrRun(this.db, run.id, {
        status: 'pending',
        failureStage: null,
        lastError: null,
        startedAt: null,
        finishedAt: null,
      }) ?? run;
    logger.info('pull request feedback run queued: every build slot is in use', {
      run: run.id,
      repository: run.repositoryId,
      number: run.prNumber,
      queuedAt: entry.queuedAt,
    });
    return this.view(waiting);
  }

  /** Takes a run that has not started out of the queue; a no-op otherwise. */
  private cancelQueued(runId: string): PrRunView {
    const run = getPrRun(this.db, runId);
    if (run === null) throw new PrFeedbackError(404, 'pr_run_not_found', 'No such run.');
    if (!this.slots.leaveQueue('pr-feedback', prRefId(run.repositoryId, run.prNumber))) {
      return this.view(run);
    }

    logger.info('a queued pull request feedback run was cancelled', {
      run: run.id,
      repository: run.repositoryId,
      number: run.prNumber,
    });
    return this.view(
      updatePrRun(this.db, run.id, {
        status: 'pending',
        lastError: 'Cancelled before it started.',
      }) ?? run,
    );
  }

  /** The pull request an entry points at, or `null` when it is gone. */
  private reference(entry: BuildQueueEntry): { repositoryId: string; prNumber: number } | null {
    const ref = parsePrRefId(entry.refId);
    if (ref === null) return null;
    return getRepository(this.db, ref.repositoryId) === null ? null : ref;
  }

  /** The row an entry names, when a pass has already made one. */
  private queuedRun(entry: BuildQueueEntry): PrRun | null {
    const ref = this.reference(entry);
    return ref === null ? null : findPrRun(this.db, ref.repositoryId, ref.prNumber);
  }

  private async drive(
    run: PrRun,
    repoUrl: string,
    slug: string,
    token: string,
    feedback: PullRequestFeedback,
    items: FeedbackItem[],
    state: RunState,
  ): Promise<void> {
    // Record what this pass was given, so a re-run can see what an earlier one
    // already answered.
    const threads = this.recordItems(run.id, feedback, items);

    state.phase = 'starting';
    let container: SessionContainerView;
    try {
      container = await this.containers.startPrRun({
        id: run.id,
        prNumber: run.prNumber,
        repositoryId: run.repositoryId,
      });
    } catch (cause) {
      this.fail(run.id, 'container_lost', `The container could not be started: ${String(cause)}`);
      return;
    }
    state.containerId = container.id;
    updatePrRun(this.db, run.id, { containerId: container.id });

    state.phase = 'checking-out';
    const checkout = await runPrCheckout(this.exec, container.id, {
      repoUrl,
      headBranch: run.headBranch,
      expectedHeadSha: feedback.headSha,
      timeoutMs: this.config.sessionSetupTimeoutMs,
    });
    if (!checkout.ok) {
      this.fail(run.id, 'checkout', `${checkout.message}\n${checkout.stderr}`.trim());
      return;
    }
    if (state.stopping) return this.stopped(run.id);

    state.phase = 'running-agent';
    const headBefore = await this.runner.headSha(container.id);
    const agentTimeoutMs = getAgentTimeoutMs(this.db, this.config);
    const result = await this.runner.run({
      sessionId: run.id,
      containerId: container.id,
      // A feedback run is one agent, not a loop; the number only has to name
      // the pid file the reap below aims at.
      iteration: 1,
      prompt: prFeedbackPrompt({
        slug,
        timeoutMs: agentTimeoutMs,
        number: run.prNumber,
        title: run.prTitle,
        headBranch: run.headBranch,
        items,
      }),
      // Read now rather than cached, so a timeout changed on the settings page
      // applies to the next run without a restart. The agent is told the same
      // number, because it is the only one of the two that can spend it well.
      timeoutMs: agentTimeoutMs,
      model: getBuildModel(this.db),
    });
    if (state.stopping) return this.stopped(run.id);
    if (isUsageLimitRefusal(result)) {
      // The account is out of usage, not the pull request out of sense: this
      // pass did nothing wrong and there is nothing to salvage from it (US-007).
      // The hold goes up for the whole server, because the builds are running
      // into the same wall a few seconds behind — and then the run is failed,
      // because a feedback pass is single-shot and comes back through Retry
      // rather than resuming by itself.
      const until = this.hold.arm();
      // The agent is still in the container with the checkout under it and this
      // exec is being walked away from; the retry checks the same branch out.
      await this.runner.reap(run.id, container.id);
      this.fail(run.id, 'agent', heldRunMessage(until));
      await this.slots.holdAll(until);
      return;
    }
    if (result.timedOut) {
      // The timeout closed chief-web's end of the exec and nothing else: the
      // agent is still in the container with the checkout under it, and this
      // run may be about to be marked failed and made retryable. Left alone it
      // would still be there when the retry checks the branch out again — and
      // it would still be writing to the working tree the checks below read.
      await this.runner.reap(run.id, container.id);
    }

    const headAfter = await this.runner.headSha(container.id);
    const committed = headAfter !== null && headAfter !== headBefore;

    // (B) What the agent says it did, read off the volume rather than asked.
    const parsed = parseOutcome(this.readOutcome(run.id), items.map((item) => item.key));

    // The report is written last, after the commit, so a complete one is the
    // agent's own statement that it got to the end of the contract. A run that
    // left one behind and was then cut short lost nothing but the tail of its
    // own turn, and is judged below on exactly the same evidence as any other
    // — every cross-check still applies. One that did not is the failure the
    // timeout looks like: work in a tree nobody can describe.
    if (result.timedOut && !parsed.ok) {
      this.fail(run.id, 'agent', `The agent ran out of time.\n${result.output}`.trim());
      return;
    }

    if (!parsed.ok) {
      // A commit chief-web cannot describe, cannot attribute to a comment and
      // cannot reply about would sit on a human's pull request forever. An
      // unpushed one costs nothing — the next run's reset regenerates it.
      this.fail(run.id, 'outcome', parsed.error ?? 'The agent left no usable report.');
      return;
    }

    // (C) Cross-check the claim against the world.
    const claimedWork = parsed.items.some((item) => item.outcome === 'addressed');
    if (claimedWork && !committed) {
      for (const item of parsed.items) {
        const thread = threads.get(item.key);
        if (thread !== undefined) {
          updateThread(this.db, thread.id, {
            outcome: 'skipped',
            summary: null,
            error: 'The agent reported this as addressed but made no commit.',
          });
        }
      }
      this.fail(
        run.id,
        'agent',
        'The agent reported work it did not commit, so nothing was pushed and no comment was answered.',
      );
      return;
    }

    for (const item of parsed.items) {
      const thread = threads.get(item.key);
      if (thread === undefined) continue;
      updateThread(this.db, thread.id, { outcome: item.outcome, summary: item.note });
    }

    if (!committed) {
      // A legitimate outcome: every comment was considered and none warranted
      // a change. Nothing to push, but the reasons are still worth posting.
      updatePrRun(this.db, run.id, { status: 'finished', finishedAt: new Date().toISOString() });
      state.phase = 'replying';
      await this.answer(run.id, token, slug, null);
      return;
    }

    state.phase = 'pushing';
    const push = await runPush(this.exec, container.id, {
      featureBranch: run.headBranch,
      timeoutMs: this.config.pushTimeoutMs,
    });
    if (!push.ok) {
      this.fail(run.id, 'push', `${push.message}\n${push.stderr}`.trim());
      return;
    }

    // (D) The sha every reply quotes is read after the push, never taken from
    // anything the agent said.
    const delivered = (await this.runner.headSha(container.id)) ?? headAfter;
    updatePrRun(this.db, run.id, {
      status: 'finished',
      headSha: delivered,
      finishedAt: new Date().toISOString(),
    });

    state.phase = 'replying';
    await this.answer(run.id, token, slug, delivered);
  }

  /**
   * Says on GitHub what happened, once the fix is on the remote.
   *
   * Every write is guarded by three more checks against the world: the thread
   * still accepts a reply, it is not already resolved, and — before resolving —
   * GitHub still says this token may. A thread that was skipped is answered but
   * never resolved: leaving it open is what keeps a person in control of it.
   */
  private async answer(
    runId: string,
    token: string,
    slug: string,
    headSha: string | null,
  ): Promise<void> {
    const run = getPrRun(this.db, runId);
    if (run === null) return;

    let firstFailure: { stage: PrFailureStage; message: string } | null = null;

    for (const thread of listThreads(this.db, runId)) {
      if (thread.outcome === null) continue;
      // A review summary has no thread and no comment id, so GitHub gives
      // nothing to reply to. It is input to the agent only.
      if (thread.kind === 'review' || thread.firstCommentId === null) continue;
      // The same sentence about the same commit, twice, is noise.
      if (thread.repliedAt !== null && thread.repliedHeadSha === headSha) continue;

      const body = this.replyBody(thread, headSha, run);
      try {
        const posted = await this.github.reply(
          token,
          slug,
          run.prNumber,
          thread.firstCommentId,
          body,
        );
        updateThread(this.db, thread.id, {
          repliedAt: new Date().toISOString(),
          replyUrl: posted.url,
          repliedHeadSha: headSha,
          error: null,
        });
      } catch (cause) {
        const message = cause instanceof GithubApiError ? cause.message : String(cause);
        updateThread(this.db, thread.id, { error: `The reply was refused: ${message}` });
        // A permission fact is permanent and retrying changes nothing; anything
        // else could succeed later and is worth surfacing as a failure.
        if (!(cause instanceof GithubApiError) || cause.code !== 'github_forbidden') {
          firstFailure ??= { stage: 'reply', message };
        }
        continue;
      }

      if (thread.outcome !== 'addressed') continue;
      try {
        const resolved = await this.github.resolve(token, thread.threadId);
        if (resolved.isResolved) {
          updateThread(this.db, thread.id, { resolvedAt: new Date().toISOString() });
        }
      } catch (cause) {
        const message = cause instanceof GithubApiError ? cause.message : String(cause);
        const refused = cause instanceof GithubApiError && cause.code === 'github_forbidden';
        updateThread(this.db, thread.id, {
          error: refused
            ? // Expected on a fine-grained token: GitHub does not offer
              // `resolveReviewThread` to them at all — it answers FORBIDDEN and,
              // unlike a genuine permission gap, names no permission to add. The
              // answer is posted either way, so this is a note, not a failure.
              'Answered. This GitHub token cannot resolve threads, so it is left open for you to close.'
            : `The reply was posted, but the thread could not be resolved: ${message}`,
        });
        if (!refused) firstFailure ??= { stage: 'reply', message };
      }
    }

    if (firstFailure !== null) {
      // The fix is already on the remote; only the answering is outstanding, so
      // the retry plan can re-run just this step.
      this.fail(runId, firstFailure.stage, firstFailure.message);
    }
  }

  private replyBody(thread: PrFeedbackThread, headSha: string | null, run: PrRun): string {
    const lines: string[] = [];
    if (thread.outcome === 'addressed' && headSha !== null) {
      lines.push(`chief-web addressed this in \`${headSha.slice(0, 7)}\`, pushed to \`${run.headBranch}\`.`);
    } else if (thread.outcome === 'skipped') {
      lines.push('chief-web looked at this and changed nothing, so the thread is left open.');
    } else {
      lines.push('chief-web did not report on this thread, so it is left open.');
    }
    if (thread.summary !== null) lines.push('', thread.summary.slice(0, MAX_SUMMARY_CHARS));

    const link =
      this.config.publicUrl === ''
        ? 'chief-web'
        : `[chief-web](${this.config.publicUrl}/pull-requests)`;
    lines.push('', '---', '', `🤖 ${link} · pass ${String(run.attempt)}`);
    return lines.join('\n');
  }

  private async readFeedback(
    token: string,
    slug: string,
    prNumber: number,
  ): Promise<PullRequestFeedback> {
    try {
      return await this.github.feedback(token, slug, prNumber);
    } catch (cause) {
      if (cause instanceof GithubApiError) throw cause;
      throw new PrFeedbackError(502, 'feedback_unreadable', String(cause));
    }
  }

  /** Unresolved threads first, then review bodies, keyed T1… and R1…. */
  private itemsOf(feedback: PullRequestFeedback): FeedbackItem[] {
    const items: FeedbackItem[] = [];
    let threadIndex = 0;
    for (const thread of feedback.threads) {
      if (thread.isResolved) continue;
      const comment = thread.comments[0];
      if (comment === undefined) continue;
      threadIndex += 1;
      items.push({
        key: `T${String(threadIndex)}`,
        kind: 'thread',
        path: thread.path,
        line: thread.line,
        author: comment.authorLogin,
        body: comment.body,
        url: comment.url,
        outdated: thread.isOutdated,
      });
    }
    feedback.reviews.forEach((review, index) => {
      items.push({
        key: `R${String(index + 1)}`,
        kind: 'review',
        path: null,
        line: null,
        author: review.authorLogin,
        body: review.body,
        url: review.url,
        outdated: false,
      });
    });
    return items;
  }

  private recordItems(
    runId: string,
    feedback: PullRequestFeedback,
    items: readonly FeedbackItem[],
  ): Map<string, PrFeedbackThread> {
    const threadsByUrl = new Map<string, ReviewThread>();
    for (const thread of feedback.threads) {
      const comment = thread.comments[0];
      if (comment !== undefined) threadsByUrl.set(comment.url, thread);
    }

    const recorded = new Map<string, PrFeedbackThread>();
    for (const item of items) {
      const source = threadsByUrl.get(item.url);
      const review = feedback.reviews.find((entry) => entry.url === item.url);
      const threadId = source?.id ?? review?.id ?? item.url;
      recorded.set(
        item.key,
        upsertThread(this.db, {
          runId,
          threadId,
          kind: item.kind,
          firstCommentId: source?.comments[0]?.databaseId ?? null,
          feedbackKey: item.key,
        }),
      );
    }
    return recorded;
  }

  /** The agent's report, read off the data volume rather than through an exec. */
  private readOutcome(runId: string): string | null {
    const file = path.join(
      sessionWorkspaceDir(this.config, runId),
      path.basename(CONTAINER_OUTCOME_PATH),
    );
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  }

  private stopped(runId: string): void {
    updatePrRun(this.db, runId, {
      status: 'pending',
      lastError: 'Stopped.',
      finishedAt: new Date().toISOString(),
    });
  }

  private fail(runId: string, stage: PrFailureStage, message: string): void {
    updatePrRun(this.db, runId, {
      status: 'failed',
      failureStage: stage,
      lastError: message.slice(0, 8000),
      finishedAt: new Date().toISOString(),
    });
    logger.warn('pull request feedback run failed', { run: runId, stage });
  }

  private view(run: PrRun): PrRunView {
    const state = this.live.get(run.id);
    const queuePosition = buildQueuePosition(
      this.db,
      'pr-feedback',
      prRefId(run.repositoryId, run.prNumber),
    );
    return {
      id: run.id,
      repositoryId: run.repositoryId,
      prNumber: run.prNumber,
      prUrl: run.prUrl,
      prTitle: run.prTitle,
      headBranch: run.headBranch,
      status: run.status,
      running: state !== undefined,
      phase: state?.phase ?? null,
      attempt: run.attempt,
      failureStage: run.failureStage,
      queued: queuePosition !== null,
      queuePosition,
      lastError: run.lastError,
      headSha: run.headSha,
      threads: listThreads(this.db, run.id).map((thread) => ({
        threadId: thread.threadId,
        key: thread.feedbackKey,
        kind: thread.kind,
        path: null,
        line: null,
        outcome: thread.outcome,
        summary: thread.summary,
        replied: thread.repliedAt !== null,
        replyUrl: thread.replyUrl,
        resolved: thread.resolvedAt !== null,
        error: thread.error,
      })),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    };
  }
}

/**
 * What a pass is told when it is asked for during a hold (US-007).
 *
 * Unlike a build there is no queue to be put in, so the sentence has to carry
 * the whole answer: why nothing started, and when asking again will work.
 */
function heldStartMessage(prNumber: number, until: string): string {
  return (
    'Claude’s usage limit was reached, so no agent can be started until ' +
    `${until}. Nothing was done to #${String(prNumber)}; start the pass again ` +
    'after that time.'
  );
}

/**
 * What a pass that was refused mid-run leaves behind (US-007).
 *
 * It names the limit and the resume time for the same reason the build loop's
 * does, and says the pass is retryable, because a PR run is single-shot: it is
 * the operator, not the scheduler, that brings it back.
 */
function heldRunMessage(until: string): string {
  return (
    'Claude’s usage limit was reached, so this pass was stopped before it ' +
    `could finish and agent work is held until ${until}. Nothing was pushed ` +
    'and no comment was answered — retry the run once the hold lifts.'
  );
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


/**
 * The production wiring: the real GitHub client, the shared orchestrator, and
 * the build loop as the owner of the slot cap.
 */
export function createPrFeedbackService(
  config: Config,
  db: Database,
  containers: PrRunContainers,
  exec: SessionExecutor,
  runner: AgentRunner,
  slots: BuildSlots,
  github: PrFeedbackGateway = new GithubPrFeedback(config),
  hold: UsageLimitHold = new UsageLimitHold(db),
): PrFeedbackService {
  return new PrFeedbackService(
    config,
    db,
    containers,
    exec,
    runner,
    github,
    slots,
    () => getGithubToken(db),
    hold,
  );
}

class GithubPrFeedback implements PrFeedbackGateway {
  constructor(private readonly config: Pick<Config, 'githubApiUrl' | 'githubGraphqlUrl'>) {}

  feedback(token: string, slug: string, number: number): Promise<PullRequestFeedback> {
    return fetchPullRequestFeedback(token, this.config.githubGraphqlUrl, slug, number);
  }

  reply(
    token: string,
    slug: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number; url: string }> {
    return replyToReviewThread(token, this.config.githubApiUrl, slug, number, commentId, body);
  }

  resolve(token: string, threadId: string): Promise<{ isResolved: boolean }> {
    return resolveReviewThread(token, this.config.githubGraphqlUrl, threadId);
  }
}
