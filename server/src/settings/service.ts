import type { Config } from '../config.js';
import {
  type Database,
  deleteSetting,
  getSetting,
  getSettingNumber,
  setSetting,
  type SettingKey,
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
 * Bounds for the pull request sync interval, in minutes (US-004). One minute
 * is the floor `PR_SYNC_INTERVAL_MS` already enforces — below that the poll
 * costs more GitHub rate budget than the freshness is worth — and a day is the
 * point past which the sync has stopped being a sync.
 */
export const MIN_PR_SYNC_INTERVAL_MINUTES = 1;
export const MAX_PR_SYNC_INTERVAL_MINUTES = 1440;

/**
 * Bounds for the merge conflict scan interval, in minutes (US-004). The same
 * reasoning and the same bounds as the pull request sync above: the scan costs
 * one listing per repository plus one request per candidate pull request, so
 * the floor is what keeps the GitHub budget in hand, and past a day a scan is
 * no longer a scan.
 */
export const MIN_PR_CONFLICT_INTERVAL_MINUTES = 1;
export const MAX_PR_CONFLICT_INTERVAL_MINUTES = 1440;

/**
 * Bounds for the Sentry poll interval, in minutes (US-002). The same reasoning
 * as the pull request sync above — a floor that keeps the Sentry rate budget in
 * hand, and a ceiling past which a poll is no longer a poll.
 */
export const MIN_SENTRY_POLL_INTERVAL_MINUTES = 1;
export const MAX_SENTRY_POLL_INTERVAL_MINUTES = 1440;

/** How often Sentry is polled when the operator has not chosen (US-002). */
export const DEFAULT_SENTRY_POLL_INTERVAL_MINUTES = 15;

/**
 * Bounds on how many issues one planning pass may plan (US-010). One is the
 * floor because a pass that plans nothing is a pass that has been turned off
 * without saying so — the Sentry poll interval is where "less often" belongs —
 * and ten is the ceiling because every plan is an agent in its own right, so
 * an error storm at a higher number is a fleet rather than a queue.
 */
export const MIN_SENTRY_PLANS_PER_TICK = 1;
export const MAX_SENTRY_PLANS_PER_TICK = 10;

/** How many issues a pass plans when the operator has not chosen (US-010). */
export const DEFAULT_SENTRY_PLANS_PER_TICK = 2;

/** Sentry's own hosted API; overridden per install for self-hosted Sentry. */
export const DEFAULT_SENTRY_BASE_URL = 'https://sentry.io/api/0/';

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

/**
 * Models Claude Code accepts as an `--advisor`.
 *
 * A strict subset of {@link AGENT_MODELS}: Haiku is deliberately absent because
 * the CLI refuses it outright — `The model "haiku" cannot be used as an
 * advisor.` — and it refuses at launch, which kills the whole build iteration
 * rather than degrading it. Keeping Haiku out of this list is what makes an
 * unusable advisor unsavable instead of unbuildable.
 *
 * This is the whole rule (US-006). The CLI also wants an advisor to be at
 * least as capable as the model it advises, but it treats a weaker advisor as
 * a warning rather than a launch failure: `--model opus --advisor sonnet`
 * prints `"sonnet" cannot advise "claude-opus-5" … The advisor will not be
 * used for the main model.` on stderr and runs the iteration to completion,
 * exit 0. chief-web does not refuse those pairs, because refusing them would
 * reject a configuration that works.
 */
export const ADVISOR_MODELS = ['opus', 'sonnet', 'fable'] as const;

export type AdvisorModel = (typeof ADVISOR_MODELS)[number];

export function isAdvisorModel(value: string): value is AdvisorModel {
  return (ADVISOR_MODELS as readonly string[]).includes(value);
}

/**
 * Which model plans a Sentry issue — the one call that triages it and writes
 * its proposed fix plan (US-002, presented as the *planning model* since
 * US-010). One cheap one-shot call per issue, so this defaults to the cheapest
 * family rather than to "let the CLI choose" — a planning pass accidentally
 * running on Opus is the expensive mistake this default exists to prevent.
 */
export const DEFAULT_SENTRY_MODEL: AgentModel = 'haiku';

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
  /** The Sentry auth token, masked the same way the GitHub one is (US-002). */
  readonly sentryToken: GithubTokenView;
  /** How often Sentry is polled for new unresolved issues, in minutes. */
  readonly sentryPollIntervalMinutes: number;
  /** Model the one-shot triage-and-plan call runs on; never `null`. */
  readonly sentryModel: AgentModel;
  /** How many issues one planning pass may plan, across every repository. */
  readonly sentryPlansPerTick: number;
  /** Root of the Sentry API; a self-hosted install points this at itself. */
  readonly sentryBaseUrl: string;
  readonly maxConcurrentSessions: number;
  /** Cap on one headless agent iteration of the build loop, in minutes. */
  readonly agentTimeoutMinutes: number;
  /** How often the pull request sync asks GitHub about open PRs, in minutes. */
  readonly prSyncIntervalMinutes: number;
  /** How often open pull requests are scanned for merge conflicts, in minutes. */
  readonly prConflictIntervalMinutes: number;
  /** Whether the merge conflict fixer may scan and push at all. */
  readonly conflictFixEnabled: boolean;
  /** Model the planning terminal runs on; `null` leaves the CLI to choose. */
  readonly planningModel: AgentModel | null;
  /** Model each build iteration runs on; `null` leaves the CLI to choose. */
  readonly buildModel: AgentModel | null;
  /** Model the automatic code review runs on; `null` leaves the CLI to choose. */
  readonly reviewModel: AgentModel | null;
  /** Model advising each build iteration; `null` means no advisor at all. */
  readonly advisorModel: AdvisorModel | null;
  /** Whether new sessions are created with the code-review flag already on. */
  readonly codeReviewDefault: boolean;
  readonly gitAuthorName: string;
  readonly gitAuthorEmail: string;
  /** OpenRouter key for voice speech-to-text, chief and the backup voice. */
  readonly openrouterApiKey: GithubTokenView;
  /** ElevenLabs key for the default voice (and Scribe realtime). */
  readonly elevenlabsApiKey: GithubTokenView;
  /** Everything else Settings → Voice edits (voice US-001). */
  readonly voice: VoiceSettings;
}

