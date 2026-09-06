import fs from 'node:fs';
import path from 'node:path';

import type { AgentRunner } from '../build/index.js';
import type { Config } from '../config.js';
import type { Database, Session, Story } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { isUsageLimitRefusal } from '../limits/index.js';
import { sessionWorkspaceDir } from '../orchestrator/index.js';
import type { SessionContainers, SessionExecutor } from '../sessions/index.js';
import { getAgentTimeoutMs } from '../settings/index.js';
import { readBranchDiff } from './diff.js';
import { cleanDescription } from './output.js';
import { CONTAINER_DESCRIPTION_PATH, descriptionPrompt } from './prompts.js';

/**
 * One headless pass that writes the functional description of a session's
 * branch (US-001).
 *
 * The smallest of the feature agents: read the branch diff out of the clone,
 * hand it to one `claude -p` fenced as untrusted data, read back the markdown
 * it wrote. No stories, no iteration, no retry — and no failure that matters,
 * because everything that consumes a description opens its pull request with
 * or without one. Every way this can go wrong is reported as a code and a
 * sentence; nothing here throws.
 *
 * The runner is the build loop's {@link AgentRunner}, unchanged: the pid file,
 * the stream rendering, the reap after a timeout and the `--model` handling are
 * all the plumbing an iteration uses, so this agent is exactly as interruptible
 * and exactly as reapable as a build.
 */

/** Why a pass ended; `ok` is the only one that carries a description. */
export type DescriptionCode =
  | 'ok'
  | 'container_unavailable'
  | 'diff_unavailable'
  | 'agent_timed_out'
  | 'usage_limit'
  | 'agent_failed'
  | 'empty_description';

export interface DescriptionResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly code: DescriptionCode;
  /** What an operator is told; what the delivery log quotes on a failure. */
  readonly message: string;
  /** The markdown, or `null` whenever `ok` is false. */
  readonly description: string | null;
  /** The tail of the agent's output, for the failure the operator reads. */
  readonly output: string;
}

/** What {@link DescriptionService.describeInContainer} is pointed at. */
export interface DescriptionSubject {
  /** The workspace and pid-file key: the session id. */
  readonly id: string;
  /** The name the operator gave the work; the pull request's title. */
  readonly name: string;
  readonly containerId: string;
  /** The branch the pull request merges into; the left side of the diff. */
  readonly targetBranch: string;
  /** The session's branch, checked out in the container. */
  readonly featureBranch: string;
  /** Titles of the finished stories, given to the agent as context. */
  readonly storyTitles: readonly string[];
}

/**
 * The pid-file slot this pass uses.
 *
 * Build iterations are numbered from 1 and the review pass took 0, so -1 is
 * the next number no other agent of this session can be addressed by; the
 * sweep in `build/agent.ts` globs on the session id and reaps it with the rest.
 */
export const DESCRIPTION_ITERATION = -1;

/**
 * The longest this pass may take, whatever the build timeout is set to.
 *
 * A build iteration is allowed an hour because it is writing code. This one
 * reads a diff it was handed and writes 150 words, and it runs inside a
 * delivery that a person is waiting on — so it gets the smaller of the two.
 */
export const MAX_DESCRIPTION_TIMEOUT_MS = 300_000;

