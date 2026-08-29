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
 * Commit identity used inside runner containers (US-006). The same defaults are
 * baked into the runner image, so a container started without these environment
 * variables still commits successfully.
 */
export const DEFAULT_GIT_AUTHOR_NAME = 'chief-web';
export const DEFAULT_GIT_AUTHOR_EMAIL = 'chief-web@localhost';

/** Upper bound on both identity fields; git itself has no limit worth hitting. */
const MAX_GIT_IDENTITY_CHARS = 200;

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

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
  readonly gitAuthorName: string;
  readonly gitAuthorEmail: string;
}

export interface AppSettingsUpdate {
  /** A new token, or `null` to remove the stored one. Omitted leaves it alone. */
  readonly githubToken?: string | null;
  readonly maxConcurrentSessions?: number;
  /** `null` restores the built-in default; omitted leaves the stored value. */
  readonly gitAuthorName?: string | null;
  readonly gitAuthorEmail?: string | null;
}

/**
 * `git commit` refuses a name containing `<`, `>` or a line break, and an empty
 * one leaves the commit unattributable — reject both here so the problem shows
 * up on the settings page instead of halfway through a build.
 */
export function isValidGitAuthorName(value: string): boolean {
  return value.trim() !== '' && value.length <= MAX_GIT_IDENTITY_CHARS && !/[<>\n\r]/.test(value);
}

/** As above, plus a shape check: an address git can put between angle brackets. */
export function isValidGitAuthorEmail(value: string): boolean {
  return value.length <= MAX_GIT_IDENTITY_CHARS && /^[^\s<>@]+@[^\s<>@]+$/.test(value);
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

/** The commit identity runner containers are started with (US-006). */
export function getGitIdentity(db: Database): GitIdentity {
  return {
    name: getSetting(db, 'git_author_name') ?? DEFAULT_GIT_AUTHOR_NAME,
    email: getSetting(db, 'git_author_email') ?? DEFAULT_GIT_AUTHOR_EMAIL,
  };
}

export function readAppSettings(db: Database, config: Config): AppSettings {
  const token = getGithubToken(db);
  const identity = getGitIdentity(db);
  return {
    githubToken: token === null ? NO_TOKEN : maskToken(token),
    // The env var is only the default: once saved, the settings row wins.
    maxConcurrentSessions: getSettingNumber(
      db,
      'max_concurrent_sessions',
      config.maxConcurrentSessions,
    ),
    gitAuthorName: identity.name,
    gitAuthorEmail: identity.email,
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

    // `null` clears the row, which makes the built-in default apply again.
    if (update.gitAuthorName === null) deleteSetting(db, 'git_author_name');
    else if (update.gitAuthorName !== undefined) {
      setSetting(db, 'git_author_name', update.gitAuthorName);
    }

    if (update.gitAuthorEmail === null) deleteSetting(db, 'git_author_email');
    else if (update.gitAuthorEmail !== undefined) {
      setSetting(db, 'git_author_email', update.gitAuthorEmail);
    }
  });

  return readAppSettings(db, config);
}
