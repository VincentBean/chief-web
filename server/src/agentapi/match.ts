import { type Database, listRepositories, type Repository } from '../db/index.js';
import { normalizeRemote } from './remote.js';

export type RemoteMatch =
  | { readonly kind: 'invalid' }
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly repository: Repository }
  | { readonly kind: 'many'; readonly repositories: readonly Repository[] };

const GITHUB_HOST = 'github.com';

/**
 * Finds the repositories a local agent's `origin` belongs to: the normalized
 * remote equals the normalized `sshUrl`, or — for a github.com remote — its
 * `owner/repo` equals the `githubSlug`, ignoring case.
 */
export function matchRemote(db: Database, remote: string): RemoteMatch {
  const key = normalizeRemote(remote);
  if (key === null) return { kind: 'invalid' };
  const slug = key.startsWith(`${GITHUB_HOST}/`) ? key.slice(GITHUB_HOST.length + 1) : null;

  const matches = listRepositories(db).filter(
    (repository) =>
      normalizeRemote(repository.sshUrl) === key ||
      (slug !== null && repository.githubSlug.toLowerCase() === slug),
  );

  if (matches.length === 0) return { kind: 'none' };
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { kind: 'one', repository: only };
  return { kind: 'many', repositories: matches };
}
