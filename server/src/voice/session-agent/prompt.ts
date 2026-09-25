import { containerPrdDir, type PlanningMode, type PlanningPromptInput, planningPrompt } from '../../planning/prompts.js';

/**
 * What a session voice agent is told (plan Appendix A.2): the voice rules on
 * the command line (`--append-system-prompt`), and chief's own planning prompt
 * with a block of voice overrides as its first stdin message.
 */

/** Appendix A.2 part 1, with the call's language filled in. */
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

/** Appendix A.2 part 2: the block appended to chief's planning prompt. */
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
- Start now by greeting the operator in one sentence and asking ${ask}${said}.`;
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

/** How much of an interrupted reply the next utterance quotes back. */
export const INTERRUPTED_QUOTE_CHARS = 200;

/**
 * An utterance as the agent reads it (plan §10.2): `[voice] <text>`, or after
 * an interrupt `[voice][interrupted after: "…"] <text>` quoting the tail of
 * what the operator actually heard.
 */
export function voiceUtterance(text: string, interruptedAfter: string | null = null): string {
  if (interruptedAfter === null) return `[voice] ${text}`;
  const heard = interruptedAfter.replace(/\s+/g, ' ').trim();
  const quoted = heard.length <= INTERRUPTED_QUOTE_CHARS ? heard : `…${heard.slice(-(INTERRUPTED_QUOTE_CHARS - 1))}`;
  return `[voice][interrupted after: "${quoted}"] ${text}`;
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}
