/**
 * Minimal GitHub REST client. Only the calls chief-web actually needs live
 * here; there is no SDK dependency because a single `fetch` covers it.
 */

/** Codes surfaced to the UI so it can phrase a useful message. */
export type GithubErrorCode =
  | 'github_unauthorized'
  | 'github_forbidden'
  | 'github_not_found'
  | 'github_rejected'
  | 'github_unreachable'
  | 'github_error';

/** A failed GitHub call, carrying a code and a human-readable explanation. */
export class GithubApiError extends Error {
  constructor(
    readonly code: GithubErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

export interface GithubUser {
  /** The account login the token authenticates as, e.g. `octocat`. */
  readonly login: string;
}

/** A pull request, reduced to what chief-web stores and shows. */
export interface PullRequest {
  readonly number: number;
  /** The `html_url`: what the session page links to. */
  readonly url: string;
  readonly state: string;
  /**
   * The GraphQL `node_id`. REST cannot turn a draft into a ready pull
   * request, so undrafting goes through `markPullRequestReadyForReview`, and
   * that mutation accepts nothing but this id. Null when GitHub did not send
   * one.
   */
  readonly nodeId: string | null;
  /** Still a draft. An adopted pull request is frequently already ready. */
  readonly draft: boolean;
}

/** Everything `POST /repos/{owner}/{repo}/pulls` needs. */
export interface PullRequestInput {
  /** `owner/repo`, as stored on the repository. */
  readonly slug: string;
  /** Branch the changes are on. Always a branch of the same repository. */
  readonly head: string;
  /** Branch the pull request targets, e.g. `develop` or `main`. */
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface OpenedPullRequest {
  readonly pullRequest: PullRequest;
  /** True when an open pull request for that head/base already existed. */
  readonly adopted: boolean;
}

/** How long a single GitHub call may take before it is treated as unreachable. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `GET /user` — the cheapest call that proves a token is live and tells us who
 * it belongs to. Used by the Settings page's "Validate" action (US-004).
 */
export async function fetchGithubUser(token: string, baseUrl: string): Promise<GithubUser> {
  const response = await githubFetch(token, url(baseUrl, '/user'), { method: 'GET' });
  if (!response.ok) throw await failureOf(response);

  const login = await readLogin(response);
  if (login === null) {
    throw new GithubApiError('github_error', 'GitHub returned an unexpected response body.');
  }
  return { login };
}

/**
 * Opens the session's pull request, or adopts the one that is already there
 * (US-014).
 *
 * A build that is retried — or one whose branch was pushed and turned into a
 * pull request by hand — must not end in a duplicate or an error, so the
 * existing pull request is looked up *first*. GitHub itself also refuses a
 * duplicate, with a 422, and that answer is treated the same way: look again,
 * and adopt what the race produced.
 */
export async function openPullRequest(
  token: string,
  baseUrl: string,
  input: PullRequestInput,
): Promise<OpenedPullRequest> {
  const existing = await findPullRequest(token, baseUrl, input);
  if (existing !== null) return { pullRequest: existing, adopted: true };

  try {
    return { pullRequest: await createPullRequest(token, baseUrl, input), adopted: false };
  } catch (cause) {
    if (!(cause instanceof GithubApiError) || cause.status !== 422) throw cause;
    const raced = await findPullRequest(token, baseUrl, input);
    if (raced === null) throw cause;
    return { pullRequest: raced, adopted: true };
  }
}

/**
 * The state of one pull request, as GitHub reports it (US-003).
 *
 * `merged` is its own flag rather than a third value of `state`: GitHub says
 * `closed` both for a pull request that was merged and for one that was closed
 * without merging, and telling those two apart is the whole point of the sync.
 */
export interface PullRequestState {
  readonly number: number;
  /** `open` or `closed`, verbatim. */
  readonly state: string;
  readonly merged: boolean;
}

/**
 * `GET /repos/{slug}/pulls/{number}` — one pull request, reduced to whether it
 * is still open and whether it was merged.
 */
export async function fetchPullRequestState(
  token: string,
  baseUrl: string,
  slug: string,
  number: number,
): Promise<PullRequestState> {
  const response = await githubFetch(token, url(baseUrl, `/repos/${slug}/pulls/${String(number)}`), {
    method: 'GET',
  });
  if (!response.ok) throw await failureOf(response);

  const state = toPullRequestState(await response.json().catch(() => null));
  if (state === null) {
    throw new GithubApiError('github_error', 'GitHub returned an unexpected pull request body.');
  }
  return state;
}

/**
 * GitHub's answer to "can this be merged?", which is three-valued (US-001).
 *
 * `unknown` is not a polite way of saying "clean": GitHub computes mergeability
 * lazily, and answers `mergeable: null` until the background job has run. The
 * caller has to be able to tell "there is no conflict" from "nobody has looked
 * yet", because acting on the second as if it were the first would either skip
 * a conflicted pull request forever or start a fix run against a branch that
 * merges fine.
 */
export type Mergeability = 'conflicted' | 'clean' | 'unknown';

/** What the conflict fixer needs to know about one pull request. */
export interface PullRequestMergeability {
  readonly number: number;
  readonly mergeable: Mergeability;
  /**
   * `mergeable_state` verbatim — `dirty`, `clean`, `blocked`, `behind`,
   * `unknown`, … It is undocumented and open-ended, so it is carried as a
   * string for logging and never branched on; {@link mergeable} is the
   * decision. `unknown` when the body did not carry one.
   */
  readonly mergeableState: string;
  readonly headSha: string;
  readonly baseSha: string;
  /** Head branch, unqualified — what a fix run would check out. */
  readonly headRef: string;
  /** Branch the pull request targets, the one that gets merged in. */
  readonly baseRef: string;
  /**
   * The pull request description, verbatim; empty when it has none.
   *
   * Carried because an agent resolving a conflict has to know what the pull
   * request was trying to do — the diff alone does not say which side of a
   * conflicting hunk is the point of the change (US-005).
   */
  readonly body: string;
}

/**
 * `GET /repos/{slug}/pulls/{number}` — the same call as
 * {@link fetchPullRequestState}, read for mergeability instead of open/merged.
 *
 * It is a separate function rather than more fields on `PullRequestState`
 * because the two have different callers with different needs: the sync only
 * ever wants open/merged, and widening its type would make every one of its
 * stubs carry SHAs it does not use.
 */
export async function fetchPullRequestMergeability(
  token: string,
  baseUrl: string,
  slug: string,
  number: number,
): Promise<PullRequestMergeability> {
  const response = await githubFetch(token, url(baseUrl, `/repos/${slug}/pulls/${String(number)}`), {
    method: 'GET',
  });
  if (!response.ok) throw await failureOf(response);

  const mergeability = toPullRequestMergeability(await response.json().catch(() => null));
  if (mergeability === null) {
    throw new GithubApiError('github_error', 'GitHub returned an unexpected pull request body.');
  }
  return mergeability;
}

/** The open pull request for `head` → `base`, or null when there is none. */
export async function findPullRequest(
  token: string,
  baseUrl: string,
  input: Pick<PullRequestInput, 'slug' | 'head' | 'base'>,
): Promise<PullRequest | null> {
  const owner = input.slug.split('/')[0] ?? '';
  const query = new URLSearchParams({
    state: 'open',
    // Cross-repository pull requests are qualified `owner:branch`; chief-web
    // only ever pushes to the repository itself, so the owner is our own.
    head: `${owner}:${input.head}`,
    base: input.base,
    per_page: '1',
  });

  const response = await githubFetch(token, `${url(baseUrl, `/repos/${input.slug}/pulls`)}?${query.toString()}`, {
    method: 'GET',
  });
  if (!response.ok) throw await failureOf(response);

  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body) || body.length === 0) return null;
  return toPullRequest(body[0]);
}

/** `POST /repos/{slug}/pulls`. Rejects with a 422 when one already exists. */
export async function createPullRequest(
  token: string,
  baseUrl: string,
  input: PullRequestInput,
): Promise<PullRequest> {
  const response = await githubFetch(token, url(baseUrl, `/repos/${input.slug}/pulls`), {
    method: 'POST',
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      // Every session pull request starts as a draft; delivery marks it ready
      // once the review — and whatever fixes it asked for — are done (US-001).
      draft: true,
    }),
  });
  if (!response.ok) throw await failureOf(response);

  const created = toPullRequest(await response.json().catch(() => null));
  if (created === null) {
    throw new GithubApiError('github_error', 'GitHub did not return the pull request it created.');
  }
  return created;
}

