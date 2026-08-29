import { prdDirFor } from '../prd/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';
import { EDIT_PROMPT_TEMPLATE, INIT_PROMPT_TEMPLATE } from './templates.js';

/**
 * The prompt the planning terminal starts `claude` with (US-011).
 *
 * `chief new` runs `claude "<init prompt>"` in the repository, and `chief edit`
 * runs `claude "<edit prompt>"` once a `prd.md` exists. chief-web does the same
 * thing in the session container, so the conversation — clarifying questions
 * with lettered options, then a PRD in chief's exact format — is identical.
 */

/** Which of chief's two prompts a planning terminal was started with. */
export type PlanningMode = 'create' | 'edit';

/** chief's own wording when `chief new` is given no context argument. */
export const DEFAULT_CONTEXT = 'No additional context provided. Ask the user what they want to build.';

/** How much operator-supplied context is passed through to the agent. */
export const MAX_CONTEXT_LENGTH = 4000;

/**
 * The absolute PRD directory *inside* the container, which is what the prompt
 * has to name: the agent's working directory is the clone, but chief passes an
 * absolute path and an absolute one cannot be misread.
 */
export function containerPrdDir(sessionName: string): string {
  return `${CONTAINER_REPO_DIR}/${prdDirFor(sessionName)}`;
}

export interface PlanningPromptInput {
  readonly sessionName: string;
  readonly featureBranch: string;
  readonly repositoryName: string;
  /** Free text from the operator describing what should be built. */
  readonly context?: string | undefined;
}

/**
 * chief's init prompt with the PRD directory and context substituted.
 *
 * The context slot is chief's own extension point, so the session's identity
 * goes there rather than into the body of the prompt: the agent is told which
 * session and branch it is planning for, followed by whatever the operator
 * typed (or chief's default sentence when they typed nothing).
 */
export function initPlanningPrompt(input: PlanningPromptInput): string {
  const prompt = INIT_PROMPT_TEMPLATE.replaceAll(
    '{{PRD_DIR}}',
    containerPrdDir(input.sessionName),
  ).replaceAll('{{CONTEXT}}', planningContext(input));
  return prompt + formatRules(input.sessionName);
}

/** chief's edit prompt, used once `prd.md` exists. */
export function editPlanningPrompt(sessionName: string): string {
  return (
    EDIT_PROMPT_TEMPLATE.replaceAll('{{PRD_DIR}}', containerPrdDir(sessionName)) +
    formatRules(sessionName)
  );
}

/**
 * The one thing chief's own prompts leave implicit: the `**Status:**` line.
 *
 * chief writes statuses itself when it converts a PRD, so its prompts never
 * mention them. chief-web reads `prd.md` as written — the parser in `prd/` is
 * the only thing standing between planning and the build loop — so the exact
 * shape of a story is spelled out here, on top of the ported prompt rather than
 * inside it, which keeps the ported text comparable with chief's.
 */
function formatRules(sessionName: string): string {
  return `

---

## chief-web: the exact story format

chief-web parses \`${containerPrdDir(sessionName)}/prd.md\` itself, so every user story must be
written exactly like this, with no extra fields between the heading and the criteria:

\`\`\`markdown
### US-001: Short title
**Status:** todo
**Priority:** 1
**Description:** As a <user>, I want <feature> so that <benefit>.

**Acceptance Criteria:**
- [ ] A specific, verifiable criterion
- [ ] Typecheck passes
\`\`\`

Rules chief-web enforces when it reads the file:

- Story headings are \`### US-xxx: Title\` with a three-digit, unique id. Never renumber an id that
  is already in the file.
- \`**Status:**\` is one of \`todo\`, \`in-progress\` or \`done\`. Write \`todo\` for every new story.
- \`**Priority:**\` is a number greater than 0, lowest first, and no two stories share one.
- Acceptance criteria are checkboxes — \`- [ ]\` for outstanding, \`- [x]\` for already done — and
  every story needs at least one.
- Write only the PRD. Do not create, edit or delete any other file in the repository.`;
}

export function planningPrompt(mode: PlanningMode, input: PlanningPromptInput): string {
  return mode === 'edit' ? editPlanningPrompt(input.sessionName) : initPlanningPrompt(input);
}

/** `claude "<prompt>"`: the prompt is one argv element, never shell-parsed. */
export function planningCommand(prompt: string): string[] {
  return ['claude', prompt];
}

function planningContext(input: PlanningPromptInput): string {
  const supplied = (input.context ?? '').trim().slice(0, MAX_CONTEXT_LENGTH);
  return [
    `You are planning the chief-web session "${input.sessionName}" in the repository ` +
      `"${input.repositoryName}". The work will be built on the branch ${input.featureBranch}.`,
    '',
    supplied === '' ? DEFAULT_CONTEXT : supplied,
  ].join('\n');
}
