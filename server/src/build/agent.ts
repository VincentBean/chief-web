import type { ExecSpec } from '../docker/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';
import { agentCommand } from './prompts.js';

/**
 * How a build iteration's `claude` process is started and addressed from
 * *inside* the session container (US-013).
 *
 * The Engine API has no "kill exec" and the pid it reports is a **host** pid,
 * so — exactly like a browser terminal (US-007) — the agent is started under a
 * one-line wrapper that records its own pid before `exec`ing the real command.
 * "Stop build" reads that file back and signals it, which is the only way to
 * end a headless agent gracefully rather than by discarding its container.
 */

/** Directory inside the session container holding the agent's pid file. */
export const AGENT_PID_DIR = '/tmp/.chief-build';

export function agentPidFile(sessionId: string): string {
  return `${AGENT_PID_DIR}/${sessionId}.pid`;
}

/**
 * Wraps `command` so its pid is recorded before it takes over the process.
 *
 * The command is passed as positional arguments and run with `exec "$@"`, so
 * nothing in it is ever re-parsed by the shell — which matters here more than
 * anywhere else, because the prompt is tens of kilobytes of markdown full of
 * backticks, quotes and `$`.
 */
export function wrapAgentCommand(sessionId: string, command: readonly string[]): string[] {
  const file = agentPidFile(sessionId);
  return [
    '/bin/sh',
    '-c',
    `mkdir -p ${AGENT_PID_DIR} 2>/dev/null; echo $$ > ${file}; exec "$@"`,
    'chief-build',
    ...command,
  ];
}

/** One headless `claude -p` iteration, in the clone. */
export function agentExecSpec(
  sessionId: string,
  prompt: string,
  model?: string | null,
): ExecSpec {
  return {
    cmd: wrapAgentCommand(sessionId, agentCommand(prompt, model)),
    workingDir: CONTAINER_REPO_DIR,
  };
}

/**
 * Sends `signal` to the recorded pid, to its process group, and to its direct
 * children.
 *
 * The agent itself is `exec`ed, so the recorded pid *is* `claude` and the
 * middle line is the one that matters. The other two are for what it started:
 * an iteration that is running the project's test suite when the operator
 * presses "Stop build" would otherwise leave that suite behind, still holding
 * the workspace. Every failure is swallowed and the exit code is always 0 — an
 * agent that has already finished is a success, not something to report.
 */
export function agentSignalSpec(sessionId: string, signal: string): ExecSpec {
  const file = agentPidFile(sessionId);
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `pid=$(cat ${file} 2>/dev/null); ` +
        `if [ -n "$pid" ]; then ` +
        `kill -${signal} -"$pid" 2>/dev/null; ` +
        `kill -${signal} "$pid" 2>/dev/null; ` +
        `pkill -${signal} -P "$pid" 2>/dev/null; ` +
        `fi; rm -f ${file}; exit 0`,
    ],
  };
}

/** `git rev-parse HEAD` in the clone; the loop's evidence that a commit landed. */
export function headShaSpec(): ExecSpec {
  return { cmd: ['git', 'rev-parse', 'HEAD'], workingDir: CONTAINER_REPO_DIR };
}
