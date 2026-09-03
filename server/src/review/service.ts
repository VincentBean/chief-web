import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunner } from '../build/index.js';
import type { Config } from '../config.js';
import type { Database, Session } from '../db/index.js';
import { isUsageLimitRefusal } from '../limits/index.js';
import { logger } from '../lib/logger.js';
import { sessionWorkspaceDir } from '../orchestrator/index.js';
import type { SessionContainers } from '../sessions/index.js';
import { getAgentTimeoutMs, getReviewModel } from '../settings/index.js';
import { parseReviewFindings, type ReviewReport } from './findings.js';
import { CONTAINER_FINDINGS_PATH, reviewPrompt } from './prompts.js';

/**
 * One headless review pass over a session's pull request (US-007).
 *
 * A much smaller thing than the build loop: no stories, no iteration cap and no
 * retries of its own — one `claude -p` in the session's *existing* container,
 * then a document that either parses or does not. The retrying belongs to the
 * caller (US-009), which is also what turns a third failure into the `review`
 * failure stage; everything here does is say what happened.
 *
 * The runner is the build loop's {@link AgentRunner}, unchanged: the pid file,
 * the stream rendering, the reap after a timeout and the `--model` handling are
 * all the same plumbing an iteration uses, so a review is exactly as
 * interruptible and exactly as reapable as a build.
 */

/** Why a pass ended; `ok` is the only one that carries a report. */
export type ReviewCode =
  | 'ok'
  | 'container_unavailable'
  | 'agent_timed_out'
  | 'usage_limit'
  | 'agent_failed'
  | 'invalid_findings';

export interface ReviewPassResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly code: ReviewCode;
  /** What an operator is told; the session's `lastError` when this failed. */
  readonly message: string;
  /** The findings, or `null` whenever `ok` is false. */
  readonly report: ReviewReport | null;
  /** The tail of the agent's output, for the failure the operator reads. */
  readonly output: string;
}

/** What {@link ReviewService.reviewInContainer} is pointed at. */
export interface ReviewSubject {
  /** The workspace and pid-file key: a session id, or a review run's id. */
  readonly id: string;
  /** What the log lines call it. */
  readonly name: string;
  readonly containerId: string;
  /** The branch the pull request merges into; the left side of the diff. */
  readonly targetBranch: string;
  /** The pull request's branch, already checked out in the container. */
  readonly featureBranch: string;
}

/**
 * The pid-file slot this pass uses.
 *
 * Build iterations are numbered from 1, so 0 is a number no iteration of this
 * session can have taken — the review's agent stays addressable next to them
 * instead of overwriting the last iteration's record.
 */
export const REVIEW_ITERATION = 0;

