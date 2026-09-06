/**
 * Just enough markdown to preview the review context written for a repository
 * (US-003), on top of the inline splitting `comment.ts` already does.
 *
 * The field holds review guidance — headings, bullets, the occasional snippet
 * — so the preview handles those blocks and nothing else. The reasoning for
 * not taking a markdown library is the one `comment.ts` records: a dependency
 * and an escaping surface in exchange for constructs this text does not use.
 * Nothing here produces HTML; the caller renders the blocks as React nodes, so
 * the text is escaped by React and `dangerouslySetInnerHTML` never appears.
 */

import { splitInlineCode, type TextRun } from './comment.ts';

export type MarkdownBlock =
  /** `level` is clamped to 3, the deepest heading `base.css` styles. */
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly runs: readonly TextRun[] }
  | { readonly kind: 'paragraph'; readonly runs: readonly TextRun[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly TextRun[])[] }
  | { readonly kind: 'code'; readonly language: string | null; readonly text: string };

const FENCE = /^[ \t]*(`{3,})[ \t]*([^`]*)$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
const BULLET = /^[ \t]*[-*+][ \t]+(.*)$/;
const NUMBERED = /^[ \t]*\d+[.)][ \t]+(.*)$/;

/** Splits markdown into the blocks a reader needs told apart. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const [, ticks = '```', language = ''] = fence;
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end of the text, the way a half
      // typed snippet does while it is still being written.
      while (index < lines.length && !isClosingFence(lines[index] ?? '', ticks)) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', language: language.trim() === '' ? null : language.trim(), text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const hashes = (heading[1] ?? '#').length;
      blocks.push({
        kind: 'heading',
        level: hashes >= 3 ? 3 : hashes === 2 ? 2 : 1,
        runs: splitInlineCode((heading[2] ?? '').replace(/[ \t]+#*[ \t]*$/, '')),
      });
      index += 1;
      continue;
    }

    const item = listItem(line);
    if (item !== null) {
      const items: TextRun[][] = [];
      const ordered = item.ordered;
      // A run of items is one list: switching marker starts a new one, so
      // bullets under a numbered step do not silently join it.
      let next: ReturnType<typeof listItem> = item;
      while (next !== null && next.ordered === ordered) {
        items.push(splitInlineCode(next.text));
        index += 1;
        next = index < lines.length ? listItem(lines[index] ?? '') : null;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // Everything else is prose. Consecutive lines are one paragraph, joined by
    // their newlines: the renderer keeps them, the way GitHub keeps a soft
    // break inside a comment.
    const prose: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (current.trim() === '' || FENCE.test(current) || HEADING.test(current) || listItem(current) !== null) break;
      prose.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', runs: splitInlineCode(prose.join('\n')) });
  }

  return blocks;
}

function isClosingFence(line: string, ticks: string): boolean {
  const match = FENCE.exec(line);
  return match !== null && (match[1] ?? '').length >= ticks.length && (match[2] ?? '').trim() === '';
}

function listItem(line: string): { readonly ordered: boolean; readonly text: string } | null {
  const bullet = BULLET.exec(line);
  if (bullet !== null) return { ordered: false, text: bullet[1] ?? '' };
  const numbered = NUMBERED.exec(line);
  if (numbered !== null) return { ordered: true, text: numbered[1] ?? '' };
  return null;
}
