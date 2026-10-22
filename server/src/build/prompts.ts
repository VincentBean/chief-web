import path from 'node:path';

import type { ParsedPrd, PrdStory } from '../prd/index.js';
import { prdDirFor, prdPathFor, progressPathFor, screenshotsDirFor } from '../prd/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';
import { AGENT_PROMPT_TEMPLATE, DEPENDENCY_ANALYSIS_PROMPT_TEMPLATE } from './templates.js';

/**
 * The prompt one iteration of the Ralph loop starts `claude -p` with (US-013).
 *
 * chief builds it from `embed/prompt.txt` with the next story inlined as JSON,
 * so the agent never has to read (or misread) the whole PRD. chief-web does the
 * same, and adds two things chief gets for free from running on the developer's
 * own machine: the PRD's freeform context, and the current `progress.md` — the
 * agent is in a container it has never seen before, so the accumulated
 * learnings are handed to it rather than left to be discovered.
 *
 * The addendum sits *after* the ported prompt rather than inside it, exactly as
 * the planning prompts do, which keeps the ported text comparable with chief's.
 */

/**
 * Learnings file next to the PRD; `{{PROGRESS_PATH}}` in chief's template. In
 * the clone, or in the story worktree at `root` (async stories US-006).
 */
export function containerProgressPath(sessionName: string, root: string = CONTAINER_REPO_DIR): string {
  return `${root}/${progressPathFor(sessionName)}`;
}

/** How much of `progress.md` is inlined; the file itself is always readable. */
export const MAX_PROGRESS_CHARS = 20_000;

/** How much of the PRD's freeform introduction is inlined. */
export const MAX_PRD_CONTEXT_CHARS = 4000;

export interface AgentPromptInput {
  readonly sessionName: string;
  /** The story this iteration must implement. */
  readonly story: PrdStory;
  /**
   * How long this iteration has before it is cut short.
   *
   * The agent is told, because it is the only one of the two who can do
   * anything about it: chief-web can stop an iteration at the deadline but it
   * cannot make one arrive early, and an agent that does not know it is on a
   * clock spends it like there is no clock — a full-suite run started at the
   * twenty-fifth minute is a whole iteration thrown away, and the loop reads
   * the result as a story that made no progress.
   */
  readonly timeoutMs: number;
  /** The parsed PRD, for its project name and freeform description. */
  readonly prd: Pick<ParsedPrd, 'project' | 'description'> | null;
  /** Contents of `progress.md`, or `null` when the file does not exist yet. */
  readonly progress: string | null;
  /**
   * Whether this iteration has `ask_operator` (decisions US-003).
   *
   * The section describing it is only added when the tool is actually on the
   * argv: a prompt that tells an agent to call a tool it does not have costs
   * it a turn discovering that, and the whole point of the rules below is to
   * keep it from burning the iteration on things that are not the story.
   */
  readonly canAsk?: boolean;
  /**
   * The story's own worktree and branch, when it runs in one (async stories
   * US-006). Every path the prompt names is then the worktree's, and the agent
   * is told to commit there; absent, it works in `/workspace/repo` as always.
   */
  readonly worktree?: { readonly dir: string; readonly branch: string } | null;
}

/**
 * chief's story JSON: the same field names its own agents see, so a prompt
 * built here is interchangeable with one built by `chief run`.
 */
export function storyContext(story: PrdStory): string {
  return JSON.stringify(
    {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria.map((criterion) => criterion.text),
      priority: story.priority,
      passes: story.status === 'done',
    },
    null,
    2,
  );
}

/** chief's `GetPrompt` plus the chief-web addendum. */
export function agentPrompt(input: AgentPromptInput): string {
  const progressPath = containerProgressPath(input.sessionName, rootOf(input));
  const prompt = AGENT_PROMPT_TEMPLATE.replaceAll('{{PROGRESS_PATH}}', progressPath)
    .replaceAll('{{STORY_CONTEXT}}', storyContext(input.story))
    .replaceAll('{{STORY_ID}}', input.story.id)
    .replaceAll('{{STORY_TITLE}}', input.story.title);
  return prompt + addendum(input);
}

export interface DependencyAnalysisPromptInput {
  readonly sessionName: string;
  /** The whole of `prd.md`, as it is on disk. */
  readonly prd: string;
  /** Every story id in the PRD, in priority order. */
  readonly storyIds: readonly string[];
}

