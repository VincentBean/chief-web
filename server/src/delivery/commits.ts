import type { ExecSpec } from '../docker/index.js';
import { CONTAINER_REPO_DIR, type SessionExecutor } from '../sessions/index.js';

/**
 * Counting what a run actually committed (US-006).
 *
 * A recurring task that finds nothing to do — the nightly "run rector and fix
 * what it reports" on a night rector reports nothing — still walks the whole
 * build loop and still reaches delivery. Pushing an empty branch and asking
 * GitHub for a pull request with no commits in it is noise at best (GitHub
 * refuses it with "No commits between …", which would fail the session), so
 * the delivery asks this first: is there anything on the feature branch the
 * base branch does not already have?
 *
 * The comparison is against `origin/<base>` — the ref the clone and the branch
 * step already work from (US-010) — rather than the local base branch, which a
 * clone of a single branch does not have at all.
 */

/** How much of git's output is kept when the count could not be read. */
const MAX_OUTPUT_CHARS = 2000;

/**
 * Commits reachable from the feature branch but not from the base branch.
 * `--count` answers a bare number, and `..` is the range every "what did this
 * branch add" question is asked with.
 */
export const COMMIT_COUNT_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git rev-list --count "origin/$CHIEF_BASE_BRANCH..$CHIEF_FEATURE_BRANCH"`;

export interface CommitCountInput {
  readonly baseBranch: string;
  readonly featureBranch: string;
  /** Cap on the count; it is a local read, so this is only a backstop. */
  readonly timeoutMs: number;
}

export interface CommitCount {
  /** Whether git answered with a number at all. */
  readonly known: boolean;
  /** How far ahead of the base branch the feature branch is; 0 when clean. */
  readonly commits: number;
  /** Why the count could not be read; empty when it could. */
  readonly message: string;
}

/** `sh -c` with the branches in the environment, so the shell parses nothing. */
export function commitCountExecSpec(baseBranch: string, featureBranch: string): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', COMMIT_COUNT_SCRIPT],
    env: [
      `CHIEF_BASE_BRANCH=${baseBranch}`,
      `CHIEF_FEATURE_BRANCH=${featureBranch}`,
      `CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`,
    ],
    workingDir: CONTAINER_REPO_DIR,
  };
}

/**
 * Runs the count. Never throws for a git failure, and never guesses: a range
 * git could not resolve answers `known: false`, which the delivery reads as
 * "carry on as usual" rather than as "there is nothing to deliver". Skipping a
 * pull request is only ever done on a number git really gave.
 */
export async function countBranchCommits(
  exec: SessionExecutor,
  container: string,
  input: CommitCountInput,
): Promise<CommitCount> {
  const result = await exec.runExec(
    container,
    commitCountExecSpec(input.baseBranch, input.featureBranch),
    input.timeoutMs,
  );

  if (result.timedOut) {
    return { known: false, commits: 0, message: 'counting the commits on the branch timed out' };
  }
  if (result.exitCode !== 0) {
    return {
      known: false,
      commits: 0,
      message:
        `git exited ${String(result.exitCode)} counting the commits of ` +
        `"${input.featureBranch}" over "origin/${input.baseBranch}"${detail(result)}`,
    };
  }

  const count = Number.parseInt(result.stdout.trim(), 10);
  if (!Number.isInteger(count) || count < 0) {
    return {
      known: false,
      commits: 0,
      message: `git answered "${result.stdout.trim()}", which is not a number of commits`,
    };
  }
  return { known: true, commits: count, message: '' };
}

/** git's own words, appended to the failure when it said anything. */
function detail(result: { stdout: string; stderr: string }): string {
  const text = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  if (text === '') return '';
  const kept = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}…` : text;
  return `: ${kept}`;
}
