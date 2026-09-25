/** How much of an interrupted reply the cut-off note quotes back (plan §5). */
export const CUT_OFF_QUOTE_CHARS = 200;

/**
 * The note that opens the next message to an agent the operator talked over
 * (voice US-020; plan §5): `[You were interrupted after saying: "<tail>"]`,
 * quoting the last {@link CUT_OFF_QUOTE_CHARS} characters of what was heard.
 */
export function cutOffNote(heard: string): string {
  const flat = heard.replace(/\s+/g, ' ').trim();
  return `[You were interrupted after saying: "${flat.slice(-CUT_OFF_QUOTE_CHARS)}"]`;
}
