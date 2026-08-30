import { RUNNER_WORKSPACE_DIR } from '../runner/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';

/**
 * The prompt for one pass over a pull request's review feedback (US-021).
 *
 * Shaped like `build/prompts.ts`: the work is inlined as JSON the way a story
 * is, followed by a `## chief-web:` addendum saying what must be left behind.
 * What differs is the contract at the end — a build iteration proves itself by
 * changing `prd.md`, and this one proves itself by writing a report that names
 * every comment it was given.
 */

/**
 * Where the agent writes its report.
 *
 * Deliberately a sibling of the clone rather than a file inside it: it can then
 * never be swept into a `git add -A` and committed onto someone else's pull
 * request, and it needs no `.git/info/exclude` entry to stay out.
 */
export const CONTAINER_OUTCOME_PATH = `${RUNNER_WORKSPACE_DIR}/feedback-outcome.json`;

/** One piece of feedback the agent is asked to deal with. */
export interface FeedbackItem {
  /**
   * The key the agent echoes back — `T1`, `R1`.
   *
   * Deliberately not the GraphQL node id, which is forty opaque characters an
   * agent will mangle. chief-web keeps the key-to-thread mapping; the agent
   * never sees an id at all, and a short key is checkable.
   */
  readonly key: string;
  readonly kind: 'thread' | 'review';
  readonly path: string | null;
  readonly line: number | null;
  readonly author: string | null;
  readonly body: string;
  readonly url: string;
  /** The diff has moved under this thread, so its line may no longer be right. */
  readonly outdated: boolean;
}

/** The feedback as JSON, the way `storyContext` inlines a story. */
export function feedbackContext(items: readonly FeedbackItem[]): string {
  return JSON.stringify(
    items.map((item) => ({
      key: item.key,
      kind: item.kind,
      file: item.path,
      line: item.line,
      author: item.author,
      outdated: item.outdated,
      comment: item.body,
      url: item.url,
    })),
    null,
    2,
  );
}

/** The commit every pass makes, so the history says what the change was for. */
export function feedbackCommitMessage(number: number): string {
  return `fix: address review feedback on #${String(number)}`;
}

export interface PrFeedbackPromptInput {
  readonly slug: string;
  readonly number: number;
  readonly title: string;
  readonly headBranch: string;
  readonly items: readonly FeedbackItem[];
}

/** The whole prompt: the brief, the feedback, and what to leave behind. */
export function prFeedbackPrompt(input: PrFeedbackPromptInput): string {
  const commitMessage = feedbackCommitMessage(input.number);

  return `# Review feedback on ${input.slug}#${String(input.number)}

You are an autonomous coding agent working on a pull request that has been
reviewed. The pull request is "${input.title}" and its branch,
\`${input.headBranch}\`, is already checked out in \`${CONTAINER_REPO_DIR}\`.

Below is every unresolved comment on it. Work through them: read the code each
one points at, decide whether it is right, and make the change if it is.

## The feedback

\`\`\`json
${feedbackContext(input.items)}
\`\`\`

## chief-web: what this run has to leave behind

chief-web reads three things when you are done, and nothing else: the git
history, \`${CONTAINER_OUTCOME_PATH}\`, and what \`origin\` has after chief-web
pushes. Nothing you say in your reply is read.

1. Work on the branch that is already checked out (\`${input.headBranch}\`). Do
   not create a branch, do not rebase, do not amend, and **do not push** —
   chief-web pushes.
2. Make **one** commit, with exactly this message:
   \`${commitMessage}\`
3. **Do not reply on GitHub and do not use \`gh\`.** chief-web posts every reply
   and resolves every thread itself, after the push has landed, so that a reply
   can never claim a fix that is not on the remote.
4. Do not touch \`.chief/\`.
5. **Last, after the commit**, write \`${CONTAINER_OUTCOME_PATH}\` with exactly
   this shape:

\`\`\`json
{
  "addressed": [
    { "key": "T1", "summary": "one sentence, past tense, saying what changed" }
  ],
  "skipped": [
    { "key": "T2", "reason": "one sentence saying why nothing changed" }
  ]
}
\`\`\`

6. Every key above must appear exactly once, in exactly one of the two lists. A
   key you leave out is treated as skipped with no reason given, which is the
   least useful of the three outcomes for whoever reads the pull request.
7. **Skipping is a good outcome.** If a comment is wrong, or asks for a decision
   a person has to make, or points at code that is no longer on this branch,
   skip it and say why. chief-web posts your reason as the reply and leaves the
   thread open for a human. Do not invent a change just to have addressed
   something.
8. If you address nothing at all, make no commit — an empty commit is worse than
   none — and still write the report with every key under \`skipped\`.
`;
}
