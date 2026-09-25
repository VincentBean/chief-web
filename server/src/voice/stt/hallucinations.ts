/**
 * What speech-to-text models "hear" in silence or a cough (voice US-004;
 * docs/voice-plan.md §7.1). Whisper-family models were trained on subtitles, so a near-empty clip
 * comes back as a sign-off. Only trusted as a hallucination on a short clip: a
 * real "thank you" at the end of a long sentence is kept.
 */

/** Below this an utterance matching the list is dropped. */
export const HALLUCINATION_MAX_MS = 1_200;

const HALLUCINATIONS: readonly string[] = [
  // English
  'thank you.',
  'thank you',
  'thanks for watching!',
  'thanks for watching.',
  'thank you for watching.',
  'you',
  'bye.',
  // Dutch
  'bedankt voor het kijken',
  'bedankt voor het kijken.',
  'bedankt voor het kijken!',
  'dank je wel.',
  'dank u wel.',
  'ondertiteling door de amara.org gemeenschap',
  // Punctuation only
  '.',
  '...',
];

const LIST = new Set(HALLUCINATIONS.map(normalise));

/** Trim, lowercase and collapse whitespace; punctuation stays so "." still matches. */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Is this transcript of an utterance this long empty or a known silence hallucination? */
export function isHallucination(text: string, durationMs: number): boolean {
  const normalised = normalise(text);
  if (normalised === '') return true;
  return durationMs < HALLUCINATION_MAX_MS && LIST.has(normalised);
}
