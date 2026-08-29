/**
 * Minimal GitHub REST client. Only the calls chief-web actually needs live
 * here; there is no SDK dependency because a single `fetch` covers it.
 */

/** Codes surfaced to the UI so it can phrase a useful message. */
export type GithubErrorCode =
  | 'github_unauthorized'
  | 'github_forbidden'
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

/** How long a validation call may take before it is treated as unreachable. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `GET /user` — the cheapest call that proves a token is live and tells us who
 * it belongs to. Used by the Settings page's "Validate" action (US-004).
 */
export async function fetchGithubUser(token: string, baseUrl: string): Promise<GithubUser> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/user`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'chief-web',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new GithubApiError(
      'github_unreachable',
      `Could not reach the GitHub API: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (response.ok) {
    const login = await readLogin(response);
    if (login === null) {
      throw new GithubApiError('github_error', 'GitHub returned an unexpected response body.');
    }
    return { login };
  }

  const detail = await readMessage(response);
  if (response.status === 401) {
    throw new GithubApiError(
      'github_unauthorized',
      `GitHub rejected the token: ${detail ?? 'it is invalid, revoked or expired.'}`,
      401,
    );
  }
  if (response.status === 403) {
    throw new GithubApiError(
      'github_forbidden',
      `GitHub refused the request: ${detail ?? 'the token lacks the required permissions.'}`,
      403,
    );
  }
  throw new GithubApiError(
    'github_error',
    `GitHub returned HTTP ${response.status}${detail === null ? '' : `: ${detail}`}`,
    response.status,
  );
}

async function readLogin(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null || !('login' in body)) return null;
  const login = (body as { login: unknown }).login;
  return typeof login === 'string' && login !== '' ? login : null;
}

/** GitHub error bodies carry a `message`; fall back to nothing when absent. */
async function readMessage(response: Response): Promise<string | null> {
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null || !('message' in body)) return null;
  const message = (body as { message: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : null;
}
