import type { SentryIssue } from '../db/index.js';

import type { SentryException, SentryIssueDetails, SentryStackFrame } from './client.js';

/**
 * The deterministic half of duplicate detection (US-003).
 *
 * Asking the model "is this the same defect as one of these?" is only cheap if
 * "these" is a handful. A repository can have fifty issues in flight, and
 * pasting all of them into a haiku call would cost more than the classification
 * it is attached to — so before the model sees anything, every candidate is
 * scored against the issue being classified with plain string and stack-frame
 * comparison, and only the best few survive.
 *
 * Everything here is a pure function over values the caller already holds: no
 * database handle, no Sentry call, no container. That is deliberate — this is
 * the one part of the feature with real logic in it, and it should be testable
 * by calling it.
 *
 * ## What the scoring is, and is not
 *
 * It is a shortlist, not a verdict. A high score means "worth asking about";
 * the answer still comes from the classification call, which is the only thing
 * that can tell "the same bug seen from two entry points" from "two different
 * bugs that both throw `TypeError`". So the weights below are tuned to be
 * *inclusive* — a near-miss reaching the prompt costs a few hundred tokens,
 * while a real duplicate falling below the threshold costs a whole build
 * session and a redundant pull request.
 */

/**
 * How many in-app stack frames a signature keeps.
 *
 * The frames nearest the crash are the ones that identify the defect; the
 * callers above them differ between entry points precisely in the case this
 * feature exists to catch. Five is enough to tell two functions in the same
 * file apart without dragging the whole request path in.
 */
export const MAX_SIGNATURE_FRAMES = 5;

/**
 * The score, out of 100, at which a candidate is worth showing the model.
 *
 * This is what keeps unrelated issues out of the prompt: below it, a candidate
 * shares little more than a word or two of its title, and asking about it would
 * spend tokens on a question with an obvious answer. Thirty is low enough that
 * a pair matching on culprit and title alone — all a pre-feature row with a
 * NULL signature can offer, and worth at most 35 — still gets asked about, and
 * high enough that a shared culprit on its own (25) does not.
 */
export const DUPLICATE_SCORE_THRESHOLD = 30;

/**
 * How many candidates the prompt may name.
 *
 * The cap is what keeps the prompt short and the haiku call cheap: each
 * candidate adds a title, a culprit and its top frames to a call that is
 * otherwise one error report. Three is enough to cover a cluster the poller
 * ingested in one tick, and past three the extra candidates are the ones the
 * threshold barely let through anyway.
 */
export const MAX_DUPLICATE_CANDIDATES = 3;

/**
 * A normalized fingerprint of one defect, as stored in `sentry_issues.signature`.
 *
 * Four parts, most identifying first. `exceptionType` and `culprit` come
 * straight from Sentry; `titleKey` and `frames` are normalized so that the same
 * defect reported from two deploys, or with a different array index in its
 * message, produces the same strings.
 */
export interface IssueSignature {
  /** The first exception's type, e.g. `TypeError`. Null when there is none. */
  readonly exceptionType: string | null;
  /** Sentry's culprit — roughly "where it happened". Null when there is none. */
  readonly culprit: string | null;
  /** The title with its variable parts flattened; see {@link titleKey}. */
  readonly titleKey: string;
  /** Up to {@link MAX_SIGNATURE_FRAMES} in-app `file:function`, crashing frame last. */
  readonly frames: readonly string[];
}

/** Deploy roots that differ between environments but mean the same tree. */
const PATH_PREFIXES = ['/usr/src/app/', '/var/www/', '/workspace/', '/app/'] as const;

/** Points awarded for each part when the two signatures agree on it fully. */
const EXCEPTION_TYPE_WEIGHT = 40;
const CULPRIT_WEIGHT = 25;
const FRAMES_WEIGHT = 25;
const TITLE_WEIGHT = 10;

/**
 * The signature of the issue being classified, from the details the classifier
 * has already fetched. No Sentry call of its own — that is what keeps the
 * documented per-tick request budget unchanged.
 */
export function issueSignature(details: SentryIssueDetails): IssueSignature {
  const exceptions = details.latestEvent?.exceptions ?? [];
  return {
    exceptionType: trimmedOrNull(exceptions[0]?.type ?? null),
    culprit: trimmedOrNull(details.issue.culprit),
    titleKey: titleKey(details.issue.title),
    frames: signatureFrames(exceptions),
  };
}

/**
 * The degraded signature of a candidate that has none stored.
 *
 * Every row the poller ingested before this feature shipped has
 * `signature = NULL`, and re-fetching its event from Sentry to fill that in
 * would cost one API call per candidate per tick. Title and culprit are on the
 * row already, and they are the only two parts such a row can score on: a
 * matching culprit is worth {@link CULPRIT_WEIGHT} and a fully overlapping
 * title {@link TITLE_WEIGHT}, so 35 at best and
 * {@link DUPLICATE_SCORE_THRESHOLD} once the culprit matches and about half
 * the title tokens do. An old row that really is the same defect still reaches
 * the prompt, and the model decides.
 */
export function signatureFromIssue(issue: SentryIssue): IssueSignature {
  return {
    exceptionType: null,
    culprit: trimmedOrNull(issue.culprit),
    titleKey: titleKey(issue.title),
    frames: [],
  };
}

/**
 * The signature to score a candidate row with: the stored one when it parses,
 * the degraded one otherwise. Never throws and never returns null, so a row
 * written by an older version stays a candidate rather than disappearing.
 */
export function candidateSignature(issue: SentryIssue): IssueSignature {
  return parseSignature(issue.signature) ?? signatureFromIssue(issue);
}

