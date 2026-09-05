import {
  CodeFenceScanner,
  STATUS_LINE_PATTERN,
  STORY_HEADING_PATTERN,
  type StoryStatus,
} from './parse.js';

/**
 * Writing a story's status back into `prd.md` (US-012).
 *
 * The PRD is the agent's document, not chief-web's: it is written by `claude`
 * during planning and read again by every `claude` the build loop starts. So
 * the only thing chief-web is allowed to change in it is the `**Status:**` line
 * of a story — everything else, including the file's own formatting, prose and
 * ordering, must survive untouched. That is what makes the parser a round trip:
 * `parsePrd(setStoryStatus(content, id, status).content)` differs from
 * `parsePrd(content)` in exactly that one story's status.
 */

export interface StoryStatusUpdate {
  /** Identifier from the PRD, e.g. `US-001`. */
  readonly storyId: string;
  readonly status: StoryStatus;
}

export interface PrdWriteResult {
  readonly content: string;
  /** False when nothing in the file needed changing. */
  readonly changed: boolean;
  /** Requested ids the file has no story for; those updates were dropped. */
  readonly missing: readonly string[];
}

/** `**Status:** done` — the exact line chief writes. */
export function statusLine(status: StoryStatus): string {
  return `**Status:** ${status}`;
}

/** Convenience wrapper around {@link setStoryStatuses} for a single story. */
export function setStoryStatus(
  content: string,
  storyId: string,
  status: StoryStatus,
): PrdWriteResult {
  return setStoryStatuses(content, [{ storyId, status }]);
}

/**
 * Rewrites the `**Status:**` line of each named story in place, inserting one
 * directly under the heading when the story has none (a story without a status
 * is `todo`, so there is nothing else to preserve). Unknown ids are reported
 * rather than added: chief-web never invents stories the agent did not write.
 */
export function setStoryStatuses(
  content: string,
  updates: readonly StoryStatusUpdate[],
): PrdWriteResult {
  const wanted = new Map(updates.map((update) => [update.storyId, update.status]));
  const lines = content.split('\n');
  const out: string[] = [];
  const seen = new Set<string>();

  /** The story block being copied, when its status is one we have to write. */
  let block: { id: string; status: StoryStatus; headingIndex: number; written: boolean } | null =
    null;

  // A block that ended without a `**Status:**` line gets one under its heading.
  // Later indices are recorded after the splice, so they stay correct.
  const flush = (): void => {
    if (block !== null && !block.written) {
      out.splice(block.headingIndex + 1, 0, statusLine(block.status) + endingOf(out[block.headingIndex] ?? ''));
    }
    block = null;
  };

  const fences = new CodeFenceScanner();

  for (const line of lines) {
    // A fenced block is copied through untouched: a Sentry stack trace embedded
    // in a story (US-007) may contain a line that reads exactly like a heading
    // or a status, and rewriting one would corrupt the error being reported —
    // and leave the story's real status behind.
    if (fences.consume(line)) {
      out.push(line);
      continue;
    }

    const trimmed = line.trim();

    const heading = STORY_HEADING_PATTERN.exec(trimmed);
    if (heading !== null) {
      flush();
      const id = heading[1] ?? '';
      seen.add(id);
      out.push(line);
      const status = wanted.get(id);
      if (status !== undefined) {
        block = { id, status, headingIndex: out.length - 1, written: false };
      }
      continue;
    }

    // Any other section heading closes the story block it follows, exactly as
    // the parser ends one there.
    if (line.startsWith('## ') || line.startsWith('### ')) {
      flush();
      out.push(line);
      continue;
    }

    if (block !== null && !block.written && STATUS_LINE_PATTERN.test(trimmed)) {
      out.push(indentOf(line) + statusLine(block.status) + endingOf(line));
      block.written = true;
      continue;
    }

    out.push(line);
  }

  flush();

  const next = out.join('\n');
  return {
    content: next,
    changed: next !== content,
    missing: [...wanted.keys()].filter((id) => !seen.has(id)),
  };
}

/** Whitespace the line starts with, so an indented PRD stays indented. */
function indentOf(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? '';
}

/** `\r` when the file uses CRLF endings, so splitting on `\n` cannot eat one. */
function endingOf(line: string): string {
  return line.endsWith('\r') ? '\r' : '';
}
