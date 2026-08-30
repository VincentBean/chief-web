/**
 * Just enough of GitHub's markdown to render a review comment legibly.
 *
 * Review bodies are markdown, and the ones that matter contain exactly three
 * constructs: prose, fenced code blocks, and inline code inside prose — a real
 * comment reads *"Using float casting for money comparisons can produce
 * incorrect results"* with `commitHeaderField()` in backticks.
 *
 * A markdown library would be a new dependency and a new escaping surface for
 * text written by whoever reviewed the pull request, in exchange for handling
 * constructs these bodies do not use. This is the same reasoning `Icon.tsx`
 * records for not taking an icon package. Nothing here produces HTML — the
 * caller renders the parts as React nodes, so the text is escaped by React and
 * `dangerouslySetInnerHTML` never appears.
 */

/** A run of prose, which is either plain or inline code. */
export interface TextRun {
  readonly code: boolean;
  readonly text: string;
}

export type BodyPart =
  | { readonly kind: 'text'; readonly runs: readonly TextRun[] }
  | { readonly kind: 'code'; readonly language: string | null; readonly text: string };

/** Splits a comment body into the parts a reader needs told apart. */
export function parseCommentBody(body: string): BodyPart[] {
  const parts: BodyPart[] = [];
  // A fence is three or more backticks at the start of a line, so a triple
  // backtick *inside* a sentence is not mistaken for one.
  const fence = /^[ \t]*(`{3,})[ \t]*([^\n`]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

  let cursor = 0;
  for (const match of body.matchAll(fence)) {
    const start = match.index;
    if (start > cursor) pushText(parts, body.slice(cursor, start));
    parts.push({
      kind: 'code',
      language: (match[2] ?? '').trim() === '' ? null : (match[2] ?? '').trim(),
      text: stripTrailingNewline(match[3] ?? ''),
    });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) pushText(parts, body.slice(cursor));

  return parts;
}

function pushText(parts: BodyPart[], raw: string): void {
  const text = raw.replace(/^\n+|\n+$/g, '');
  if (text === '') return;
  parts.push({ kind: 'text', runs: splitInlineCode(text) });
}

/** Splits prose on single-backtick spans, keeping the order of everything. */
export function splitInlineCode(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /`([^`\n]+)`/g;

  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > cursor) runs.push({ code: false, text: text.slice(cursor, start) });
    runs.push({ code: true, text: match[1] ?? '' });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) runs.push({ code: false, text: text.slice(cursor) });

  return runs.length === 0 ? [{ code: false, text }] : runs;
}

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * A file path split for display: the directory, and the name the eye looks for.
 *
 * Review paths are deep — `packages/leo/resources/views/livewire/partials/
 * proposal-header-field.blade.php` — and truncating one loses the ability to
 * tell two same-named partials apart, so both halves are kept and the caller
 * renders the directory quietly above the name.
 */
export function splitPath(path: string): { dir: string | null; name: string } {
  const cut = path.lastIndexOf('/');
  return cut === -1
    ? { dir: null, name: path }
    : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}