/** Joins a path onto the API base, tolerating a trailing slash on the base. */
export function url(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * One request, with a network failure turned into `github_unreachable`.
 *
 * The caller's headers are merged *over* these defaults rather than replacing
 * them: the review-thread client (US-021) needs `accept: application/json` for
 * GraphQL but must keep the authorization, version and user-agent headers.
 * Spreading `init` and then assigning `headers` — which is what this did until
 * that second caller arrived — silently discarded whatever the caller passed.
 */
export async function githubFetch(
  token: string,
  target: string,
  init: Omit<RequestInit, 'headers' | 'signal'> & {
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const { headers, ...rest } = init;
  try {
    return await fetch(target, {
      ...rest,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'chief-web',
        ...(headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new GithubApiError(
      'github_unreachable',
      `Could not reach the GitHub API: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Turns a non-2xx answer into the error the operator is shown. */
export async function failureOf(response: Response): Promise<GithubApiError> {
  const detail = await readMessage(response);
  switch (response.status) {
    case 401:
      return new GithubApiError(
        'github_unauthorized',
        `GitHub rejected the token: ${detail ?? 'it is invalid, revoked or expired.'}`,
        401,
      );
    case 403:
      return new GithubApiError(
        'github_forbidden',
        `GitHub refused the request: ${detail ?? 'the token lacks the required permissions.'}`,
        403,
      );
    case 404:
      return new GithubApiError(
        'github_not_found',
        `GitHub found nothing there: ${detail ?? 'the repository does not exist, or the token cannot see it.'}`,
        404,
      );
    case 422:
      return new GithubApiError(
        'github_rejected',
        `GitHub rejected the request: ${detail ?? 'it was well-formed but could not be processed.'}`,
        422,
      );
    default:
      return new GithubApiError(
        'github_error',
        `GitHub returned HTTP ${response.status}${detail === null ? '' : `: ${detail}`}`,
        response.status,
      );
  }
}

function toPullRequest(value: unknown): PullRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as {
    number?: unknown;
    html_url?: unknown;
    state?: unknown;
    node_id?: unknown;
    draft?: unknown;
  };
  if (typeof body.number !== 'number' || typeof body.html_url !== 'string') return null;
  return {
    number: body.number,
    url: body.html_url,
    state: typeof body.state === 'string' ? body.state : 'open',
    // Both the create response and the list entries carry these, so an adopted
    // pull request answers "is it a draft, and what do I undraft?" as fully as
    // one this session created.
    nodeId: typeof body.node_id === 'string' && body.node_id !== '' ? body.node_id : null,
    draft: body.draft === true,
  };
}

/**
 * `merged` is the authoritative field; `merged_at` is only its timestamp and is
 * accepted as a fallback, because a body that carries one without the other
 * still says unambiguously that the pull request was merged.
 */
function toPullRequestState(value: unknown): PullRequestState | null {
  if (typeof value !== 'object' || value === null) return null;
  const body = value as {
    number?: unknown;
    state?: unknown;
    merged?: unknown;
    merged_at?: unknown;
  };
  if (typeof body.number !== 'number') return null;
  return {
    number: body.number,
    state: typeof body.state === 'string' ? body.state : 'open',
    merged: body.merged === true || typeof body.merged_at === 'string',
  };
}

/**
 * A body counts as usable only when it carries the identity of both sides —
 * number, head ref/SHA and base ref/SHA. Missing `mergeable` is *not* malformed:
 * that is precisely how GitHub says "still computing".
 */
function toPullRequestMergeability(value: unknown): PullRequestMergeability | null {
  const body = asRecord(value);
  const head = body === null ? null : asRecord(body['head']);
  const base = body === null ? null : asRecord(body['base']);
  if (body === null || head === null || base === null) return null;
  if (typeof body['number'] !== 'number') return null;

  const headRef = readField(head, 'ref');
  const headSha = readField(head, 'sha');
  const baseRef = readField(base, 'ref');
  const baseSha = readField(base, 'sha');
  if (headRef === null || headSha === null || baseRef === null || baseSha === null) return null;

  return {
    number: body['number'],
    mergeable: toMergeability(body['mergeable']),
    mergeableState: readField(body, 'mergeable_state') ?? 'unknown',
    headSha,
    baseSha,
    headRef,
    baseRef,
    body: readField(body, 'body') ?? '',
  };
}

/**
 * Anything that is not literally `true` or `false` — `null`, a missing key, or
 * a value of some other shape — is "GitHub has not decided", never "clean".
 */
function toMergeability(value: unknown): Mergeability {
  if (value === true) return 'clean';
  if (value === false) return 'conflicted';
  return 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readField(record: Record<string, unknown>, key: string): string | null {
  const found = record[key];
  return typeof found === 'string' && found !== '' ? found : null;
}

async function readLogin(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null || !('login' in body)) return null;
  const login = (body as { login: unknown }).login;
  return typeof login === 'string' && login !== '' ? login : null;
}

/**
 * GitHub error bodies carry a `message`, and a 422 additionally carries an
 * `errors` array whose entries say what was actually wrong ("No commits
 * between main and chief/x") — the useful half, so both are kept.
 */
async function readMessage(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) return null;

  const message = (body as { message?: unknown }).message;
  const head = typeof message === 'string' && message !== '' ? message : null;
  const details = readErrorDetails((body as { errors?: unknown }).errors);
  if (head === null) return details;
  return details === null ? head : `${head} (${details})`;
}

function readErrorDetails(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const messages = errors
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (typeof entry !== 'object' || entry === null) return null;
      const detail = (entry as { message?: unknown }).message;
      return typeof detail === 'string' && detail !== '' ? detail : null;
    })
    .filter((entry): entry is string => entry !== null);
  return messages.length === 0 ? null : messages.join('; ');
}
