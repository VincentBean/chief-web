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
- Ask one question at a time. Never use lettered or numbered options; ask naturally.
- Messages starting with [voice] are the operator's transcribed speech; transcription can be wrong,
  so if something sounds odd, check rather than guess.
- When you have written or updated the PRD, say so in one sentence, say how many stories it has,
  and suggest saying "back to chief" to mark it ready and build it.
- Speak ${languageName(language)} unless the operator switches language.`;
}

/** docs/voice-plan.md Appendix A.2 part 2: the block appended to chief's planning prompt. */
export function voiceModeOverrides(mode: PlanningMode, prdPath: string, context: string | null): string {
  const said = context === null || context.trim() === '' ? '' : ` (they said: "${context.trim()}")`;
  const ask = mode === 'edit' ? 'what they want to change in the PRD' : 'what they want to build';
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
 * The message sent when the operator returns to a planning session (US-004):
 * the open questions of a `waiting` session one by one, or, when none are
 * left (`done`), a one-sentence "the PRD is complete".
 */
export function resumePrompt(openQuestions: readonly string[]): string {
  if (openQuestions.length === 0) {
    return 'The operator is back on the call. The PRD is complete and has no open questions. Say so in one sentence and suggest saying "back to chief" to mark it ready and build it.';
  }
  const numbered = openQuestions.map((question, i) => `${i + 1}. ${question}`).join('\n');
  return `The operator is back on the call. These are the open questions in the PRD:
${numbered}

Greet the operator in one sentence and ask the first question. As soon as a question is answered, remove it from \`## Open Questions\` in the PRD and update the affected stories.`;
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
  });
  return body + voiceModeOverrides(mode, `${containerPrdDir(input.sessionName)}/prd.md`, firstWords);
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
