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

/**
 * Bounds for the per-iteration agent timeout, in minutes (US-019). One minute
 * is short enough to be a deliberate "fail fast" and long enough for a real
 * `claude -p` to at least start; twelve hours is well past the point where a
 * stuck agent should have been noticed.
 */
export const MIN_AGENT_TIMEOUT_MINUTES = 1;
export const MAX_AGENT_TIMEOUT_MINUTES = 720;

const MS_PER_MINUTE = 60_000;

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
  /** Cap on one headless agent iteration of the build loop, in minutes. */
  readonly agentTimeoutMinutes: number;
  readonly gitAuthorName: string;
  readonly gitAuthorEmail: string;
}

export interface AppSettingsUpdate {
  /** A new token, or `null` to remove the stored one. Omitted leaves it alone. */
  readonly githubToken?: string | null;
  readonly maxConcurrentSessions?: number;
  readonly agentTimeoutMinutes?: number;
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

/**
 * How many sessions may build at the same time (US-004, enforced in US-018).
 *
 * The env var is only the default: once the operator has saved a value on the
 * settings page, the row wins. Clamped to the bounds the settings route
 * validates, so a value written straight into the database — or an
 * `MAX_CONCURRENT_SESSIONS=0` in the environment — cannot wedge the queue with
 * a cap no build can ever fit under.
 */
export function getMaxConcurrentSessions(
  db: Database,
  config: Pick<Config, 'maxConcurrentSessions'>,
): number {
  const stored = getSettingNumber(db, 'max_concurrent_sessions', config.maxConcurrentSessions);
  return Math.min(MAX_CONCURRENT_SESSIONS, Math.max(MIN_CONCURRENT_SESSIONS, stored));
}

/**
 * How long one headless `claude -p` iteration may run before it is cut short
 * and counted as a failed attempt (US-019).
 *
 * Same shape as {@link getMaxConcurrentSessions}: `BUILD_ITERATION_TIMEOUT_MS`
 * is only the default, the settings row wins once the operator has saved one,
 * and it is read on every iteration so a change applies to the next one with no
 * restart. Only a *stored* value is clamped — the environment is allowed to set
 * anything, which is what lets a test run the loop with a millisecond timeout.
 */
export function getAgentTimeoutMs(
  db: Database,
  config: Pick<Config, 'buildIterationTimeoutMs'>,
): number {
  const stored = getSettingNumber(db, 'agent_timeout_minutes', 0);
  if (stored <= 0) return config.buildIterationTimeoutMs;
  return clampAgentTimeoutMinutes(stored) * MS_PER_MINUTE;
}

function clampAgentTimeoutMinutes(minutes: number): number {
  return Math.min(MAX_AGENT_TIMEOUT_MINUTES, Math.max(MIN_AGENT_TIMEOUT_MINUTES, minutes));
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
    agentTimeoutMinutes: Math.round(getAgentTimeoutMs(db, config) / MS_PER_MINUTE),
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

    if (update.agentTimeoutMinutes !== undefined) {
      setSettingNumber(db, 'agent_timeout_minutes', update.agentTimeoutMinutes);
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