export interface AppSettingsUpdate {
  /** A new token, or `null` to remove the stored one. Omitted leaves it alone. */
  readonly githubToken?: string | null;
  /** The same rules as `githubToken` above, for Sentry (US-002). */
  readonly sentryToken?: string | null;
  readonly sentryPollIntervalMinutes?: number;
  /** There is no "let the CLI choose" for the planning pass, so no `null`. */
  readonly sentryModel?: AgentModel;
  readonly sentryPlansPerTick?: number;
  /** `null` restores Sentry's own hosted API. */
  readonly sentryBaseUrl?: string | null;
  readonly maxConcurrentSessions?: number;
  readonly agentTimeoutMinutes?: number;
  readonly prSyncIntervalMinutes?: number;
  readonly prConflictIntervalMinutes?: number;
  readonly conflictFixEnabled?: boolean;
  /** `null` hands the choice back to the CLI; omitted leaves the stored value. */
  readonly planningModel?: AgentModel | null;
  readonly buildModel?: AgentModel | null;
  readonly reviewModel?: AgentModel | null;
  /** `null` means no advisor at all; omitted leaves the stored value. */
  readonly advisorModel?: AdvisorModel | null;
  readonly codeReviewDefault?: boolean;
  /** `null` restores the built-in default; omitted leaves the stored value. */
  readonly gitAuthorName?: string | null;
  readonly gitAuthorEmail?: string | null;
  /** The same rules as `githubToken` above, for the two voice providers. */
  readonly openrouterApiKey?: string | null;
  readonly elevenlabsApiKey?: string | null;
  readonly voice?: VoiceSettingsUpdate;
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

/**
 * A Sentry API root chief-web is willing to call: an absolute `http(s)` URL
 * (US-002). Self-hosted Sentry lives on any host, so the only thing worth
 * checking is the scheme — anything else here would lock those installs out.
 */
export function isValidSentryBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'http:' || url.protocol === 'https:';
}

/** A number of plans per pass the operator is allowed to save (US-010). */
export function isValidSentryPlansPerTick(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_SENTRY_PLANS_PER_TICK &&
    value <= MAX_SENTRY_PLANS_PER_TICK
  );
}

/** A poll interval the operator is allowed to save (US-002). */
export function isValidSentryPollIntervalMinutes(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_SENTRY_POLL_INTERVAL_MINUTES &&
    value <= MAX_SENTRY_POLL_INTERVAL_MINUTES
  );
}

/** Everything but the last four characters is unrecoverable from this view. */
export function maskToken(token: string): GithubTokenView {
  return { configured: true, last4: token.slice(-VISIBLE_TOKEN_CHARS) };
}

const NO_TOKEN: GithubTokenView = { configured: false, last4: null };

function masked(token: string | null): GithubTokenView {
  return token === null ? NO_TOKEN : maskToken(token);
}

/** The stored PAT, for the code that talks to GitHub on the operator's behalf. */
export function getGithubToken(db: Database): string | null {
  return getSetting(db, 'github_token');
}

/** The stored Sentry auth token, for the poller and the resolve call (US-002). */
export function getSentryToken(db: Database): string | null {
  return getSetting(db, 'sentry_token');
}

