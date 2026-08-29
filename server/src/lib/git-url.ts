/**
 * Git remote URL helpers.
 *
 * Repositories are registered with an SSH URL (`git@github.com:owner/repo.git`),
 * and the GitHub `owner/repo` slug used by the PR API (US-014) is derived from
 * it. The operator can always override the derived slug, so parsing only has to
 * cover the common shapes rather than every exotic remote.
 */

/** `[user@]host:path` — the scp-like form git uses for SSH remotes. */
const SCP_LIKE = /^(?:[^\s@/]+@)?([^\s@/:]+):(.+)$/;

/** GitHub owners and repository names, as accepted by the REST API. */
export const GITHUB_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ParsedGitUrl {
  readonly host: string;
  /** Repository path without a leading slash or the trailing `.git`. */
  readonly path: string;
}

function stripPath(raw: string): string {
  let value = raw.trim();
  while (value.startsWith('/')) value = value.slice(1);
  while (value.endsWith('/')) value = value.slice(0, -1);
  if (value.toLowerCase().endsWith('.git')) value = value.slice(0, -'.git'.length);
  return value;
}

/**
 * Splits a git remote into host and repository path, accepting both the
 * scp-like form and a full URL (`ssh://`, `https://`, `git://`).
 * Returns `null` when the string is not a usable remote.
 */
export function parseGitUrl(raw: string): ParsedGitUrl | null {
  const url = raw.trim();
  if (url === '') return null;

  if (url.includes('://')) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const path = stripPath(parsed.pathname);
    if (parsed.hostname === '' || path === '') return null;
    return { host: parsed.hostname, path };
  }

  const match = SCP_LIKE.exec(url);
  const host = match?.[1];
  const rest = match?.[2];
  if (host === undefined || rest === undefined) return null;
  const path = stripPath(rest);
  if (path === '') return null;
  return { host, path };
}

export function isValidGitUrl(raw: string): boolean {
  return parseGitUrl(raw) !== null;
}

export function isValidGithubSlug(slug: string): boolean {
  return GITHUB_SLUG_PATTERN.test(slug);
}

/**
 * Best-effort `owner/repo` for a remote. The host is not checked, so a GitHub
 * Enterprise remote derives a slug too; anything that is not exactly two path
 * segments returns `null` and the operator has to type the slug.
 */
export function deriveGithubSlug(url: string): string | null {
  const parsed = parseGitUrl(url);
  if (parsed === null) return null;
  const segments = parsed.path.split('/').filter((segment) => segment !== '');
  if (segments.length !== 2) return null;
  const slug = segments.join('/');
  return isValidGithubSlug(slug) ? slug : null;
}
