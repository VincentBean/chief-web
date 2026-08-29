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