/**
 * The prompt of the dependency-analysis agent (async stories US-005). The PRD
 * goes in last and through a replacer function, so nothing in it — a `{{…}}`
 * or a `$&` — is ever read as a placeholder or a replacement pattern.
 */
export function dependencyAnalysisPrompt(input: DependencyAnalysisPromptInput): string {
  const ids = input.storyIds.map((id) => `\`${id}\``).join(', ');
  return DEPENDENCY_ANALYSIS_PROMPT_TEMPLATE.replaceAll('{{REPO_DIR}}', () => CONTAINER_REPO_DIR)
    .replaceAll('{{PRD_PATH}}', () => `${CONTAINER_REPO_DIR}/${prdPathFor(input.sessionName)}`)
    .replaceAll('{{STORY_IDS}}', () => ids)
    .replace('{{PRD}}', () => input.prd.trim());
}

/**
 * `claude -p "<prompt>"` in headless mode.
 *
 * The prompt is one argv element, never shell-parsed, and permissions are
 * skipped because there is no one to answer a prompt: the agent runs
 * unattended, as uid 1000, in a throwaway container whose only mounts are this
 * session's workspace and the shared credentials — which is exactly the
 * isolation that makes skipping them safe, and what chief's own loop does.
 */
export function agentCommand(
  prompt: string,
  model?: string | null,
  advisor?: string | null,
  effort?: string | null,
  mcpConfigFile?: string | null,
): string[] {
  // `stream-json` is what makes the live log possible: the default text format
  // prints nothing until the agent exits, which for one iteration is up to an
  // hour of silence. `--verbose` is required alongside it for `-p`, and chief
  // passes exactly the same pair.
  // `--model` is omitted entirely when none is configured; that absence is how
  // the CLI's own default is selected. `--advisor` follows the same rule and
  // sits right after it: the pair reads as one choice, and no advisor at all
  // is the only way to launch the iteration the way it is launched today —
  // the flag is never passed bare and never passed with an empty value.
  // `--effort` follows the pair under the same rule: no effort is today's argv.
  // `--mcp-config` is the iteration's one MCP server (decisions US-003), and
  // is variadic (`<configs...>`), so it sits immediately before another flag.
  // Absent, the iteration is launched exactly as it was before decisions
  // existed and `ask_operator` is not a tool the agent has.
  return [
    'claude',
    ...(model == null ? [] : ['--model', model]),
    ...(advisor == null || advisor === '' ? [] : ['--advisor', advisor]),
    ...(effort == null || effort === '' ? [] : ['--effort', effort]),
    ...(mcpConfigFile == null || mcpConfigFile === '' ? [] : ['--mcp-config', mcpConfigFile]),
    '--dangerously-skip-permissions',
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    prompt,
  ];
}

/**
 * What chief's prompt leaves to chief itself.
 *
 * chief writes `**Status:**` and ticks the acceptance criteria in `prd.md` from
 * Go after each iteration; chief-web reads that file as the agent leaves it —
 * the parser in `prd/` is the only thing that says whether a story is done — so
 * the agent is told to keep it up to date. The PRD context and `progress.md`
 * follow, because the container is fresh every time. A feedback session's
 * screenshots (voice feedback US-011) are named so no story's cleanup takes them.
 */
