import type { ExecSpec } from '../docker/index.js';
import { CONTAINER_REPO_DIR, type SessionExecutor } from '../sessions/index.js';

/**
 * Reading the branch diff the description is written from (US-001).
 *
 * The same range every "what did this branch add" question is asked with, and
 * the same one the review agent runs for itself: `origin/<target>...<feature>`,
 * against the remote-tracking ref rather than a local base branch, which a
 * single-branch clone does not have at all.
 *
 * The description agent is not asked to run this itself. It is handed the
 * patch in its prompt, fenced as untrusted data, so the pass is one `claude -p`
 * over text it cannot act on rather than an agent loose in the clone.
 */

/** How much of the patch the container sends back; the head, not the tail. */
export const MAX_DIFF_BYTES = 200_000;

/** How much of git's output is kept when the diff could not be read. */
const MAX_OUTPUT_CHARS = 2000;

/**
 * `--stat` first, then the patch.
 *
 * The summary names *every* file the branch touched, so even a diff cut short
 * by `head` leaves the agent with the whole shape of the change. `head -c`
 * bounds the patch inside the container: what comes back over the exec is kept
 * from the front, where `ExecOutput` would otherwise keep the tail.
 */
export const BRANCH_DIFF_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git fetch --quiet origin "$CHIEF_TARGET_BRANCH" >/dev/null 2>&1 || true
git diff --stat "origin/$CHIEF_TARGET_BRANCH...$CHIEF_FEATURE_BRANCH"
echo
git diff "origin/$CHIEF_TARGET_BRANCH...$CHIEF_FEATURE_BRANCH" | head -c "$CHIEF_MAX_BYTES"`;

export interface BranchDiffInput {
  /** The branch the pull request merges into; the left side of the range. */
  readonly targetBranch: string;
  /** The session's branch, as it exists in the clone. */
  readonly featureBranch: string;
  /** Cap on the read; it is a local git command, so this is only a backstop. */
  readonly timeoutMs: number;
  /** How much of the patch to send back; {@link MAX_DIFF_BYTES} by default. */
  readonly maxBytes?: number;
}

export interface BranchDiff {
  /** Whether git produced a diff at all. */
  readonly ok: boolean;
  /** The patch, empty whenever `ok` is false. */
  readonly diff: string;
  /** Why the diff could not be read; empty when it could. */
  readonly message: string;
}

/** `sh -c` with the branches in the environment, so the shell parses nothing. */
export function branchDiffExecSpec(
  targetBranch: string,
  featureBranch: string,
  maxBytes: number = MAX_DIFF_BYTES,
): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', BRANCH_DIFF_SCRIPT],
    env: [
      `CHIEF_TARGET_BRANCH=${targetBranch}`,
      `CHIEF_FEATURE_BRANCH=${featureBranch}`,
      `CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`,
      `CHIEF_MAX_BYTES=${String(maxBytes)}`,
    ],
    workingDir: CONTAINER_REPO_DIR,
  };
}

/**
 * Runs the read. Never throws for a git failure: the description is optional
 * everywhere it is used, so a range git could not resolve is a reason to skip
 * the pass, never a reason to fail the delivery that asked for it.
 */
export async function readBranchDiff(
  exec: SessionExecutor,
  container: string,
  input: BranchDiffInput,
): Promise<BranchDiff> {
  const result = await exec.runExec(
    container,
    branchDiffExecSpec(input.targetBranch, input.featureBranch, input.maxBytes),
    input.timeoutMs,
  );

  if (result.timedOut) {
    return { ok: false, diff: '', message: 'reading the branch diff timed out' };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      diff: '',
      message:
        `git exited ${String(result.exitCode)} diffing "${input.featureBranch}" against ` +
        `"origin/${input.targetBranch}"${detail(result)}`,
    };
  }

  const diff = result.stdout.trim();
  if (diff === '') {
    return {
      ok: false,
      diff: '',
      message: `"${input.featureBranch}" has no changes over "origin/${input.targetBranch}"`,
    };
  }
  return { ok: true, diff, message: '' };
}

/** git's own words, appended to the failure when it said anything. */
function detail(result: { stdout: string; stderr: string }): string {
  const text = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  if (text === '') return '';
  const kept = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text;
  return `: ${kept}`;
}
