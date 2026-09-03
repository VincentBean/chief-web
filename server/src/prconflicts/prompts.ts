import { CONTAINER_REPO_DIR } from '../sessions/index.js';

/**
 * The prompt for resolving a pull request's merge conflicts (US-005).
 *
 * Shaped like `prfeedback/prompts.ts`: a brief, the work inlined, and a
 * `## chief-web:` addendum saying what the run may and may not do. The
 * prohibitions are the same ones — no commit, no rebase, no amend, no branch,
 * no push — for the same reason: everything that reaches a human's pull
 * request is chief-web's own doing, after checks the agent cannot skip.
 *
 * What is new here is the standard the resolution is held to. A merge conflict
 * has no "right answer" in the diff; it has two intents that both have to
 * survive. So the agent is given the pull request's title and description as
 * well as the files, because the description is very often the only place the
 * point of the change is written down.
 */

/** How much of a pull request description is worth inlining. */
const MAX_BODY_CHARS = 4000;

export interface ConflictPromptInput {
  readonly slug: string;
  readonly number: number;
  readonly title: string;
  /** The pull request's description; empty when it has none. */
  readonly body: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  /** The paths git stopped on: the only ones that may be touched. */
  readonly files: readonly string[];
  /**
   * How long the agent has before it is cut short. Told to it for the same
   * reason the build prompt tells it: chief-web can enforce a deadline but it
   * cannot make one arrive early.
   */
  readonly timeoutMs: number;
}

/** The budget as the agent should read it: whole minutes, never "1800000ms". */
function minutes(timeoutMs: number): string {
  const whole = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${String(whole)} minute${whole === 1 ? '' : 's'}`;
}

/** The pull request's description, trimmed, or a line saying it has none. */
export function descriptionOf(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') return '_The pull request has no description._';
  return trimmed.length > MAX_BODY_CHARS
    ? `${trimmed.slice(0, MAX_BODY_CHARS)}\n\n… (description truncated)`
    : trimmed;
}

/** The whole prompt: the conflict, the pull request's purpose, and the rules. */
export function conflictResolutionPrompt(input: ConflictPromptInput): string {
  const files = input.files.map((file) => `- \`${file}\``).join('\n');

  return `# Merge conflicts on ${input.slug}#${String(input.number)}

You are an autonomous coding agent resolving merge conflicts on an open pull
request. Its branch, \`${input.headBranch}\`, is checked out in
\`${CONTAINER_REPO_DIR}\`, and \`origin/${input.baseBranch}\` has just been
merged into it. Git stopped part-way: the files below are in the working tree
with conflict markers in them, and the merge is waiting for you to finish it.

## The pull request

**${input.title}**

${descriptionOf(input.body)}

## The conflicted files

${files}

## What resolving means here

Both sides are right about something. \`${input.baseBranch}\` moved on for a
reason, and this pull request was opened for a reason — the one written above.
A resolution keeps both intents: read the surrounding code, work out what each
side was trying to do, and write the version that does both. Deleting one
side's work to make the markers go away is the one outcome that is worse than
leaving the conflict.

You have **${minutes(input.timeoutMs)}**. Spend it on the conflicted files and
the code immediately around them; you do not need to run the project's whole
test suite to merge two hunks.

## chief-web: what this run may and may not do

chief-web reads the working tree when you are done, and nothing else. Nothing
you say in your reply is read.

1. **Edit only the conflicted files listed above.** They are the whole of the
   job. A change to any other file is not part of this merge and would be
   pushed onto a human's pull request under a merge commit's message.
2. Remove every conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) from
   those files, leaving code that a person would have written.
3. **Do not commit, do not \`git add\`, do not rebase, do not amend, do not
   create or switch branches, and do not push.** chief-web stages the files,
   makes the merge commit and pushes it, after checking your work — that
   sequence is what keeps a broken resolution off the pull request.
4. Do not run \`git merge --abort\` or \`git reset\`. If the conflict cannot be
   resolved faithfully, leave it alone and say so; chief-web aborts the merge
   itself and nothing is pushed.
5. **Do not comment on GitHub and do not use \`gh\`.**
6. Do not touch \`.chief/\`.
`;
}
