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
  {
    id: '0008_session_pr_states',
    sql: `
      -- The two post-build states of US-001: \`pr-open\` (the pull request is
      -- open on GitHub) and \`merged\` (it was merged). \`finished\` stays the
      -- terminal state of a session that opened no pull request at all.
      --
      -- Same rebuild dance as 0005 and 0007: SQLite cannot widen a CHECK in
      -- place, and the table cannot be renamed out of the way because foreign
      -- keys on would rewrite \`stories.session_id\` to follow the rename and
      -- then cascade every story away with the old table. So the stories are
      -- set aside, \`sessions\` is rebuilt under its own name, and both sets of
      -- rows go back inside the migration runner's transaction.
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
                               ('pending', 'ready', 'building', 'waiting', 'failed',
                                'finished', 'pr-open', 'merged')),
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

      -- Backfill, once: every session that ended with a pull request opened is
      -- where \`pr-open\` now describes it. Some of those are merged or closed
      -- already; the sync's first tick asks GitHub and corrects them within
      -- minutes, which is why this does not try to guess. \`updated_at\` is
      -- deliberately left alone — the session list is ordered by it, and a
      -- deploy should not reshuffle it.
      UPDATE sessions SET status = 'pr-open'
        WHERE status = 'finished' AND pr_url IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_sessions_repository ON sessions (repository_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);
      -- Backs the FIFO build queue (US-018); NULLs are not indexed by SQLite.
      CREATE INDEX IF NOT EXISTS idx_sessions_queued_at ON sessions (queued_at)
        WHERE queued_at IS NOT NULL;
    `,
  },
  {
    id: '0009_pr_reviews',
    sql: `
      -- Code reviews started by hand on an open pull request, from the Pull
      -- requests page. A session's own review (US-007) is a step of its
      -- delivery and leaves nothing behind but the review on GitHub; this is
      -- the same pass pointed at a pull request chief-web may never have built,
      -- so it needs a row of its own to be started, watched and stopped from.
      --
      -- Kept apart from \`pr_runs\` for the reason that table is kept apart
      -- from \`sessions\`: the two runs share a pull request, not a lifecycle.
      -- A feedback pass pushes and replies; a review changes nothing and posts
      -- one review. One row per pull request, reused across re-runs, so the
      -- workspace and the clone survive between them.
      CREATE TABLE IF NOT EXISTS pr_reviews (
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
        failure_stage   TEXT
                          CHECK (failure_stage IS NULL OR failure_stage IN
                            ('checkout', 'agent', 'findings', 'publish',
                             'container_lost')),
        attempt         INTEGER NOT NULL DEFAULT 0,
        container_id    TEXT,
        -- The commit the review was read at; what the findings are about.
        head_sha        TEXT,
        -- What the last successful pass posted: the review's URL and how many
        -- findings went inline versus into the body.
        review_url      TEXT,
        inline_comments INTEGER,
        folded_findings INTEGER,
        -- The sentence about the feedback run the findings were handed to.
        solver_message  TEXT,
        last_error      TEXT,
        started_at      TEXT,
        finished_at     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (repository_id, pr_number)
      );

      CREATE INDEX IF NOT EXISTS idx_pr_reviews_repository ON pr_reviews (repository_id);
      CREATE INDEX IF NOT EXISTS idx_pr_reviews_status ON pr_reviews (status);
    `,
  },
  {
    id: '0010_pr_conflict_fixes',
    sql: `
      -- Merge-conflict resolutions the fixer ran on an open pull request.
      -- One row per pull request, like \`pr_reviews\`: the row is the *live*
      -- record of the last fix, and starting a fix for a pull request that
      -- already has one replaces it rather than piling up history.
      --
      -- The two SHAs are what make the "don't retry until the pull request
      -- changes" rule survive a restart: a \`failed\` row blocks further
      -- attempts only while the pull request still sits on the same head and
      -- base commits. Both are known before a run starts — the mergeability
      -- fetch returns them — so neither is nullable.
      CREATE TABLE IF NOT EXISTS pr_conflict_fixes (
        id            TEXT PRIMARY KEY,
        repository_id TEXT NOT NULL
                        REFERENCES repositories (id) ON DELETE CASCADE,
        pr_number     INTEGER NOT NULL,
        pr_url        TEXT NOT NULL,
        pr_title      TEXT NOT NULL,
        head_branch   TEXT NOT NULL,
        base_branch   TEXT NOT NULL,
        -- The commits the conflict was seen at; what the fix is for.
        head_sha      TEXT NOT NULL,
        base_sha      TEXT NOT NULL,
        status        TEXT NOT NULL
                        CHECK (status IN ('running', 'succeeded', 'failed')),
        -- Attempts spent on this run; after three the fix is \`failed\`.
        attempts      INTEGER NOT NULL DEFAULT 0,
        failure_stage TEXT
                        CHECK (failure_stage IS NULL OR failure_stage IN
                          ('checkout', 'merge', 'agent', 'verify', 'push',
                           'container_lost')),
        last_error    TEXT,
        container_id  TEXT,
        -- The merge commit a succeeded fix pushed to the head branch.
        merge_sha     TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (repository_id, pr_number)
      );

      CREATE INDEX IF NOT EXISTS idx_pr_conflict_fixes_repository
        ON pr_conflict_fixes (repository_id);
      CREATE INDEX IF NOT EXISTS idx_pr_conflict_fixes_status
        ON pr_conflict_fixes (status);
    `,
  },
  {
    id: '0010_session_review_states',
    sql: `
      -- The two in-flight states of the draft chain (US-002): \`reviewing\`
      -- (the automatic code review is running over the draft pull request) and
      -- \`fixing\` (the feedback run is pushing fixes for what it found). Both
      -- sit between \`building\` and \`pr-open\`, which is now only reached once
      -- the pull request has been marked ready for review.
      --
      -- Same rebuild dance as 0005, 0007 and 0008: SQLite cannot widen a CHECK
      -- in place, and \`sessions\` cannot be renamed out of the way because the
      -- foreign key on \`stories.session_id\` would follow the rename and then
      -- cascade every story away with the old table. No backfill this time --
      -- no existing row can legitimately be in either new state.
      --
      -- The \`0010\` prefix is shared with \`0010_pr_conflict_fixes\`, which
      -- landed on \`main\` while this branch was open. Migrations are matched
      -- and ordered by their full id, so neither had to be renumbered out from
      -- under the databases that have already recorded it; the fixer creates a
      -- table of its own and runs first, which is where an ORDER BY id puts it
      -- too.
      CREATE TABLE sessions_backup AS SELECT * FROM sessions;
      CREATE TABLE stories_backup AS SELECT * FROM stories;

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
                               ('pending', 'ready', 'building', 'waiting', 'failed',
                                'finished', 'reviewing', 'fixing', 'pr-open', 'merged')),
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
  {
    id: '0011_session_feedback_failure_stage',
    sql: `
      -- The feedback run gets a failure stage of its own (US-006). A session
      -- whose run failed has its commits pushed, its pull request open and its
      -- review posted, so — like \`review\` before it — a retry re-runs the
      -- delivery from there and never a story.
      --
      -- The same rebuild dance as 0005, 0007, 0008 and the migration right
      -- before this one: SQLite cannot widen a CHECK in place, and
      -- \`sessions\` cannot be renamed out of the way because the foreign key
      -- on \`stories.session_id\` would follow the rename and cascade every
      -- story away with the old table.
      CREATE TABLE sessions_backup AS SELECT * FROM sessions;
      CREATE TABLE stories_backup AS SELECT * FROM stories;

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
                               ('pending', 'ready', 'building', 'waiting', 'failed',
                                'finished', 'reviewing', 'fixing', 'pr-open', 'merged')),
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
                                'feedback', 'container_lost')),
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
  {
    id: '0012_recurring_tasks',
    sql: `
      -- Recurring tasks (US-001): a stored prompt plus a cron expression, from
      -- which the scheduler spawns one ordinary session per due occurrence.
      --
      -- \`next_run_at\` is a column, not a timer: the scheduler's due-query is
      -- the only thing that fires a task, so a restart or an hour of downtime
      -- resumes exactly where it left off — the same property scheduled starts
      -- already have.
      CREATE TABLE IF NOT EXISTS recurring_tasks (
        id               TEXT PRIMARY KEY,
        repository_id    TEXT NOT NULL
                           REFERENCES repositories (id) ON DELETE CASCADE,
        -- Slug, and the same alphabet as a session name: every run is named
        -- \`<name>-<YYYYMMDD-HHmm>\`, which has to stay a legal session name.
        name             TEXT NOT NULL
                           CHECK (name <> '' AND name NOT GLOB '*[^A-Za-z0-9_-]*'),
        -- What the run is asked to do; embedded verbatim in the generated PRD.
        prompt           TEXT NOT NULL CHECK (prompt <> ''),
        -- Five-field cron, evaluated in the server's timezone.
        cron_expression  TEXT NOT NULL,
        base_branch      TEXT NOT NULL,
        pr_target        TEXT NOT NULL CHECK (pr_target IN ('develop', 'main')),
        run_code_review  INTEGER NOT NULL DEFAULT 0 CHECK (run_code_review IN (0, 1)),
        paused           INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
        -- UTC ISO moment the next occurrence is due. NULL means "never fires"
        -- — where a paused task is left until it is resumed.
        next_run_at      TEXT,
        -- Denormalized mirror of the newest \`recurring_task_occurrences\` row,
        -- so the task list can show an outcome without a per-row subquery.
        last_outcome     TEXT
                           CHECK (last_outcome IS NULL OR last_outcome IN
                             ('started', 'skipped', 'fire-failed', 'pr-opened',
                              'clean', 'failed')),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE (repository_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_recurring_tasks_repository
        ON recurring_tasks (repository_id);
      -- Backs the due-tasks query; NULLs are not indexed by SQLite, so a task
      -- with no next occurrence costs nothing to skip.
      CREATE INDEX IF NOT EXISTS idx_recurring_tasks_next_run_at
        ON recurring_tasks (next_run_at)
        WHERE next_run_at IS NOT NULL;

      -- One row per occurrence, including the ones that create no session: a
      -- skip because yesterday's pull request is still open is as much a part
      -- of the history as a run that opened one.
      CREATE TABLE IF NOT EXISTS recurring_task_occurrences (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        recurring_task_id TEXT NOT NULL
                            REFERENCES recurring_tasks (id) ON DELETE CASCADE,
        occurred_at       TEXT NOT NULL,
        outcome           TEXT NOT NULL
                            CHECK (outcome IN
                              ('started', 'skipped', 'fire-failed', 'pr-opened',
                               'clean', 'failed')),
        -- Why, in the operator's words: the skip reason, the failure, or the
        -- pull request link.
        detail            TEXT,
        -- The session this occurrence spawned, when it spawned one. Nulled
        -- rather than cascaded if that session is deleted by hand, so the
        -- history keeps the row.
        session_id        TEXT REFERENCES sessions (id) ON DELETE SET NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recurring_task_occurrences_task
        ON recurring_task_occurrences (recurring_task_id, occurred_at DESC, id DESC);

      -- Which task a run came from; NULL for every session a human started.
      -- Deleting a task nulls this rather than touching the session: the runs
      -- it already produced are ordinary sessions and outlive it.
      --
      -- NOTE for whoever next rebuilds \`sessions\` to widen a CHECK the way
      -- 0005/0007/0008/0010/0011 did: this column has to be carried across, and
      -- the occurrence rows set aside the way the stories are, or dropping the
      -- old table nulls every \`session_id\` in the history.
      ALTER TABLE sessions ADD COLUMN recurring_task_id TEXT
        REFERENCES recurring_tasks (id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_sessions_recurring_task
        ON sessions (recurring_task_id)
        WHERE recurring_task_id IS NOT NULL;
    `,
  },
  {
    id: '0013_sentry_issues',
    sql: `
      -- Which Sentry project a repository's errors come from (US-001). Both
      -- slugs are set together or not at all: a link needs an org *and* a
      -- project to address anything, and NULL is what "not linked" means.
      ALTER TABLE repositories ADD COLUMN sentry_org TEXT;
      ALTER TABLE repositories ADD COLUMN sentry_project TEXT;

      -- Every Sentry issue chief-web has ever taken an interest in.
      --
      -- Modelled on \`pr_runs\`: one durable row per upstream object, carrying
      -- the whole lifecycle rather than one row per attempt, so a restart --
      -- or a poll that sees the same issue for the hundredth time -- resumes
      -- instead of duplicating. The Sentry-side fields are a cache of what the
      -- last poll saw; the chief-web-side fields (\`status\`, \`explanation\`,
      -- \`session_id\`, \`attempts\`) are the state machine, and a refresh
      -- never touches them.
      CREATE TABLE IF NOT EXISTS sentry_issues (
        id                 TEXT PRIMARY KEY,
        repository_id      TEXT NOT NULL
                             REFERENCES repositories (id) ON DELETE CASCADE,
        -- Sentry's own issue id, as a string. Unique across the install, so it
        -- is the dedupe key for the poller across every linked project.
        sentry_issue_id    TEXT NOT NULL UNIQUE,
        -- The human-facing \`PROJECT-1AB\` id; what session names derive from.
        short_id           TEXT NOT NULL,
        title              TEXT NOT NULL,
        -- Where Sentry thinks the error came from; frequently absent.
        culprit            TEXT,
        permalink          TEXT NOT NULL,
        level              TEXT,
        event_count        INTEGER NOT NULL DEFAULT 0,
        first_seen         TEXT NOT NULL,
        last_seen          TEXT NOT NULL,
        -- pending    -> fetched, awaiting classification
        -- queued     -> classified fixable, awaiting session creation
        -- working    -> session created and linked
        -- fixed      -> the linked session's pull request was merged
        -- cannot_fix -> the classifier said no, or the session never landed
        status             TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN
                               ('pending', 'queued', 'working', 'fixed', 'cannot_fix')),
        -- Why an issue is \`cannot_fix\`, in the operator's words. Every
        -- \`cannot_fix\` row is expected to carry one.
        explanation        TEXT,
        -- The build session working on the fix. ON DELETE SET NULL rather than
        -- CASCADE: deleting a session must not erase the record that chief-web
        -- ever looked at this issue, or the next poll would ingest it again.
        session_id         TEXT
                             REFERENCES sessions (id) ON DELETE SET NULL,
        -- Whether the "resolve it upstream" call has succeeded yet. Separate
        -- from \`status\`, because a failed resolve retries on later ticks and
        -- must never revert \`fixed\`.
        resolved_in_sentry INTEGER NOT NULL DEFAULT 0,
        -- Failed tries at the issue's current phase; at three the issue goes
        -- \`cannot_fix\`. One counter serves both classification and session
        -- creation because those phases never overlap -- the verdict that ends
        -- the first is what starts the second, and it resets the counter.
        attempts           INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sentry_issues_repository
        ON sentry_issues (repository_id);
      CREATE INDEX IF NOT EXISTS idx_sentry_issues_status
        ON sentry_issues (status);
      -- The merge watcher looks issues up by the session that is fixing them.
      CREATE INDEX IF NOT EXISTS idx_sentry_issues_session
        ON sentry_issues (session_id)
        WHERE session_id IS NOT NULL;
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
