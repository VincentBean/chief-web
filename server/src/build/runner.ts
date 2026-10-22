import type { ExecDeadline, ExecOutput, ExecSpec, StreamExecOptions } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import { abortMerge, type VerifyResult, verifyResolution } from '../prconflicts/merge.js';
import type { SessionExecutor } from '../sessions/index.js';
import {
  addStoryWorktreeSpec,
  AGENT_SIGNALLED,
  agentExecSpec,
  agentSignalSpec,
  headShaSpec,
  mergeStorySpec,
  RECOVERY_MERGE_ABORTED,
  recoverStoryWorkspacesSpec,
  removeStoryWorktreeSpec,
  restoreWorkspaceSpec,
  storyBranch,
  type StoryTarget,
  workspaceStatusSpec,
} from './agent.js';
import { type AgentToolCall, AgentOutputFormatter } from './stream.js';

/**
 * Running one headless agent iteration inside a session container (US-013).
 *
 * Declared as an interface next to the loop that uses it — the same shape as
 * `SessionDocker` (US-009) — so the retry, cap and story-selection tests drive
 * the whole service with a mock and never touch a daemon. The production
 * implementation is a thin wrapper around `DockerApi.streamExec`: the agent is
 * asked for `stream-json` so its output can be shown while it is still working
 * (US-016), and every chunk is rendered and forwarded as it arrives.
 */

/** How much of an iteration's output is kept for the session's error message. */
const MAX_OUTPUT_CHARS = 8000;

export interface AgentInvocation {
  readonly sessionId: string;
  readonly containerId: string;
  /** Which iteration of the run this is; it names the agent's pid file. */
  readonly iteration: number;
  readonly prompt: string;
  /** Cap on the whole iteration; a stuck agent must not hold the loop forever. */
  readonly timeoutMs: number;
  /** `--model` for this iteration; `null`/absent leaves the choice to the CLI. */
  readonly model?: string | null;
  /**
   * `--advisor` for this iteration: the stronger model the CLI consults while
   * the iteration works. `null`/absent passes no flag at all, which is how the
   * iteration is launched when no advisor is configured.
   */
  readonly advisor?: string | null;
  /**
   * `--effort` for this iteration: the session's thinking effort, or the global
   * default. `null`/absent passes no flag, leaving the choice to the CLI.
   */
  readonly effort?: string | null;
  /**
   * `--mcp-config` for this iteration: the `chief` server that offers
   * `ask_operator` (decisions US-003). `null`/absent passes no flag, which is
   * how an iteration is launched where no question can be asked.
   */
  readonly mcpConfigFile?: string | null;
  /**
   * The iteration's budget as a clock that can be stopped (decisions US-004).
   * Given one, it is used *instead of* {@link timeoutMs}: the two are the same
   * number, and the deadline is the one that can be paused while the agent
   * waits for an answer. Ignored by an executor that cannot stream.
   */
  readonly deadline?: ExecDeadline | null;
  /**
   * Called with the agent's output as it is produced, already rendered from
   * `stream-json` into the lines a person reads (US-016).
   */
  readonly onOutput?: (text: string) => void;
  /**
   * Called for each tool call on the stream as it arrives (decisions US-004):
   * how the loop notices `ask_operator`. It must not throw, and it must not
   * block the stream — anything slow belongs in a promise of its own.
   */
  readonly onToolCall?: (call: AgentToolCall) => void;
  /**
   * The story worktree to run in (async stories US-006). Given one, the agent
   * runs there and records its pid under the story and attempt instead of the
   * iteration; `null`/absent runs it in the clone, as always.
   */
  readonly story?: StoryTarget | null;
}

export interface AgentResult {
  /** `null` when the iteration was cut short by its timeout. */
  readonly exitCode: number | null;
  /** Everything the agent printed, stderr first, truncated. */
  readonly output: string;
  readonly timedOut: boolean;
}

/**
 * The slice of `DockerApi` an iteration needs.
 *
 * `streamExec` is optional so an executor injected by a test — or any collector
 * that only knows how to run a command to completion — still drives a build;
 * the log then arrives in one piece when the iteration ends instead of live.
 */
export interface AgentExecutor extends SessionExecutor {
  streamExec?(container: string, spec: ExecSpec, options: StreamExecOptions): Promise<ExecOutput>;
}