function addendum(input: AgentPromptInput): string {
  const root = rootOf(input);
  const prdPath = `${root}/${prdDirFor(input.sessionName)}/prd.md`;
  const screenshotsPath = `${root}/${screenshotsDirFor(input.sessionName)}`;
  const sections: string[] = [];
  if (input.worktree != null) sections.push(worktreeSection(input.worktree));
  sections.push(
    `

---

## chief-web: finishing the story

chief-web reads \`${prdPath}\` after every iteration; that file, and the git history, are the
only evidence it has that anything happened. Before you finish, all four of these must be true:

1. The story is implemented and the project's quality checks pass.
2. The work is committed with the message \`feat: ${input.story.id} - ${input.story.title}\`.
3. In \`${prdPath}\`, the \`**Status:**\` line of \`${input.story.id}\` reads \`done\` and every
   acceptance criterion of that story is checked off (\`- [x]\`). Change nothing else in the file:
   do not renumber ids, reorder stories, or touch another story's status.
4. A dated entry for ${input.story.id}, including its **Learnings for future iterations**, is
   appended to \`${containerProgressPath(input.sessionName, root)}\`.

If you cannot honestly complete the story, leave its \`**Status:**\` at \`in-progress\`, commit
whatever partial work is worth keeping, and write down in \`progress.md\` what is blocking it —
the next iteration continues from there.

When \`prd.md\` has a \`## Feedback\` section, read it: it says what was wrong and how to reproduce it,
and the screenshots it links are in \`${screenshotsPath}/\`. Leave that directory as it is — never
delete, move or commit it, and never run \`git clean\`, \`git stash -u\` or anything else that
sweeps untracked files in this clone: the screenshots stay there for the stories after yours and
for the review.

### You are on a clock

This iteration has **${minutes(input.timeoutMs)}**. When that runs out you are stopped where you
stand, and an iteration that had to be stopped counts as a failed attempt even if it committed
something — three of those in a row end the whole run. So:

- Run the tests that cover what you changed. A full-suite run late in the iteration is how the
  budget gets spent on finding out that nothing you touched was broken.
- Commit as soon as the story is actually done, rather than leaving the commit until after one
  last sweep of the suite. The commit is the only part of your work that survives being stopped.
- If the budget is nearly gone, spend what is left on points 2 to 4 above — a committed
  half-story the next iteration can pick up is worth more than a finished one nobody recorded.`,
  );

  const context = prdContext(input.prd);
  if (context !== null) {
    sections.push(`

---

## chief-web: the PRD this story belongs to

${context}`);
  }

  if (input.canAsk === true) sections.push(askSection());

  const progress = (input.progress ?? '').trim();
  sections.push(`

---

## chief-web: ${progressPathFor(input.sessionName)}

${
  progress === ''
    ? 'This file does not exist yet — you are the first iteration. Create it, and start it with a `## Codebase Patterns` section.'
    : `The learnings of the previous iterations, inlined so you do not have to go looking for them.\n\n${truncate(progress, MAX_PROGRESS_CHARS)}`
}`);

  return sections.join('');
}

/**
 * When to stop and ask (decisions US-003).
 *
 * The tool's own description says what it is for; this says when an iteration
 * should reach for it, which is a different question and the one that decides
 * whether the feature helps or hurts. Two failure modes are worth more than
 * the words it takes to prevent them: an agent that asks instead of reading
 * the code turns a build into a chat, and an agent that never asks guesses at
 * a decision that was not its to make and throws a story's work away. So the
 * bar is named explicitly, and so is the cost of waiting — which is nothing,
 * because the clock stops.
 */
function askSection(): string {
  return `

---

## chief-web: when you need a decision

You have one tool for this: \`ask_operator\`. It puts your question in front of the operator and
waits for their answer, and the iteration's clock is stopped for as long as it waits — a question
costs you no part of your budget, however long it takes to answer.

Ask when, and only when, **a decision is genuinely not yours to make**:

- the PRD and the code leave a product question open, and the two readings lead to different work;
- two designs are both defensible and the choice is not reversible in a later story;
- doing the story properly needs something outside its scope (a schema change, a new dependency,
  touching a module the PRD never mentions);
- what you found contradicts the story — the behaviour it asks for is already there, or cannot
  work as written.

Do not ask for anything you can settle yourself. Read the code, the PRD, \`progress.md\` and the
git history first; a question whose answer is in the repository is a question that wastes an
operator's attention and your own turn. Never ask for permission to proceed, for a review of work
you have already done, or for help with an error — those are yours. One question per call, and
only while you are actually blocked on it.

When you ask: say in one or two sentences what you have established, offer the concrete options
you can see, and recommend one. If nobody answers, you are told so — then take the most
conservative option, write the question and the choice you made under \`## Open Questions\` in the
PRD and in your \`progress.md\` entry, and finish the story on that basis.`;
}

/** Where this agent works: its story worktree, or the clone. */
function rootOf(input: AgentPromptInput): string {
  return input.worktree?.dir ?? CONTAINER_REPO_DIR;
}

/**
 * Where a parallel story works (async stories US-006). Other agents are busy
 * in `/workspace/repo` and in worktrees of their own at the same time, so the
 * agent is told plainly that its checkout, and its branch, are the only ones
 * that are its to change. chief-web merges the branch back itself.
 */
