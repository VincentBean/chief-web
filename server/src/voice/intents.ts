/**
 * Intents (plan §11): short utterances the call handles itself, before the
 * focused agent sees them. Matching is on the whole utterance against exact
 * phrase lists (English and Dutch), after lowercasing and stripping
 * punctuation, and only for utterances of at most {@link MAX_INTENT_WORDS}
 * words, so a normal sentence that happens to contain "yes" is never taken.
 *
 * The answer to a pending confirmation (voice US-011), and the focus and
 * control intents (voice US-019).
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

/* ------------------------------------------------ focus and control (US-019) */

/** A focus or control intent: handled by the call itself, before the focused agent. */
export type CallIntent =
  | { readonly kind: 'to_chief' }
  | { readonly kind: 'to_session'; readonly name: string }
  | { readonly kind: 'stop_talking' }
  | { readonly kind: 'hangup' };

export const TO_CHIEF: readonly string[] = [
  'chief',
  'hey chief',
  'hi chief',
  'back to chief',
  'go back to chief',
  'take me back to chief',
  'chief please',
  'terug naar chief',
  'ga terug naar chief',
  'hé chief',
  'hoi chief',
];

export const STOP_TALKING: readonly string[] = [
  'stop',
  'stop talking',
  'stop it',
  'wait',
  'wait a second',
  'wait a moment',
  'hold on',
  'hang on',
  'shh',
  'quiet',
  'be quiet',
  'wacht',
  'wacht even',
  'wacht eens',
  'even wachten',
  'stop maar',
  'hou op',
];

export const HANGUP: readonly string[] = [
  'hang up',
  'hangup',
  'hang up please',
  "that's all",
  "that's all for now",
  "that's it",
  'goodbye',
  'bye',
  'bye bye',
  'end the call',
  'end call',
  'ophangen',
  'hang maar op',
  'je mag ophangen',
  'dat was het',
  'dat was het voor nu',
  'dat is alles',
  'doei',
  'tot ziens',
];

/** What comes before a session name in "switch to csv export", "ga naar billing export". */
export const TO_SESSION_PREFIXES: readonly string[] = [
  'switch to',
  'switch over to',
  'talk to',
  'go to',
  'let me talk to',
  'ga naar',
  'schakel naar',
  'schakel over naar',
  'praat met',
  'ik wil praten met',
];

const CONTROL = new Map<string, CallIntent>([
  ...TO_CHIEF.map((phrase) => [normalizeUtterance(phrase), { kind: 'to_chief' }] as const),
  ...STOP_TALKING.map((phrase) => [normalizeUtterance(phrase), { kind: 'stop_talking' }] as const),
  ...HANGUP.map((phrase) => [normalizeUtterance(phrase), { kind: 'hangup' }] as const),
]);

/** Longest first, so "switch over to x" is not read as "switch" + "over to x". */
const PREFIXES = TO_SESSION_PREFIXES.map(normalizeUtterance).sort((a, b) => b.length - a.length);

/**
 * "Back to chief" → `to_chief`, "Switch to billing export." → `to_session`
 * with the name as spoken (`billing export`; the shared resolver maps it onto
 * a session), "wacht" → `stop_talking`, "ophangen" → `hangup`. Anything else,
 * or anything longer than {@link MAX_INTENT_WORDS} words, is null.
 */
export function matchCallIntent(text: string): CallIntent | null {
  const normalized = normalizeUtterance(text);
  if (normalized === '' || normalized.split(' ').length > MAX_INTENT_WORDS) return null;
  const control = CONTROL.get(normalized);
  if (control !== undefined) return control;
  for (const prefix of PREFIXES) {
    if (!normalized.startsWith(`${prefix} `)) continue;
    const name = normalized.slice(prefix.length + 1).trim();
    // "switch to chief" is the way back, not a session called chief.
    if (CONTROL.get(name)?.kind === 'to_chief') return { kind: 'to_chief' };
    return name === '' ? null : { kind: 'to_session', name };
  }
  return null;
}
