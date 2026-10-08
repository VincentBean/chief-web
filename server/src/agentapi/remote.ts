import { parseGitUrl } from '../lib/git-url.js';

/** URL schemes a git `origin` can use; anything else (e.g. `file://`) is not a remote we can match. */
const REMOTE_SCHEMES = new Set(['ssh:', 'git+ssh:', 'ssh+git:', 'https:', 'http:', 'git:']);

/**
 * The comparison key of a git remote (send-to-chief US-005): lowercase
 * `host/owner/repo`, without user, port, `.git` suffix or trailing slash, so
 * `git@github.com:Owner/Repo.git` and `https://github.com/owner/repo/` meet.
 * Returns `null` for anything that is not an scp-like or URL remote with at
 * least an owner and a repository segment.
 */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.includes('://')) {
    const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(trimmed)?.[0].toLowerCase();
    if (scheme === undefined || !REMOTE_SCHEMES.has(scheme)) return null;
  }
  const parsed = parseGitUrl(trimmed);
  if (parsed === null) return null;
  const segments = parsed.path.split('/');
  if (segments.length < 2 || segments.some((segment) => segment === '')) return null;
  return `${parsed.host}/${segments.join('/')}`.toLowerCase();
}
