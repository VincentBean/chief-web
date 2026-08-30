import type { ExecOutput, ExecSpec, StreamExecOptions } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import type { SessionExecutor } from '../sessions/index.js';
import { AGENT_SIGNALLED, agentExecSpec, agentSignalSpec, headShaSpec } from './agent.js';
import { AgentOutputFormatter } from './stream.js';

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
   * Called with the agent's output as it is produced, already rendered from
   * `stream-json` into the lines a person reads (US-016).
   */
  readonly onOutput?: (text: string) => void;
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
  /** Signals the running agent so it can shut down; never throws. */
  stop(sessionId: string, containerId: string): Promise<void>;
  /**
   * Leaves no agent of this session running, whatever it takes: signalled,
   * given a moment, then killed. Never throws.
   */
  reap(sessionId: string, containerId: string): Promise<void>;
  /** HEAD of the clone, or `null` when there is no commit to read. */
  headSha(containerId: string): Promise<string | null>;
}

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
    const formatter = new AgentOutputFormatter();
    let output = '';
    const emit = (text: string): void => {
      if (text === '') return;
      output = tail(output + text);
      invocation.onOutput?.(text);
    };

    const result = await stream(invocation.containerId, spec, {
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

  async stop(sessionId: string, containerId: string): Promise<void> {
    // SIGTERM only: the agent is mid-edit in a real working copy, and killing
    // it outright is how a half-written file survives into the next iteration.
    await this.exec.runExec(containerId, agentSignalSpec(sessionId, 'TERM'), SIGNAL_TIMEOUT_MS);
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
  async reap(sessionId: string, containerId: string): Promise<void> {
    try {
      const termed = await this.exec.runExec(
        containerId,
        agentSignalSpec(sessionId, 'TERM'),
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
        agentSignalSpec(sessionId, 'KILL', { remove: true }),
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

  async headSha(containerId: string): Promise<string | null> {
    const result = await this.exec.runExec(containerId, headShaSpec(), HEAD_TIMEOUT_MS);
    if (result.exitCode !== 0 || result.timedOut) return null;
    const sha = result.stdout.trim();
    return sha === '' ? null : sha;
  }
}

/** A clone with no commits at all answers nothing; neither takes long. */
const HEAD_TIMEOUT_MS = 30_000;
const SIGNAL_TIMEOUT_MS = 15_000;

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
