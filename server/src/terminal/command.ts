/**
 * How a terminal's process is addressed from *inside* the target container.
 *
 * The Engine API has no "kill exec", and the pid it reports in
 * `GET /exec/{id}/json` is a **host** pid — meaningless inside a container that
 * has its own PID namespace, so signalling it from a second exec does nothing.
 *
 * Instead the shell is started under a one-line wrapper that records its own
 * pid in a file named after the terminal, then `exec`s the real command (so the
 * pid stays valid). Closing a terminal reads that file back and signals it.
 */

/** Directory inside the target container holding one pid file per terminal. */
export const TERMINAL_PID_DIR = '/tmp/.chief-terminals';

export function terminalPidFile(id: string): string {
  return `${TERMINAL_PID_DIR}/${id}.pid`;
}

/**
 * Wraps `command` so its pid is recorded before it takes over the process.
 *
 * The command is passed as positional arguments and run with `exec "$@"`, so
 * nothing in it is ever re-parsed by the shell — no quoting, no injection.
 */
export function wrapTerminalCommand(id: string, command: readonly string[]): string[] {
  const file = terminalPidFile(id);
  return [
    '/bin/sh',
    '-c',
    `mkdir -p ${TERMINAL_PID_DIR} 2>/dev/null; echo $$ > ${file}; exec "$@"`,
    'chief-terminal',
    ...command,
  ];
}

/**
 * Sends `signal` to the recorded pid. Always exits 0: the process having
 * already gone is a success, not something to report.
 */
export function terminalSignalCommand(id: string, signal: string, cleanup: boolean): string[] {
  const file = terminalPidFile(id);
  return [
    '/bin/sh',
    '-c',
    `pid=$(cat ${file} 2>/dev/null); [ -n "$pid" ] && kill -${signal} "$pid" 2>/dev/null; ` +
      `${cleanup ? `rm -f ${file}; ` : ''}exit 0`,
  ];
}

/** Removes the pid file of a terminal that shut down without being signalled. */
export function terminalCleanupCommand(id: string): string[] {
  return ['/bin/sh', '-c', `rm -f ${terminalPidFile(id)}; exit 0`];
}
