/**
 * Keeping a login off everything the call shows or stores (voice feedback
 * US-009): a session agent's tool input goes through {@link redactCredentials}
 * before it becomes a tool card, and so before the call socket and
 * `voice_turns` see it. A tool's result never gets that far: the stream
 * parser keeps only whether it succeeded (`events.ts`).
 */

export const REDACTED = '[redacted]';

/** `password`, `username` and their spellings (`userName`, `user_password`, `passwd`). */
const CREDENTIAL_KEY = /password|passwd|username|user_name/i;
/** A form field that names a login field (`browser_fill_form`'s `{ name: 'Password', value }`). */
const LABEL_KEYS = ['name', 'element', 'label'] as const;
const VALUE_KEYS = new Set(['value', 'text']);
/** Shorter values are not scrubbed out of other text: "ann" would take "planning" with it. */
const MIN_SCRUBBED_LENGTH = 4;

/**
 * `input` with every value under a credential key replaced by
 * {@link REDACTED}, and those values scrubbed out of every other string too
 * (a Bash `curl -u ann:secret …` next to a `password` key).
 */
export function redactCredentials(input: unknown): unknown {
  const secrets = new Set<string>();
  collect(input, secrets);
  const scrubbed = [...secrets].filter((secret) => secret.length >= MIN_SCRUBBED_LENGTH).sort((a, b) => b.length - a.length);
  return rebuild(input, scrubbed);
}

function collect(value: unknown, secrets: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, secrets);
    return;
  }
  const record = asRecord(value);
  if (record === null) return;
  const labelled = namesCredential(record);
  for (const [key, item] of Object.entries(record)) {
    if (CREDENTIAL_KEY.test(key) || (labelled && VALUE_KEYS.has(key))) secretsOf(item, secrets);
    else collect(item, secrets);
  }
}

function secretsOf(value: unknown, secrets: Set<string>): void {
  if (typeof value === 'string') {
    if (value.trim() !== '') secrets.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) secretsOf(item, secrets);
  } else {
    const record = asRecord(value);
    if (record !== null) for (const item of Object.values(record)) secretsOf(item, secrets);
  }
}

function rebuild(value: unknown, scrubbed: readonly string[]): unknown {
  if (typeof value === 'string') return scrub(value, scrubbed);
  if (Array.isArray(value)) return value.map((item) => rebuild(item, scrubbed));
  const record = asRecord(value);
  if (record === null) return value;
  const labelled = namesCredential(record);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    out[key] = CREDENTIAL_KEY.test(key) || (labelled && VALUE_KEYS.has(key)) ? REDACTED : rebuild(item, scrubbed);
  }
  return out;
}

function scrub(text: string, scrubbed: readonly string[]): string {
  return scrubbed.reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

function namesCredential(record: Record<string, unknown>): boolean {
  return LABEL_KEYS.some((key) => {
    const label = record[key];
    return typeof label === 'string' && CREDENTIAL_KEY.test(label.replace(/\s+/g, ''));
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
