import { randomUUID } from 'node:crypto';

import { changeCount, type Database, nowIso, type Row, text } from './sqlite.js';

/**
 * A login saved for a repository (voice feedback US-010), picked from the
 * "watch with me" card instead of typed again. The password is only ever read
 * back by the server, to write it into a session container's answer file.
 */
export interface RepositoryLogin {
  readonly id: string;
  readonly repositoryId: string;
  readonly label: string;
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly createdAt: string;
}

export interface CreateRepositoryLoginInput {
  readonly repositoryId: string;
  readonly label: string;
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

function mapRepositoryLogin(row: Row): RepositoryLogin {
  return {
    id: text(row, 'id'),
    repositoryId: text(row, 'repository_id'),
    label: text(row, 'label'),
    url: text(row, 'url'),
    username: text(row, 'username'),
    password: text(row, 'password'),
    createdAt: text(row, 'created_at'),
  };
}

/** A repository's saved logins, oldest first. */
export function listRepositoryLogins(db: Database, repositoryId: string): RepositoryLogin[] {
  return db
    .prepare('SELECT * FROM repository_logins WHERE repository_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(repositoryId)
    .map(mapRepositoryLogin);
}

export function getRepositoryLogin(db: Database, id: string): RepositoryLogin | null {
  const row = db.prepare('SELECT * FROM repository_logins WHERE id = ?').get(id);
  return row ? mapRepositoryLogin(row) : null;
}

export function createRepositoryLogin(db: Database, input: CreateRepositoryLoginInput): RepositoryLogin {
  const login: RepositoryLogin = { id: randomUUID(), ...input, createdAt: nowIso() };
  db.prepare(
    `INSERT INTO repository_logins (id, repository_id, label, url, username, password, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(login.id, login.repositoryId, login.label, login.url, login.username, login.password, login.createdAt);
  return login;
}

export function deleteRepositoryLogin(db: Database, id: string): boolean {
  return changeCount(db.prepare('DELETE FROM repository_logins WHERE id = ?').run(id)) > 0;
}
