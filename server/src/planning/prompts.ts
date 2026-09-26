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
  /**
   * The session's feedback (voice feedback sessions US-001): when present the
   * conversation plans a fix for it rather than asking what to build.
   */
  readonly feedback?: string | null | undefined;
}

/** What a feedback session's context slot says instead of chief's default sentence. */
export const FEEDBACK_CONTEXT =
  'This is a feedback session: the operator reported a problem, quoted in the section ' +
  '"chief-web: this session starts from feedback" below. Plan a fix for it.';

/** The heading of the block {@link feedbackBlock} appends; present at most once in a prompt. */
export const FEEDBACK_BLOCK_HEADING = '## chief-web: this session starts from feedback';

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

/**
 * The planning prompt for `mode`, plus {@link feedbackBlock} when the session
 * has feedback — in both modes, so a conversation resumed once a PRD exists
 * still knows what it is fixing.
 */
export function planningPrompt(mode: PlanningMode, input: PlanningPromptInput): string {
  const body = mode === 'edit' ? editPlanningPrompt(input.sessionName) : initPlanningPrompt(input);
  const feedback = sessionFeedback(input);
  return feedback === null ? body : body + feedbackBlock(feedback);
}

/** The feedback as the prompt quotes it: trimmed, cut at {@link MAX_CONTEXT_LENGTH}, null when blank. */
function sessionFeedback(input: PlanningPromptInput): string | null {
  const feedback = (input.feedback ?? '').trim().slice(0, MAX_CONTEXT_LENGTH);
  return feedback === '' ? null : feedback;
}

/**
 * The feedback variant's instructions: the feedback verbatim between tags (a
 * fence could be closed by the feedback itself), then where to look, when to
 * reproduce, and the `## Feedback` section the PRD has to open with.
 */
function feedbackBlock(feedback: string): string {
  return `

---

${FEEDBACK_BLOCK_HEADING}

The operator gave this feedback, quoted verbatim between the tags:

<feedback>
${feedback}
</feedback>

Plan a fix for this feedback; do not ask the operator what they want to build.

1. Find where the feedback lives in the code: the pages, components and server code involved.
2. When a browser is available to you, reproduce the problem before writing any story: visit the
   pages involved and note exactly what you did and what you saw. Without a browser, say so and
   work from the code.
3. Ask the operator only what the feedback and the code leave open.

The PRD must contain a \`## Feedback\` section after the introduction and before the first story,
with:

- the feedback above, verbatim;
- the pages visited, as paths only (\`/settings/billing\`, never a full URL with a host, a token or
  a password — never write credentials into the PRD);
- the reproduction steps;
- what was observed.

The stories then fix what that section describes.`;
}

/**
 * `claude "<prompt>"`: the prompt is one argv element, never shell-parsed.
 * With `resumeId` it is `claude --resume <id> "<prompt>"`, continuing a
 * voice planning conversation (voice US-025); the id sits right after the
 * flag, whose value is optional.
 */
export function planningCommand(prompt: string, model?: string | null, resumeId?: string | null): string[] {
  // No `--model` at all when none is configured: an absent flag is what lets
  // Claude Code apply its own default, and there is no name that means that.
  const selected = model == null ? [] : ['--model', model];
  const resume = resumeId == null ? [] : ['--resume', resumeId];
  return ['claude', ...selected, ...resume, prompt];
}

/**
 * The first message of a planning terminal that resumes a voice planning
 * conversation: the planning prompt is already in it, only the medium changed.
 */
export const VOICE_HANDOVER_PROMPT =
  'The operator has left the voice call and continues this planning conversation here by typing. ' +
  'Their messages are no longer transcribed speech, and the voice-call rules about short spoken replies ' +
  'no longer apply; the PRD rules from the start of the conversation still do. ' +
  'In two or three sentences, recap where the conversation stands and what you need from them next.';

function planningContext(input: PlanningPromptInput): string {
  const supplied = (input.context ?? '').trim().slice(0, MAX_CONTEXT_LENGTH);
  return [
    `You are planning the chief-web session "${input.sessionName}" in the repository ` +
      `"${input.repositoryName}". The work will be built on the branch ${input.featureBranch}.`,
    '',
    supplied !== '' ? supplied : sessionFeedback(input) === null ? DEFAULT_CONTEXT : FEEDBACK_CONTEXT,
  ].join('\n');
}