export interface AgentRunner {
  /** Runs one iteration to completion. Rejects only if the daemon does. */
  run(invocation: AgentInvocation): Promise<AgentResult>;
  /**
   * Signals the running agent so it can shut down; never throws. With a
   * `storyId`, only that story's agent (async stories US-006).
   */
  stop(sessionId: string, containerId: string, storyId?: string | null): Promise<void>;
  /**
   * Leaves no agent of this session running, whatever it takes: signalled,
   * given a moment, then killed. Never throws.
   */
  reap(sessionId: string, containerId: string, storyId?: string | null): Promise<void>;
  /**
   * HEAD of the clone — or of the worktree at `workingDir` — or `null` when
   * there is no commit to read.
   */
  headSha(containerId: string, workingDir?: string): Promise<string | null>;
  /**
   * `git status --porcelain` of the clone, `.chief/` aside, or `null` when it
   * could not be read (async stories US-005). Optional: a runner without it
   * cannot check the read-only dependency analysis, so the check is skipped.
   */
  workspaceStatus?(containerId: string): Promise<string | null>;
  /** `git checkout -- . && git clean -fd`, `.chief/` aside. Never throws. */
  restoreWorkspace?(containerId: string): Promise<void>;
  /**
   * Creates `/workspace/worktrees/<story-id>` on `chief-story/<session>/<story-id>`
   * off the session branch's HEAD, after removing any leftover of either, and
   * copies the PRD in (async stories US-006). Rejects when it could not.
   * Optional: a runner without it runs every story in the clone.
   */
  addStoryWorktree?(containerId: string, sessionName: string, storyId: string): Promise<void>;
  /** Removes a merged or abandoned story's worktree and branch. Never throws. */
  removeStoryWorktree?(containerId: string, sessionName: string, storyId: string): Promise<void>;
  /**
   * `git merge --no-ff` of a finished story's branch into the session branch
   * in `/workspace/repo` (async stories US-007). Never throws: a merge that
   * did not happen is an outcome. A conflicted merge is left in place.
   * Optional: without it, a finished story's worktree is left unmerged.
   */
  mergeStory?(containerId: string, sessionName: string, storyId: string, message: string): Promise<StoryMergeOutcome>;
  /** `git merge --abort` in `/workspace/repo`. Never throws. */
  abortStoryMerge?(containerId: string, sessionName: string, storyId: string): Promise<void>;
  /**
   * The clean-up in front of every run (async stories US-011): aborts a merge
   * left half-done in `/workspace/repo`, removes every story worktree and
   * every `chief-story/<session>/*` branch, and says what it removed. Never
   * throws. Optional: a runner without worktrees has nothing to clear.
   */
  recoverStoryWorkspaces?(containerId: string, sessionName: string): Promise<StoryWorkspaceRecovery>;
  /**
   * After a conflict-resolution agent (async stories US-008): stages `files`
   * in `/workspace/repo`, checks nothing is unmerged and no conflict marker is
   * left, and makes the merge commit — `verifyResolution` from
   * `prconflicts/`. Never throws. Optional: without it, a conflicted merge is
   * aborted straight away.
   */
  verifyStoryMerge?(
    containerId: string,
    sessionName: string,
    storyId: string,
    files: readonly string[],
  ): Promise<VerifyResult>;
}

/** What {@link AgentRunner.recoverStoryWorkspaces} cleared (async stories US-011). */
export interface StoryWorkspaceRecovery {
  /** A merge was in progress in the clone, and is aborted now. */
  readonly abortedMerge: boolean;
  /** The story ids whose worktree was removed. */
  readonly worktrees: readonly string[];
  /** The `chief-story/<session>/*` branches deleted. */
  readonly branches: readonly string[];
  /** Why part of it could not be done; `null` when all of it was. */
  readonly error: string | null;
}

/** How a story's merge into the session branch went (async stories US-007). */
export type StoryMergeOutcome =
  | { readonly code: 'merged'; readonly mergeSha: string }
  | /** Git stopped on conflicts in `files`; the merge is still in progress. */ {
      readonly code: 'conflicted';
      readonly files: readonly string[];
      readonly message: string;
    }
  | /** Anything else; nothing was merged. */ { readonly code: 'failed'; readonly message: string };

/** The {@link AgentRunner} that actually execs into the session container. */
export class ContainerAgentRunner implements AgentRunner {
  constructor(
    private readonly exec: AgentExecutor,
    /** How long a reaped agent is given to go quietly before it is killed. */
    private readonly reapGraceMs: number = AGENT_REAP_GRACE_MS,
  ) {}

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    const spec = agentExecSpec(
      invocation.sessionId,
      invocation.iteration,
      invocation.prompt,
      invocation.model,
      invocation.advisor,
      invocation.effort,
      invocation.mcpConfigFile,
      invocation.story,
    );
    const stream = this.exec.streamExec?.bind(this.exec);
    if (stream === undefined) {
      const collected = await this.exec.runExec(invocation.containerId, spec, invocation.timeoutMs);
      const output = renderWhole(collected);
      invocation.onOutput?.(output);
      return { exitCode: collected.exitCode, output: truncate(output), timedOut: collected.timedOut };
    }

