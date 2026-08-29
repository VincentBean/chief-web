import type { ExecSpec } from '../docker/index.js';
import { CONTAINER_REPO_DIR, type SessionExecutor } from '../sessions/index.js';

/**
 * Pushing a session's feature branch to `origin` (US-014).
 *
 * The push runs *inside* the session container, exactly like the clone
 * (US-010): that is where the repository's deploy key and the entrypoint's SSH
 * setup live, and it is the only place the working copy exists at all.
 *
 * It is a plain `git push --set-upstream` — never `--force`, and never with a
 * refspec chief-web made up. A remote that has moved on is a failure the
 * operator has to see, not something to overwrite.
 */

/** How much of git's output is kept for the operator. */
const MAX_OUTPUT_CHARS = 8000;

/**
 * The branch is checked out in the clone, so it is pushed by name; `-u` makes
 * the second push (and every one after it) a no-op rather than an error.
 */
export const PUSH_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git push --set-upstream origin "$CHIEF_FEATURE_BRANCH"`;

export interface PushInput {
  readonly featureBranch: string;
  /** Cap on the push; a large first push over SSH is the slow case. */
  readonly timeoutMs: number;
}

export interface PushResult {
  readonly ok: boolean;
  /** One-line explanation for the operator; stored as the session's error. */
  readonly message: string;
  /** git's own output, empty when there was nothing to report. */
  readonly stderr: string;
}

/** `sh -c` with the branch in the environment, so the shell parses nothing. */
export function pushExecSpec(featureBranch: string): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', PUSH_SCRIPT],
    env: [`CHIEF_FEATURE_BRANCH=${featureBranch}`, `CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`],
    workingDir: CONTAINER_REPO_DIR,
  };
}

/**
 * Runs the push. Never throws for a git failure — a rejected remote is part of
 * the answer, the same way a failed clone is (US-010).
 */
export async function runPush(
  exec: SessionExecutor,
  container: string,
  input: PushInput,
): Promise<PushResult> {
  const result = await exec.runExec(container, pushExecSpec(input.featureBranch), input.timeoutMs);

  if (result.timedOut) {
    return {
      ok: false,
      message: `Pushing "${input.featureBranch}" to origin timed out after ${String(
        Math.round(input.timeoutMs / 1000),
      )}s.`,
      stderr: output(result),
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      message:
        `Pushing "${input.featureBranch}" to origin failed (git exited ` +
        `${String(result.exitCode)}). Check that the repository's deploy key has write access.`,
      stderr: output(result),
    };
  }
  return {
    ok: true,
    message: `Pushed "${input.featureBranch}" to origin.`,
    stderr: output(result),
  };
}

/** git says everything interesting on stderr; stdout is only a fallback. */
function output(result: { stdout: string; stderr: string }): string {
  const text = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : text;
}
