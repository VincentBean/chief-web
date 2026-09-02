/**
 * Reading what the review agent found (US-007).
 *
 * Everything here fails closed. The findings are going straight onto a human's
 * pull request, so a document that is not exactly the shape the prompt asked
 * for is not salvaged, guessed at or partially posted — it is a failed attempt,
 * and the pass is run again. Posting garbage to GitHub is worse than posting
 * nothing at all, and unlike a failed attempt it cannot be taken back.
 */

/** One comment the review wants to leave on a line of the pull request. */
export interface ReviewFinding {
  /** Repository-relative path of the file, as `git diff` names its new side. */
  readonly path: string;
  /** A line in the *new* version of the file, expected to be within the diff. */
  readonly line: number;
  /** The comment body, as it will be posted. */
  readonly body: string;
}

/** A whole review: the findings, plus the paragraph posted alongside them. */
export interface ReviewReport {
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface ParsedReview {
  /** The report, or `null` when the output could not be used. */
  readonly report: ReviewReport | null;
  /** Why it could not be used; `null` when it could. */
  readonly error: string | null;
}

/** The longest comment body kept; a finding is a paragraph, not an essay. */
export const MAX_BODY_CHARS = 4000;

/** The longest summary kept; it is one comment on the pull request. */
export const MAX_SUMMARY_CHARS = 4000;

/**
 * Parses the agent's findings document.
 *
 * `raw` is whatever chief-web managed to get hold of: the file the prompt asked
 * for, or — when there is no file — the agent's own output, which is why this
 * tolerates a document that arrives wrapped in a fenced block or surrounded by
 * the agent's prose. What it does not tolerate is a document of the wrong
 * *shape*: that is the failed attempt the story asks for.
 */
export function parseReviewFindings(raw: string | null): ParsedReview {
  if (raw === null || raw.trim() === '') {
    return failure('The review agent produced no findings document.');
  }

  let lastError = 'The review agent did not produce a JSON document.';
  for (const candidate of candidates(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = readReport(parsed);
    if (result.report !== null) return result;
    // A candidate that parsed as JSON but was the wrong shape is the most
    // informative thing we are going to see; keep its reason for the caller.
    lastError = result.error ?? lastError;
  }
  return failure(lastError);
}

/**
 * The substrings worth trying as JSON, best first.
 *
 * The file the prompt asks for is normally the whole string, so that is tried
 * first. The fenced blocks come next, last one first: an agent that narrates
 * before it answers puts the document at the end, and one that echoed the
 * prompt's example schema put that at the beginning.
 */
function candidates(raw: string): string[] {
  const trimmed = raw.trim();
  const found = [trimmed];

  const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const fence of fences.reverse()) {
    const block = fence[1]?.trim();
    if (block !== undefined && block !== '') found.push(block);
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) found.push(trimmed.slice(first, last + 1));

  return found;
}

/** The shape check: every field the prompt promised, or nothing. */
function readReport(parsed: unknown): ParsedReview {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return failure('The review agent\'s findings document is not a JSON object.');
  }
  const body = parsed as Record<string, unknown>;

  const summary = body['summary'];
  if (typeof summary !== 'string' || summary.trim() === '') {
    return failure('The review agent\'s findings document has no "summary" string.');
  }

  const raw = body['findings'];
  if (!Array.isArray(raw)) {
    // Absence is not "nothing found": an empty review says so with `[]`, and a
    // document missing the field is one the agent never finished writing.
    return failure('The review agent\'s findings document has no "findings" array.');
  }

  const findings: ReviewFinding[] = [];
  for (const [index, entry] of raw.entries()) {
    const finding = readFinding(entry);
    if (finding === null) {
      // One malformed entry condemns the document rather than being dropped:
      // an agent that got a finding wrong is an agent whose other findings are
      // not evidence of anything either.
      return failure(
        `Finding ${String(index + 1)} in the review agent's findings document is not ` +
          '{ path: string, line: number, body: string }.',
      );
    }
    findings.push(finding);
  }
  return {
    report: { summary: summary.trim().slice(0, MAX_SUMMARY_CHARS), findings },
    error: null,
  };
}

function readFinding(entry: unknown): ReviewFinding | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;

  const path = record['path'];
  if (typeof path !== 'string') return null;
  const normalized = normalizePath(path);
  if (normalized === '') return null;

  const line = record['line'];
  // A line is a position in a file: whole, and counted from one. `0`, `-3` and
  // `12.5` all mean the agent guessed, and GitHub rejects the comment anyway.
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;

  const body = record['body'];
  if (typeof body !== 'string' || body.trim() === '') return null;

  return { path: normalized, line, body: body.trim().slice(0, MAX_BODY_CHARS) };
}

/**
 * The path as GitHub names it: relative to the repository root.
 *
 * An agent working in `/workspace/repo` reaches for an absolute path often
 * enough that stripping the clone's prefix is worth doing here rather than
 * failing a whole document over it. A path that escapes the repository is not
 * something to guess about, so `..` is left to fail the shape check.
 */
function normalizePath(path: string): string {
  let value = path.trim().replace(/^\/workspace\/repo\/+/, '').replace(/^\.\/+/, '');
  while (value.startsWith('/')) value = value.slice(1);
  if (value === '' || value.split('/').includes('..')) return '';
  return value;
}

function failure(error: string): ParsedReview {
  return { report: null, error };
}
