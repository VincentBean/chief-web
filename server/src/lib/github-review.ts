import {
  failureOf,
  GithubApiError,
  type GithubErrorCode,
  githubFetch,
  REQUEST_TIMEOUT_MS,
  url,
} from './github.js';

/**
 * Reading pull requests and their review feedback (US-021).
 *
 * Separate from `github.ts` because it needs two things that client does not:
 * GraphQL — review threads carry `isResolved` and the node id
 * `resolveReviewThread` wants, neither of which REST exposes — and pagination,
 * which nothing in chief-web had needed before.
 */

/** Pages a paginator follows before it gives up and reports `truncated`. */
export const MAX_PAGES = 5;

/** Repositories queried at once when listing across all of them. */
export const LIST_CONCURRENCY = 4;

/** Whole-repository deadline for a list, pagination included. */
export const LIST_REPO_BUDGET_MS = 20_000;

/**
 * The GraphQL endpoint for a REST base URL.
 *
 * `https://api.github.com` → `https://api.github.com/graphql`, but a GitHub
 * Enterprise install is `https://host/api/v3` → `https://host/api/graphql` —
 * the one case appending `/graphql` gets wrong.
 */
export function graphqlUrlFor(restBaseUrl: string): string {
  const base = restBaseUrl.replace(/\/+$/, '');
  return base.endsWith('/api/v3') ? `${base.slice(0, -'/v3'.length)}/graphql` : `${base}/graphql`;
}

/**
 * `POST /graphql`.
 *
 * GraphQL answers **200 with an `errors` array** where REST answers 403 or 404,
 * so the status code alone is not the outcome: a permission failure here looks
 * like a success until the body is read. The errors are mapped onto the same
 * {@link GithubErrorCode}s the REST client produces, so callers and the UI have
 * one error vocabulary rather than two.
 */
export async function githubGraphql<T>(
  token: string,
  graphqlUrl: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const response = await githubFetch(
    token,
    graphqlUrl,
    {
      method: 'POST',
      // GraphQL answers plain JSON; the REST media type would be a lie.
      headers: { accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    },
    timeoutMs,
  );
  if (!response.ok) throw await failureOf(response);

  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    throw new GithubApiError('github_error', 'GitHub returned an unexpected GraphQL response.');
  }

  const errors = (body as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) throw graphqlFailure(errors);

  const data = (body as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) {
    throw new GithubApiError('github_error', 'GitHub returned a GraphQL response with no data.');
  }
  return data as T;
}

/** Maps GraphQL's own error types onto the REST client's codes. */
function graphqlFailure(errors: readonly unknown[]): GithubApiError {
  const first = errors[0];
  const type = readString(first, 'type');
  const message =
    errors
      .map((entry) => readString(entry, 'message'))
      .filter((text): text is string => text !== null)
      .join('; ') || 'GitHub rejected the GraphQL query.';

  switch (type) {
    case 'FORBIDDEN':
    case 'INSUFFICIENT_SCOPES':
      return new GithubApiError('github_forbidden', `GitHub refused the request: ${message}`, 403);
    case 'NOT_FOUND':
      return new GithubApiError('github_not_found', `GitHub found nothing there: ${message}`, 404);
    case 'RATE_LIMITED':
      return new GithubApiError(
        'github_forbidden',
        `GitHub rate-limited the request: ${message}`,
        403,
      );
    default:
      return new GithubApiError('github_error', `GitHub rejected the GraphQL query: ${message}`);
  }
}

/**
 * Follows `Link: <…>; rel="next"` until there is no next page.
 *
 * Bounded rather than trusted: a paginator that cannot end is a hang, and a
 * repository with more than {@link MAX_PAGES} pages of *open* pull requests is a
 * mis-registration rather than a list anyone wants rendered. The next URL must
 * share an origin with the first — a redirect must never carry the token to
 * another host.
 */
export async function paginate<T>(
  token: string,
  firstUrl: string,
  read: (body: unknown) => readonly T[],
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ items: T[]; truncated: boolean }> {
  const origin = new URL(firstUrl).origin;
  const items: T[] = [];
  let next: string | null = firstUrl;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (next === null) return { items, truncated: false };

    const response: Response = await githubFetch(token, next, { method: 'GET' }, timeoutMs);
    if (!response.ok) throw await failureOf(response);
    items.push(...read(await response.json().catch(() => null)));

    const following = nextLink(response.headers.get('link'));
    next = following !== null && new URL(following).origin === origin ? following : null;
  }

  return { items, truncated: next !== null };
}

