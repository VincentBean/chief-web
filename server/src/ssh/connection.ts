import { spawn } from 'node:child_process';

import type { Config } from '../config.js';

/**
 * "Test connection" (US-005): runs `git ls-remote` against the registered
 * remote with the repository's own key, inside a short-lived runner container,
 * and reports git's stderr verbatim when it fails.
 *
 * The key is piped in on **stdin** rather than mounted or passed as an env var:
 * the runner image runs as a non-root user (US-006) which could not read a
 * root-owned `0600` file from the data volume, and `docker inspect` would
 * expose an env var to anyone with socket access.
 */

/** Runs inside the container with the private key on stdin. */
const SCRIPT = `set -e
umask 077
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cat > "$dir/key"
chmod 600 "$dir/key"
export GIT_SSH_COMMAND="ssh -i $dir/key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$dir/known_hosts -o ConnectTimeout=10"
git ls-remote --heads "$CHIEF_REPO_URL" > /dev/null`;

/** How much of the container's stderr we keep for the UI. */
const MAX_STDERR_CHARS = 4000;

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Injected in tests so the suite never needs a Docker daemon. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<CommandResult>;

export interface ConnectionTestResult {
  readonly ok: boolean;
  /** One-line summary for the operator. */
  readonly message: string;
  /** The underlying stderr, empty when there was nothing to report. */
  readonly stderr: string;
}

export function spawnCommand(
  command: string,
  args: readonly string[],
  stdin: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    // A container that exits before reading stdin makes the write fail; that is
    // not the interesting error, the exit code is.
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin);

    child.on('error', (error) => {
      finish({ code: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

function truncate(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_STDERR_CHARS
    ? `${trimmed.slice(0, MAX_STDERR_CHARS)}\n… (truncated)`
    : trimmed;
}

export interface ConnectionTestInput {
  readonly sshUrl: string;
  readonly privateKey: string;
}

/**
 * `docker run --rm -i` a runner container that clones nothing and only asks the
 * remote for its refs. Never throws: a failure is part of the answer.
 */
export async function testGitConnection(
  config: Config,
  input: ConnectionTestInput,
  run: CommandRunner = spawnCommand,
): Promise<ConnectionTestResult> {
  const args = [
    'run',
    '--rm',
    '-i',
    '--label',
    'chief-web.role=connection-test',
    '--env',
    `CHIEF_REPO_URL=${input.sshUrl}`,
    '--entrypoint',
    'sh',
    config.runnerImage,
    '-c',
    SCRIPT,
  ];

  const result = await run(config.dockerBin, args, input.privateKey, config.connectionTestTimeoutMs);

  if (result.timedOut) {
    return {
      ok: false,
      message: `The connection test timed out after ${Math.round(config.connectionTestTimeoutMs / 1000)}s.`,
      stderr: truncate(result.stderr),
    };
  }
  if (result.code === 0) {
    return { ok: true, message: 'Connected — the remote accepted the key.', stderr: '' };
  }
  return {
    ok: false,
    message:
      result.code === null
        ? 'The connection test could not be started.'
        : `git ls-remote failed (exit code ${result.code}).`,
    stderr: truncate(result.stderr) || 'The runner produced no output.',
  };
}
