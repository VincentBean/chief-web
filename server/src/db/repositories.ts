import { randomUUID } from 'node:crypto';

import { changeCount, type Database, nowIso, type Row, text } from './sqlite.js';

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
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateRepositoryInput {
  readonly name: string;
  readonly sshUrl: string;
  readonly githubSlug: string;
  readonly defaultBaseBranch?: string;
}

export interface UpdateRepositoryInput {
  readonly name?: string;
  readonly sshUrl?: string;
  readonly githubSlug?: string;
  readonly defaultBaseBranch?: string;
}

const COLUMNS: Record<keyof UpdateRepositoryInput, string> = {
  name: 'name',
  sshUrl: 'ssh_url',
  githubSlug: 'github_slug',
  defaultBaseBranch: 'default_base_branch',
};

export function mapRepository(row: Row): Repository {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    sshUrl: text(row, 'ssh_url'),
    githubSlug: text(row, 'github_slug'),
    defaultBaseBranch: text(row, 'default_base_branch'),
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
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO repositories
       (id, name, ssh_url, github_slug, default_base_branch, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    repository.id,
    repository.name,
    repository.sshUrl,
    repository.githubSlug,
    repository.defaultBaseBranch,
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
  const params: Record<string, string> = { ':id': id, ':updated_at': nowIso() };

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
