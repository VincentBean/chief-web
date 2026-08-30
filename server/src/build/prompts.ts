import type { ParsedPrd, PrdStory } from '../prd/index.js';
import { prdDirFor, progressPathFor } from '../prd/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';
import { AGENT_PROMPT_TEMPLATE } from './templates.js';

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

/** Learnings file next to the PRD; `{{PROGRESS_PATH}}` in chief's template. */
export function containerProgressPath(sessionName: string): string {
  return `${CONTAINER_REPO_DIR}/${progressPathFor(sessionName)}`;
}

/** How much of `progress.md` is inlined; the file itself is always readable. */
export const MAX_PROGRESS_CHARS = 20_000;

/** How much of the PRD's freeform introduction is inlined. */
export const MAX_PRD_CONTEXT_CHARS = 4000;

export interface AgentPromptInput {
  readonly sessionName: string;
  /** The story this iteration must implement. */
  readonly story: PrdStory;
  /** The parsed PRD, for its project name and freeform description. */
  readonly prd: Pick<ParsedPrd, 'project' | 'description'> | null;
  /** Contents of `progress.md`, or `null` when the file does not exist yet. */
  readonly progress: string | null;
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
  const progressPath = containerProgressPath(input.sessionName);
  const prompt = AGENT_PROMPT_TEMPLATE.replaceAll('{{PROGRESS_PATH}}', progressPath)
    .replaceAll('{{STORY_CONTEXT}}', storyContext(input.story))
    .replaceAll('{{STORY_ID}}', input.story.id)
    .replaceAll('{{STORY_TITLE}}', input.story.title);
  return prompt + addendum(input);
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
export function agentCommand(prompt: string, model?: string | null): string[] {
  // `stream-json` is what makes the live log possible: the default text format
  // prints nothing until the agent exits, which for one iteration is up to an
  // hour of silence. `--verbose` is required alongside it for `-p`, and chief
  // passes exactly the same pair.
  // `--model` is omitted entirely when none is configured; that absence is how
  // the CLI's own default is selected.
  return [
    'claude',
    ...(model == null ? [] : ['--model', model]),
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
 * follow, because the container is fresh every time.
 */
function addendum(input: AgentPromptInput): string {
  const prdPath = `${CONTAINER_REPO_DIR}/${prdDirFor(input.sessionName)}/prd.md`;
  const sections = [
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
   appended to \`${containerProgressPath(input.sessionName)}\`.

If you cannot honestly complete the story, leave its \`**Status:**\` at \`in-progress\`, commit
whatever partial work is worth keeping, and write down in \`progress.md\` what is blocking it —
the next iteration continues from there.`,
  ];

  const context = prdContext(input.prd);
  if (context !== null) {
    sections.push(`

---

## chief-web: the PRD this story belongs to

${context}`);
  }

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

function prdContext(prd: AgentPromptInput['prd']): string | null {
  if (prd === null) return null;
  const parts: string[] = [];
  if (prd.project !== null && prd.project !== '') parts.push(`**Project:** ${prd.project}`);
  if (prd.description !== null && prd.description !== '') parts.push(prd.description);
  if (parts.length === 0) return null;
  return truncate(parts.join('\n\n'), MAX_PRD_CONTEXT_CHARS);
}

/** Keeps the tail of the prompt bounded; the file itself is always readable. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n\n… (truncated; read the file itself for the rest)`;
}
