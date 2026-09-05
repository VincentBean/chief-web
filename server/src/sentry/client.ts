/**
 * Minimal Sentry web API client (US-004).
 *
 * Same shape as `server/src/lib/github.ts`: no SDK, one `fetch`, and every
 * failure — HTTP or network — converted into a single typed error class so a
 * caller can `catch (e) { if (e instanceof SentryApiError) … }` and know it has
 * seen everything this module can produce.
 *
 * The base URL comes from the `sentry_base_url` setting, so a self-hosted
 * install is the same code with a different root. Every path here is
 * organization-scoped (`/organizations/{org}/…`), which both sentry.io and
 * current self-hosted Sentry serve.
 */

import type { Database } from '../db/index.js';
import { getSentryBaseUrl, getSentryToken } from '../settings/index.js';

/**
 * The classes of failure a caller can act on: a bad token, a thing that is not
 * there, a rate limit worth waiting out, an unreachable host, and everything
 * else.
 */
export type SentryErrorCode =
  | 'sentry_unauthorized'
  | 'sentry_not_found'
  | 'sentry_rate_limited'
  | 'sentry_unreachable'
  | 'sentry_error';

/** A failed Sentry call. The only error type this module ever rejects with. */
export class SentryApiError extends Error {
  constructor(
    readonly code: SentryErrorCode,
    message: string,
    readonly status?: number,
    /** How long Sentry asked us to wait, when it said so (429 only). */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'SentryApiError';
  }
}

/** An unresolved issue, reduced to the columns `sentry_issues` stores. */
export interface SentryIssueSummary {
  readonly id: string;
  readonly shortId: string;
  readonly title: string;
  readonly culprit: string | null;
  readonly permalink: string;
  readonly level: string | null;
  /**
   * Sentry’s own status — `unresolved`, `resolved` or `ignored` — or null when the
   * payload carried none. The list endpoint already asks for unresolved issues
   * only, so this is what lets the poller state that guarantee itself rather
   * than inherit it from a query string.
   */
  readonly status: string | null;
  /** How many times the issue has been seen. Sentry sends it as a string. */
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
}

/** One frame of a stacktrace, with the fields worth putting in a prompt. */
export interface SentryStackFrame {
  readonly filename: string | null;
  readonly function: string | null;
  readonly module: string | null;
  readonly absPath: string | null;
  readonly lineNo: number | null;
  readonly colNo: number | null;
  readonly contextLine: string | null;
  /** False for framework/vendor frames; the app's own frames are the useful ones. */
  readonly inApp: boolean;
}

/** One exception of the chain, outermost first as Sentry orders them. */
export interface SentryException {
  readonly type: string | null;
  readonly value: string | null;
  readonly module: string | null;
  /** Ordered as Sentry sends them: caller first, crashing frame last. */
  readonly frames: readonly SentryStackFrame[];
}

export interface SentryBreadcrumb {
  readonly timestamp: string | null;
  readonly type: string | null;
  readonly category: string | null;
  readonly level: string | null;
  readonly message: string | null;
}

export interface SentryTag {
  readonly key: string;
  readonly value: string;
}

/** The latest event of an issue: the concrete occurrence, with its context. */
export interface SentryEvent {
  readonly id: string | null;
  readonly message: string | null;
  readonly platform: string | null;
  readonly dateCreated: string | null;
  readonly exceptions: readonly SentryException[];
  readonly tags: readonly SentryTag[];
  readonly breadcrumbs: readonly SentryBreadcrumb[];
}

/**
 * An issue plus its latest event. `latestEvent` is null when Sentry has no
 * event left for the issue (retention) — that is a normal answer, not an error,
 * and the classifier simply gets less to work with.
 */
export interface SentryIssueDetails {
  readonly issue: SentryIssueSummary;
  readonly latestEvent: SentryEvent | null;
}

/** How long a single Sentry call may take before it counts as unreachable. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How many pages of issues one `listUnresolvedIssues` call will follow.
 *
 * Sentry's default page is 25 issues, so this is 500 — far more than a poll
 * tick should ever ingest, and a hard stop against a `Link` header that keeps
 * claiming there is a next page.
 */
export const MAX_ISSUE_PAGES = 20;

/** Issues per page. Sentry's own maximum for this endpoint is 100. */
export const ISSUES_PER_PAGE = 100;