    // Rendered here rather than in the log store, so what the session's error
    // message quotes on a stalled iteration is exactly what the log showed.
    const formatter = new AgentOutputFormatter(
      invocation.onToolCall === undefined ? {} : { onToolCall: invocation.onToolCall },
    );
    let output = '';
    const emit = (text: string): void => {
      if (text === '') return;
      output = tail(output + text);
      invocation.onOutput?.(text);
    };

    const result = await stream(invocation.containerId, spec, {
      // The pausable clock when there is one; the plain cap otherwise. Both
      // are the same budget, and `streamExec` prefers the deadline.
      ...(invocation.deadline == null ? {} : { deadline: invocation.deadline }),
      timeoutMs: invocation.timeoutMs,
      // Everything is kept here, so the daemon client keeps nothing.
      maxOutputChars: 0,
      onOutput: ({ stream: which, text }) => {
        emit(which === 'stderr' ? text : formatter.push(text));
      },
    });
    emit(formatter.flush());

    return { exitCode: result.exitCode, output, timedOut: result.timedOut };
  }

  async stop(sessionId: string, containerId: string, storyId?: string | null): Promise<void> {
    // SIGTERM only: the agent is mid-edit in a real working copy, and killing
    // it outright is how a half-written file survives into the next iteration.
    await this.exec.runExec(containerId, agentSignalSpec(sessionId, 'TERM', { storyId }), SIGNAL_TIMEOUT_MS);
  }

  /**
   * Everything `stop` does, and then makes sure of it.
   *
   * Used where nothing is going to come back and check: an iteration that ran
   * out of time is abandoned, not stopped — destroying the exec stream closes
   * chief-web's end of it and nothing else, because the Engine API cannot kill
   * an exec — so without this the agent keeps running with the workspace under
   * it and the next iteration execs a second one into the same working tree.
   *
   * SIGTERM first, for the same reason `stop` sends it: the agent is mid-edit
   * in a real working copy. What is different here is that its answer is no
   * longer wanted, so the grace period is short and SIGKILL is the end of it.
   */
  async reap(sessionId: string, containerId: string, storyId?: string | null): Promise<void> {
    try {
      const termed = await this.exec.runExec(
        containerId,
        agentSignalSpec(sessionId, 'TERM', { storyId }),
        SIGNAL_TIMEOUT_MS,
      );
      // Nothing was running: the sweep before a run and the one after a stop
      // that was honoured both land here, and neither should spend the grace
      // period waiting for an agent that is not there.
      if (!termed.stdout.includes(AGENT_SIGNALLED)) return;

      await pause(this.reapGraceMs);
      // The pid files go with this pass: anything still answering to them has
      // now had both signals, and a record kept past that is one the next
      // sweep would aim at a recycled pid.
      await this.exec.runExec(
        containerId,
        agentSignalSpec(sessionId, 'KILL', { remove: true, storyId }),
        SIGNAL_TIMEOUT_MS,
      );
    } catch (cause) {
      // A container that has gone away has no agent left in it either, and a
      // daemon that will not answer is not something the loop can act on.
      logger.warn('could not reap the build agent', {
        session: sessionId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async headSha(containerId: string, workingDir?: string): Promise<string | null> {
    const result = await this.exec.runExec(containerId, headShaSpec(workingDir), HEAD_TIMEOUT_MS);
    if (result.exitCode !== 0 || result.timedOut) return null;
    const sha = result.stdout.trim();
    return sha === '' ? null : sha;
  }

  async workspaceStatus(containerId: string): Promise<string | null> {
    const result = await this.exec.runExec(containerId, workspaceStatusSpec(), HEAD_TIMEOUT_MS);
    if (result.exitCode !== 0 || result.timedOut) return null;
    return result.stdout;
  }

  async restoreWorkspace(containerId: string): Promise<void> {
    try {
      const result = await this.exec.runExec(containerId, restoreWorkspaceSpec(), HEAD_TIMEOUT_MS);
      if (result.exitCode !== 0 || result.timedOut) {
        logger.warn('could not restore the clone after the dependency analysis', {
          container: containerId,
          exitCode: result.exitCode,
          stderr: result.stderr.trim(),
        });
      }
    } catch (cause) {
      logger.warn('could not restore the clone after the dependency analysis', {
        container: containerId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async addStoryWorktree(containerId: string, sessionName: string, storyId: string): Promise<void> {
    const result = await this.exec.runExec(containerId, addStoryWorktreeSpec(sessionName, storyId), WORKTREE_TIMEOUT_MS);
    if (result.timedOut) throw new Error(`creating the worktree of ${storyId} timed out`);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(
        `creating the worktree of ${storyId} failed (exit ${String(result.exitCode)})${stderr === '' ? '' : `: ${stderr}`}`,
      );
    }
  }

  async removeStoryWorktree(containerId: string, sessionName: string, storyId: string): Promise<void> {
    try {
      const result = await this.exec.runExec(
        containerId,
        removeStoryWorktreeSpec(sessionName, storyId),
        WORKTREE_TIMEOUT_MS,
      );
      if (result.exitCode !== 0 || result.timedOut) {
        logger.warn('could not remove a story worktree', {
          container: containerId,
          story: storyId,
          exitCode: result.exitCode,
          stderr: result.stderr.trim(),
        });
      }
    } catch (cause) {
      logger.warn('could not remove a story worktree', {
        container: containerId,
        story: storyId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async mergeStory(
    containerId: string,
    sessionName: string,
    storyId: string,
    message: string,
  ): Promise<StoryMergeOutcome> {
    let result: ExecOutput;
    try {
      result = await this.exec.runExec(containerId, mergeStorySpec(sessionName, storyId, message), WORKTREE_TIMEOUT_MS);
    } catch (cause) {
      return { code: 'failed', message: cause instanceof Error ? cause.message : String(cause) };
    }
    const stdout = result.stdout.trim();
    if (result.timedOut) return { code: 'failed', message: `merging ${storyId} timed out` };
    if (result.exitCode === 0 && stdout !== '') return { code: 'merged', mergeSha: stdout };
    const output = result.stderr.trim();
    const files = stdout === '' ? [] : stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    return files.length > 0
      ? { code: 'conflicted', files, message: output }
      : { code: 'failed', message: output === '' ? `exit ${String(result.exitCode)}` : output };
  }

  async abortStoryMerge(containerId: string, sessionName: string, storyId: string): Promise<void> {
    const aborted = await abortMerge(this.exec, containerId, {
      baseBranch: storyBranch(sessionName, storyId),
      timeoutMs: WORKTREE_TIMEOUT_MS,
    });
    if (!aborted) logger.warn('could not abort a story merge', { container: containerId, story: storyId });
  }

  async recoverStoryWorkspaces(containerId: string, sessionName: string): Promise<StoryWorkspaceRecovery> {
    let result: ExecOutput;
    try {
      result = await this.exec.runExec(containerId, recoverStoryWorkspacesSpec(sessionName), WORKTREE_TIMEOUT_MS);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      return { abortedMerge: false, worktrees: [], branches: [], error };
    }
    const lines = result.stdout.split('\n').map((line) => line.trim());
    const after = (prefix: string): string[] =>
      lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
    const stderr = result.stderr.trim();
    return {
      abortedMerge: lines.includes(RECOVERY_MERGE_ABORTED),
      worktrees: after('worktree '),
      branches: after('branch '),
      error: result.timedOut
        ? 'clearing the story worktrees timed out'
        : result.exitCode === 0
          ? null
          : stderr === ''
            ? `exit ${String(result.exitCode)}`
            : stderr,
    };
  }

  async verifyStoryMerge(
    containerId: string,
    sessionName: string,
    storyId: string,
    files: readonly string[],
  ): Promise<VerifyResult> {
    try {
      return await verifyResolution(this.exec, containerId, {
        baseBranch: storyBranch(sessionName, storyId),
        files,
        timeoutMs: WORKTREE_TIMEOUT_MS,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, code: 'commit_failed', message: `The resolution could not be checked: ${message}`, stderr: '' };
    }
  }
}

/** A clone with no commits at all answers nothing; neither takes long. */
const HEAD_TIMEOUT_MS = 30_000;
const SIGNAL_TIMEOUT_MS = 15_000;
/** A worktree is a checkout of the whole tree; a big repository takes a while. */
const WORKTREE_TIMEOUT_MS = 120_000;

/**
 * The pause between a reap's SIGTERM and its SIGKILL. Long enough for the CLI
 * to put its own tools down, short enough that the loop is not waiting on an
 * iteration whose output it has already given up on.
 */
export const AGENT_REAP_GRACE_MS = 10_000;

export function createAgentRunner(exec: AgentExecutor, reapGraceMs?: number): AgentRunner {
  return new ContainerAgentRunner(exec, reapGraceMs);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`;
}

/** Keeps the *end* of a streamed iteration: that is where the reason is. */
function tail(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : text.slice(text.length - MAX_OUTPUT_CHARS);
}

/** The whole output of a non-streaming executor, rendered in one go. */
function renderWhole(collected: ExecOutput): string {
  const formatter = new AgentOutputFormatter();
  const rendered = `${formatter.push(collected.stdout)}${formatter.flush()}`;
  return `${collected.stderr.trim()}\n${rendered.trim()}`.trim();
}