export class DescriptionService {
  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly containers: SessionContainers,
    private readonly exec: SessionExecutor,
    private readonly runner: AgentRunner,
  ) {}

  /**
   * Describes a session's branch, starting its container if it is not running.
   * Never throws: see the class note.
   */
  async describe(session: Session, stories: readonly Story[]): Promise<DescriptionResult> {
    let containerId: string;
    try {
      containerId = (await this.containers.start(session)).id;
    } catch (cause) {
      return this.failed(session.id, session.name, 'container_unavailable', {
        message: `The description could not be started: ${describeError(cause)}`,
        output: '',
      });
    }

    return this.describeInContainer({
      id: session.id,
      name: session.name,
      containerId,
      targetBranch: session.prTargetBranch,
      featureBranch: session.featureBranch,
      storyTitles: doneStoryTitles(stories),
    });
  }

  /** The pass itself, in a container the caller already has. */
  async describeInContainer(subject: DescriptionSubject): Promise<DescriptionResult> {
    const { id, name, containerId } = subject;
    // Read now rather than cached, so a timeout changed on the settings page
    // applies to the next delivery without a restart.
    const timeoutMs = Math.min(
      getAgentTimeoutMs(this.db, this.config),
      MAX_DESCRIPTION_TIMEOUT_MS,
    );

    const diff = await this.readDiff(subject, timeoutMs);
    if (!diff.ok) {
      return this.failed(id, name, 'diff_unavailable', {
        message: `The description was skipped: ${diff.message}.`,
        output: '',
      });
    }

    this.clearDescription(id);
    const result = await this.runner.run({
      sessionId: id,
      containerId,
      iteration: DESCRIPTION_ITERATION,
      prompt: descriptionPrompt({
        sessionName: name,
        targetBranch: subject.targetBranch,
        featureBranch: subject.featureBranch,
        storyTitles: subject.storyTitles,
        diff: diff.diff,
        timeoutMs,
      }),
      timeoutMs,
      // No `--model`: the CLI's own default writes the description, the same
      // way an absent planning model is passed straight through.
      model: null,
    });

    if (result.timedOut) {
      // The timeout closed chief-web's end of the exec and nothing else, so
      // the agent is still in the container and has to be reaped before the
      // delivery moves on to the pull request.
      await this.runner.reap(id, containerId);
      return this.failed(id, name, 'agent_timed_out', {
        message: 'The description agent ran out of time before it wrote anything.',
        output: result.output,
      });
    }
    if (isUsageLimitRefusal(result)) {
      await this.runner.reap(id, containerId);
      return this.failed(id, name, 'usage_limit', {
        message: 'The description agent stopped on a usage limit.',
        output: result.output,
      });
    }

    // The file the prompt asked for, falling back to what the agent printed: a
    // pass that answered in its reply instead of writing the file has still
    // written the description. The fallback is only trusted for an agent that
    // exited cleanly — the output of a crashed one is a stack trace, and a
    // stack trace at the top of a pull request is worse than no description.
    const written = this.readDescription(id) ?? (result.exitCode === 0 ? result.output : null);
    const description = written === null ? null : cleanDescription(written);
    if (description === null) {
      const code = result.exitCode === 0 ? 'empty_description' : 'agent_failed';
      return this.failed(id, name, code, {
        message:
          result.exitCode === 0
            ? 'The description agent produced no text.'
            : `The description agent exited with code ${String(result.exitCode)} and wrote nothing.`,
        output: result.output,
      });
    }

    logger.info('pull request description written', {
      session: id,
      name,
      words: description.split(/\s+/).filter((word) => word !== '').length,
    });

    return {
      ok: true,
      sessionId: id,
      code: 'ok',
      message: 'The pull request description was written.',
      description,
      output: result.output,
    };
  }

  /** The branch diff, or the reason there is none; never throws. */
  private async readDiff(
    subject: DescriptionSubject,
    timeoutMs: number,
  ): Promise<{ ok: boolean; diff: string; message: string }> {
    try {
      return await readBranchDiff(this.exec, subject.containerId, {
        targetBranch: subject.targetBranch,
        featureBranch: subject.featureBranch,
        timeoutMs,
      });
    } catch (cause) {
      return { ok: false, diff: '', message: describeError(cause) };
    }
  }

  /** Where the description lands on the host; the volume's side of the file. */
  private descriptionPath(sessionId: string): string {
    return path.join(
      sessionWorkspaceDir(this.config, sessionId),
      path.basename(CONTAINER_DESCRIPTION_PATH),
    );
  }

  /**
   * Deletes any description left by an earlier delivery.
   *
   * Without this a retry whose agent wrote nothing would read — and publish —
   * the description of an older state of the branch.
   */
  private clearDescription(sessionId: string): void {
    try {
      fs.rmSync(this.descriptionPath(sessionId), { force: true });
    } catch (cause) {
      logger.warn('could not clear the previous pull request description', {
        session: sessionId,
        error: describeError(cause),
      });
    }
  }

  /** The agent's markdown, read off the data volume rather than through an exec. */
  private readDescription(sessionId: string): string | null {
    try {
      return fs.readFileSync(this.descriptionPath(sessionId), 'utf8');
    } catch {
      return null;
    }
  }

  private failed(
    id: string,
    name: string,
    code: Exclude<DescriptionCode, 'ok'>,
    detail: { message: string; output: string },
  ): DescriptionResult {
    logger.warn('no pull request description was written', {
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
      description: null,
      output: detail.output,
    };
  }
}

export function createDescriptionService(
  config: Config,
  db: Database,
  containers: SessionContainers,
  exec: SessionExecutor,
  runner: AgentRunner,
): DescriptionService {
  return new DescriptionService(config, db, containers, exec, runner);
}

/** The titles of the stories the build actually finished, in priority order. */
export function doneStoryTitles(stories: readonly Story[]): string[] {
  return [...stories]
    .filter((story) => story.status === 'done')
    .sort((left, right) => left.priority - right.priority || left.storyId.localeCompare(right.storyId))
    .map((story) => story.title);
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
