import fs from 'node:fs';

import { parsePrd, type PrdParseError } from './parse.js';

/**
 * The state of a session's `prd.md` on the data volume (US-011).
 *
 * The session page polls this, so it is deliberately a plain file read: the
 * workspace is a bind mount the server itself can see, and asking the container
 * would cost an exec per poll for an answer the filesystem already has.
 */
export interface PrdStatus {
  /** Path relative to the repository root, which is how the UI names it. */
  readonly path: string;
  readonly exists: boolean;
  /** True only when the file exists *and* has no parse errors. */
  readonly parses: boolean;
  readonly storyCount: number;
  readonly errors: readonly PrdParseError[];
  /** Last modification time, ISO-8601 UTC; `null` when there is no file. */
  readonly updatedAt: string | null;
  readonly bytes: number;
}

/** A file bigger than this is not a PRD; reading it would only cost memory. */
const MAX_PRD_BYTES = 2 * 1024 * 1024;

/**
 * Reads and parses `absolutePath`. Never throws — a PRD that is missing,
 * unreadable or malformed is a state the page shows, not a failed request.
 */
export function readPrdStatus(absolutePath: string, displayPath: string): PrdStatus {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch {
    return {
      path: displayPath,
      exists: false,
      parses: false,
      storyCount: 0,
      errors: [],
      updatedAt: null,
      bytes: 0,
    };
  }

  const updatedAt = stats.mtime.toISOString();
  if (stats.size > MAX_PRD_BYTES) {
    return {
      path: displayPath,
      exists: true,
      parses: false,
      storyCount: 0,
      errors: [{ line: 0, message: `${displayPath} is larger than 2 MiB, which is not a PRD.` }],
      updatedAt,
      bytes: stats.size,
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch (cause) {
    return {
      path: displayPath,
      exists: true,
      parses: false,
      storyCount: 0,
      errors: [{ line: 0, message: `${displayPath} could not be read: ${String(cause)}` }],
      updatedAt,
      bytes: stats.size,
    };
  }

  const parsed = parsePrd(content);
  return {
    path: displayPath,
    exists: true,
    parses: parsed.errors.length === 0,
    storyCount: parsed.stories.length,
    errors: parsed.errors,
    updatedAt,
    bytes: stats.size,
  };
}
