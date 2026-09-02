import type { Config } from '../config.js';
import { GithubApiError } from '../lib/github.js';
import {
  createPullRequestReview,
  listPullRequestFiles,
  type PullRequestFile,
  type ReviewCommentInput,
} from '../lib/github-review.js';
import { logger } from '../lib/logger.js';
import type { ReviewFinding, ReviewReport } from './findings.js';

/**
 * Putting a review on the pull request (US-008).
 *
 * The findings go to GitHub and nowhere else: one review, event `COMMENT`, the
 * summary as its body and every finding as an inline comment. Never an
 * approval, never a "changes requested" — an agent does not get to sign off on
 * a human's pull request — and never a cap on how much it may say: a large
 * pull request gets a large review rather than a truncated one.
 *
 * The one thing that can go wrong locally is an anchor. GitHub validates every
 * comment of a review before it creates anything, so a single `path`/`line`
 * outside the diff would throw the whole review away. Those findings are found
 * first — by comparing them against the diff GitHub itself reports — and
 * folded into the review body, so the review is still posted and no finding is
 * lost on the way.
 */

/** The pull request a review is posted to. */
export interface ReviewTarget {
  /** `owner/repo`, as stored on the repository. */
  readonly slug: string;
  readonly number: number;
}

/** What was posted, for the log line and the operator's message. */
export interface PublishedReview {
  /** The review's `html_url`; empty when GitHub did not return one. */
  readonly url: string;
  /** Findings posted as inline comments. */
  readonly inlineComments: number;
  /** Findings that could not be anchored and went into the body instead. */
  readonly foldedFindings: number;
}

/** The slice of GitHub the review step needs; tests pass a stub. */
export interface ReviewPublisher {
  publish(token: string, target: ReviewTarget, report: ReviewReport): Promise<PublishedReview>;
}

/** The production publisher: the real REST API at the configured base URL. */
export class GithubReviewPublisher implements ReviewPublisher {
  constructor(private readonly config: Pick<Config, 'githubApiUrl'>) {}

  publish(token: string, target: ReviewTarget, report: ReviewReport): Promise<PublishedReview> {
    return publishReview(token, this.config.githubApiUrl, target, report);
  }
}

/** The sentence a review with nothing to say leads with. */
export const NOTHING_TO_FLAG = 'The automated code review found nothing to flag.';

/** The heading the findings GitHub would not anchor are collected under. */
export const OTHER_FINDINGS_HEADING = '### Other findings';

/**
 * Posts one review for `report`.
 *
 * Resolves with what was posted, and rejects only when GitHub refused the
 * review itself — a refusal the caller turns into a failed attempt (US-009).
 */
export async function publishReview(
  token: string,
  baseUrl: string,
  target: ReviewTarget,
  report: ReviewReport,
): Promise<PublishedReview> {
  if (report.findings.length === 0) {
    const posted = await createPullRequestReview(token, baseUrl, target.slug, target.number, {
      body: emptyReviewBody(report.summary),
      comments: [],
    });
    return { url: posted.url, inlineComments: 0, foldedFindings: 0 };
  }

  const placed = await placeFindings(token, baseUrl, target, report.findings);
  try {
    const posted = await createPullRequestReview(token, baseUrl, target.slug, target.number, {
      body: reviewBody(report.summary, placed.folded),
      comments: placed.inline.map(toComment),
    });
    return {
      url: posted.url,
      inlineComments: placed.inline.length,
      foldedFindings: placed.folded.length,
    };
  } catch (cause) {
    // A 422 is GitHub rejecting an anchor we believed in — a line that moved,
    // or a file whose patch it did not report. The findings are worth more
    // than their position, so the review goes up again with all of them in the
    // body. Anything else (a 401, an unreachable API) is the caller's problem.
    if (!(cause instanceof GithubApiError) || cause.status !== 422) throw cause;
    if (placed.inline.length === 0) throw cause;

    logger.warn('github rejected the review\'s inline comments; folding them into the body', {
      repository: target.slug,
      number: target.number,
      comments: placed.inline.length,
      error: cause.message,
    });
    const posted = await createPullRequestReview(token, baseUrl, target.slug, target.number, {
      body: reviewBody(report.summary, report.findings),
      comments: [],
    });
    return { url: posted.url, inlineComments: 0, foldedFindings: report.findings.length };
  }
}

/** The findings that can be anchored, and the ones that have to be written out. */
interface PlacedFindings {
  readonly inline: readonly ReviewFinding[];
  readonly folded: readonly ReviewFinding[];
}

/**
 * Splits the findings by whether GitHub can anchor them.
 *
 * When the diff cannot be read — the call failed, or the pull request is too
 * large to page through — every finding is tried inline: guessing that a
 * finding is unanchorable would silently demote a perfectly good comment, and
 * the 422 fallback still catches the case where the guess would have been
 * right.
 */
async function placeFindings(
  token: string,
  baseUrl: string,
  target: ReviewTarget,
  findings: readonly ReviewFinding[],
): Promise<PlacedFindings> {
  let files: readonly PullRequestFile[];
  try {
    const listed = await listPullRequestFiles(token, baseUrl, target.slug, target.number);
    if (listed.truncated) return { inline: findings, folded: [] };
    files = listed.files;
  } catch (cause) {
    logger.warn('could not read the pull request diff; anchoring every finding inline', {
      repository: target.slug,
      number: target.number,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return { inline: findings, folded: [] };
  }

  const anchorable = new Map<string, ReadonlySet<number>>();
  for (const file of files) anchorable.set(file.filename, commentableLines(file.patch));

  const inline: ReviewFinding[] = [];
  const folded: ReviewFinding[] = [];
  for (const finding of findings) {
    const lines = anchorable.get(finding.path);
    if (lines !== undefined && lines.has(finding.line)) inline.push(finding);
    else folded.push(finding);
  }
  return { inline, folded };
}

/**
 * The lines of a file's new side a review comment may be anchored to.
 *
 * GitHub accepts any line inside a hunk, context lines included, so both ` `
 * and `+` advance the new-side counter and both are commentable; `-` lines
 * only exist on the old side, and `\ No newline at end of file` is not a line
 * at all. A file with no patch — binary, or too large for GitHub to diff — has
 * nowhere to put a comment.
 */
export function commentableLines(patch: string | null): ReadonlySet<number> {
  const lines = new Set<number>();
  if (patch === null) return lines;

  let next = 0;
  for (const row of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header !== null) {
      next = Number(header[1]);
      continue;
    }
    if (next === 0) continue;
    if (row.startsWith('+') || row.startsWith(' ')) {
      lines.add(next);
      next += 1;
    }
  }
  return lines;
}

/** The review body: the summary, plus whatever could not be anchored. */
export function reviewBody(summary: string, folded: readonly ReviewFinding[]): string {
  const parts = [summary.trim()];
  if (folded.length > 0) {
    parts.push(
      OTHER_FINDINGS_HEADING,
      'These could not be attached to a line of this pull request\'s diff.',
      ...folded.map((finding) => `**\`${finding.path}:${String(finding.line)}\`**\n\n${finding.body.trim()}`),
    );
  }
  return parts.join('\n\n');
}

/** The body of a review that found nothing: it has to say so, and briefly. */
export function emptyReviewBody(summary: string): string {
  const trimmed = summary.trim();
  return trimmed === '' ? NOTHING_TO_FLAG : `${NOTHING_TO_FLAG}\n\n${trimmed}`;
}

function toComment(finding: ReviewFinding): ReviewCommentInput {
  return { path: finding.path, line: finding.line, body: finding.body };
}