/** The `rel="next"` URL of a `Link` header, or null when there is none. */
export function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*(.+)$/.exec(part);
    if (match && /\brel\s*=\s*"?next"?/.test(match[2] ?? '')) return match[1] ?? null;
  }
  return null;
}

export interface OpenPullRequest {
  readonly number: number;
  readonly title: string;
  /** The `html_url`: what the UI links to. */
  readonly url: string;
  /** Head branch, unqualified — what gets checked out. */
  readonly headRef: string;
  readonly headSha: string;
  /** `owner/repo` the head lives on; null when a fork has been deleted. */
  readonly headSlug: string | null;
  readonly baseRef: string;
  /** The head is not on this repository, so the deploy key cannot push to it. */
  readonly fromFork: boolean;
  readonly draft: boolean;
  readonly authorLogin: string | null;
  readonly updatedAt: string;
}

/** Every open pull request of one repository, oldest page first. */
export async function listOpenPullRequests(
  token: string,
  baseUrl: string,
  slug: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ pullRequests: OpenPullRequest[]; truncated: boolean }> {
  const query = new URLSearchParams({ state: 'open', per_page: '100', sort: 'updated', direction: 'desc' });
  const { items, truncated } = await paginate(
    token,
    `${url(baseUrl, `/repos/${slug}/pulls`)}?${query.toString()}`,
    (body) => (Array.isArray(body) ? body.map((entry) => toOpenPullRequest(entry, slug)) : []),
    timeoutMs,
  );
  return {
    pullRequests: items.filter((entry): entry is OpenPullRequest => entry !== null),
    truncated,
  };
}

/** One repository's slice of the list: its pull requests, or why there are none. */
export interface RepositoryPullRequests {
  readonly slug: string;
  readonly pullRequests: readonly OpenPullRequest[];
  readonly error: GithubErrorCode | null;
  readonly message: string | null;
  readonly truncated: boolean;
}

/**
 * Every open pull request of every slug, at most {@link LIST_CONCURRENCY} in
 * flight.
 *
 * One repository's failure is that repository's failure and nothing else's: a
 * slug the token lost access to, or a remote that has gone slow, comes back with
 * an `error` beside an empty list while the others come back with theirs. This
 * page is a *list* — half a list plus a named reason beats a single 502.
 */
export async function listOpenPullRequestsAcross(
  token: string,
  baseUrl: string,
  slugs: readonly string[],
): Promise<RepositoryPullRequests[]> {
  const results: RepositoryPullRequests[] = new Array<RepositoryPullRequests>(slugs.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const slug = slugs[index];
      if (slug === undefined) return;

      try {
        const { pullRequests, truncated } = await listOpenPullRequests(
          token,
          baseUrl,
          slug,
          LIST_REPO_BUDGET_MS,
        );
        results[index] = { slug, pullRequests, error: null, message: null, truncated };
      } catch (cause) {
        const failure =
          cause instanceof GithubApiError
            ? cause
            : new GithubApiError('github_error', String(cause));
        results[index] = {
          slug,
          pullRequests: [],
          error: failure.code,
          message: failure.message,
          truncated: false,
        };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(LIST_CONCURRENCY, slugs.length) }, () => worker()),
  );
  return results;
}

function toOpenPullRequest(value: unknown, slug: string): OpenPullRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const head = asRecord(raw['head']);
  const base = asRecord(raw['base']);
  const headRepo = head === null ? null : asRecord(head['repo']);
  const headSlug = headRepo === null ? null : readString(headRepo, 'full_name');

  const number = raw['number'];
  const headRef = head === null ? null : readString(head, 'ref');
  if (typeof number !== 'number' || headRef === null) return null;

  return {
    number,
    title: readString(raw, 'title') ?? '',
    url: readString(raw, 'html_url') ?? '',
    headRef,
    headSha: (head === null ? null : readString(head, 'sha')) ?? '',
    headSlug,
    baseRef: (base === null ? null : readString(base, 'ref')) ?? '',
    // Three independent signals, because getting this wrong means a run that
    // fixes the code and then cannot deliver it.
    fromFork: headRepo === null || headSlug === null || headSlug !== slug,
    draft: raw['draft'] === true,
    authorLogin: readString(asRecord(raw['user']) ?? {}, 'login'),
    updatedAt: readString(raw, 'updated_at') ?? '',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown, key: string): string | null {
  const record = asRecord(value);
  if (record === null) return null;
  const found = record[key];
  return typeof found === 'string' && found !== '' ? found : null;
}

