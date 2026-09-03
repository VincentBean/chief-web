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

/**
 * Models an agent may be run on, as Claude Code's own `--model` values.
 *
 * These are the CLI's *aliases* rather than pinned ids (`claude-opus-5`), so
 * they keep meaning the latest model of each family as the pinned CLI version
 * in `runner/Dockerfile` moves. The CLI resolves an unknown name locally and
 * only warns, so the allowlist is chief-web's own: a typo becomes a settings
 * error instead of a whole build run on a model nobody chose.
 *
 * Adding a family — or a pinned id, which `--model` also takes — is this list
 * plus nothing else.
 */
export const AGENT_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export type AgentModel = (typeof AGENT_MODELS)[number];

export function isAgentModel(value: string): value is AgentModel {
  return (AGENT_MODELS as readonly string[]).includes(value);
}

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
  /** Model the planning terminal runs on; `null` leaves the CLI to choose. */
  readonly planningModel: AgentModel | null;
  /** Model each build iteration runs on; `null` leaves the CLI to choose. */
  readonly buildModel: AgentModel | null;
  /** Model the automatic code review runs on; `null` leaves the CLI to choose. */
  readonly reviewModel: AgentModel | null;
  /** Whether new sessions are created with the code-review flag already on. */
  readonly codeReviewDefault: boolean;
  readonly gitAuthorName: string;
  readonly gitAuthorEmail: string;
}

export interface AppSettingsUpdate {
  /** A new token, or `null` to remove the stored one. Omitted leaves it alone. */
  readonly githubToken?: string | null;
  readonly maxConcurrentSessions?: number;
  readonly agentTimeoutMinutes?: number;
  /** `null` hands the choice back to the CLI; omitted leaves the stored value. */
  readonly planningModel?: AgentModel | null;
  readonly buildModel?: AgentModel | null;
  readonly reviewModel?: AgentModel | null;
  readonly codeReviewDefault?: boolean;
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

/**
 * Which model the interactive planning `claude` runs on, or `null` to pass no
 * `--model` at all and let the CLI apply its own default.
 *
 * A stored value that is no longer in {@link AGENT_MODELS} — a hand-edited row,
 * or a family dropped from a later runner image — reads as `null` rather than
 * being passed through. The same fail-safe reasoning as clamping the
 * concurrency cap: the default always runs, an unknown name might not.
 */
export function getPlanningModel(db: Database): AgentModel | null {
  return readModel(db, 'planning_model');
}

/** As above, for the headless `claude -p` of each build iteration. */
export function getBuildModel(db: Database): AgentModel | null {
  return readModel(db, 'build_model');
}

/** As above, for the headless review pass over a session's pull request. */
export function getReviewModel(db: Database): AgentModel | null {
  return readModel(db, 'review_model');
}

function readModel(
  db: Database,
  key: 'planning_model' | 'build_model' | 'review_model',
): AgentModel | null {
  const stored = getSetting(db, key);
  return stored !== null && isAgentModel(stored) ? stored : null;
}

/**
 * Whether a session created without an explicit `codeReview` gets the flag.
 *
 * Read at creation time rather than copied into new sessions by the web form,
 * so a session created straight over the API honours the default too. Only the
 * default is global: once a session exists its own flag is what counts, and
 * changing this leaves existing sessions alone.
 */
export function getCodeReviewDefault(db: Database): boolean {
  return getSetting(db, 'code_review_default') === '1';
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
    planningModel: getPlanningModel(db),
    buildModel: getBuildModel(db),
    reviewModel: getReviewModel(db),
    codeReviewDefault: getCodeReviewDefault(db),
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

    // For every model `null` clears the row, which is what "let the CLI
    // choose" is stored as — there is no sentinel model name for it.
    if (update.planningModel === null) deleteSetting(db, 'planning_model');
    else if (update.planningModel !== undefined) {
      setSetting(db, 'planning_model', update.planningModel);
    }

    if (update.buildModel === null) deleteSetting(db, 'build_model');
    else if (update.buildModel !== undefined) setSetting(db, 'build_model', update.buildModel);

    if (update.reviewModel === null) deleteSetting(db, 'review_model');
    else if (update.reviewModel !== undefined) setSetting(db, 'review_model', update.reviewModel);

    if (update.codeReviewDefault !== undefined) {
      setSetting(db, 'code_review_default', update.codeReviewDefault ? '1' : '0');
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
