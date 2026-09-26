import {
  createRepositoryLogin,
  type Database,
  deleteRepositoryLogin,
  getRepository,
  getRepositoryLogin,
  getSession,
  listRepositoryLogins,
  type RepositoryLogin,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { BrowserSavedLogins } from '../voice/browser-ask.js';
import { MAX_CREDENTIAL_CHARS, parseBrowserUrl } from '../voice/protocol.js';
import { RepositoryError } from './service.js';

/** Longest label a saved login takes, in characters. */
export const MAX_LOGIN_LABEL_LENGTH = 100;

/** A saved login as the API returns it: never the password. */
export interface RepositoryLoginView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly username: string;
  readonly created_at: string;
}

/** What `POST /api/repositories/:id/logins` and the card's "Save this login" hand in. */
export interface SaveRepositoryLoginRequest {
  readonly label?: string;
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

export function toRepositoryLoginView(login: RepositoryLogin): RepositoryLoginView {
  return {
    id: login.id,
    label: login.label,
    url: login.url,
    username: login.username,
    created_at: login.createdAt,
  };
}

/** `staging.example.com (admin)`, or just the host for a password-only login. */
export function defaultLoginLabel(url: string, username: string): string {
  const host = new URL(url).host;
  return username === '' ? host : `${host} (${username})`;
}

function requireRepository(db: Database, repositoryId: string): void {
  if (getRepository(db, repositoryId) === null) {
    throw new RepositoryError(404, 'repository_not_found', 'No such repository.');
  }
}

export function listRepositoryLoginViews(db: Database, repositoryId: string): RepositoryLoginView[] {
  requireRepository(db, repositoryId);
  return listRepositoryLogins(db, repositoryId).map(toRepositoryLoginView);
}

/**
 * Validates and stores a login: the one code path behind both the
 * Repositories page and "Save this login" on the "watch with me" card.
 */
export function saveRepositoryLogin(
  db: Database,
  repositoryId: string,
  request: SaveRepositoryLoginRequest,
): RepositoryLoginView {
  requireRepository(db, repositoryId);
  const url = parseBrowserUrl(request.url);
  if (url === null) {
    throw new RepositoryError(400, 'invalid_url', 'Enter a full http:// or https:// address.');
  }
  const username = request.username.trim();
  if (username.length > MAX_CREDENTIAL_CHARS) {
    throw new RepositoryError(400, 'invalid_username', `The username must be at most ${MAX_CREDENTIAL_CHARS} characters.`);
  }
  if (request.password === '' || request.password.length > MAX_CREDENTIAL_CHARS) {
    throw new RepositoryError(400, 'invalid_password', `A password of at most ${MAX_CREDENTIAL_CHARS} characters is required.`);
  }
  const label = request.label?.trim() ?? '';
  if (label.length > MAX_LOGIN_LABEL_LENGTH) {
    throw new RepositoryError(400, 'invalid_label', `The label must be at most ${MAX_LOGIN_LABEL_LENGTH} characters.`);
  }
  const login = createRepositoryLogin(db, {
    repositoryId,
    label: label === '' ? defaultLoginLabel(url, username) : label,
    url,
    username,
    password: request.password,
  });
  return toRepositoryLoginView(login);
}

export function deleteRepositoryLoginOf(db: Database, repositoryId: string, loginId: string): void {
  requireRepository(db, repositoryId);
  const login = getRepositoryLogin(db, loginId);
  if (login === null || login.repositoryId !== repositoryId) {
    throw new RepositoryError(404, 'login_not_found', 'No such saved login.');
  }
  deleteRepositoryLogin(db, loginId);
}

/**
 * The "watch with me" card's view of the saved logins (US-007's
 * `BrowserSavedLogins`): those of the session's repository. A saved login is
 * resolved to its password here, on the server, only when the answer file is
 * written.
 */
export function createBrowserSavedLogins(db: Database): BrowserSavedLogins {
  const repositoryOf = (sessionId: string): string | null => getSession(db, sessionId)?.repositoryId ?? null;
  return {
    list(sessionId) {
      const repositoryId = repositoryOf(sessionId);
      if (repositoryId === null) return [];
      return listRepositoryLogins(db, repositoryId).map((login) => ({ id: login.id, label: login.label, url: login.url }));
    },
    resolve(sessionId, savedLoginId) {
      const login = getRepositoryLogin(db, savedLoginId);
      if (login === null || login.repositoryId !== repositoryOf(sessionId)) return null;
      return { username: login.username, password: login.password };
    },
    save(sessionId, login) {
      const repositoryId = repositoryOf(sessionId);
      if (repositoryId === null) return;
      try {
        saveRepositoryLogin(db, repositoryId, login);
      } catch (cause) {
        // The page still opens; only the saving is lost.
        logger.warn('a login from the watch-with-me card could not be saved', {
          sessionId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
  };
}
