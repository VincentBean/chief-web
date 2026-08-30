import type { FeedbackOutcome } from '../db/index.js';

/**
 * Reading what the agent says it did (US-021).
 *
 * The agent writes `/workspace/feedback-outcome.json` and chief-web reads it
 * off the data volume, the same way the build loop reads `prd.md` rather than
 * asking the agent how it got on. This file is still only a *claim*: it says
 * which comment the agent believes it addressed, and the service cross-checks
 * every claim against the git history before a word of it reaches GitHub.
 *
 * Everything here fails closed. A file that cannot be parsed, a key the agent
 * put in both lists, a key it never mentioned — none of them may end up looking
 * like "addressed", because the consequence of that mistake is a public reply
 * claiming a fix that does not exist.
 */

export interface ItemOutcome {
  /** The short key chief-web issued: `T1`, `R2`. */
  readonly key: string;
  readonly outcome: FeedbackOutcome;
  /** The agent's summary, or its reason for skipping; null when unreported. */
  readonly note: string | null;
}

export interface ParsedOutcome {
  readonly ok: boolean;
  /** One entry per key that was issued, whatever the agent said about it. */
  readonly items: readonly ItemOutcome[];
  /** Why the file could not be used; null when it could. */
  readonly error: string | null;
  /** Keys the agent invented. Dropped rather than fatal, but worth logging. */
  readonly unknownKeys: readonly string[];
}

/** The longest note kept; a reply is a sentence, not an essay. */
const MAX_NOTE_CHARS = 600;

/**
 * Parses the agent's report against the keys it was given.
 *
 * `issued` is the authority for what exists: a key the agent never mentions
 * comes back `unreported`, never `addressed`. Silence is not consent, and the
 * failure mode of the other choice is answering a comment nobody looked at.
 */
export function parseOutcome(raw: string | null, issued: readonly string[]): ParsedOutcome {
  const unreported = (error: string | null): ParsedOutcome => ({
    ok: error === null,
    items: issued.map((key) => ({ key, outcome: 'unreported' as const, note: null })),
    error,
    unknownKeys: [],
  });

  if (raw === null) {
    return unreported(
      'The agent did not write /workspace/feedback-outcome.json, so there is no record of what it looked at.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return unreported(
      `/workspace/feedback-outcome.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return unreported('/workspace/feedback-outcome.json is not a JSON object.');
  }

  const body = parsed as Record<string, unknown>;
  const addressed = readEntries(body['addressed'], 'summary');
  const skipped = readEntries(body['skipped'], 'reason');
  const known = new Set(issued);

  const seen = new Map<string, { outcome: FeedbackOutcome; note: string | null }>();
  const unknownKeys: string[] = [];
  const contradictions: string[] = [];

  const record = (
    entries: readonly { key: string; note: string | null }[],
    outcome: FeedbackOutcome,
  ): void => {
    for (const entry of entries) {
      if (!known.has(entry.key)) {
        if (!unknownKeys.includes(entry.key)) unknownKeys.push(entry.key);
        continue;
      }
      const existing = seen.get(entry.key);
      if (existing !== undefined && existing.outcome !== outcome) {
        contradictions.push(entry.key);
        continue;
      }
      seen.set(entry.key, { outcome, note: entry.note });
    }
  };

  record(addressed, 'addressed');
  record(skipped, 'skipped');

  if (contradictions.length > 0) {
    // The agent said it both did and did not do the same thing. There is no
    // safe way to pick one, so the whole report is unusable.
    return unreported(
      `The agent reported ${contradictions.join(', ')} as both addressed and skipped, so its report cannot be trusted.`,
    );
  }

  return {
    ok: true,
    items: issued.map((key) => {
      const found = seen.get(key);
      return found === undefined
        ? { key, outcome: 'unreported' as const, note: null }
        : { key, outcome: found.outcome, note: found.note };
    }),
    error: null,
    unknownKeys,
  };
}

function readEntries(value: unknown, noteField: string): { key: string; note: string | null }[] {
  if (!Array.isArray(value)) return [];
  const entries: { key: string; note: string | null }[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const key = record['key'];
    if (typeof key !== 'string' || key === '') continue;
    const note = record[noteField];
    entries.push({
      key,
      note: typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, MAX_NOTE_CHARS) : null,
    });
  }
  return entries;
}

/**
 * What a re-run has to redo.
 *
 * Pure, so every branch is testable without a container — the same reason the
 * session retry plan is pure. A run that failed while answering has already
 * pushed its fix, so re-running the agent would spend a pass and a build slot
 * redoing work that is already on the remote.
 */
export function planPrRerun(
  run: { readonly status: string; readonly failureStage: string | null; readonly headSha: string | null },
  threads: readonly { readonly outcome: string | null; readonly repliedAt: string | null }[],
): { mode: 'full' | 'replies-only'; reason: string } {
  const unanswered = threads.filter(
    (thread) => thread.outcome !== null && thread.outcome !== 'unreported' && thread.repliedAt === null,
  );

  if (run.failureStage === 'reply' && run.headSha !== null && unanswered.length > 0) {
    return {
      mode: 'replies-only',
      reason:
        `The fix is already pushed as ${run.headSha.slice(0, 7)}; only the replies on GitHub are ` +
        `outstanding (${String(unanswered.length)}).`,
    };
  }

  return {
    mode: 'full',
    reason: 'The pull request is checked out again and the agent makes another pass.',
  };
}