/* -------------------------------------------------------------- feedback -- */

export interface ReviewComment {
  /** REST id: the reply endpoint addresses comments by this, never by node id. */
  readonly databaseId: number | null;
  readonly authorLogin: string | null;
  /** `User`, `Bot`, `Organization`… Recorded, never filtered on — the threads
   *  worth acting on are frequently a review bot's. */
  readonly authorType: string | null;
  readonly body: string;
  readonly url: string;
}

export interface ReviewThread {
  /** GraphQL node id; the only thing `resolveReviewThread` accepts. */
  readonly id: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly viewerCanReply: boolean;
  readonly viewerCanResolve: boolean;
  readonly path: string | null;
  /** `line` goes null once a thread is outdated; `originalLine` is the fallback. */
  readonly line: number | null;
  /** Oldest first. `[0]` is the only comment a reply may target. */
  readonly comments: readonly ReviewComment[];
}

export interface ReviewSummary {
  readonly id: string;
  readonly authorLogin: string | null;
  readonly authorType: string | null;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  readonly state: string;
  readonly body: string;
  readonly url: string;
  readonly submittedAt: string | null;
}

export interface PullRequestFeedback {
  readonly slug: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  /** OPEN | CLOSED | MERGED */
  readonly state: string;
  readonly headRef: string;
  readonly headSha: string;
  readonly headSlug: string | null;
  readonly baseRef: string;
  readonly fromFork: boolean;
  readonly threads: readonly ReviewThread[];
  readonly reviews: readonly ReviewSummary[];
  /** A page limit was hit, so this is not all of the feedback. */
  readonly truncated: boolean;
}

/**
 * Exported so a test can assert the query still asks for everything the reply
 * and resolve steps depend on — `databaseId` and `id` especially, which are
 * easy to drop while editing and produce a feature that silently stops writing.
 */
export const PULL_REQUEST_FEEDBACK_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state title url isCrossRepository headRefName headRefOid baseRefName
      headRepository { nameWithOwner }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated viewerCanReply viewerCanResolve path line originalLine
          comments(first: 20) {
            pageInfo { hasNextPage }
            nodes { databaseId body url author { login __typename } }
          }
        }
      }
      reviews(first: 100) {
        pageInfo { hasNextPage }
        nodes { id state body url submittedAt author { login __typename } }
      }
    }
  }
}`;

/** Everything one pull request's feedback needs, in a single round trip. */
export async function fetchPullRequestFeedback(
  token: string,
  graphqlUrl: string,
  slug: string,
  number: number,
): Promise<PullRequestFeedback> {
  const [owner, name] = slug.split('/');
  if (owner === undefined || name === undefined) {
    throw new GithubApiError('github_error', `"${slug}" is not a GitHub owner/repo slug.`);
  }

  const data = await githubGraphql<{ repository?: { pullRequest?: unknown } | null }>(
    token,
    graphqlUrl,
    PULL_REQUEST_FEEDBACK_QUERY,
    { owner, name, number },
  );

  const pr = asRecord(data.repository?.pullRequest);
  if (pr === null) {
    throw new GithubApiError('github_not_found', `GitHub has no pull request ${slug}#${String(number)}.`);
  }

  const threadPage = asRecord(pr['reviewThreads']);
  const reviewPage = asRecord(pr['reviews']);
  const headSlug = readString(asRecord(pr['headRepository']) ?? {}, 'nameWithOwner');
  const threads = nodesOf(threadPage).map(toReviewThread).filter(isPresent);
  const reviews = nodesOf(reviewPage).map(toReviewSummary).filter(isPresent);

  return {
    slug,
    number,
    title: readString(pr, 'title') ?? '',
    url: readString(pr, 'url') ?? '',
    state: readString(pr, 'state') ?? 'OPEN',
    headRef: readString(pr, 'headRefName') ?? '',
    headSha: readString(pr, 'headRefOid') ?? '',
    headSlug,
    baseRef: readString(pr, 'baseRefName') ?? '',
    fromFork: pr['isCrossRepository'] === true || headSlug === null || headSlug !== slug,
    threads,
    reviews,
    truncated:
      hasNextPage(threadPage) ||
      hasNextPage(reviewPage) ||
      nodesOf(threadPage).some((node) => hasNextPage(asRecord(asRecord(node)?.['comments']))),
  };
}

