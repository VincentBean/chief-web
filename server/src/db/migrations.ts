import { type Database, nowIso, text, withTransaction } from './sqlite.js';

export interface Migration {
  /** Stable identifier; never rename or reorder an applied migration. */
  readonly id: string;
  readonly sql: string;
}

/**
 * Ordered list of schema migrations. Migrations are append-only: once an id has
 * shipped it is recorded in `schema_migrations` and never runs again, so
 * restarting the stack is always a no-op on an up-to-date database.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS repositories (
        id                  TEXT PRIMARY KEY,
        name                TEXT NOT NULL UNIQUE,
        ssh_url             TEXT NOT NULL,
        github_slug         TEXT NOT NULL,
        default_base_branch TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id                 TEXT PRIMARY KEY,
        repository_id      TEXT NOT NULL
                             REFERENCES repositories (id) ON DELETE RESTRICT,
        -- Slug: letters, numbers, hyphens and underscores only.
        name               TEXT NOT NULL
                             CHECK (name <> '' AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
        status             TEXT NOT NULL
                             CHECK (status IN ('pending', 'ready', 'building', 'failed', 'finished')),
        base_branch        TEXT NOT NULL,
        feature_branch     TEXT NOT NULL,
        pr_target_branch   TEXT NOT NULL CHECK (pr_target_branch IN ('develop', 'main')),
        scheduled_start_at TEXT,
        queued_at          TEXT,
        container_id       TEXT,
        pr_url             TEXT,
        last_error         TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE (repository_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_repository ON sessions (repository_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
      -- Backs the FIFO build queue (US-018); NULLs are not indexed by SQLite.
      CREATE INDEX IF NOT EXISTS idx_sessions_queued_at ON sessions (queued_at)
        WHERE queued_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS stories (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        story_id   TEXT NOT NULL,
        title      TEXT NOT NULL,
        priority   INTEGER NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('todo', 'in-progress', 'done')),
        commit_sha TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, story_id)
      );

      CREATE INDEX IF NOT EXISTS idx_stories_session ON stories (session_id, priority);

      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '0002_repository_ssh_keys',
    sql: `
      -- The public half of the repository's deploy key, its fingerprint, and
      -- whether chief-web generated it or the operator pasted one. The private
      -- key itself lives on the data volume at \`$SSH_KEYS_DIR/<id>.key\`,
      -- never in the database (US-005).
      ALTER TABLE repositories ADD COLUMN public_key TEXT;
      ALTER TABLE repositories ADD COLUMN key_fingerprint TEXT;
      ALTER TABLE repositories ADD COLUMN key_source TEXT
        CHECK (key_source IS NULL OR key_source IN ('generated', 'imported'));
    `,
  },
];

/**
 * Applies every migration that has not run yet, each in its own transaction,
 * and returns the ids that were applied (empty when already up to date).
 */
export function runMigrations(db: Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const alreadyApplied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => text(row, 'id')),
  );

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (alreadyApplied.has(migration.id)) continue;
    withTransaction(db, () => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        nowIso(),
      );
    });
    applied.push(migration.id);
  }
  return applied;
}
