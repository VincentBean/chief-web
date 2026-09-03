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
  {
    id: '0003_session_failure_stage',
    sql: `
      -- Which step a \`failed\` session failed at, next to the human-readable
      -- \`last_error\` (US-019). It is what "Retry" dispatches on: an agent,
      -- PRD or lost-container failure resumes the loop at the first story that
      -- is not done, while a push or pull-request failure re-runs only the
      -- delivery. NULL for every session that is not failed — and for rows
      -- that failed before this column existed, where the story list is the
      -- only evidence left.
      ALTER TABLE sessions ADD COLUMN failure_stage TEXT
        CHECK (failure_stage IS NULL OR failure_stage IN
          ('agent', 'prd', 'push', 'pull_request', 'container_lost'));
    `,
  },
  {
    id: '0004_pr_feedback_runs',
    sql: `
      -- Processing a pull request's review feedback (US-021).
      --
      -- Deliberately not a \`sessions\` row. A session is a PRD built story by
      -- story on a branch chief-web created; this is one pass over someone
      -- else's branch, and the two disagree on the columns that matter:
      -- \`pr_target_branch\` is CHECKed to develop/main while a real pull
      -- request targets anything, and \`status\` has no way to say "replying".
      -- Sharing the table would also put these rows in front of the build
      -- loop's queue, which picks the head of every queued session and starts
      -- the Ralph loop on it.
      CREATE TABLE IF NOT EXISTS pr_runs (
        id              TEXT PRIMARY KEY,
        repository_id   TEXT NOT NULL
                          REFERENCES repositories (id) ON DELETE CASCADE,
        pr_number       INTEGER NOT NULL,
        pr_url          TEXT NOT NULL,
        pr_title        TEXT NOT NULL,
        head_branch     TEXT NOT NULL,
        base_branch     TEXT NOT NULL,
        status          TEXT NOT NULL
                          CHECK (status IN ('pending', 'running', 'finished', 'failed')),
        -- Which step failed. \`reply\` sits after \`push\` on purpose: a run
        -- that failed there has already delivered its fix, so retrying it must
        -- not run the agent again.
        failure_stage   TEXT
                          CHECK (failure_stage IS NULL OR failure_stage IN
                            ('feedback', 'checkout', 'agent', 'outcome', 'push',
                             'reply', 'container_lost')),
        -- Passes made so far, quoted in the reply footer so a second pass on
        -- the same thread is distinguishable from the first.
        attempt         INTEGER NOT NULL DEFAULT 0,
        container_id    TEXT,
        -- The commit the last successful push delivered; what replies quote.
        head_sha        TEXT,
        last_error      TEXT,
        started_at      TEXT,
        finished_at     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        -- One row per pull request, reused across re-runs: the workspace, the
        -- clone and the per-thread record all hang off it, which is what makes
        -- a re-run after a partial success resume rather than start over.
        UNIQUE (repository_id, pr_number)
      );

      CREATE INDEX IF NOT EXISTS idx_pr_runs_repository ON pr_runs (repository_id);
      CREATE INDEX IF NOT EXISTS idx_pr_runs_status ON pr_runs (status);

      -- What happened to each piece of feedback, across every run on this pull
      -- request. This is the record that makes replying idempotent.
      CREATE TABLE IF NOT EXISTS pr_feedback_threads (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id            TEXT NOT NULL REFERENCES pr_runs (id) ON DELETE CASCADE,
        -- GraphQL node id: the only thing \`resolveReviewThread\` accepts.
        thread_id         TEXT NOT NULL,
        kind              TEXT NOT NULL CHECK (kind IN ('thread', 'review')),
        -- REST id of the thread's *first* comment. GitHub refuses replies to
        -- replies, so this is the only comment that can ever be answered;
        -- NULL for a review summary, which has no thread to reply to at all.
        first_comment_id  INTEGER,
        -- The short key the agent echoes back (\`T1\`, \`R1\`) instead of a
        -- forty-character node id it would mangle.
        feedback_key      TEXT NOT NULL,
        outcome           TEXT
                            CHECK (outcome IS NULL OR outcome IN
                              ('addressed', 'skipped', 'unreported')),
        summary           TEXT,
        replied_at        TEXT,
        reply_url         TEXT,
        -- Which commit the posted reply quoted. A re-run ending on the same
        -- commit does not say the same sentence twice; a new one does.
        replied_head_sha  TEXT,
        resolved_at       TEXT,
        -- Why a reply or a resolve did not happen; never silently swallowed.
        error             TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        UNIQUE (run_id, thread_id)
      );
    `,
  },
  {
    id: '0005_session_waiting_status',
    sql: `
      -- The usage-limit hold gets a status of its own (US-003): a session that
      -- Claude refused is neither building nor failed, and \`waiting_until\`
      -- records the moment it may resume.
      --
      -- SQLite cannot widen a CHECK in place, so \`sessions\` is rebuilt. It
      -- cannot be renamed out of the way first either: with foreign keys on,
      -- SQLite rewrites \`stories.session_id\` to follow the rename, and
      -- dropping the old table would then cascade every story away. So the
      -- stories are set aside, the table is rebuilt under its own name, and
      -- both sets of rows go back — all of it inside the one transaction the
      -- migration runner already holds.
      CREATE TABLE sessions_backup AS SELECT * FROM sessions;
      CREATE TABLE stories_backup AS SELECT * FROM stories;

      -- Takes the stories and the indexes with it; both are restored below.
      DROP TABLE sessions;

      CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        repository_id      TEXT NOT NULL
                             REFERENCES repositories (id) ON DELETE RESTRICT,
        -- Slug: letters, numbers, hyphens and underscores only.
        name               TEXT NOT NULL
                             CHECK (name <> '' AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
        status             TEXT NOT NULL
                             CHECK (status IN
                               ('pending', 'ready', 'building', 'waiting', 'failed', 'finished')),
        base_branch        TEXT NOT NULL,
        feature_branch     TEXT NOT NULL,
        pr_target_branch   TEXT NOT NULL CHECK (pr_target_branch IN ('develop', 'main')),
        scheduled_start_at TEXT,
        queued_at          TEXT,
        container_id       TEXT,
        pr_url             TEXT,
        last_error         TEXT,
        failure_stage      TEXT
                             CHECK (failure_stage IS NULL OR failure_stage IN
                               ('agent', 'prd', 'push', 'pull_request', 'container_lost')),
        -- UTC ISO time a \`waiting\` session may resume; NULL for every other
        -- status, and for every row that predates the hold.
        waiting_until      TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE (repository_id, name)
      );

      INSERT INTO sessions
        (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
         scheduled_start_at, queued_at, container_id, pr_url, last_error, failure_stage,
         waiting_until, created_at, updated_at)
      SELECT
         id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
         scheduled_start_at, queued_at, container_id, pr_url, last_error, failure_stage,
         NULL, created_at, updated_at
      FROM sessions_backup;

      INSERT INTO stories SELECT * FROM stories_backup;

      DROP TABLE sessions_backup;
      DROP TABLE stories_backup;

      CREATE INDEX IF NOT EXISTS idx_sessions_repository ON sessions (repository_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
      -- Backs the FIFO build queue (US-018); NULLs are not indexed by SQLite.
      CREATE INDEX IF NOT EXISTS idx_sessions_queued_at ON sessions (queued_at)
        WHERE queued_at IS NOT NULL;
    `,
  },
  {
    id: '0006_session_code_review',
    sql: `
      -- Whether this session's pull request should be reviewed automatically
      -- once it is opened (US-003). Stored as 0/1 because SQLite has no
      -- boolean; existing sessions default to off, so turning the feature on
      -- never surprises a session that was planned without it.
      ALTER TABLE sessions ADD COLUMN code_review INTEGER NOT NULL DEFAULT 0
        CHECK (code_review IN (0, 1));
    `,
  },
  {
    id: '0007_session_review_failure_stage',
    sql: `
      -- The code review gets a failure stage of its own (US-006): a session
      -- whose review failed has its commits pushed and its pull request open,
      -- so a retry must re-run the review alone.
      --
      -- SQLite cannot widen a CHECK in place, so \`sessions\` is rebuilt the
      -- same way \`0005\` rebuilt it: the stories are set aside first, because
      -- with foreign keys on, dropping the table would cascade them away.
      CREATE TABLE sessions_backup AS SELECT * FROM sessions;
      CREATE TABLE stories_backup AS SELECT * FROM stories;

      -- Takes the stories and the indexes with it; both are restored below.
      DROP TABLE sessions;

      CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        repository_id      TEXT NOT NULL
                             REFERENCES repositories (id) ON DELETE RESTRICT,
        -- Slug: letters, numbers, hyphens and underscores only.
        name               TEXT NOT NULL
                             CHECK (name <> '' AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
        status             TEXT NOT NULL
                             CHECK (status IN
                               ('pending', 'ready', 'building', 'waiting', 'failed', 'finished')),
        base_branch        TEXT NOT NULL,
        feature_branch     TEXT NOT NULL,
        pr_target_branch   TEXT NOT NULL CHECK (pr_target_branch IN ('develop', 'main')),
        scheduled_start_at TEXT,
        queued_at          TEXT,
        container_id       TEXT,
        pr_url             TEXT,
        last_error         TEXT,
        failure_stage      TEXT
                             CHECK (failure_stage IS NULL OR failure_stage IN
                               ('agent', 'prd', 'push', 'pull_request', 'review',
                                'container_lost')),
        -- UTC ISO time a \`waiting\` session may resume; NULL for every other
        -- status, and for every row that predates the hold.
        waiting_until      TEXT,
        code_review        INTEGER NOT NULL DEFAULT 0 CHECK (code_review IN (0, 1)),
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        UNIQUE (repository_id, name)
      );

      INSERT INTO sessions
        (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
         scheduled_start_at, queued_at, container_id, pr_url, last_error, failure_stage,
         waiting_until, code_review, created_at, updated_at)
      SELECT
         id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
         scheduled_start_at, queued_at, container_id, pr_url, last_error, failure_stage,
         waiting_until, code_review, created_at, updated_at
      FROM sessions_backup;

      INSERT INTO stories SELECT * FROM stories_backup;

      DROP TABLE sessions_backup;
      DROP TABLE stories_backup;

      CREATE INDEX IF NOT EXISTS idx_sessions_repository ON sessions (repository_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
      -- Backs the FIFO build queue (US-018); NULLs are not indexed by SQLite.
      CREATE INDEX IF NOT EXISTS idx_sessions_queued_at ON sessions (queued_at)
        WHERE queued_at IS NOT NULL;
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