function worktreeSection(worktree: NonNullable<AgentPromptInput['worktree']>): string {
  return `

---

## chief-web: your worktree

Other stories of this PRD are being built at the same time, each in a checkout of its own. Yours
is the git worktree at \`${worktree.dir}\`, on the branch \`${worktree.branch}\`:

- Work in \`${worktree.dir}\` only, and commit there, on \`${worktree.branch}\`. Do not switch branches, and
  do not merge, rebase or push — chief-web merges your branch into the session branch when you
  are done.
- Never change anything in \`${CONTAINER_REPO_DIR}\` or in another story's worktree under
  \`${path.posix.dirname(worktree.dir)}/\`.
- The \`prd.md\` and \`progress.md\` to update are the copies in your worktree, at the paths below.`;
}

function prdContext(prd: AgentPromptInput['prd']): string | null {
  if (prd === null) return null;
  const parts: string[] = [];
  if (prd.project !== null && prd.project !== '') parts.push(`**Project:** ${prd.project}`);
  if (prd.description !== null && prd.description !== '') parts.push(prd.description);
  if (parts.length === 0) return null;
  return truncate(parts.join('\n\n'), MAX_PRD_CONTEXT_CHARS);
}

/** The budget as the agent should read it: whole minutes, never "1800000ms". */
function minutes(timeoutMs: number): string {
  const whole = Math.max(1, Math.round(timeoutMs / 60_000));
  return `${String(whole)} minute${whole === 1 ? '' : 's'}`;
}

/** Keeps the tail of the prompt bounded; the file itself is always readable. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n… (truncated; read the file itself for the rest)`;
}

export interface StoryConflictPromptInput {
  readonly storyId: string;
  readonly title: string;
  /** The story's description from `prd.md`; empty when it has none. */
  readonly description: string;
  /** The story branch being merged into the session branch. */
  readonly storyBranch: string;
  /** The paths git stopped on: the only ones that may be touched. */
  readonly files: readonly string[];
  readonly timeoutMs: number;
}

/** First line of {@link storyConflictPrompt}; how a log or a test tells it apart. */
export const STORY_CONFLICT_PROMPT_HEADING = '# Merge conflicts merging';

/**
 * The prompt for resolving a finished story's merge conflicts in the clone
 * (async stories US-008), in the style of `prconflicts/prompts.ts`: the
 * conflict, what the story was for, and what the run may and may not do. The
 * agent only edits files; chief-web stages, checks and commits the merge with
 * `verifyResolution`, and aborts it when the check fails.
 */
export function storyConflictPrompt(input: StoryConflictPromptInput): string {
  const files = input.files.map((file) => `- \`${file}\``).join('\n');
  const description = input.description.trim() === '' ? '_The story has no description._' : input.description.trim();

  return `${STORY_CONFLICT_PROMPT_HEADING} ${input.storyId}

You are an autonomous coding agent resolving merge conflicts. Several stories of one PRD are
built at the same time, each on a branch of its own. ${input.storyId} is finished, and its
branch, \`${input.storyBranch}\`, has just been merged into the session branch checked out in
\`${CONTAINER_REPO_DIR}\`. Git stopped part-way: the files below are in the working tree with
conflict markers in them, and the merge is waiting for you to finish it.

## The story being merged

**${input.storyId}: ${input.title}**

${description}

## The conflicted files

${files}

## What resolving means here

Both sides are right about something. The session branch moved on because other stories were
merged into it while ${input.storyId} was being built, and ${input.storyId} was built for the
reason written above. A resolution keeps both: read the surrounding code, work out what each side
was trying to do, and write the version that does both. Deleting one side's work to make the
markers go away is the one outcome that is worse than leaving the conflict.

You have **${minutes(input.timeoutMs)}**. Spend it on the conflicted files and the code
immediately around them; you do not need to run the project's whole test suite to merge two hunks.

## chief-web: what this run may and may not do

chief-web reads the working tree when you are done, and nothing else. Nothing you say in your
reply is read.

1. **Edit only the conflicted files listed above**, in \`${CONTAINER_REPO_DIR}\`. They are the
   whole of the job.
2. Remove every conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) from those files, leaving
   code that a person would have written.
3. **Do not commit, do not \`git add\`, do not rebase, do not amend, do not create or switch
   branches, and do not push.** chief-web stages the files and makes the merge commit itself,
   after checking your work.
4. Do not run \`git merge --abort\` or \`git reset\`. If the conflict cannot be resolved
   faithfully, leave it alone and say so; chief-web aborts the merge itself and the story is
   built again on the updated branch.
5. Do not touch \`.chief/\`, and do not touch another story's worktree.
`;
}