/** The JSON written to `sentry_issues.signature`. */
export function serializeSignature(signature: IssueSignature): string {
  return JSON.stringify({
    exceptionType: signature.exceptionType,
    culprit: signature.culprit,
    titleKey: signature.titleKey,
    frames: [...signature.frames],
  });
}

/**
 * Reads back what {@link serializeSignature} wrote, or null.
 *
 * Null for absent, unparseable and wrong-shaped JSON alike: a signature is a
 * cache of a normalization that may well change shape in a later version, and
 * a stored value this build cannot read must degrade the match rather than
 * throw somewhere on the path that decides whether real bugs get fixed.
 */
export function parseSignature(json: string | null | undefined): IssueSignature | null {
  if (json === null || json === undefined || json.trim() === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const titleKeyValue = record.titleKey;
  if (typeof titleKeyValue !== 'string') return null;

  const frames = record.frames;
  if (!Array.isArray(frames) || !frames.every((frame) => typeof frame === 'string')) return null;

  return {
    exceptionType: optionalString(record.exceptionType),
    culprit: optionalString(record.culprit),
    titleKey: titleKeyValue,
    frames: frames as string[],
  };
}

/**
 * How alike two signatures are, 0–100.
 *
 * 40 for the same exception type, 25 for the same culprit, 25 scaled by how far
 * the two frame lists overlap, 10 scaled by how far their title tokens overlap
 * — most weight on the parts that are hardest to share by accident. A part
 * missing from either side scores zero for that part: two issues that both lack
 * an exception type have told us nothing, and treating "both null" as a match
 * would make every pre-feature row look like every other one.
 */
export function scoreSignatures(a: IssueSignature, b: IssueSignature): number {
  const exceptionType =
    a.exceptionType !== null && a.exceptionType === b.exceptionType ? EXCEPTION_TYPE_WEIGHT : 0;
  const culprit = a.culprit !== null && a.culprit === b.culprit ? CULPRIT_WEIGHT : 0;
  const frames = FRAMES_WEIGHT * overlap(a.frames, b.frames);
  const title = TITLE_WEIGHT * overlap(tokens(a.titleKey), tokens(b.titleKey));

  return Math.round(exceptionType + culprit + frames + title);
}

/**
 * The candidates worth putting in the prompt: those scoring at or above
 * {@link DUPLICATE_SCORE_THRESHOLD}, best first, at most
 * {@link MAX_DUPLICATE_CANDIDATES} of them.
 *
 * Ties keep the order they came in, which from `listSentryDuplicateCandidates`
 * is most recently touched first — of two equally plausible originals, the one
 * still being worked on is the better thing to fold into.
 */
export function rankCandidates(
  subject: IssueSignature,
  candidates: readonly SentryIssue[],
): SentryIssue[] {
  return candidates
    .map((issue) => ({ issue, score: scoreSignatures(subject, candidateSignature(issue)) }))
    .filter((scored) => scored.score >= DUPLICATE_SCORE_THRESHOLD)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_DUPLICATE_CANDIDATES)
    .map((scored) => scored.issue);
}

/**
 * A title with everything that varies between two reports of one defect
 * flattened away: `Undefined array key "17"` and `Undefined array key "42"`
 * both become `undefined array key ?`.
 *
 * The order matters. Quoted strings and hex-looking tokens go first, because
 * they are the parts whose *contents* are noise; only then does every remaining
 * run of digits collapse to `0`, so a bare `line 41` still matches `line 7`.
 * `?` and `0` survive the punctuation strip on purpose — they are the
 * placeholders, and losing them would let two different shapes of message
 * collapse onto the same key.
 */
export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, ' ? ')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ' ? ')
    .replace(/\b0x[0-9a-f]+\b/g, ' ? ')
    .replace(/\b[0-9a-f]{8,}\b/g, (token) =>
      /\d/.test(token) && /[a-f]/.test(token) ? ' ? ' : token,
    )
    .replace(/\d+/g, '0')
    .replace(/[^a-z0-9?\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `/app/src/Handler.php` and `/var/www/src/Handler.php` are the same file seen
 * from two deploy layouts; the signature should not care which container wrote
 * the frame.
 */
export function normalizeFramePath(path: string): string {
  for (const prefix of PATH_PREFIXES) {
    if (path.startsWith(prefix)) return path.slice(prefix.length);
  }
  return path;
}

/**
 * The in-app frames nearest the crash, `file:function`, crashing frame last.
 *
 * Library frames are dropped: two unrelated bugs surfacing through the same
 * framework entry point share those, and a signature made of them would match
 * everything. Chained exceptions are walked until one of them has in-app frames
 * — a wrapper exception often carries none of its own.
 */
function signatureFrames(exceptions: readonly SentryException[]): string[] {
  for (const exception of exceptions) {
    const frames = exception.frames.filter((frame) => frame.inApp);
    if (frames.length > 0) {
      return frames.slice(-MAX_SIGNATURE_FRAMES).map(frameKey);
    }
  }
  return [];
}

function frameKey(frame: SentryStackFrame): string {
  const file = trimmedOrNull(frame.filename) ?? trimmedOrNull(frame.absPath) ?? trimmedOrNull(frame.module);
  const name = trimmedOrNull(frame.function) ?? '?';
  return `${file === null ? '?' : normalizeFramePath(file)}:${name}`;
}

/**
 * How far two lists overlap, 0–1: the size of their intersection over the size
 * of their union, so identical lists give 1 and any pair of empty lists gives 0
 * rather than a free full match.
 */
function overlap(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const value of a) {
    if (b.has(value)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

function tokens(key: string): string[] {
  return key.split(' ').filter((token) => token !== '');
}

function trimmedOrNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
