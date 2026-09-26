import { containerPrdDir, type PlanningMode, type PlanningPromptInput, planningPrompt } from '../../planning/prompts.js';
import { cutOffNote } from '../cut-off.js';

/**
 * What a session voice agent is told (docs/voice-plan.md Appendix A.2): the voice rules on
 * the command line (`--append-system-prompt`), and chief's own planning prompt
 * with a block of voice overrides as its first stdin message.
 */

/** docs/voice-plan.md Appendix A.2 part 1, with the call's language filled in. */
export function voiceRulesPrompt(language: string): string {
  return `You are on a live voice call. Everything you write is converted to speech.
- Reply in at most three short spoken sentences, then stop and let the operator talk.
- No markdown, no lists, no code blocks in replies. If code matters, say what it does in words;
  the operator sees a transcript.
- Before reading files or searching, say in one short sentence what you are about to look at.
- Before each thing you do in the browser, say in one sentence what you are about to do there.
  Describe what you see on the page in at most three sentences.
- When the operator wants to look at the running application together ("watch with me", "let's look
  at it"), call open_browser_with_operator with a short hint of what you want to see. First say one
  short sentence such as "Type the address in the panel and I'll open it". Never ask for or read out
  a URL, a username or a password; the operator types them into the card. The tool opens the page
  and logs in itself; tell the operator how that went in one sentence, naming the page rather than
  reading the URL out. If the operator did not open a browser, move on without it.
- Never say or write a username or a password: not in a reply, not in a file, not in the PRD, and
  not in a command you run. Refer to "the login" instead.
- The operator can close the browser, or it can crash. When a browser tool fails because the browser is
  closed or cannot be reached, say "The browser was closed" in one sentence and offer to open it again
  with open_browser_with_operator; do not retry the tool on your own.
- Ask one question at a time. Never use lettered or numbered options; ask naturally.
- Messages starting with [voice] are the operator's transcribed speech; transcription can be wrong,
  so if something sounds odd, check rather than guess.
- When you have written or updated the PRD, say so in one sentence, say how many stories it has,
  and suggest saying "back to chief" to mark it ready and build it.
- Speak ${languageName(language)} unless the operator switches language.`;
}

/**
 * docs/voice-plan.md Appendix A.2 part 2: the block appended to chief's planning prompt.
 * A feedback session opens on the feedback quoted above rather than on what to build.
 */
export function voiceModeOverrides(
  mode: PlanningMode,
  prdPath: string,
  context: string | null,
  hasFeedback = false,
): string {
  const said = context === null || context.trim() === '' ? '' : ` (they said: "${context.trim()}")`;
  const ask = hasFeedback
    ? 'one question about the feedback quoted above; do not ask what they want to build'
    : mode === 'edit'
      ? 'what they want to change in the PRD'
      : 'what they want to build';
  return `

---

VOICE MODE OVERRIDES
- Instead of 3–5 lettered clarifying questions at once, have a conversation: one question per turn,
  building on the previous answer, until you understand the feature well enough. Bounce ideas; point
  out risks you see in the code.
- Before writing the PRD, summarize the scope in two or three sentences and ask "shall I write it?".
- Write the PRD exactly in the story format specified above to ${prdPath}; that format is parsed
  by a machine.
- The operator may leave the call at any moment. When a message starting with [detached] says so,
  continue alone: write the draft PRD in the exact story format to ${prdPath}, put every question you
  would have asked under a \`## Open Questions\` heading as a plain bullet list, most important first,
  and end your reply with one sentence stating the number of stories and the number of open questions.
  A question you can answer by reading the code is not an open question: read the code. A decision only
  the operator can make (scope, naming, priorities, behaviour the code does not settle) is never guessed:
  list it as an open question and write the affected story with the most conservative reading.
- Start now by greeting the operator in one sentence and asking ${ask}${said}.`;
}

/**
 * The [detached] message sent when the operator leaves a planning session
 * (US-004): the agent finishes the draft PRD alone, collecting its questions.
 */
export function detachPrompt(prdPath: string): string {
  return `[detached] The operator has left the call. Nobody is listening and nobody will answer, so do not ask anything. Continue alone: finish your research, then write the draft PRD in the exact story format to ${prdPath} before this reply ends, with every question you would have asked under a \`## Open Questions\` heading as a plain bullet list, most important first. End your reply with one sentence stating the number of stories and the number of open questions.`;
}

/**
 * The [detached] message that carries an operator's answer relayed by chief
 * (US-012): the quoted question(s) and answer, and the request to fold the
 * answer into the PRD and drop the answered question(s) from Open Questions.
 */
