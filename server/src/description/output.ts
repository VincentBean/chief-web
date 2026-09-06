/**
 * Reading the description back out of what the agent left (US-001).
 *
 * There is no document shape to validate here — the pass produces prose, and
 * prose either exists or it does not. So the whole contract is: whatever comes
 * back is markdown, and **empty is a failure**. A pull request body with an
 * empty `## What this does` section under it is worse than one without the
 * section at all, so nothing here is allowed to return an empty string.
 */

/** How much of the description is kept; a body section, not an essay. */
export const MAX_DESCRIPTION_CHARS = 4000;

/**
 * The description as a pull request body can carry it, or `null` when the
 * agent left nothing usable.
 *
 * Three things are stripped: the log lines the stream formatter puts around an
 * agent's own words (which are in the output fallback, never in the file), a
 * markdown fence wrapped around the whole answer, and trailing whitespace.
 */
export function cleanDescription(raw: string): string | null {
  const lines = raw.replace(/\r/g, '').split('\n');
  const text = unwrapFence(lines.filter((line) => !isLogLine(line)).join('\n')).trim();
  if (text === '') return null;
  return text.length <= MAX_DESCRIPTION_CHARS
    ? text
    : `${text.slice(0, MAX_DESCRIPTION_CHARS).trimEnd()}…`;
}

/** A line the agent's log put there — `[claude] finished (12.3s, 4 turns)`. */
function isLogLine(line: string): boolean {
  return /^\[(claude|tool|ok|failed)\]/.test(line.trimStart());
}

/**
 * Drops a code fence wrapping the *whole* answer.
 *
 * A model asked for markdown quite reasonably hands back ```` ```markdown ````
 * around it; pasted into a pull request body that renders as a code block
 * instead of as the description. A fence that only covers part of the text is
 * left alone — that one is a code sample inside the description.
 */
function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(trimmed);
  if (match === null) return text;
  const body = match[1] ?? '';
  return body.includes('```') ? text : body;
}