/** The cheap re-check taken immediately before a push. */
export async function fetchPullRequestHead(
  token: string,
  graphqlUrl: string,
  slug: string,
  number: number,
): Promise<{ state: string; headSha: string }> {
  const feedback = await fetchPullRequestFeedback(token, graphqlUrl, slug, number);
  return { state: feedback.state, headSha: feedback.headSha };
}

function toReviewThread(value: unknown): ReviewThread | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const id = readString(raw, 'id');
  if (id === null) return null;

  const line = raw['line'];
  const originalLine = raw['originalLine'];
  return {
    id,
    isResolved: raw['isResolved'] === true,
    isOutdated: raw['isOutdated'] === true,
    viewerCanReply: raw['viewerCanReply'] === true,
    viewerCanResolve: raw['viewerCanResolve'] === true,
    path: readString(raw, 'path'),
    line: typeof line === 'number' ? line : typeof originalLine === 'number' ? originalLine : null,
    comments: nodesOf(asRecord(raw['comments'])).map(toReviewComment).filter(isPresent),
  };
}

function toReviewComment(value: unknown): ReviewComment | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const databaseId = raw['databaseId'];
  const author = asRecord(raw['author']);
  return {
    databaseId: typeof databaseId === 'number' ? databaseId : null,
    authorLogin: author === null ? null : readString(author, 'login'),
    authorType: author === null ? null : readString(author, '__typename'),
    body: readString(raw, 'body') ?? '',
    url: readString(raw, 'url') ?? '',
  };
}

function toReviewSummary(value: unknown): ReviewSummary | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const id = readString(raw, 'id');
  const body = readString(raw, 'body');
  // A review with no body is a bare approval; there is nothing to act on.
  if (id === null || body === null) return null;
  const author = asRecord(raw['author']);
  return {
    id,
    authorLogin: author === null ? null : readString(author, 'login'),
    authorType: author === null ? null : readString(author, '__typename'),
    state: readString(raw, 'state') ?? 'COMMENTED',
    body,
    url: readString(raw, 'url') ?? '',
    submittedAt: readString(raw, 'submittedAt'),
  };
}

function nodesOf(page: Record<string, unknown> | null): unknown[] {
  const nodes = page === null ? null : page['nodes'];
  return Array.isArray(nodes) ? nodes : [];
}

function hasNextPage(page: Record<string, unknown> | null): boolean {
  const info = page === null ? null : asRecord(page['pageInfo']);
  return info !== null && info['hasNextPage'] === true;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/* ----------------------------------------------------------------- writes -- */

/**
 * `POST /repos/{slug}/pulls/{number}/comments/{commentId}/replies`.
 *
 * `commentId` must be the **first** comment of the thread: GitHub answers
 * "Replies to replies are not supported" for anything else, which is why
 * {@link ReviewThread.comments} is kept in order and only `[0]` is ever used.
 * 201 is the only success.
 */
export async function replyToReviewThread(
  token: string,
  baseUrl: string,
  slug: string,
  number: number,
  commentId: number,
  body: string,
): Promise<{ id: number; url: string }> {
  const response = await githubFetch(
    token,
    url(baseUrl, `/repos/${slug}/pulls/${String(number)}/comments/${String(commentId)}/replies`),
    { method: 'POST', body: JSON.stringify({ body }) },
  );
  if (response.status !== 201) throw await failureOf(response);

  const created = asRecord(await response.json().catch(() => null));
  const id = created === null ? null : created['id'];
  return {
    id: typeof id === 'number' ? id : 0,
    url: (created === null ? null : readString(created, 'html_url')) ?? '',
  };
}

/** The mutation, exported so a test can assert it still sends what it must. */
export const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

/**
 * `resolveReviewThread(input: { threadId })`.
 *
 * Idempotent in the only sense that matters here: a thread that is already
 * resolved comes back resolved rather than rejected, so a re-run over a partly
 * finished run does not have to remember what it did.
 */
export async function resolveReviewThread(
  token: string,
  graphqlUrl: string,
  threadId: string,
): Promise<{ isResolved: boolean }> {
  const data = await githubGraphql<{ resolveReviewThread?: { thread?: unknown } | null }>(
    token,
    graphqlUrl,
    RESOLVE_THREAD_MUTATION,
    { threadId },
  );
  const thread = asRecord(data.resolveReviewThread?.thread);
  return { isResolved: thread !== null && thread['isResolved'] === true };
}
