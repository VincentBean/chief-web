import type { Config } from '../config.js';
import {
  type Database,
  deleteSetting,
  getSetting,
  getSettingNumber,
  setSetting,
  setSettingNumber,
  withTransaction,
} from '../db/index.js';

/** Bounds for the max-concurrent-builds setting (US-004, enforced in US-018). */
export const MIN_CONCURRENT_SESSIONS = 1;
export const MAX_CONCURRENT_SESSIONS = 50;

/** How many trailing characters of the GitHub token the UI may see. */
const VISIBLE_TOKEN_CHARS = 4;

/**
 * What the API is allowed to say about the stored token: whether one exists
 * and its last four characters. The token itself never leaves the server after
 * it has been saved.
 */
export interface GithubTokenView {
  readonly configured: boolean;
  readonly last4: string | null;
}

export interface AppSettings {
  readonly githubToken: GithubTokenView;
  readonly maxConcurrentSessions: number;
}

export interface AppSettingsUpdate {
  /** A new token, or `null` to remove the stored one. Omitted leaves it alone. */
  readonly githubToken?: string | null;
  readonly maxConcurrentSessions?: number;
}

/** Everything but the last four characters is unrecoverable from this view. */
export function maskToken(token: string): GithubTokenView {
  return { configured: true, last4: token.slice(-VISIBLE_TOKEN_CHARS) };
}

const NO_TOKEN: GithubTokenView = { configured: false, last4: null };

/** The stored PAT, for the code that talks to GitHub on the operator's behalf. */
export function getGithubToken(db: Database): string | null {
  return getSetting(db, 'github_token');
}

export function readAppSettings(db: Database, config: Config): AppSettings {
  const token = getGithubToken(db);
  return {
    githubToken: token === null ? NO_TOKEN : maskToken(token),
    // The env var is only the default: once saved, the settings row wins.
    maxConcurrentSessions: getSettingNumber(
      db,
      'max_concurrent_sessions',
      config.maxConcurrentSessions,
    ),
  };
}

export function updateAppSettings(
  db: Database,
  config: Config,
  update: AppSettingsUpdate,
): AppSettings {
  withTransaction(db, () => {
    if (update.githubToken === null) deleteSetting(db, 'github_token');
    else if (update.githubToken !== undefined) setSetting(db, 'github_token', update.githubToken);

    if (update.maxConcurrentSessions !== undefined) {
      setSettingNumber(db, 'max_concurrent_sessions', update.maxConcurrentSessions);
    }
  });

  return readAppSettings(db, config);
}
