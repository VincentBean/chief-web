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
 *
 * It is also the only way to end one that ran out of time. Closing the exec
 * stream — all a timeout can do from the outside — leaves the agent running
 * with the workspace still under it, so every pid an iteration records has to
 * stay addressable until something has confirmed it is gone.
 */

/** Directory inside the session container holding the agents' pid files. */
export const AGENT_PID_DIR = '/tmp/.chief-build';

/**
 * One pid file per *iteration*, not per session.
 *
 * A single file per session was overwritten by the next iteration, which meant
 * an agent that outlived its iteration — the whole reason for reaping one —
 * became unreachable the moment its successor started. Keying the file on the
 * iteration keeps every agent this session has ever started addressable, and
 * {@link agentSignalSpec} sweeps all of them at once.
 */
export function agentPidFile(sessionId: string, iteration: number): string {
  return `${AGENT_PID_DIR}/${sessionId}-${String(iteration)}.pid`;
}

/**
 * Printed by {@link agentSignalSpec} for each agent it found still running.
 *
 * A sweep that prints nothing found nothing, and a reap can stop there instead
 * of sitting through a grace period for an agent that was never there — which
 * is the normal case for both of the paths that reap.
 */
export const AGENT_SIGNALLED = 'chief-signalled';

/** Every iteration's pid file, for the sweep; a shell glob, not a path. */
export function agentPidGlob(sessionId: string): string {
  return `${AGENT_PID_DIR}/${sessionId}-*.pid`;
}

/**
 * Wraps `command` so its pid is recorded before it takes over the process.
 *
 * The command is passed as positional arguments and run with `exec "$@"`, so
 * nothing in it is ever re-parsed by the shell — which matters here more than
 * anywhere else, because the prompt is tens of kilobytes of markdown full of
 * backticks, quotes and `$`.
 */
export function wrapAgentCommand(
  sessionId: string,
  iteration: number,
  command: readonly string[],
): string[] {
  const file = agentPidFile(sessionId, iteration);
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
  iteration: number,
  prompt: string,
  model?: string | null,
): ExecSpec {
  return {
    cmd: wrapAgentCommand(sessionId, iteration, agentCommand(prompt, model)),
    workingDir: CONTAINER_REPO_DIR,
  };
}

/**
 * Sends `signal` to every agent this session has recorded: to each pid, to its
 * process group, and to its direct children.
 *
 * The agent itself is `exec`ed, so a recorded pid *is* `claude` and the middle
 * line is the one that matters. The other two are for what it started: an
 * iteration that is running the project's test suite when it is signalled
 * would otherwise leave that suite — and the database servers it started —
 * behind, still holding the workspace.
 *
 * A pid is only signalled when `/proc` still shows it running the agent. Pids
 * are recycled, and by the time a leftover file is swept its number may belong
 * to something else entirely; a record that no longer points at an agent is
 * deleted rather than shot at. `remove` deletes the ones that do, and belongs
 * to the last pass of a reap — an earlier pass has to leave the record behind
 * or the pass after it has nothing left to aim at.
 *
 * Every failure is swallowed and the exit code is always 0 — an agent that has
 * already finished is a success, not something to report. What it does print is
 * {@link AGENT_SIGNALLED}, once per agent it actually signalled, which is how a
 * reap knows whether there is anything to come back and kill.
 */
export function agentSignalSpec(
  sessionId: string,
  signal: string,
  options: { readonly remove?: boolean } = {},
): ExecSpec {
  const glob = agentPidGlob(sessionId);
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `for file in ${glob}; do ` +
        `[ -f "$file" ] || continue; ` +
        `pid=$(cat "$file" 2>/dev/null); ` +
        `if [ -n "$pid" ] && grep -qa claude /proc/"$pid"/cmdline 2>/dev/null; then ` +
        `kill -${signal} -"$pid" 2>/dev/null; ` +
        `kill -${signal} "$pid" 2>/dev/null; ` +
        `pkill -${signal} -P "$pid" 2>/dev/null; ` +
        `echo ${AGENT_SIGNALLED}; ` +
        `${options.remove === true ? 'rm -f "$file"; ' : ''}` +
        `else rm -f "$file"; fi; ` +
        `done; exit 0`,
    ],
  };
}

/** `git rev-parse HEAD` in the clone; the loop's evidence that a commit landed. */
export function headShaSpec(): ExecSpec {
  return { cmd: ['git', 'rev-parse', 'HEAD'], workingDir: CONTAINER_REPO_DIR };
}
