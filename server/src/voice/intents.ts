/**
 * Intents (plan §11): short utterances the call handles itself, before the
 * focused agent sees them. Matching is on the whole utterance against exact
 * phrase lists (English and Dutch), after lowercasing and stripping
 * punctuation, and only for utterances of at most {@link MAX_INTENT_WORDS}
 * words, so a normal sentence that happens to contain "yes" is never taken.
 *
 * So far only the answer to a pending confirmation (voice US-011); the focus
 * and control intents of US-019 go here too.
 */

export const MAX_INTENT_WORDS = 8;

export type ConfirmIntent = 'yes' | 'no';

const YES = [
  'yes',
  'yeah',
  'yep',
  'yes please',
  'yes do it',
  'do it',
  'go',
  'go ahead',
  'confirm',
  'confirmed',
  'ok',
  'okay',
  'sure',
  'ja',
  'jawel',
  'ja graag',
  'ja doe maar',
  'doe maar',
  'doe het maar',
  'klopt',
  'dat klopt',
  'ja klopt',
  'oké',
  'oke',
  'prima',
  'akkoord',
];

const NO = [
  'no',
  'nope',
  'no thanks',
  'cancel',
  'cancel it',
  'never mind',
  'nevermind',
  "don't",
  'dont',
  'nee',
  'nee dank je',
  'niet doen',
  'laat maar',
  'nee laat maar',
  'annuleer',
  'annuleren',
];

/** Lowercase, punctuation stripped, whitespace collapsed; apostrophes and accents stay. */
export function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/[\s-]+/g, ' ')
    .trim();
}

const PHRASES = new Map<string, ConfirmIntent>([
  ...YES.map((phrase) => [normalizeUtterance(phrase), 'yes'] as const),
  ...NO.map((phrase) => [normalizeUtterance(phrase), 'no'] as const),
]);

/** "Ja." → `yes`, "Nee, laat maar" → `no`; anything else, or anything long, is null. */
export function matchConfirmIntent(text: string): ConfirmIntent | null {
  const normalized = normalizeUtterance(text);
  if (normalized === '' || normalized.split(' ').length > MAX_INTENT_WORDS) return null;
  return PHRASES.get(normalized) ?? null;
}