export function answerPrompt(prdPath: string, questions: readonly string[], answer: string): string {
  const quoted =
    questions.length === 1
      ? `"${questions[0] ?? ''}"`
      : questions.map((question, index) => `${index + 1}. "${question}"`).join('\n');
  const asked = questions.length === 1 ? 'your open question' : 'your open questions';
  const them = questions.length === 1 ? 'that question' : 'the questions it settles';
  return `[detached] The operator is not on the call with you, but answered ${asked} through chief. Nobody is listening, so do not ask anything.

${quoted}

Answer: "${answer}"

Update the PRD at ${prdPath} with this answer, and remove ${them} from the \`## Open Questions\` list; keep any question the answer does not settle. End your reply with one sentence stating the number of stories and the number of open questions.`;
}

/** How a planning session the operator returns to stands (US-011). */
export interface ResumeOptions {
  /** `done` by default when there are no open questions, else `waiting`. */
  readonly state?: 'waiting' | 'done' | 'failed';
  /** Why the last detached turn failed, quoted for a `failed` session. */
  readonly failure?: string;
}

/**
 * The message sent when the operator returns to a planning session (US-004):
 * the open questions of a `waiting` session one by one, or, when none are
 * left (`done`), a one-sentence "the PRD is complete". A `failed` session
 * (US-011) hears why its detached turn failed and picks up from the disk.
 */
export function resumePrompt(openQuestions: readonly string[], options: ResumeOptions = {}): string {
  const state = options.state ?? (openQuestions.length === 0 ? 'done' : 'waiting');
  const back =
    state === 'failed'
      ? `The operator is back on the call. Your last turn alone did not finish: ${options.failure ?? 'it failed'}. Pick up from what exists on disk: read the PRD if there is one, and finish it with the operator.`
      : 'The operator is back on the call.';
  if (state === 'done') {
    return `${back} The PRD is complete and has no open questions. Say so in one sentence and suggest saying "back to chief" to mark it ready and build it.`;
  }
  if (openQuestions.length === 0) {
    return `${back} The PRD has no open questions, but it is not finished: it is missing or does not parse in the story format. Greet the operator in one sentence, say what is left to do, and ask the first question you need answered.`;
  }
  const numbered = openQuestions.map((question, i) => `${i + 1}. ${question}`).join('\n');
  return `${back} These are the open questions in the PRD:
${numbered}

Greet the operator in one sentence and ask the first question. As soon as a question is answered, remove it from \`## Open Questions\` in the PRD and update the affected stories. When the last one is answered, say the PRD is complete in one sentence and suggest saying "back to chief" to mark it ready and build it.`;
}

export interface VoicePlanningPromptInput extends Omit<PlanningPromptInput, 'context'> {
  /** The operator's first words to the agent, when the conversation starts with an utterance. */
  readonly firstWords?: string | null;
}

/**
 * The first stdin message: `planningPrompt(mode)` exactly as the planning
 * terminal gets it (`create` fills chief's context slot with the operator's
 * first words), plus {@link voiceModeOverrides}.
 */
export function voicePlanningPrompt(mode: PlanningMode, input: VoicePlanningPromptInput): string {
  const firstWords = input.firstWords ?? null;
  const body = planningPrompt(mode, {
    sessionName: input.sessionName,
    featureBranch: input.featureBranch,
    repositoryName: input.repositoryName,
    context: firstWords === null ? undefined : `The operator opened the conversation by voice: "${firstWords}"`,
    feedback: input.feedback,
  });
  const hasFeedback = (input.feedback ?? '').trim() !== '';
  return body + voiceModeOverrides(mode, `${containerPrdDir(input.sessionName)}/prd.md`, firstWords, hasFeedback);
}

export interface VoiceQaPromptInput {
  readonly sessionName: string;
  readonly status: string;
  /** The operator's first words to the agent, when the conversation starts with an utterance. */
  readonly firstWords?: string | null;
}

/**
 * The first stdin message for a session that is not pending (docs/voice-plan.md Appendix A.3,
 * voice US-025): questions only, the tree belongs to the build loop. The
 * command line backs the last sentence up with `--disallowedTools`.
 */
export function voiceQaPrompt(input: VoiceQaPromptInput): string {
  const said = (input.firstWords ?? '').trim();
  const start =
    said === ''
      ? 'Start now by greeting the operator in one sentence and asking what they want to know.'
      : `The operator opened the conversation by voice: "${said}"`;
  return `You are answering questions about session ${input.sessionName} (${input.status}). Read the code, \`.chief/\` progress files and git log as needed. Do not modify any files.

${start}`;
}

/**
 * An utterance as the agent reads it (docs/voice-plan.md §10.2): `[voice] <text>`, or after
 * an interrupt `[voice] [You were interrupted after saying: "…"] <text>`
 * quoting the tail of what the operator actually heard (US-020).
 */
export function voiceUtterance(text: string, interruptedAfter: string | null = null): string {
  if (interruptedAfter === null) return `[voice] ${text}`;
  return `[voice] ${cutOffNote(interruptedAfter)} ${text}`;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
