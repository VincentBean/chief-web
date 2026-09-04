import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { CONTAINER_REPO_DIR, type SessionExecutor } from '../sessions/index.js';

/**
 * The git side of resolving a merge conflict inside a run's container (US-005).
 *
 * Shaped like `prfeedback/checkout.ts`: every step is one `sh -c` script, every
 * variable is passed as an environment variable or a positional argument and
 * never interpolated into the script, and a git failure is part of the answer
 * rather than an exception.
 *
 * The division of labour is the whole point of this module: **the agent only
 * edits files**. Fetching the base, starting the merge, staging, committing,
 * aborting and pushing all happen here, in scripts chief-web wrote, so that a
 * confused agent can never put something on a human's pull request that
 * chief-web did not check first.
 */

/** Every git step a fix run drives, in the order it drives them. */
export type MergeStep =
  | 'fetch-base'
  | 'merge'
  | 'conflicts'
  | 'stage'
  | 'status'
  | 'markers'
  | 'commit'
  | 'abort';

/** The base branch as `origin/<base>`, fetched fresh — never a stale ref. */
const FETCH_BASE_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git fetch --quiet origin "$CHIEF_BASE_BRANCH"`;

/**
 * Merges the base into the checked-out head branch.
 *
 * `--no-edit` so a clean merge commits itself with git's own message; a
 * conflicted one stops with the working tree half-merged, which is exactly the
 * state the agent is asked to finish.
 */
const MERGE_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git merge --no-edit "origin/$CHIEF_BASE_BRANCH"`;

/** The unmerged paths, NUL-separated so a newline in a name cannot lie. */
const CONFLICTS_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git diff --name-only --diff-filter=U -z`;

/**
 * Stages the resolution — only the paths that were conflicted, passed as
 * positional arguments so nothing about a file name is ever parsed by a shell.
 *
 * `-A` rather than a plain add so a conflict the agent resolved by deleting the
 * file is staged as the deletion it is.
 */
const STAGE_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git add -A -- "$@"`;

/** Porcelain status, read for unmerged entries only. */
const STATUS_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git status --porcelain`;

/**
 * Prints every given file that still has a conflict marker in it.
 *
 * Only the files the merge actually conflicted in are looked at: a repository
 * is perfectly entitled to contain a line of seven equals signs — a Markdown
 * heading underline, a diff in a fixture, this very file — and failing a run
 * over one somewhere else would be a bug, not a safeguard.
 */
const MARKERS_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
for file in "$@"; do
    [ -f "$file" ] || continue
    if grep -qE '^(<<<<<<<|=======$|>>>>>>>)' -- "$file"; then
        echo "$file"
    fi
done`;

/**
 * Commits the resolved merge.
 *
 * `--no-edit` keeps git's own merge message, so the history reads the way a
 * hand-made merge would. `--no-verify` because this commit is chief-web's,
 * mechanical and already verified: a repository's pre-commit hook has plenty
 * to say about the code on the branch and nothing to say about whether two
 * sides were merged correctly.
 */
const COMMIT_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git commit --no-edit --no-verify`;

/** Puts the working copy back where the merge found it. */
const ABORT_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git merge --abort`;

/** The command for `step`, exported so the tests can assert what each runs. */
export function mergeScript(step: MergeStep): string {
  switch (step) {
    case 'fetch-base':
      return FETCH_BASE_SCRIPT;
    case 'merge':
      return MERGE_SCRIPT;
    case 'conflicts':
      return CONFLICTS_SCRIPT;
    case 'stage':
      return STAGE_SCRIPT;
    case 'status':
      return STATUS_SCRIPT;
    case 'markers':
      return MARKERS_SCRIPT;
    case 'commit':
      return COMMIT_SCRIPT;
    case 'abort':
      return ABORT_SCRIPT;
  }
}

/**
 * `sh -c <script> sh <file…>` with the merge environment.
 *
 * The files go in as positional arguments rather than into the script, so a
 * path out of someone else's repository can never become a command.
 */
