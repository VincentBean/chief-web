import { changeCount, type Database, nowIso, text, withTransaction } from './sqlite.js';

/**
 * Known keys of the settings table. Values are always stored as text; use the
 * typed accessors below for numbers. Add a key here when a story needs one.
 */
export const SETTING_KEYS = [
  /** Global GitHub Personal Access Token used for PR creation (US-004). */
  'github_token',
  /** Hash of the generated shared password when `CHIEF_WEB_PASSWORD` is unset (US-003). */
  'password_hash',
  /** Long-lived HMAC secret used to sign session cookies (US-003). */
  'session_secret',
  /** Max simultaneously building sessions (US-018). */
  'max_concurrent_sessions',
  /** Git identity used for agent commits inside session containers (US-006). */
  'git_author_name',
  'git_author_email',
  /** Per-iteration agent timeout in minutes (US-019). */
  'agent_timeout_minutes',
  /**
   * `--model` for the planning terminal and for each build iteration. An
   * absent row means "no `--model` flag", which is how the CLI's own default
   * is selected — so there is no value here standing for the default.
   */
  'planning_model',
  'build_model',
  /** `--model` for the automatic pull-request code review; same absent-row rule. */
  'review_model',
  /**
   * `--advisor` for each build iteration: the second, stronger model the main
   * model consults at its own decision points. An absent row means no
   * `--advisor` flag at all, so the iteration launches exactly as it does
   * today — there is no value here standing for "no advisor".
   */
  'advisor_model',
  /**
   * Whether a new session gets its code-review flag set when the request does
   * not say (US-004). Stored as `1`/`0`; an absent row means off.
   */
  'code_review_default',
  /**
   * How often the pull request sync polls GitHub, in minutes (US-004). An
   * absent row means the `PR_SYNC_INTERVAL_MS` default applies.
   */
  'pr_sync_interval_minutes',
  /**
   * How often open pull requests are scanned for merge conflicts, in minutes
   * (US-004). An absent row means the `PR_CONFLICT_INTERVAL_MS` default
   * applies.
   */
  'pr_conflict_interval_minutes',
  /**
   * Whether the merge conflict fixer may run at all (US-004). Stored as
   * `1`/`0`; an *absent* row means on, unlike `code_review_default` — the
   * feature ships enabled and the row only ever records a deliberate "off".
   */
  'conflict_fix_enabled',
  /**
   * Sentry auth token used to poll issues and resolve them again (US-002).
   * Write-only over the API, exactly like `github_token`.
   */
  'sentry_token',
  /**
   * How often Sentry is polled for new unresolved issues, in minutes (US-002).
   * An absent row means the built-in 15 minute default.
   */
  'sentry_poll_interval_minutes',
  /**
   * `--model` for the planning pass, which triages an issue and writes its
   * proposed fix plan (US-002; renamed in the UI by US-010, key kept so
   * existing installs keep their choice). Unlike the other model rows an
   * absent one is not "let the CLI choose" but the built-in `haiku` — the
   * planning pass is a cheap one-shot call by design.
   */
  'sentry_model',
  /**
   * How many issues one planning pass may plan, across every repository
   * (US-010). An absent row means the built-in default of 2; a stored value
   * outside 1–10 is clamped on the way out.
   */
  'sentry_plans_per_tick',
  /**
   * Base URL of the Sentry API, for self-hosted installations (US-002). An
   * absent row means `https://sentry.io/api/0/`.
   */
  'sentry_base_url',
  /**
   * ISO timestamp until which agent work is held after a Claude usage-limit
   * refusal (US-002). Written and read through `limits/hold.ts`; a value in
   * the past means no hold, so nothing has to sweep the row.
   */
  'claude_limit_until',
  /**
   * Voice calls (voice US-001). Both provider keys are write-only over the
   * API, exactly like `github_token`; every `voice_*` row is read through
   * `VOICE_FIELDS` in `settings/service.ts`, where an absent or unreadable
   * row means that field's default.
   */
  'openrouter_api_key',
  'elevenlabs_api_key',
  'voice_enabled',
  'voice_stt_provider',
  'voice_or_stt_model',
  'voice_language',
  'voice_secondary_language',
  'voice_keyterms_enabled',
  'voice_tts_model',
  'voice_voice_id',
  'voice_or_tts_model',
  'voice_or_tts_voice',
  'voice_or_tts_sample_rate',
  'voice_chief_model',
  'voice_session_model',
  'voice_vad_silence_ms',
  'voice_barge_in',
  'voice_event_verbosity',
  'voice_timezone',
  'voice_pronunciations',
  'voice_transcript_retention_days',
  'voice_ptt_global',
  'voice_live_captions',
  'voice_speculative_chief',
  /**
   * ISO timestamp until which calls start on the OpenRouter fallback voice,
   * because ElevenLabs said its credits ran out (docs/voice-plan.md §8.6). Internal: never
   * part of the settings view and never accepted by `PUT /api/settings`.
   */
  'voice_el_exhausted_until',
  /** Scribe's measured credits per minute (US-023). Internal like the one above. */
  'voice_scribe_credits_per_min',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function getSetting(db: Database, key: SettingKey): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? text(row, 'value') : null;
}

export function setSetting(db: Database, key: SettingKey, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, nowIso());
}

export function setSettings(db: Database, values: Partial<Record<SettingKey, string>>): void {
  withTransaction(db, () => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      setSetting(db, key as SettingKey, value);
    }
  });
}

export function deleteSetting(db: Database, key: SettingKey): boolean {
  return changeCount(db.prepare('DELETE FROM settings WHERE key = ?').run(key)) > 0;
}

/** Every stored setting, keyed by name. Unknown keys are ignored. */
export function getAllSettings(db: Database): Partial<Record<SettingKey, string>> {
  const known = new Set<string>(SETTING_KEYS);
  const settings: Partial<Record<SettingKey, string>> = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    const key = text(row, 'key');
    if (known.has(key)) settings[key as SettingKey] = text(row, 'value');
  }
  return settings;
}

/** Reads an integer setting, falling back when unset or unparseable. */
export function getSettingNumber(db: Database, key: SettingKey, fallback: number): number {
  const raw = getSetting(db, key);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) ? value : fallback;
}

export function setSettingNumber(db: Database, key: SettingKey, value: number): void {
  setSetting(db, key, String(value));
}