/**
 * How long the Sentry poll waits between passes (US-002).
 *
 * Unlike the pull request intervals there is no environment default behind
 * this one — the integration is configured entirely from the settings page —
 * so an absent or unparseable row reads as
 * {@link DEFAULT_SENTRY_POLL_INTERVAL_MINUTES} and a stored value is clamped.
 */
export function getSentryPollIntervalMinutes(db: Database): number {
  const stored = getSettingNumber(db, 'sentry_poll_interval_minutes', 0);
  if (stored <= 0) return DEFAULT_SENTRY_POLL_INTERVAL_MINUTES;
  return Math.min(
    MAX_SENTRY_POLL_INTERVAL_MINUTES,
    Math.max(MIN_SENTRY_POLL_INTERVAL_MINUTES, stored),
  );
}

/** The same interval the poller actually arms its timer with. */
export function getSentryPollIntervalMs(db: Database): number {
  return getSentryPollIntervalMinutes(db) * MS_PER_MINUTE;
}

/**
 * Which model the Sentry planning pass runs on (US-002). A hand-edited row
 * naming a model chief-web does not offer reads as the default, the same
 * fail-safe as {@link getPlanningModel} — except that here the fallback is a
 * real model, because the pass always has to run on something.
 */
export function getSentryModel(db: Database): AgentModel {
  const stored = getSetting(db, 'sentry_model');
  return stored !== null && isAgentModel(stored) ? stored : DEFAULT_SENTRY_MODEL;
}

/**
 * How many issues one planning pass may plan (US-010).
 *
 * Read at the start of every pass, so a change applies from the next tick with
 * no restart. An absent or unparseable row reads as
 * {@link DEFAULT_SENTRY_PLANS_PER_TICK} and a stored value is clamped to the
 * bounds the settings route validates — a hand-edited `0` would otherwise
 * wedge the pass on a cap no issue can ever fit under, which is silently
 * indistinguishable from Sentry having nothing to say.
 */
export function getSentryPlansPerTick(db: Database): number {
  const stored = getSettingNumber(db, 'sentry_plans_per_tick', 0);
  if (stored <= 0) return DEFAULT_SENTRY_PLANS_PER_TICK;
  return Math.min(MAX_SENTRY_PLANS_PER_TICK, Math.max(MIN_SENTRY_PLANS_PER_TICK, stored));
}

/**
 * The Sentry API root (US-002). Absent — or hand-edited to something that is
 * not an http(s) URL — reads as Sentry's own hosted API.
 */
