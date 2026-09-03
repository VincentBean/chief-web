import { RUNNER_WORKSPACE_DIR } from '../runner/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';

/**
 * The prompt for the one headless pass that reviews a session's pull request
 * (US-007).
 *
 * Shaped like `prfeedback/prompts.ts`: a brief, then a `## chief-web:` section
 * saying what has to be left behind. The contract is narrower than either of
 * the other two agents' — this one may not change a single file. It reads the
 * diff the pull request proposes and writes findings; chief-web is what posts
 * them (US-008), so an agent that "fixed" something instead would be changing
 * a branch a human is already looking at.
 */

/**
 * Where the agent writes its findings.
 *
 * A sibling of the clone, like the feedback report, so it can never be swept
 * into a `git add -A` and committed onto the pull request it is reviewing, and
 * so chief-web reads it off the data volume rather than through a second exec.
 */
export const CONTAINER_FINDINGS_PATH = `${RUNNER_WORKSPACE_DIR}/review-findings.json`;

export interface ReviewPromptInput {
  /** The branch the pull request merges *into*; the left side of the diff. */
  readonly targetBranch: string;
  /** The session's branch, already checked out in the clone. */
  readonly featureBranch: string;
  /**
   * How long the pass has before it is cut short.
   *
   * Told to the agent for the same reason the build and feedback prompts tell
   * it: chief-web can enforce a deadline but it cannot make one arrive early,
   * and a review that spent its budget reading the whole repository leaves
   * nothing behind at all.
   */
  readonly timeoutMs: number;
}

/** The budget as the agent should read it: whole minutes, never "1800000ms". */
function minutes(timeoutMs: number): string {
  const whole = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${String(whole)} minute${whole === 1 ? '' : 's'}`;
}

/** The whole prompt: what to review, what counts as a finding, what to write. */
export function reviewPrompt(input: ReviewPromptInput): string {
  return `# Code review of \`${input.featureBranch}\`

You are reviewing a pull request. Its branch, \`${input.featureBranch}\`, is
already checked out in \`${CONTAINER_REPO_DIR}\`, and it is proposed for merge
into \`${input.targetBranch}\`.

Review **only the diff between the two branches** — the code that is already on
\`${input.targetBranch}\` is not under review, however much you disagree with
it. Start by reading the change:

\`\`\`sh
git fetch --quiet origin ${input.targetBranch}
git diff origin/${input.targetBranch}...HEAD
\`\`\`

Read the surrounding files where the diff alone does not tell you whether the
change is correct — a hunk that looks wrong in isolation is usually the one
that needs the rest of the file before you can say so.

## What to report

Two kinds of thing, and nothing else:

1. **Correctness bugs** — the change does something other than what it plainly
   intends: a wrong condition, an unhandled case that will be hit, a value that
   cannot be what the code assumes, a resource left open, a race.
2. **Clear quality issues** — duplication of something that already exists in
   this repository, dead or unreachable code, an error swallowed silently, a
   name or an abstraction that will actively mislead the next reader.

Leave everything else out. Style opinions, alternative designs you happen to
prefer, "consider adding a test" on code that is already tested, and praise are
all noise on a pull request, and each one makes the findings that matter harder
to find. **No findings at all is a good and common outcome** — say so in the
summary and write an empty list. Do not pad the list to look thorough.

You have **${minutes(input.timeoutMs)}**. Spend it on the diff.

## chief-web: what this pass has to leave behind

chief-web reads exactly one thing when you are done: the JSON document at
\`${CONTAINER_FINDINGS_PATH}\`. Nothing you say in your reply is read.

1. **Change nothing.** Do not edit a file, do not commit, do not push, do not
   run \`gh\`, and do not comment on GitHub yourself. chief-web posts your
   findings. This is a review, and the branch belongs to someone else.
2. Write \`${CONTAINER_FINDINGS_PATH}\` with exactly this shape, and nothing
   around it:

\`\`\`json
{
  "summary": "one short paragraph on the change as a whole",
  "findings": [
    {
      "path": "src/example.ts",
      "line": 42,
      "body": "What is wrong, and why it matters. One or two sentences."
    }
  ]
}
\`\`\`

3. \`path\` is the file's path **relative to the repository root**, exactly as
   \`git diff\` names it on the right-hand side.
4. \`line\` is a line number **in the new version of that file**, and it must be
   a line the diff actually touches. chief-web anchors your comment to that
   line on the pull request, and a line outside the diff cannot be commented
   on — the finding is dropped instead of posted.
5. \`body\` is the comment as a person will read it on GitHub. Markdown is fine.
   Say what is wrong and why; a suggested fix is welcome but the finding has to
   stand without it.
6. \`summary\` is always required, including when \`findings\` is empty. It is
   posted as the review's own comment.
7. The file must be valid JSON of that shape. chief-web will not post anything
   it cannot parse, so a pass that wrote prose, or wrapped the document in
   commentary, is a pass that reviewed nothing.
`;
}
