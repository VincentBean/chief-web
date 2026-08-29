import type { SessionExecutor } from '../sessions/index.js';
import { agentExecSpec, agentSignalSpec, headShaSpec } from './agent.js';

/**
 * Running one headless agent iteration inside a session container (US-013).
 *
 * Declared as an interface next to the loop that uses it — the same shape as
 * `SessionDocker` (US-009) — so the retry, cap and story-selection tests drive
 * the whole service with a mock and never touch a daemon. The production
 * implementation is a thin wrapper around `DockerApi.runExec`.
 */

/** How much of an iteration's output is kept for the session's error message. */
const MAX_OUTPUT_CHARS = 8000;

export interface AgentInvocation {
  readonly sessionId: string;
  readonly containerId: string;
  readonly prompt: string;
  /** Cap on the whole iteration; a stuck agent must not hold the loop forever. */
  readonly timeoutMs: number;
}

export interface AgentResult {
  /** `null` when the iteration was cut short by its timeout. */
  readonly exitCode: number | null;
  /** Everything the agent printed, stderr first, truncated. */
  readonly output: string;
  readonly timedOut: boolean;
}

export interface AgentRunner {
  /** Runs one iteration to completion. Rejects only if the daemon does. */
  run(invocation: AgentInvocation): Promise<AgentResult>;
  /** Signals the running agent so it can shut down; never throws. */
  stop(sessionId: string, containerId: string): Promise<void>;
  /** HEAD of the clone, or `null` when there is no commit to read. */
  headSha(containerId: string): Promise<string | null>;
}

/** The {@link AgentRunner} that actually execs into the session container. */
export class ContainerAgentRunner implements AgentRunner {
  constructor(private readonly exec: SessionExecutor) {}

  async run(invocation: AgentInvocation): Promise<AgentResult> {
    const result = await this.exec.runExec(
      invocation.containerId,
      agentExecSpec(invocation.sessionId, invocation.prompt),
      invocation.timeoutMs,
    );
    return {
      exitCode: result.exitCode,
      output: truncate(`${result.stderr.trim()}\n${result.stdout.trim()}`.trim()),
      timedOut: result.timedOut,
    };
  }

  async stop(sessionId: string, containerId: string): Promise<void> {
    // SIGTERM only: the agent is mid-edit in a real working copy, and killing
    // it outright is how a half-written file survives into the next iteration.
    await this.exec.runExec(containerId, agentSignalSpec(sessionId, 'TERM'), SIGNAL_TIMEOUT_MS);
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

export function createAgentRunner(exec: SessionExecutor): AgentRunner {
  return new ContainerAgentRunner(exec);
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)`;
}