export function mergeExecSpec(
  step: MergeStep,
  baseBranch: string,
  files: readonly string[] = [],
): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', mergeScript(step), 'sh', ...files],
    env: [`CHIEF_BASE_BRANCH=${baseBranch}`, `CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`],
    workingDir: CONTAINER_REPO_DIR,
  };
}

export interface MergeInput {
  /** The branch merged *into* the checked-out head branch. */
  readonly baseBranch: string;
  /** Cap on each git command; the fetch is the slow one. */
  readonly timeoutMs: number;
}

export type MergeCode =
  | /** The base merged cleanly and git made the commit itself. */ 'merged'
  | /** Git stopped on conflicts; the files are in {@link MergeAttempt.files}. */ 'conflicted'
  | /** Something other than a conflict went wrong; nothing was resolved. */ 'failed';

export interface MergeAttempt {
  readonly code: MergeCode;
  /** The conflicted paths, empty unless `code` is `conflicted`. */
  readonly files: readonly string[];
  readonly message: string;
  readonly stderr: string;
}

/**
 * Fetches the base branch and merges it in.
 *
 * A conflict is not a failure here — it is the case this whole feature exists
 * for. What *is* a failure is a merge that stopped for any other reason, which
 * is told apart by asking git what is unmerged: a stopped merge with no
 * unmerged path is not a conflict.
 */
export async function runBaseMerge(
  exec: SessionExecutor,
  container: string,
  input: MergeInput,
): Promise<MergeAttempt> {
  const run = (step: MergeStep, files: readonly string[] = []): Promise<ExecOutput> =>
    exec.runExec(container, mergeExecSpec(step, input.baseBranch, files), input.timeoutMs);

  const fetched = await run('fetch-base');
  if (fetched.timedOut || fetched.exitCode !== 0) {
    return {
      code: 'failed',
      files: [],
      message: fetched.timedOut
        ? `Fetching "${input.baseBranch}" from origin timed out after ${seconds(input.timeoutMs)}.`
        : `Fetching "${input.baseBranch}" from origin failed (git exited ${String(fetched.exitCode)}).`,
      stderr: output(fetched),
    };
  }

  const merged = await run('merge');
  if (merged.timedOut) {
    return {
      code: 'failed',
      files: [],
      message: `Merging "${input.baseBranch}" timed out after ${seconds(input.timeoutMs)}.`,
      stderr: output(merged),
    };
  }
  if (merged.exitCode === 0) {
    return {
      code: 'merged',
      files: [],
      message: `"origin/${input.baseBranch}" merged cleanly; no agent was needed.`,
      stderr: output(merged),
    };
  }

  const listed = await run('conflicts');
  const files = splitNul(listed.stdout);
  if (listed.timedOut || listed.exitCode !== 0 || files.length === 0) {
    return {
      code: 'failed',
      files: [],
      message:
        `Merging "${input.baseBranch}" stopped (git exited ${String(merged.exitCode)}) without ` +
        'leaving any conflicted file behind, so there is nothing an agent could resolve.',
      stderr: output(merged),
    };
  }

  return {
    code: 'conflicted',
    files,
    message: `Merging "${input.baseBranch}" conflicted in ${count(files.length)}.`,
    stderr: output(merged),
  };
}

export interface VerifyInput extends MergeInput {
  /** The paths the merge conflicted in: the only ones checked and staged. */
  readonly files: readonly string[];
}

export type VerifyCode = 'ok' | 'stage_failed' | 'unmerged' | 'markers' | 'commit_failed';

export interface VerifyResult {
  readonly ok: boolean;
  readonly code: VerifyCode;
  readonly message: string;
  readonly stderr: string;
}

/**
 * Everything that has to be true before a resolution may be pushed (US-005).
 *
 * Staging comes first because it is what turns edited files back into a
 * resolved merge — an agent that edited the files and stopped there has done
 * its job, and `git add` is chief-web's to run, not its. Then the three checks:
 * nothing unmerged, no conflict marker in any file the merge touched, and a
 * merge commit that actually completes. Any of them failing means nothing is
 * pushed.
 */
