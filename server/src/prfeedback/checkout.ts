import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { RUNNER_WORKSPACE_DIR } from '../runner/index.js';
import { CONTAINER_REPO_DIR, type SessionExecutor } from '../sessions/index.js';

/**
 * Checking a pull request's head branch out so an agent can work on it
 * (US-021).
 *
 * This is `sessions/setup.ts` inverted. Session setup refuses when the branch
 * already exists on the remote, because it is about to create one; here the
 * branch *must* exist, because someone else made it and the pull request points
 * at it.
 */

/** `git ls-remote --exit-code` exits 2 when nothing matched the pattern. */
const LS_REMOTE_NO_MATCH = 2;

export type CheckoutStep = 'check-head' | 'clone' | 'checkout';

export type CheckoutCode =
  | 'ok'
  | 'head_branch_missing'
  | 'remote_unreachable'
  | 'clone_failed'
  | 'checkout_failed'
  | 'head_moved'
  | 'checkout_timed_out';

export interface CheckoutInput {
  readonly repoUrl: string;
  /** The pull request's head branch: what is checked out and later pushed. */
  readonly headBranch: string;
  /**
   * The commit GitHub said the head was when the feedback was read. The
   * checkout is verified against it, so a branch that moved underneath us is a
   * refusal rather than a fix built on comments that no longer apply.
   */
  readonly expectedHeadSha: string;
  /** Cap on each individual git command; the clone is the slow one. */
  readonly timeoutMs: number;
}

export interface CheckoutResult {
  readonly ok: boolean;
  readonly code: CheckoutCode;
  readonly message: string;
  readonly stderr: string;
  /** `git rev-parse HEAD` after the checkout; null when it never got there. */
  readonly headSha: string | null;
}

/** Is the head branch still on the remote? */
const CHECK_HEAD_SCRIPT = `set -e
git ls-remote --exit-code --heads "$CHIEF_REPO_URL" "refs/heads/$CHIEF_HEAD_BRANCH"`;

/**
 * Clones the head branch. An existing clone is kept — a previous run on this
 * pull request left one, and re-cloning a large repository to answer three
 * comments would be wasteful. Anything else at that path is not a clone.
 */
const CLONE_SCRIPT = `set -e
if [ -d "$CHIEF_REPO_DIR/.git" ]; then
    echo "chief-web: reusing the existing clone at $CHIEF_REPO_DIR" >&2
else
    rm -rf "$CHIEF_REPO_DIR"
    git clone --origin origin --branch "$CHIEF_HEAD_BRANCH" "$CHIEF_REPO_URL" "$CHIEF_REPO_DIR"
fi`;

/**
 * Puts the working copy exactly on what `origin` has right now.
 *
 * This is the one place chief-web is deliberately destructive with git, and it
 * needs the justification stated: this workspace is chief-web's own scratch
 * copy of *someone else's* pull request. Nothing is ever authored here outside
 * a run, and a commit left behind by a run that failed before its push was
 * never delivered — the next run regenerates it. Starting from anything other
 * than the remote's current state would push a stale branch onto a human's
 * pull request, which is far worse than discarding a local commit nobody saw.
 *
 * `clean -fd` deliberately omits `-x`, so ignored build output — `node_modules`
 * and friends — survives between runs.
 */
const CHECKOUT_SCRIPT = `set -e
cd "$CHIEF_REPO_DIR"
git fetch --quiet origin "$CHIEF_HEAD_BRANCH"
git checkout -B "$CHIEF_HEAD_BRANCH" "origin/$CHIEF_HEAD_BRANCH"
git reset --hard "origin/$CHIEF_HEAD_BRANCH"
git clean -fd
git rev-parse HEAD`;

function environment(input: CheckoutInput): string[] {
  return [
    `CHIEF_REPO_URL=${input.repoUrl}`,
    `CHIEF_HEAD_BRANCH=${input.headBranch}`,
    `CHIEF_REPO_DIR=${CONTAINER_REPO_DIR}`,
  ];
}