export class ReviewService {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly runner: AgentRunner,
  ) {}

  /**
   * Runs the pass over a session's pull request. Never throws: every way this
   * can go wrong is an attempt the caller may want to make again, and an
   * exception is not something a retry count can be kept against.
   */
  async review(session: Session): Promise<ReviewPassResult> {
    // The container the session already has — started again only because a
    // finished session's container may have been stopped since the build.
    let containerId: string;
    try {
      containerId = (await this.containers.start(session)).id;
    } catch (cause) {
      return this.failed(session.id, session.name, 'container_unavailable', {
        message: `The review could not be started: ${describe(cause)}`,
        output: '',
      });
    }

    return this.reviewInContainer({
      id: session.id,
      name: session.name,
      containerId,
      targetBranch: session.prTargetBranch,
      featureBranch: session.featureBranch,
    });
  }

  /**
   * Runs the pass in a container the caller already has.
   *
   * This is the whole review minus the container: what a session's delivery
   * runs after starting the session container, and what a review started by
   * hand on an open pull request runs after checking that pull request's
   * branch out in a container of its own. `id` names the workspace on the
   * data volume the findings are read from, and the pid file the agent is
   * addressed by.
   */
  async reviewInContainer(subject: ReviewSubject): Promise<ReviewPassResult> {
    const { id, name, containerId } = subject;
    // Read now rather than cached, so a model or a timeout changed on the
    // settings page applies to the next review without a restart. A null model
    // is passed straight through: that absence is what selects the CLI's own.
    const timeoutMs = getAgentTimeoutMs(this.db, this.config);
    const model = getReviewModel(this.db);

    this.clearFindings(id);
    const result = await this.runner.run({
      sessionId: id,
      containerId,
      iteration: REVIEW_ITERATION,
      prompt: reviewPrompt({
        targetBranch: subject.targetBranch,
        featureBranch: subject.featureBranch,
        timeoutMs,
      }),
      timeoutMs,
      model,
    });

    if (result.timedOut) {
      // The timeout closed chief-web's end of the exec and nothing else. The
      // agent is still in the container, and a retry is about to exec a second
      // one into it, so this one is reaped before its findings file is read.
      await this.runner.reap(id, containerId);
      return this.failed(id, name, 'agent_timed_out', {
        message: 'The review agent ran out of time before it wrote its findings.',
        output: result.output,
      });
    }
    if (isUsageLimitRefusal(result)) {
      // Nothing wrong with the pull request, and nothing to salvage from this
      // pass: the account is out of usage and the next attempt runs into the
      // same wall. Reported as its own code so the caller can hold rather than
      // spend the two attempts it has left on it.
      await this.runner.reap(id, containerId);
      return this.failed(id, name, 'usage_limit', {
        message: 'The review agent stopped on a usage limit.',
        output: result.output,
      });
    }

    // The file the prompt asked for, falling back to what the agent printed:
    // a pass that answered in its reply instead of writing the file has still
    // done the review, and the parser is strict enough that the fallback can
    // only ever yield a document of exactly the right shape.
    const parsed = parseReviewFindings(this.readFindings(id) ?? result.output);
    if (parsed.report === null) {
      const code = result.exitCode === 0 ? 'invalid_findings' : 'agent_failed';
      return this.failed(id, name, code, {
        message:
          result.exitCode === 0
            ? `${parsed.error ?? 'The review agent produced nothing usable.'}`
            : `The review agent exited with code ${String(result.exitCode)} and left no usable ` +
              `findings: ${parsed.error ?? ''}`.trim(),
        output: result.output,
      });
    }

    logger.info('code review finished', {
      session: id,
      name,
      findings: parsed.report.findings.length,
      model,
    });

    return {
      ok: true,
      sessionId: id,
      code: 'ok',
      message:
        parsed.report.findings.length === 0
          ? 'The review found nothing to comment on.'
          : `The review found ${String(parsed.report.findings.length)} thing${parsed.report.findings.length === 1 ? '' : 's'} to comment on.`,
      report: parsed.report,
      output: result.output,
    };
  }

  /** Where the findings land on the host; the volume's side of the file. */
  private findingsPath(sessionId: string): string {
    return path.join(
      sessionWorkspaceDir(this.config, sessionId),
      path.basename(CONTAINER_FINDINGS_PATH),
    );
  }

  /**
   * Deletes any findings file left by an earlier attempt.
   *
   * Without this, a second attempt whose agent wrote nothing would read — and
   * post — the first one's document, which is the one way a *failed* review
   * could still reach GitHub.
   */
  private clearFindings(sessionId: string): void {
    try {
      fs.rmSync(this.findingsPath(sessionId), { force: true });
    } catch (cause) {
      logger.warn('could not clear the previous review findings', {
        session: sessionId,
        error: describe(cause),
      });
    }
  }

  /** The agent's findings, read off the data volume rather than through an exec. */
  private readFindings(sessionId: string): string | null {
    try {
      return fs.readFileSync(this.findingsPath(sessionId), 'utf8');
    } catch {
      return null;
    }
  }

  private failed(
    id: string,
    name: string,
    code: Exclude<ReviewCode, 'ok'>,
    detail: { message: string; output: string },
  ): ReviewPassResult {
    logger.warn('code review attempt failed', {
      session: id,
      name,
      code,
      error: detail.message,
    });
    return {
      ok: false,
      sessionId: id,
      code,
      message: detail.message,
      report: null,
      output: detail.output,
    };
  }
}

export function createReviewService(
  config: Config,
  db: Database,
  containers: SessionContainers,
  runner: AgentRunner,
): ReviewService {
  return new ReviewService(config, db, containers, runner);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