export async function verifyResolution(
  exec: SessionExecutor,
  container: string,
  input: VerifyInput,
): Promise<VerifyResult> {
  const run = (step: MergeStep, files: readonly string[] = []): Promise<ExecOutput> =>
    exec.runExec(container, mergeExecSpec(step, input.baseBranch, files), input.timeoutMs);

  const staged = await run('stage', input.files);
  if (staged.timedOut || staged.exitCode !== 0) {
    return {
      ok: false,
      code: 'stage_failed',
      message: `The resolved files could not be staged (git exited ${String(staged.exitCode)}).`,
      stderr: output(staged),
    };
  }

  const status = await run('status');
  if (status.timedOut || status.exitCode !== 0) {
    return {
      ok: false,
      code: 'unmerged',
      message: `git status could not be read (git exited ${String(status.exitCode)}).`,
      stderr: output(status),
    };
  }
  const unmerged = unmergedPaths(status.stdout);
  if (unmerged.length > 0) {
    return {
      ok: false,
      code: 'unmerged',
      message: `The merge is still unresolved in ${unmerged.join(', ')}.`,
      stderr: output(status),
    };
  }

  const markers = await run('markers', input.files);
  if (markers.timedOut || markers.exitCode !== 0) {
    return {
      ok: false,
      code: 'markers',
      message: 'The conflicted files could not be checked for conflict markers.',
      stderr: output(markers),
    };
  }
  const left = lines(markers.stdout);
  if (left.length > 0) {
    return {
      ok: false,
      code: 'markers',
      message: `Conflict markers were left behind in ${left.join(', ')}.`,
      stderr: output(markers),
    };
  }

  const committed = await run('commit');
  if (committed.timedOut || committed.exitCode !== 0) {
    return {
      ok: false,
      code: 'commit_failed',
      message: `The merge commit failed (git exited ${String(committed.exitCode)}).`,
      stderr: output(committed),
    };
  }

  return {
    ok: true,
    code: 'ok',
    message: `Resolved ${count(input.files.length)} and committed the merge.`,
    stderr: output(committed),
  };
}

/**
 * Puts the branch back the way it was found. Never throws: this runs on the
 * way out of a failure, and a failed abort must not hide what actually went
 * wrong.
 */
export async function abortMerge(
  exec: SessionExecutor,
  container: string,
  input: MergeInput,
): Promise<boolean> {
  try {
    const result = await exec.runExec(
      container,
      mergeExecSpec('abort', input.baseBranch),
      input.timeoutMs,
    );
    return !result.timedOut && result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Whether a push was refused because the branch moved under the run.
 *
 * Told apart from every other push failure because it is not a failure of the
 * fix at all: the head is at a commit this run never saw, so the resolution it
 * built is answering the wrong question and the next scan starts a new one.
 */
export function isNonFastForward(stderr: string): boolean {
  if (!/\[rejected\]|\brejected\b/i.test(stderr)) return false;
  return /non-fast-forward|fetch first|stale info|behind its remote/i.test(stderr);
}

/** The porcelain status codes git uses for a path that is still unmerged. */
const UNMERGED_CODES = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];

/** The unmerged paths named by `git status --porcelain` output. */
export function unmergedPaths(stdout: string): string[] {
  return lines(stdout)
    .filter((line) => UNMERGED_CODES.includes(line.slice(0, 2)))
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== '');
}

function splitNul(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
}

function lines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');
}

function count(files: number): string {
  return `${String(files)} file${files === 1 ? '' : 's'}`;
}

function seconds(timeoutMs: number): string {
  return `${String(Math.round(timeoutMs / 1000))}s`;
}

function output(result: ExecOutput): string {
  return [result.stderr, result.stdout].filter((part) => part.trim() !== '').join('\n');
}
