import { randomUUID } from 'node:crypto';

import { changeCount, type Database, nowIso, nullableText, type Row, text } from './sqlite.js';

/** Whether chief-web generated the deploy key or the operator pasted one. */
export const REPOSITORY_KEY_SOURCES = ['generated', 'imported'] as const;
export type RepositoryKeySource = (typeof REPOSITORY_KEY_SOURCES)[number];

export interface Repository {
  readonly id: string;
  /** Human-readable label, unique across the install. */
  readonly name: string;
  /** Clone URL, e.g. `git@github.com:owner/repo.git`. */
  readonly sshUrl: string;
  /** GitHub `owner/repo` slug used by the PR API (US-014). */
  readonly githubSlug: string;
  /** Branch new sessions branch from unless overridden. */
  readonly defaultBaseBranch: string;
  /**
   * The `authorized_keys` line for the repository's deploy key. Public by
   * definition; the private half only ever lives on the data volume (US-005).
   */
  readonly publicKey: string | null;
  /** `SHA256:…` fingerprint of `publicKey`, for matching against GitHub. */
  readonly keyFingerprint: string | null;
  readonly keySource: RepositoryKeySource | null;
  /**
   * The Sentry org and project slugs whose issues this repository owns
   * (US-001). Both are set together or neither is: an org without a project
   * addresses nothing, and NULL on both is what "not linked" means.
   */
  readonly sentryOrg: string | null;
  readonly sentryProject: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRepositoryInput {
  readonly name: string;
  readonly sshUrl: string;
  readonly githubSlug: string;
  readonly defaultBaseBranch?: string;
  readonly publicKey?: string | null;
  readonly keyFingerprint?: string | null;
  readonly keySource?: RepositoryKeySource | null;
  readonly sentryOrg?: string | null;
  readonly sentryProject?: string | null;
}

export interface UpdateRepositoryInput {
  readonly name?: string;
  readonly sshUrl?: string;
  readonly githubSlug?: string;
  readonly defaultBaseBranch?: string;
  readonly publicKey?: string | null;
  readonly keyFingerprint?: string | null;
  readonly keySource?: RepositoryKeySource | null;
  readonly sentryOrg?: string | null;
  readonly sentryProject?: string | null;
}

const COLUMNS: Record<keyof UpdateRepositoryInput, string> = {
  name: 'name',
  sshUrl: 'ssh_url',
  githubSlug: 'github_slug',
  defaultBaseBranch: 'default_base_branch',
  publicKey: 'public_key',
  keyFingerprint: 'key_fingerprint',
  keySource: 'key_source',
  sentryOrg: 'sentry_org',
  sentryProject: 'sentry_project',
};

function keySourceOf(row: Row): RepositoryKeySource | null {
  const value = nullableText(row, 'key_source');
  if (value === null) return null;
  if (!(REPOSITORY_KEY_SOURCES as readonly string[]).includes(value)) {
    throw new Error(`Unexpected value for column "key_source": ${JSON.stringify(value)}`);
  }
  return value as RepositoryKeySource;
}

export function mapRepository(row: Row): Repository {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    sshUrl: text(row, 'ssh_url'),
    githubSlug: text(row, 'github_slug'),
    defaultBaseBranch: text(row, 'default_base_branch'),
    publicKey: nullableText(row, 'public_key'),
    keyFingerprint: nullableText(row, 'key_fingerprint'),
    keySource: keySourceOf(row),
    sentryOrg: nullableText(row, 'sentry_org'),
    sentryProject: nullableText(row, 'sentry_project'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

export function createRepository(db: Database, input: CreateRepositoryInput): Repository {
  const now = nowIso();
  const repository: Repository = {
    id: randomUUID(),
    name: input.name,
    sshUrl: input.sshUrl,
    githubSlug: input.githubSlug,
    defaultBaseBranch: input.defaultBaseBranch ?? 'main',
    publicKey: input.publicKey ?? null,
    keyFingerprint: input.keyFingerprint ?? null,
    keySource: input.keySource ?? null,
    sentryOrg: input.sentryOrg ?? null,
    sentryProject: input.sentryProject ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO repositories
       (id, name, ssh_url, github_slug, default_base_branch,
        public_key, key_fingerprint, key_source, sentry_org, sentry_project,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    repository.id,
    repository.name,
    repository.sshUrl,
    repository.githubSlug,
    repository.defaultBaseBranch,
    repository.publicKey,
    repository.keyFingerprint,
    repository.keySource,
    repository.sentryOrg,
    repository.sentryProject,
    repository.createdAt,
    repository.updatedAt,
  );

  return repository;
}

export function getRepository(db: Database, id: string): Repository | null {
  const row = db.prepare('SELECT * FROM repositories WHERE id = ?').get(id);
  return row ? mapRepository(row) : null;
}

export function getRepositoryByName(db: Database, name: string): Repository | null {
  const row = db.prepare('SELECT * FROM repositories WHERE name = ?').get(name);
  return row ? mapRepository(row) : null;
}

export function listRepositories(db: Database): Repository[] {
  return db
    .prepare('SELECT * FROM repositories ORDER BY name COLLATE NOCASE ASC')
    .all()
    .map(mapRepository);
}

/** Applies the provided fields only; returns the updated row, or null if absent. */
export function updateRepository(
  db: Database,
  id: string,
  patch: UpdateRepositoryInput,
): Repository | null {
  const assignments: string[] = [];
  const params: Record<string, string | null> = { ':id': id, ':updated_at': nowIso() };

  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = patch[field as keyof UpdateRepositoryInput];
    if (value === undefined) continue;
    assignments.push(`${column} = :${column}`);
    params[`:${column}`] = value;
  }

  if (assignments.length > 0) {
    assignments.push('updated_at = :updated_at');
    db.prepare(`UPDATE repositories SET ${assignments.join(', ')} WHERE id = :id`).run(params);
  }

  return getRepository(db, id);
}

/**
 * Deletes a repository. Sessions reference it with `ON DELETE RESTRICT`, so this
 * throws while any session still points at it (US-005).
 */
export function deleteRepository(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM repositories WHERE id = ?').run(id)) > 0;
}