/**
 * `sh -c <script>` with the checkout environment.
 *
 * Everything variable is passed as an environment variable and referenced as
 * `"$VAR"`, never interpolated into the script — a branch name comes from
 * GitHub and must not be able to become a command.
 */
export function checkoutExecSpec(script: string, input: CheckoutInput): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', script],
    env: environment(input),
    workingDir: RUNNER_WORKSPACE_DIR,
  };
}

/** The command for `step`, exported so the tests can assert what each one runs. */
export function checkoutScript(step: CheckoutStep): string {
  switch (step) {
    case 'check-head':
      return CHECK_HEAD_SCRIPT;
    case 'clone':
      return CLONE_SCRIPT;
    case 'checkout':
      return CHECKOUT_SCRIPT;
  }
}

/**
 * Runs the three steps in order, stopping at the first failure. Never throws
 * for a git failure: a rejected clone is part of the answer, exactly as it is
 * for session setup.
 */
export async function runPrCheckout(
  exec: SessionExecutor,
  container: string,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const run = (step: CheckoutStep): Promise<ExecOutput> =>
    exec.runExec(container, checkoutExecSpec(checkoutScript(step), input), input.timeoutMs);

  const check = await run('check-head');
  if (check.timedOut) return timedOut('check-head', input, check);
  if (check.exitCode === LS_REMOTE_NO_MATCH) {
    return {
      ok: false,
      code: 'head_branch_missing',
      message:
        `The branch "${input.headBranch}" is no longer on the remote. ` +
        'The pull request may have been merged or its branch deleted.',
      stderr: output(check),
      headSha: null,
    };
  }
  if (check.exitCode !== 0) {
    return {
      ok: false,
      code: 'remote_unreachable',
      message:
        `Could not read the branches of ${input.repoUrl} (git exited ${String(check.exitCode)}). ` +
        'Check the repository URL and that its deploy key is installed on the remote.',
      stderr: output(check),
      headSha: null,
    };
  }

  const clone = await run('clone');
  if (clone.timedOut) return timedOut('clone', input, clone);
  if (clone.exitCode !== 0) {
    return {
      ok: false,
      code: 'clone_failed',
      message: `Cloning ${input.repoUrl} (branch "${input.headBranch}") failed with exit code ${String(clone.exitCode)}.`,
      stderr: output(clone),
      headSha: null,
    };
  }

  const checkout = await run('checkout');
  if (checkout.timedOut) return timedOut('checkout', input, checkout);
  if (checkout.exitCode !== 0) {
    return {
      ok: false,
      code: 'checkout_failed',
      message: `Checking out "${input.headBranch}" failed with exit code ${String(checkout.exitCode)}.`,
      stderr: output(checkout),
      headSha: null,
    };
  }

  const headSha = lastLine(checkout.stdout);
  if (headSha !== input.expectedHeadSha) {
    return {
      ok: false,
      code: 'head_moved',
      message:
        `"${input.headBranch}" is now at ${short(headSha)}, but the comments were read at ` +
        `${short(input.expectedHeadSha)}. Someone pushed to the branch in between, so the ` +
        'feedback may already be out of date — start the run again to read it afresh.',
      stderr: output(checkout),
      headSha,
    };
  }

  return {
    ok: true,
    code: 'ok',
    message: `Checked out ${input.headBranch} at ${short(headSha)} in ${CONTAINER_REPO_DIR}.`,
    stderr: '',
    headSha,
  };
}

function timedOut(step: CheckoutStep, input: CheckoutInput, result: ExecOutput): CheckoutResult {
  const seconds = Math.round(input.timeoutMs / 1000);
  return {
    ok: false,
    code: 'checkout_timed_out',
    message: `The checkout timed out after ${seconds}s during the "${step}" step.`,
    stderr: output(result),
    headSha: null,
  };
}

/** `git rev-parse` prints the sha last, after whatever the fetch said. */
function lastLine(stdout: string): string | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return lines.at(-1) ?? null;
}

function short(sha: string | null): string {
  return sha === null ? 'nothing' : sha.slice(0, 7);
}

function output(result: ExecOutput): string {
  return [result.stderr, result.stdout].filter((part) => part.trim() !== '').join('\n');
}
