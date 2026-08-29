import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { RUNNER_WORKSPACE_DIR } from '../runner/index.js';

/**
 * Cloning a repository into a session container (US-010).
 *
 * Three commands, run one after another inside the already-running container
 * so they use the entrypoint's SSH setup and the repository's own deploy key:
 *
 *   1. ask `origin` whether the feature branch already exists,
 *   2. clone the base branch into `/workspace/repo`,
 *   3. create (or re-enter) the feature branch.
 *
 * They are separate execs rather than one script so a failure can be attributed
 * to the step that produced it — "that branch is taken" and "the clone failed"
 * need very different messages, and only the second one is worth a stderr dump.
 *
 * Every value the shell needs is passed in the environment and referenced as
 * `"$VAR"`, so nothing a user typed is ever parsed as shell syntax.
 */

/** Where the clone lives inside the container; `/workspace/repo`. */
export const CONTAINER_REPO_DIR = `${RUNNER_WORKSPACE_DIR}/repo`;

/** How much of a command's output the UI is shown. */
const MAX_OUTPUT_CHARS = 8000;

/** `git ls-remote --exit-code` says "no matching ref" with this exit code. */
const LS_REMOTE_NO_MATCH = 2;

/** The slice of `DockerApi` session setup needs; tests pass a stub. */
export interface SessionExecutor {
  runExec(container: string, spec: ExecSpec, timeoutMs?: number): Promise<ExecOutput>;
}

/** Which step of the setup ran, in the order they run. */
export type SetupStep = 'check-branch' | 'clone' | 'branch';

export interface SetupResult {
  readonly ok: boolean;
  /** Machine-readable reason; `ok` when nothing went wrong. */
  readonly code: SetupCode;
  /** One-line explanation for the operator; stored as the session's error. */
  readonly message: string;
  /** git's own output, empty when there was nothing to report. */
  readonly stderr: string;
}

export type SetupCode =
  | 'ok'
  | 'feature_branch_exists'
  | 'remote_unreachable'
  | 'clone_failed'
  | 'branch_failed'
  | 'setup_timed_out';

export interface SetupInput {
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly featureBranch: string;
  /** Cap on each individual git command; a clone is the slow one. */
  readonly timeoutMs: number;
}

/** Is the feature branch already on the remote? */
const CHECK_BRANCH_SCRIPT = `set -e
git ls-remote --exit-code --heads "$CHIEF_REPO_URL" "refs/heads/$CHIEF_FEATURE_BRANCH"`;

/**
 * Clones the base branch. An existing clone is kept: a retry after a failure
 * further along must not throw away work, and re-cloning would be pointless.
 * Anything else at that path is not a clone and is cleared out of the way.
 */
const CLONE_SCRIPT = `set -e
if [ -d "$CHIEF_REPO_DIR/.git" ]; then
    echo "chief-web: reusing the existing clone at $CHIEF_REPO_DIR" >&2
else
    rm -rf "$CHIEF_REPO_DIR"
    git clone --origin origin --branch "$CHIEF_BASE_BRANCH" "$CHIEF_REPO_URL" "$CHIEF_REPO_DIR"
fi`;

/**
 * Creates the feature branch from the *remote* base branch, so a reused clone
 * still starts from what `origin` has now. Re-entering an existing local branch
 * is what makes a retry idempotent.
 */
const BRANCH_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git fetch --quiet origin "$CHIEF_BASE_BRANCH"
if git show-ref --verify --quiet "refs/heads/$CHIEF_FEATURE_BRANCH"; then
    git checkout "$CHIEF_FEATURE_BRANCH"
else
    git checkout -b "$CHIEF_FEATURE_BRANCH" "origin/$CHIEF_BASE_BRANCH"
fi
git rev-parse --abbrev-ref HEAD`;

function environment(input: SetupInput): string[] {
  return [
    `CHIEF_REPO_URL=${input.repoUrl}`,
    `CHIEF_BASE_BRANCH=${input.baseBranch}`,
    `CHIEF_FEATURE_BRANCH=${input.featureBranch}`,
    `CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`,
  ];
}

/** `sh -c <script>` with the setup environment; the shell parses nothing else. */
export function setupExecSpec(script: string, input: SetupInput): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', script],
    env: environment(input),
    workingDir: RUNNER_WORKSPACE_DIR,
  };
}

/** The command for `step`, exported so the tests can assert what each one runs. */
export function setupScript(step: SetupStep): string {
  switch (step) {
    case 'check-branch':
      return CHECK_BRANCH_SCRIPT;
    case 'clone':
      return CLONE_SCRIPT;
    case 'branch':
      return BRANCH_SCRIPT;
  }
}

/**
 * Runs the three steps in order, stopping at the first failure. Never throws
 * for a git failure: a rejected clone is part of the answer, exactly like the
 * repository connection test (US-005).
 */
export async function runSessionSetup(
  exec: SessionExecutor,
  container: string,
  input: SetupInput,
): Promise<SetupResult> {
  const run = (step: SetupStep): Promise<ExecOutput> =>
    exec.runExec(container, setupExecSpec(setupScript(step), input), input.timeoutMs);

  const check = await run('check-branch');
  if (check.timedOut) return timedOut('check-branch', input, check);
  if (check.exitCode === 0 && check.stdout.trim() !== '') {
    return {
      ok: false,
      code: 'feature_branch_exists',
      message:
        `The branch "${input.featureBranch}" already exists on origin. ` +
        'Pick a different session name, or delete that remote branch first — chief-web never ' +
        'reuses or force-pushes a branch it did not create.',
      stderr: output(check),
    };
  }
  if (check.exitCode !== LS_REMOTE_NO_MATCH) {
    return {
      ok: false,
      code: 'remote_unreachable',
      message:
        `Could not read the branches of ${input.repoUrl} (git exited ${String(check.exitCode)}). ` +
        'Check the repository URL and that its deploy key is installed on the remote.',
      stderr: output(check),
    };
  }

  const clone = await run('clone');
  if (clone.timedOut) return timedOut('clone', input, clone);
  if (clone.exitCode !== 0) {
    return {
      ok: false,
      code: 'clone_failed',
      message: `Cloning ${input.repoUrl} (branch "${input.baseBranch}") failed with exit code ${String(clone.exitCode)}.`,
      stderr: output(clone),
    };
  }

  const branch = await run('branch');
  if (branch.timedOut) return timedOut('branch', input, branch);
  if (branch.exitCode !== 0) {
    return {
      ok: false,
      code: 'branch_failed',
      message: `Creating the branch "${input.featureBranch}" from "${input.baseBranch}" failed with exit code ${String(branch.exitCode)}.`,
      stderr: output(branch),
    };
  }

  return {
    ok: true,
    code: 'ok',
    message: `Cloned into ${CONTAINER_REPO_DIR} on branch ${input.featureBranch}.`,
    stderr: '',
  };
}

function timedOut(step: SetupStep, input: SetupInput, result: ExecOutput): SetupResult {
  const seconds = Math.round(input.timeoutMs / 1000);
  return {
    ok: false,
    code: 'setup_timed_out',
    message: `The repository setup timed out after ${seconds}s during the "${step}" step.`,
    stderr: output(result),
  };
}

/** git says everything interesting on stderr; stdout is only a fallback. */
function output(result: ExecOutput): string {
  const text = `${result.stderr.trim()}\n${result.stdout.trim()}`.trim();
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (truncated)` : text;
}