export class SentryClient {
  constructor(
    private readonly token: string,
    /** Root of the API, e.g. `https://sentry.io/api/0/`. */
    private readonly baseUrl: string,
    private readonly timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  /**
   * Every unresolved issue of one project, following Sentry's `Link` header
   * until it says there is no next page (or {@link MAX_ISSUE_PAGES} pages have
   * been read).
   *
   * `query=is:unresolved` is what keeps resolved and ignored issues out: Sentry
   * treats "ignored" as its own status, and neither belongs in the pipeline.
   */
  async listUnresolvedIssues(org: string, project: string): Promise<SentryIssueSummary[]> {
    const first = new URL(
      joinUrl(this.baseUrl, `/projects/${encode(org)}/${encode(project)}/issues/`),
    );
    first.searchParams.set('query', 'is:unresolved');
    first.searchParams.set('statsPeriod', '');
    first.searchParams.set('limit', String(ISSUES_PER_PAGE));

    const issues: SentryIssueSummary[] = [];
    let target: string | null = first.toString();

    for (let page = 0; page < MAX_ISSUE_PAGES && target !== null; page += 1) {
      const response: Response = await this.request('GET', target);
      const body: unknown = await readJson(response);
      if (!Array.isArray(body)) {
        throw new SentryApiError('sentry_error', 'Sentry did not return a list of issues.');
      }
      for (const entry of body) {
        const issue = toIssueSummary(entry);
        if (issue !== null) issues.push(issue);
      }
      target = nextPageUrl(response.headers.get('link'));
    }

    return issues;
  }

  /**
   * One issue plus its latest event — the stacktrace, message, tags and
   * breadcrumbs the classifier and the generated PRD are built from.
   */
  async getIssueDetails(org: string, issueId: string): Promise<SentryIssueDetails> {
    const issueBody: unknown = await readJson(
      await this.request('GET', this.url(`/organizations/${encode(org)}/issues/${encode(issueId)}/`)),
    );
    const issue = toIssueSummary(issueBody);
    if (issue === null) {
      throw new SentryApiError('sentry_error', 'Sentry did not return a usable issue.');
    }
    return { issue, latestEvent: await this.fetchLatestEvent(org, issueId) };
  }

  /** Marks the issue resolved in Sentry (US-008). */
  async resolveIssue(org: string, issueId: string): Promise<void> {
    await this.request(
      'PUT',
      this.url(`/organizations/${encode(org)}/issues/${encode(issueId)}/`),
      JSON.stringify({ status: 'resolved' }),
    );
  }

  /**
   * A retention-expired issue has no latest event, and Sentry says so with a
   * 404. That is not a failure of the call — the issue itself was just read
   * successfully — so it reads as "no event", and every other error still
   * surfaces.
   */
  private async fetchLatestEvent(org: string, issueId: string): Promise<SentryEvent | null> {
    try {
      const response = await this.request(
        'GET',
        this.url(`/organizations/${encode(org)}/issues/${encode(issueId)}/events/latest/`),
      );
      return toEvent(await readJson(response));
    } catch (cause) {
      if (cause instanceof SentryApiError && cause.code === 'sentry_not_found') return null;
      throw cause;
    }
  }

  private url(path: string): string {
    return joinUrl(this.baseUrl, path);
  }

  /**
   * One request. A network failure, a timeout or a non-2xx answer all leave
   * here as a {@link SentryApiError}, so nothing else can escape a client
   * method.
   */
  private async request(method: string, target: string, body?: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(target, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'chief-web',
        },
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new SentryApiError(
        'sentry_unreachable',
        `Could not reach the Sentry API: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!response.ok) throw await failureOf(response);
    return response;
  }
}

/**
 * The client the poller and the resolver use, or null when no token has been
 * configured — "Sentry is not set up" is the normal state of an install that
 * does not use it, and is not worth an exception at every call site.
 */
export function createSentryClient(db: Database): SentryClient | null {
  const token = getSentryToken(db);
  if (token === null || token === '') return null;
  return new SentryClient(token, getSentryBaseUrl(db));
}

/** Turns a non-2xx answer into the typed error the caller sees. */
export async function failureOf(response: Response): Promise<SentryApiError> {
  const detail = await readDetail(response);
  switch (response.status) {
    case 401:
      return new SentryApiError(
        'sentry_unauthorized',
        `Sentry rejected the token: ${detail ?? 'it is invalid, revoked or expired.'}`,
        401,
      );
    case 403:
      return new SentryApiError(
        'sentry_unauthorized',
        `Sentry refused the request: ${detail ?? 'the token lacks the required scopes.'}`,
        403,
      );
    case 404:
      return new SentryApiError(
        'sentry_not_found',
        `Sentry found nothing there: ${detail ?? 'the organization, project or issue does not exist, or the token cannot see it.'}`,
        404,
      );
    case 429:
      return new SentryApiError(
        'sentry_rate_limited',
        `Sentry rate-limited the request${detail === null ? '.' : `: ${detail}`}`,
        429,
        retryAfterMs(response),
      );
    default:
      return new SentryApiError(
        'sentry_error',
        `Sentry returned HTTP ${String(response.status)}${detail === null ? '' : `: ${detail}`}`,
        response.status,
      );
  }
}

/**
 * `Retry-After` is seconds; `X-Sentry-Rate-Limit-Reset` is an absolute unix
 * timestamp. Either is a usable "wait this long", and neither being present is
 * fine — the poller falls back to its own interval.
 */
function retryAfterMs(response: Response): number | undefined {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.round(retryAfter * 1000);

  const reset = Number(response.headers.get('x-sentry-rate-limit-reset'));
  if (!Number.isFinite(reset) || reset <= 0) return undefined;
  const remaining = reset * 1000 - Date.now();
  return remaining > 0 ? Math.round(remaining) : undefined;
}

/** Joins a path onto the API root, tolerating a trailing slash on the root. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Path segments are slugs and ids, but never trust them into a URL unescaped. */
function encode(segment: string): string {
  return encodeURIComponent(segment);
}

/**
 * The `next` URL of a Sentry `Link` header, or null when there is no further
 * page.
 *
 * Sentry always sends a `next` link — cursor pagination has no notion of an
 * end — and marks the empty one with `results="false"`, so that attribute, not
 * the link's presence, is what terminates the walk. Anything that is not an
 * absolute http(s) URL is refused rather than followed.
 */
export function nextPageUrl(header: string | null): string | null {
  if (header === null) return null;

  for (const part of splitLinks(header)) {
    const match = /^<([^>]*)>(.*)$/.exec(part.trim());
    if (match === null) continue;
    const [, target = '', rest = ''] = match;
    const attributes = rest.toLowerCase();
    if (!/;\s*rel\s*=\s*"?next"?/.test(attributes)) continue;
    if (/;\s*results\s*=\s*"?false"?/.test(attributes)) return null;
    return isHttpUrl(target) ? target : null;
  }
  return null;
}

/**
 * Splits on the commas that separate links, ignoring the ones inside `<…>` —
 * a cursor is opaque and may contain anything.
 */
function splitLinks(header: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of header) {
    if (character === '<') depth += 1;
    else if (character === '>') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A body that is not JSON is a malformed answer, not a crash. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SentryApiError(
      'sentry_error',
      'Sentry returned a response that is not JSON.',
      response.status,
    );
  }
}

/**
 * Sentry error bodies are inconsistent: `{"detail": "…"}` is the common one,
 * `{"detail": {"message": "…"}}` comes back from the rate limiter, and some
 * endpoints answer with a bare list of strings.
 */
async function readDetail(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body === 'string') return body === '' ? null : body;
  const record = asRecord(body);
  if (record === null) return null;

  const detail = record['detail'];
  if (typeof detail === 'string' && detail !== '') return detail;
  const nested = asRecord(detail);
  if (nested !== null) return readString(nested, 'message');
  return readString(record, 'message') ?? readString(record, 'error');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * An entry is usable only when it carries the identity the pipeline keys on —
 * `id` and `shortId` — plus the two timestamps `sentry_issues` requires. The
 * nullable columns (`culprit`, `level`) are genuinely absent for plenty of
 * issue types and must never disqualify a row.
 */
function toIssueSummary(value: unknown): SentryIssueSummary | null {
  const record = asRecord(value);
  if (record === null) return null;

  const id = readString(record, 'id');
  const shortId = readString(record, 'shortId');
  const firstSeen = readString(record, 'firstSeen');
  const lastSeen = readString(record, 'lastSeen');
  if (id === null || shortId === null || firstSeen === null || lastSeen === null) return null;

  return {
    id,
    shortId,
    title: readString(record, 'title') ?? shortId,
    culprit: readString(record, 'culprit'),
    permalink: readString(record, 'permalink') ?? '',
    level: readString(record, 'level'),
    status: readString(record, 'status'),
    // Sentry sends `count` as a decimal string ("1043"), not a number.
    count: readNumber(record, 'count') ?? 0,
    firstSeen,
    lastSeen,
  };
}

/**
 * The latest-event body. Stacktrace, breadcrumbs and the formatted message all
 * live in `entries`, a heterogeneous list keyed by `type`; tags are top-level.
 */
function toEvent(value: unknown): SentryEvent | null {
  const record = asRecord(value);
  if (record === null) return null;

  const entries = Array.isArray(record['entries']) ? record['entries'] : [];
  return {
    id: readString(record, 'eventID') ?? readString(record, 'id'),
    message: readString(record, 'message') ?? messageEntry(entries),
    platform: readString(record, 'platform'),
    dateCreated: readString(record, 'dateCreated'),
    exceptions: exceptionEntries(entries),
    tags: toTags(record['tags']),
    breadcrumbs: breadcrumbEntries(entries),
  };
}

/** The `data` of the first entry of that `type`, or null. */
function entryData(entries: readonly unknown[], type: string): Record<string, unknown> | null {
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === null || record['type'] !== type) continue;
    const data = asRecord(record['data']);
    if (data !== null) return data;
  }
  return null;
}

function messageEntry(entries: readonly unknown[]): string | null {
  const data = entryData(entries, 'message');
  if (data === null) return null;
  return readString(data, 'formatted') ?? readString(data, 'message');
}

function exceptionEntries(entries: readonly unknown[]): SentryException[] {
  const data = entryData(entries, 'exception');
  const values = data === null ? null : data['values'];
  if (!Array.isArray(values)) return [];

  const exceptions: SentryException[] = [];
  for (const value of values) {
    const record = asRecord(value);
    if (record === null) continue;
    exceptions.push({
      type: readString(record, 'type'),
      value: readString(record, 'value'),
      module: readString(record, 'module'),
      frames: toFrames(record['stacktrace']),
    });
  }
  return exceptions;
}

function toFrames(value: unknown): SentryStackFrame[] {
  const stacktrace = asRecord(value);
  const frames = stacktrace === null ? null : stacktrace['frames'];
  if (!Array.isArray(frames)) return [];

  const parsed: SentryStackFrame[] = [];
  for (const frame of frames) {
    const record = asRecord(frame);
    if (record === null) continue;
    parsed.push({
      filename: readString(record, 'filename'),
      function: readString(record, 'function'),
      module: readString(record, 'module'),
      absPath: readString(record, 'absPath'),
      lineNo: readNumber(record, 'lineNo'),
      colNo: readNumber(record, 'colNo'),
      contextLine: readString(record, 'context_line') ?? readString(record, 'contextLine'),
      inApp: record['inApp'] === true,
    });
  }
  return parsed;
}

function breadcrumbEntries(entries: readonly unknown[]): SentryBreadcrumb[] {
  const data = entryData(entries, 'breadcrumbs');
  const values = data === null ? null : data['values'];
  if (!Array.isArray(values)) return [];

  const breadcrumbs: SentryBreadcrumb[] = [];
  for (const value of values) {
    const record = asRecord(value);
    if (record === null) continue;
    breadcrumbs.push({
      timestamp: readString(record, 'timestamp'),
      type: readString(record, 'type'),
      category: readString(record, 'category'),
      level: readString(record, 'level'),
      message: readString(record, 'message'),
    });
  }
  return breadcrumbs;
}

/** Tags come as `[{key, value}]`; anything without both is dropped. */
function toTags(value: unknown): SentryTag[] {
  if (!Array.isArray(value)) return [];
  const tags: SentryTag[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) continue;
    const key = readString(record, 'key');
    const tagValue = readString(record, 'value');
    if (key === null || tagValue === null) continue;
    tags.push({ key, value: tagValue });
  }
  return tags;
}