export function getSentryBaseUrl(db: Database): string {
  const stored = getSetting(db, 'sentry_base_url');
  return stored !== null && isValidSentryBaseUrl(stored) ? stored : DEFAULT_SENTRY_BASE_URL;
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
 * How long the pull request sync waits between polls of GitHub (US-004).
 *
 * Same shape as {@link getAgentTimeoutMs}: `PR_SYNC_INTERVAL_MS` is only the
 * default, the settings row wins once the operator has saved one, and it is
 * read again every time the sync re-arms its timer — so a change applies to the
 * next tick with no restart. Only a *stored* value is clamped; the environment
 * keeps its own floor, checked when the config is loaded.
 */
export function getPrSyncIntervalMs(
  db: Database,
  config: Pick<Config, 'prSyncIntervalMs'>,
): number {
  const stored = getSettingNumber(db, 'pr_sync_interval_minutes', 0);
  if (stored <= 0) return config.prSyncIntervalMs;
  return (
    Math.min(MAX_PR_SYNC_INTERVAL_MINUTES, Math.max(MIN_PR_SYNC_INTERVAL_MINUTES, stored)) *
    MS_PER_MINUTE
  );
}

/**
 * How long the merge conflict scan waits between passes (US-004).
 *
 * Same shape as {@link getPrSyncIntervalMs}: `PR_CONFLICT_INTERVAL_MS` is only
 * the default (30 minutes), the settings row wins once the operator has saved
 * one, and the scan re-reads it before arming every wait — so a change applies
 * to the next tick with no restart. Only a *stored* value is clamped; the
 * environment keeps its own floor, checked when the config is loaded.
 */
export function getPrConflictIntervalMs(
  db: Database,
  config: Pick<Config, 'prConflictIntervalMs'>,
): number {
  const stored = getSettingNumber(db, 'pr_conflict_interval_minutes', 0);
  if (stored <= 0) return config.prConflictIntervalMs;
  return (
    Math.min(
      MAX_PR_CONFLICT_INTERVAL_MINUTES,
      Math.max(MIN_PR_CONFLICT_INTERVAL_MINUTES, stored),
    ) * MS_PER_MINUTE
  );
}

/**
 * Whether the merge conflict fixer may run (US-004).
 *
 * An absent row reads as enabled, so the feature works out of the box; only a
 * deliberate `0` turns it off. That is the opposite default to
 * {@link getCodeReviewDefault}, which is why the two do not share a helper.
 *
 * Read by the scan on every tick, so switching it off stops the next tick
 * before a single GitHub request is made — nothing has to be restarted, and an
 * agent already mid-fix is left to finish.
 */
export function getConflictFixEnabled(db: Database): boolean {
  return getSetting(db, 'conflict_fix_enabled') !== '0';
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

/**
 * Which model advises the headless `claude -p` of each build iteration, or
 * `null` to pass no `--advisor` at all and launch the iteration exactly as it
 * is launched today.
 *
 * Read the same fail-safe way as {@link getBuildModel}, against the narrower
 * {@link ADVISOR_MODELS}: a row naming a model the CLI would refuse — a
 * hand-edited `haiku`, or a family dropped from a later runner image — reads as
 * `null`. An iteration with no advisor still builds; one launched with a
 * rejected `--advisor` does not.
 */
export function getAdvisorModel(db: Database): AdvisorModel | null {
  const stored = getSetting(db, 'advisor_model');
  return stored !== null && isAdvisorModel(stored) ? stored : null;
}

/**
 * The advisor exactly as it is stored, whether or not it is usable (US-007).
 *
 * {@link getAdvisorModel} sanitises, which is what every caller that only wants
 * a value to hand the CLI needs. The build loop needs the unusable value too:
 * dropping an advisor is something it says out loud in the build log, and it
 * cannot name a value it was never shown.
 */
export function getStoredAdvisorModel(db: Database): string | null {
  return getSetting(db, 'advisor_model');
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

/*
 * ---------------------------------------------------------------------------
 * Voice calls (voice US-001, plan §14.1)
 * ---------------------------------------------------------------------------
 */

/**
 * Default OpenRouter speech-to-text model. The cheapest entry of OpenRouter's
 * transcription collection on 2026-09-25 is a three-way tie at $0.00000333/s
 * (`qwen/qwen3-asr-0.6b`, `nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b`
 * and this one); Whisper Large V3 Turbo is the one of the three whose listing
 * guarantees Dutch (99+ languages), and its habit of hallucinating on silence
 * is already handled by the short-utterance filter of plan §7.1.
 */
export const DEFAULT_VOICE_OR_STT_MODEL = 'openai/whisper-large-v3-turbo';

/**
 * Default OpenRouter chat model for chief. The cheapest tool-calling text model
 * in OpenRouter's catalog on 2026-09-25 once `:free`, `:batch`, `~…-latest`
 * aliases, models with an announced expiry and models older than a year are
 * left out. Chosen on price and tool support only: if its Dutch disappoints,
 * the operator types another slug in Settings → Voice.
 */
export const DEFAULT_VOICE_CHIEF_MODEL = 'inclusionai/ling-3.0-flash';

/**
 * Default OpenRouter text-to-speech model, the fallback voice of plan §8.4.
 * The cheapest paid entry of OpenRouter's speech collection on 2026-09-25 that
 * speaks Dutch: the free Deepgram Flux and the cheaper Kokoro, Orpheus and CSM
 * voices are English (or at least not Dutch) only, and the `:free` Fish Audio
 * variant is rate limited for prototyping, which a fallback cannot be.
 */
export const DEFAULT_VOICE_OR_TTS_MODEL = 'google/gemini-3.8-flash-lite-tts';

/**
 * Default voice for {@link DEFAULT_VOICE_OR_TTS_MODEL}. It has to be one of
 * that model's `supported_voices` — the plan's OpenAI-style `alloy` is not —
 * or the "Check OpenRouter key" button would reject the shipped default.
 */
export const DEFAULT_VOICE_OR_TTS_VOICE = 'Kore';

/** Where speech-to-text comes from (plan §7). */
export const VOICE_STT_PROVIDERS = ['openrouter', 'elevenlabs-realtime', 'browser'] as const;

/**
 * ElevenLabs models the multi-context WebSocket of plan §8.3 can stream. The
 * English-only v2 Flash and Turbo are left out because the default language is
 * Dutch; `eleven_v3` is left out because it has no WebSocket endpoint.
 */
export const VOICE_TTS_MODELS = [
  'eleven_flash_v2_5',
  'eleven_turbo_v2_5',
  'eleven_multilingual_v2',
] as const;

export const VOICE_BARGE_IN_MODES = ['on', 'careful', 'off'] as const;
export const VOICE_EVENT_VERBOSITIES = ['important', 'all', 'none'] as const;
export const VOICE_LIVE_CAPTIONS = ['off', 'browser'] as const;

export const MIN_VOICE_VAD_SILENCE_MS = 400;
export const MAX_VOICE_VAD_SILENCE_MS = 2000;
export const MIN_VOICE_TRANSCRIPT_RETENTION_DAYS = 1;
export const MAX_VOICE_TRANSCRIPT_RETENTION_DAYS = 365;
/** PCM sample rates worth playing: telephone quality up to studio. */
export const MIN_VOICE_OR_TTS_SAMPLE_RATE = 8000;
export const MAX_VOICE_OR_TTS_SAMPLE_RATE = 48000;

/** Caps on the pronunciation map, so a paste accident cannot bloat every reply. */
export const MAX_VOICE_PRONUNCIATIONS = 200;
const MAX_PRONUNCIATION_TERM_CHARS = 100;
const MAX_PRONUNCIATION_SPOKEN_CHARS = 200;

/**
 * What `voice_pronunciations` reads as until the operator saves a map of their
 * own. Saving `{}` clears it for good; only a missing row brings this back.
 */
export const DEFAULT_VOICE_PRONUNCIATIONS: Readonly<Record<string, string>> = {
  PRD: 'P R D',
  PR: 'P R',
  'US-': 'user story ',
  CSV: 'C S V',
  API: 'A P I',
};

/**
 * How one voice setting is stored, validated and defaulted. `decode` reads a
 * stored row and answers `undefined` for one that no longer validates (a
 * hand-edited row, or a value a later version dropped) so the default applies
 * — the same fail-safe as {@link getPlanningModel}. `parse` checks a value off
 * the wire and answers `undefined` to reject it.
 */
interface VoiceCodec<T> {
  readonly default: T;
  readonly decode: (stored: string) => T | undefined;
  readonly encode: (value: T) => string;
  readonly parse: (raw: unknown) => T | undefined;
  /** What a valid value looks like, for the rejection message. */
  readonly expects: string;
}

const boolCodec = (fallback: boolean): VoiceCodec<boolean> => ({
  default: fallback,
  decode: (stored) => (stored === '1' ? true : stored === '0' ? false : undefined),
  encode: (value) => (value ? '1' : '0'),
  parse: (raw) => (typeof raw === 'boolean' ? raw : undefined),
  expects: 'true or false',
});

function enumCodec<const V extends string>(values: readonly V[], fallback: V): VoiceCodec<V> {
  const accepts = (raw: unknown): V | undefined =>
    typeof raw === 'string' && (values as readonly string[]).includes(raw) ? (raw as V) : undefined;
  return {
    default: fallback,
    decode: accepts,
    encode: (value) => value,
    parse: accepts,
    expects: `one of ${values.join(', ')}`,
  };
}

function intCodec(min: number, max: number, fallback: number): VoiceCodec<number> {
  const inRange = (value: number): number | undefined =>
    Number.isInteger(value) && value >= min && value <= max ? value : undefined;
  return {
    default: fallback,
    decode: (stored) => (/^-?\d+$/.test(stored) ? inRange(Number(stored)) : undefined),
    encode: String,
    parse: (raw) => (typeof raw === 'number' ? inRange(raw) : undefined),
    expects: `a whole number between ${min} and ${max}`,
  };
}

/** A string field whose value is checked by `isValid` after trimming. */
function textCodec(
  isValid: (value: string) => boolean,
  fallback: string,
  expects: string,
): VoiceCodec<string> {
  return {
    default: fallback,
    decode: (stored) => (isValid(stored) ? stored : undefined),
    encode: (value) => value,
    parse: (raw) => {
      if (typeof raw !== 'string') return undefined;
      const value = raw.trim();
      return isValid(value) ? value : undefined;
    },
    expects,
  };
}

/**
 * As {@link textCodec}, plus `null` for "none". A cleared value is stored as an
 * empty row rather than deleted, because a missing row means the default — and
 * for `voice_secondary_language` the default is `en`, not "none".
 */
function nullableTextCodec(
  isValid: (value: string) => boolean,
  fallback: string | null,
  expects: string,
): VoiceCodec<string | null> {
  return {
    default: fallback,
    decode: (stored) => (stored === '' ? null : isValid(stored) ? stored : undefined),
    encode: (value) => value ?? '',
    parse: (raw) => {
      if (raw === null) return null;
      if (typeof raw !== 'string') return undefined;
      const value = raw.trim();
      if (value === '') return null;
      return isValid(value) ? value : undefined;
    },
    expects: `${expects}, or null for none`,
  };
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

/** A two-letter ISO 639-1 code that names a real language (`nl`, `en`). */
export function isValidVoiceLanguage(value: string): boolean {
  return /^[a-z]{2}$/.test(value) && languageNames.of(value) !== undefined;
}

/** An IANA time zone this Node's ICU knows, aliases included. */
export function isValidVoiceTimezone(value: string): boolean {
  if (value === '' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The shape of an OpenRouter model slug (`openai/whisper-large-v3-turbo`,
 * `~z-ai/glm-flash-latest`, `deepgram/flux-tts:free`). Only the shape: whether
 * the model exists is asked of OpenRouter by the Settings page's check button.
 */
export function isValidOpenRouterSlug(value: string): boolean {
  return value.length <= 200 && /^~?[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

/** An OpenRouter TTS voice name (`Kore`, `en-US-Harper:MAI-Voice-2`). */
export function isValidOpenRouterVoice(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
}

/** An ElevenLabs voice id: opaque, alphanumeric, twenty characters today. */
export function isValidElevenLabsVoiceId(value: string): boolean {
  return /^[A-Za-z0-9]{1,64}$/.test(value);
}

/**
 * A term → spoken-form map (plan §8.2): a plain object of strings, with
 * non-empty terms. An empty spoken form is allowed — it says "skip this".
 */
export function parseVoicePronunciations(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_VOICE_PRONUNCIATIONS) return undefined;
  const map: Record<string, string> = {};
  for (const [term, spoken] of entries) {
    if (typeof spoken !== 'string') return undefined;
    if (term.trim() === '' || term.length > MAX_PRONUNCIATION_TERM_CHARS) return undefined;
    if (spoken.length > MAX_PRONUNCIATION_SPOKEN_CHARS) return undefined;
    map[term] = spoken;
  }
  return map;
}

const pronunciationsCodec: VoiceCodec<Readonly<Record<string, string>>> = {
  default: DEFAULT_VOICE_PRONUNCIATIONS,
  decode: (stored) => {
    try {
      return parseVoicePronunciations(JSON.parse(stored));
    } catch {
      return undefined;
    }
  },
  encode: (value) => JSON.stringify(value),
  parse: parseVoicePronunciations,
  expects: `an object of at most ${MAX_VOICE_PRONUNCIATIONS} term → spoken-text strings, terms non-empty`,
};

/**
 * Every operator-facing voice setting: its settings row and how that row is
 * read, written and validated. `voice_el_exhausted_until` is deliberately not
 * here — it is internal state, so the settings view never shows it and the
 * settings route never accepts it.
 */
export const VOICE_FIELDS = {
  enabled: { key: 'voice_enabled', codec: boolCodec(false) },
  sttProvider: { key: 'voice_stt_provider', codec: enumCodec(VOICE_STT_PROVIDERS, 'openrouter') },
  orSttModel: {
    key: 'voice_or_stt_model',
    codec: textCodec(isValidOpenRouterSlug, DEFAULT_VOICE_OR_STT_MODEL, 'an OpenRouter model slug such as openai/whisper-large-v3-turbo'),
  },
  language: {
    key: 'voice_language',
    codec: textCodec(isValidVoiceLanguage, 'nl', 'a two-letter ISO 639-1 language code such as nl'),
  },
  secondaryLanguage: {
    key: 'voice_secondary_language',
    codec: nullableTextCodec(isValidVoiceLanguage, 'en', 'a two-letter ISO 639-1 language code such as en'),
  },
  keytermsEnabled: { key: 'voice_keyterms_enabled', codec: boolCodec(false) },
  ttsModel: { key: 'voice_tts_model', codec: enumCodec(VOICE_TTS_MODELS, 'eleven_flash_v2_5') },
  voiceId: {
    key: 'voice_voice_id',
    codec: nullableTextCodec(isValidElevenLabsVoiceId, null, 'an ElevenLabs voice id'),
  },
  orTtsModel: {
    key: 'voice_or_tts_model',
    codec: textCodec(isValidOpenRouterSlug, DEFAULT_VOICE_OR_TTS_MODEL, 'an OpenRouter model slug'),
  },
  orTtsVoice: {
    key: 'voice_or_tts_voice',
    codec: textCodec(isValidOpenRouterVoice, DEFAULT_VOICE_OR_TTS_VOICE, 'a voice name of the OpenRouter speech model'),
  },
  orTtsSampleRate: {
    key: 'voice_or_tts_sample_rate',
    codec: intCodec(MIN_VOICE_OR_TTS_SAMPLE_RATE, MAX_VOICE_OR_TTS_SAMPLE_RATE, 24000),
  },
  chiefModel: {
    key: 'voice_chief_model',
    codec: textCodec(isValidOpenRouterSlug, DEFAULT_VOICE_CHIEF_MODEL, 'an OpenRouter model slug'),
  },
  sessionModel: { key: 'voice_session_model', codec: enumCodec(AGENT_MODELS, 'sonnet') },
  vadSilenceMs: {
    key: 'voice_vad_silence_ms',
    codec: intCodec(MIN_VOICE_VAD_SILENCE_MS, MAX_VOICE_VAD_SILENCE_MS, 800),
  },
  bargeIn: { key: 'voice_barge_in', codec: enumCodec(VOICE_BARGE_IN_MODES, 'careful') },
  eventVerbosity: {
    key: 'voice_event_verbosity',
    codec: enumCodec(VOICE_EVENT_VERBOSITIES, 'important'),
  },
  timezone: {
    key: 'voice_timezone',
    codec: textCodec(isValidVoiceTimezone, 'Europe/Amsterdam', 'an IANA time zone such as Europe/Amsterdam'),
  },
  pronunciations: { key: 'voice_pronunciations', codec: pronunciationsCodec },
  transcriptRetentionDays: {
    key: 'voice_transcript_retention_days',
    codec: intCodec(MIN_VOICE_TRANSCRIPT_RETENTION_DAYS, MAX_VOICE_TRANSCRIPT_RETENTION_DAYS, 30),
  },
  pttGlobal: { key: 'voice_ptt_global', codec: boolCodec(false) },
  liveCaptions: { key: 'voice_live_captions', codec: enumCodec(VOICE_LIVE_CAPTIONS, 'off') },
  /** Scribe only: a partial unchanged for 300 ms starts chief's answer early (US-022). */
  speculativeChief: { key: 'voice_speculative_chief', codec: boolCodec(false) },
} as const satisfies Record<string, { key: SettingKey; codec: { readonly expects: string } }>;

export type VoiceField = keyof typeof VOICE_FIELDS;

type CodecValue<C> = C extends VoiceCodec<infer T> ? T : never;

/** The voice settings as the API shows them; the two keys are masked elsewhere. */
export type VoiceSettings = {
  readonly [F in VoiceField]: CodecValue<(typeof VOICE_FIELDS)[F]['codec']>;
};

/** Omitted fields keep their stored value. */
export type VoiceSettingsUpdate = Partial<VoiceSettings>;

const VOICE_FIELD_NAMES = Object.keys(VOICE_FIELDS) as VoiceField[];

/** The stored OpenRouter API key, for the voice server code only. */
export function getOpenRouterApiKey(db: Database): string | null {
  return getSetting(db, 'openrouter_api_key');
}

/** The stored ElevenLabs API key, for the voice server code only. */
export function getElevenLabsApiKey(db: Database): string | null {
  return getSetting(db, 'elevenlabs_api_key');
}

/** One voice setting, falling back to its default for an absent or bad row. */
function readVoiceField<F extends VoiceField>(db: Database, field: F): VoiceSettings[F] {
  const { key, codec } = VOICE_FIELDS[field] as unknown as {
    key: SettingKey;
    codec: VoiceCodec<VoiceSettings[F]>;
  };
  const stored = getSetting(db, key);
  if (stored === null) return codec.default;
  // Not `??`: a decoded `null` is a stored choice ("no secondary language").
  const decoded = codec.decode(stored);
  return decoded === undefined ? codec.default : decoded;
}

export function getVoiceSettings(db: Database): VoiceSettings {
  const settings: Partial<Record<VoiceField, unknown>> = {};
  for (const field of VOICE_FIELD_NAMES) settings[field] = readVoiceField(db, field);
  return settings as VoiceSettings;
}

/**
 * Checks the `voice` object of a `PUT /api/settings` body. Every field is
 * optional; an unknown one — `elExhaustedUntil` included — is rejected rather
 * than ignored, so a typo in a script does not silently save nothing.
 */
export function parseVoiceSettingsUpdate(
  raw: unknown,
): VoiceSettingsUpdate | { readonly error: string; readonly message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'invalid_voice', message: 'The voice settings must be a JSON object.' };
  }
  const update: Partial<Record<VoiceField, unknown>> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(name in VOICE_FIELDS)) {
      return { error: 'invalid_voice', message: `Unknown voice setting "${name}".` };
    }
    if (value === undefined) continue;
    const field = name as VoiceField;
    const { key, codec } = VOICE_FIELDS[field] as unknown as {
      key: string;
      codec: VoiceCodec<unknown>;
    };
    const parsed = codec.parse(value);
    if (parsed === undefined) {
      return { error: `invalid_${key}`, message: `${key} must be ${codec.expects}.` };
    }
    update[field] = parsed;
  }
  return update as VoiceSettingsUpdate;
}

function writeVoiceSettings(db: Database, update: VoiceSettingsUpdate): void {
  for (const field of VOICE_FIELD_NAMES) {
    const value = update[field];
    if (value === undefined) continue;
    const { key, codec } = VOICE_FIELDS[field] as unknown as {
      key: SettingKey;
      codec: VoiceCodec<unknown>;
    };
    setSetting(db, key, codec.encode(value));
  }
}

/**
 * Until when calls start on the OpenRouter fallback voice because ElevenLabs
 * ran out of credits (plan §8.6), or `null`. A time in the past means no hold,
 * so nothing has to sweep the row.
 */
export function getVoiceElExhaustedUntil(db: Database): string | null {
  const stored = getSetting(db, 'voice_el_exhausted_until');
  return stored !== null && !Number.isNaN(Date.parse(stored)) ? stored : null;
}

export function setVoiceElExhaustedUntil(db: Database, until: string | null): void {
  if (until === null) deleteSetting(db, 'voice_el_exhausted_until');
  else setSetting(db, 'voice_el_exhausted_until', until);
}

export function readAppSettings(db: Database, config: Config): AppSettings {
  const token = getGithubToken(db);
  const identity = getGitIdentity(db);
  const sentryToken = getSentryToken(db);
  return {
    githubToken: token === null ? NO_TOKEN : maskToken(token),
    sentryToken: sentryToken === null ? NO_TOKEN : maskToken(sentryToken),
    sentryPollIntervalMinutes: getSentryPollIntervalMinutes(db),
    sentryModel: getSentryModel(db),
    sentryPlansPerTick: getSentryPlansPerTick(db),
    sentryBaseUrl: getSentryBaseUrl(db),
    // The env var is only the default: once saved, the settings row wins.
    maxConcurrentSessions: getSettingNumber(
      db,
      'max_concurrent_sessions',
      config.maxConcurrentSessions,
    ),
    agentTimeoutMinutes: Math.round(getAgentTimeoutMs(db, config) / MS_PER_MINUTE),
    prSyncIntervalMinutes: Math.round(getPrSyncIntervalMs(db, config) / MS_PER_MINUTE),
    prConflictIntervalMinutes: Math.round(getPrConflictIntervalMs(db, config) / MS_PER_MINUTE),
    conflictFixEnabled: getConflictFixEnabled(db),
    planningModel: getPlanningModel(db),
    buildModel: getBuildModel(db),
    reviewModel: getReviewModel(db),
    advisorModel: getAdvisorModel(db),
    codeReviewDefault: getCodeReviewDefault(db),
    gitAuthorName: identity.name,
    gitAuthorEmail: identity.email,
    openrouterApiKey: masked(getOpenRouterApiKey(db)),
    elevenlabsApiKey: masked(getElevenLabsApiKey(db)),
    voice: getVoiceSettings(db),
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

    // Stored, masked and removed exactly like the GitHub token above.
    if (update.sentryToken === null) deleteSetting(db, 'sentry_token');
    else if (update.sentryToken !== undefined) setSetting(db, 'sentry_token', update.sentryToken);

    if (update.sentryPollIntervalMinutes !== undefined) {
      setSettingNumber(db, 'sentry_poll_interval_minutes', update.sentryPollIntervalMinutes);
    }

    if (update.sentryModel !== undefined) setSetting(db, 'sentry_model', update.sentryModel);

    if (update.sentryPlansPerTick !== undefined) {
      setSettingNumber(db, 'sentry_plans_per_tick', update.sentryPlansPerTick);
    }

    // `null` clears the row, which makes the hosted Sentry API apply again.
    if (update.sentryBaseUrl === null) deleteSetting(db, 'sentry_base_url');
    else if (update.sentryBaseUrl !== undefined) {
      setSetting(db, 'sentry_base_url', update.sentryBaseUrl);
    }

    if (update.maxConcurrentSessions !== undefined) {
      setSettingNumber(db, 'max_concurrent_sessions', update.maxConcurrentSessions);
    }

    if (update.agentTimeoutMinutes !== undefined) {
      setSettingNumber(db, 'agent_timeout_minutes', update.agentTimeoutMinutes);
    }

    if (update.prSyncIntervalMinutes !== undefined) {
      setSettingNumber(db, 'pr_sync_interval_minutes', update.prSyncIntervalMinutes);
    }

    if (update.prConflictIntervalMinutes !== undefined) {
      setSettingNumber(db, 'pr_conflict_interval_minutes', update.prConflictIntervalMinutes);
    }

    // Written both ways rather than cleared on `true`, so "on" is a recorded
    // choice and not just the absence of one.
    if (update.conflictFixEnabled !== undefined) {
      setSetting(db, 'conflict_fix_enabled', update.conflictFixEnabled ? '1' : '0');
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

    // The same two branches, except that here the cleared row means "no
    // advisor at all" rather than "let the CLI choose".
    if (update.advisorModel === null) deleteSetting(db, 'advisor_model');
    else if (update.advisorModel !== undefined) {
      setSetting(db, 'advisor_model', update.advisorModel);
    }

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

    // Stored, masked and removed exactly like the GitHub token above.
    if (update.openrouterApiKey === null) deleteSetting(db, 'openrouter_api_key');
    else if (update.openrouterApiKey !== undefined) {
      setSetting(db, 'openrouter_api_key', update.openrouterApiKey);
    }

    if (update.elevenlabsApiKey === null) deleteSetting(db, 'elevenlabs_api_key');
    else if (update.elevenlabsApiKey !== undefined) {
      setSetting(db, 'elevenlabs_api_key', update.elevenlabsApiKey);
    }

    if (update.voice !== undefined) writeVoiceSettings(db, update.voice);
  });

  return readAppSettings(db, config);
}
