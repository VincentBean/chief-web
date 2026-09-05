import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  countSessionsByStatus,
  createRepository,
  createSession,
  type Database,
  deleteRepository,
  deleteSession,
  failSession,
  FAILURE_STAGES,
  failureStageLabel,
  getAllSettings,
  getRepository,
  getSession,
  getSetting,
  getSettingNumber,
  IN_MEMORY,
  isDeliveryStage,
  listDueScheduledSessions,
  listQueuedSessions,
  listRepositories,
  listSessions,
  listStories,
  MIGRATIONS,
  nextIncompleteStory,
  openDatabase,
  queuePosition,
  type Repository,
  runMigrations,
  setSetting,
  syncStories,
  updateRepository,
  updateSession,
  updateStory,
} from './index.js';

/** The migration under test in 'widens the session status check'. */
const WAITING_MIGRATION = '0005_session_waiting_status';
const REVIEW_STAGE_MIGRATION = '0007_session_review_failure_stage';

/** The migration under test in 'widens the check to `pr-open`/`merged`'. */
const PR_STATES_MIGRATION = '0008_session_pr_states';

/** The migration under test in 'widens the check to `reviewing`/`fixing`'. */
const REVIEW_STATES_MIGRATION = '0010_session_review_states';
const FEEDBACK_STAGE_MIGRATION = '0011_session_feedback_failure_stage';

function freshDb(): Database {
  return openDatabase(IN_MEMORY);
}

function seedRepository(db: Database): Repository {
  return createRepository(db, {
    name: 'chief-web',
    sshUrl: 'git@github.com:minicodemonkey/chief-web.git',
    githubSlug: 'minicodemonkey/chief-web',
    defaultBaseBranch: 'develop',
  });
}

/**
 * A repository with only the columns migration 0001 created, for the tests that
 * walk the schema up to one migration: `createRepository` writes today's
 * column set, which a database stopped part-way through history has not got yet.
 */
function seedLegacyRepository(db: Database): { readonly id: string } {
  const at = '2026-08-30T00:00:00.000Z';
  const id = randomUUID();
  db.prepare(
    `INSERT INTO repositories
       (id, name, ssh_url, github_slug, default_base_branch, created_at, updated_at)
     VALUES (?, 'chief-web', 'git@github.com:minicodemonkey/chief-web.git',
             'minicodemonkey/chief-web', 'develop', ?, ?)`,
  ).run(id, at, at);
  return { id };
}

describe('migrations', () => {
  it('creates every table on a fresh database', () => {
    const db = freshDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row['name']);

    for (const table of ['repositories', 'sessions', 'stories', 'settings', 'schema_migrations']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
    closeDatabase(db);
  });

  it('is idempotent: re-running applies nothing and keeps data', () => {
    const db = freshDb();
    const repository = seedRepository(db);

    assert.deepEqual(runMigrations(db), []);
    assert.deepEqual(runMigrations(db), []);
    assert.equal(getRepository(db, repository.id)?.name, 'chief-web');
    closeDatabase(db);
  });

  it('records each migration exactly once', () => {
    const db = freshDb();
    const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all();

    assert.deepEqual(
      rows.map((row) => row['id']),
      MIGRATIONS.map((migration) => migration.id),
    );
    closeDatabase(db);
  });

  it('widens the session status check to `waiting`, stories intact', () => {
    // The rebuild that widens the CHECK drops and recreates `sessions` while
    // `stories` still references it, so this walks a database up to the
    // migration before it, puts a session and a story in, and then applies it.
    const db = new DatabaseSync(IN_MEMORY) as Database;
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
    );

    const index = MIGRATIONS.findIndex((migration) => migration.id === WAITING_MIGRATION);
    assert.ok(index > 0, `${WAITING_MIGRATION} is missing`);
    for (const migration of MIGRATIONS.slice(0, index)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        '2026-08-30T00:00:00.000Z',
      );
    }

    const repository = seedLegacyRepository(db);
    db.prepare(
      `INSERT INTO sessions
         (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
          created_at, updated_at)
       VALUES ('s1', ?, 'legacy', 'building', 'main', 'chief/legacy', 'main', ?, ?)`,
    ).run(repository.id, '2026-08-30T00:00:00.000Z', '2026-08-30T00:00:00.000Z');
    syncStories(db, 's1', [{ storyId: 'US-001', title: 'First', priority: 1, status: 'done' }]);

    assert.ok(runMigrations(db).includes(WAITING_MIGRATION));

    // The old rows came across, and the cascade from `stories` never fired.
    const session = getSession(db, 's1');
    assert.equal(session?.status, 'building');
    assert.equal(session?.featureBranch, 'chief/legacy');
    // Nothing was waiting before the column existed.
    assert.equal(session?.waitingUntil, null);
    assert.equal(listStories(db, 's1').length, 1);

    // The widened constraint takes the new status and still refuses the rest.
    const waiting = updateSession(db, 's1', {
      status: 'waiting',
      waitingUntil: '2026-08-30T01:00:00.000Z',
    });
    assert.equal(waiting?.status, 'waiting');
    assert.equal(waiting?.waitingUntil, '2026-08-30T01:00:00.000Z');
    assert.throws(
      () => db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('bogus', 's1'),
      /CHECK/i,
    );

    // The indexes travelled with the table, and so did the cascade.
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
      .all()
      .map((row) => row['name']);
    for (const name of ['idx_sessions_repository', 'idx_sessions_status', 'idx_sessions_queued_at']) {
      assert.ok(indexes.includes(name), `missing index ${name}`);
    }
    assert.ok(deleteSession(db, 's1'));
    assert.equal(listStories(db, 's1').length, 0);

    closeDatabase(db);
  });

  it('widens the failure stage check to `review`, rows intact', () => {
    // Same rebuild as `0005`, so the same walk: a session that already failed
    // at the push, with a story and the code-review flag set, has to come out
    // the other side unchanged (US-006).
    const db = new DatabaseSync(IN_MEMORY) as Database;
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(
      'CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);',
    );

    const index = MIGRATIONS.findIndex((migration) => migration.id === REVIEW_STAGE_MIGRATION);
    assert.ok(index > 0, `${REVIEW_STAGE_MIGRATION} is missing`);
    for (const migration of MIGRATIONS.slice(0, index)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        '2026-09-01T00:00:00.000Z',
      );
    }

    const repository = seedLegacyRepository(db);
    // Inserted by hand, like the walks above it: `createSession` writes the
    // columns the schema has *today*, which is more than it had here.
    const at = '2026-09-01T00:00:00.000Z';
    const session = { id: 'legacy' };
    db.prepare(
      `INSERT INTO sessions
         (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
          code_review, created_at, updated_at)
       VALUES (?, ?, 'legacy', 'pending', 'main', 'chief/legacy', 'main', 1, ?, ?)`,
    ).run(session.id, repository.id, at, at);
    failSession(db, session.id, 'push', 'Permission denied (publickey).');
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'First', priority: 1, status: 'done' },
    ]);

    // The stage the schema did not know yet.
    assert.throws(
      () =>
        db
          .prepare('UPDATE sessions SET failure_stage = ? WHERE id = ?')
          .run('review', session.id),
      /CHECK/i,
    );

    assert.ok(runMigrations(db).includes(REVIEW_STAGE_MIGRATION));

    const migrated = getSession(db, session.id);
    assert.equal(migrated?.status, 'failed');
    assert.equal(migrated?.failureStage, 'push');
    assert.equal(migrated?.lastError, 'Permission denied (publickey).');
    assert.equal(migrated?.codeReview, true);
    assert.equal(listStories(db, session.id).length, 1);

    // The widened constraint takes the new stage and still refuses the rest.
    assert.equal(failSession(db, session.id, 'review', 'The review failed.')?.failureStage, 'review');
    assert.throws(
      () => db.prepare('UPDATE sessions SET failure_stage = ? WHERE id = ?').run('bogus', session.id),
      /CHECK/i,
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
      .all()
      .map((row) => row['name']);
    for (const name of ['idx_sessions_repository', 'idx_sessions_status', 'idx_sessions_queued_at']) {
      assert.ok(indexes.includes(name), `missing index ${name}`);
    }

    closeDatabase(db);
  });

  it('widens the check to `pr-open`/`merged` and backfills delivered sessions', () => {
    // Another CHECK-widening rebuild (US-001), walked the same way: up to the
    // migration before it, rows in, then apply it.
    const db = new DatabaseSync(IN_MEMORY) as Database;
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');

    const index = MIGRATIONS.findIndex((migration) => migration.id === PR_STATES_MIGRATION);
    assert.ok(index > 0, `${PR_STATES_MIGRATION} is missing`);
    for (const migration of MIGRATIONS.slice(0, index)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        '2026-09-01T00:00:00.000Z',
      );
    }

    const repository = seedLegacyRepository(db);
    const at = '2026-09-01T00:00:00.000Z';
    const insert = db.prepare(
      `INSERT INTO sessions
         (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
          pr_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, 'main', ?, ?, ?)`,
    );
    insert.run('delivered', repository.id, 'delivered', 'finished',
      'chief/delivered', 'https://github.com/acme/app/pull/7', at, at);
    insert.run('nopr', repository.id, 'nopr', 'finished', 'chief/nopr', null, at, at);
    insert.run('busy', repository.id, 'busy', 'building', 'chief/busy', null, at, at);
    syncStories(db, 'delivered', [{ storyId: 'US-001', title: 'First', priority: 1, status: 'done' }]);

    assert.ok(runMigrations(db).includes(PR_STATES_MIGRATION));

    // Only the finished session that opened a pull request moves.
    assert.equal(getSession(db, 'delivered')?.status, 'pr-open');
    assert.equal(getSession(db, 'delivered')?.prUrl, 'https://github.com/acme/app/pull/7');
    assert.equal(getSession(db, 'nopr')?.status, 'finished');
    assert.equal(getSession(db, 'busy')?.status, 'building');
    // The list is ordered by `updated_at`; a backfill must not reshuffle it.
    assert.equal(getSession(db, 'delivered')?.updatedAt, at);
    // The stories came across the rebuild, cascade and all.
    assert.equal(listStories(db, 'delivered').length, 1);

    // The widened constraint takes both new statuses and still refuses the rest.
    assert.equal(updateSession(db, 'busy', { status: 'pr-open' })?.status, 'pr-open');
    assert.equal(updateSession(db, 'busy', { status: 'merged' })?.status, 'merged');
    assert.throws(
      () => db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('bogus', 'busy'),
      /CHECK/i,
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
      .all()
      .map((row) => row['name']);
    for (const name of ['idx_sessions_repository', 'idx_sessions_status', 'idx_sessions_queued_at']) {
      assert.ok(indexes.includes(name), `missing index ${name}`);
    }
    assert.ok(deleteSession(db, 'delivered'));
    assert.equal(listStories(db, 'delivered').length, 0);

    closeDatabase(db);
  });

  it('widens the check to `reviewing`/`fixing` and leaves every row alone', () => {
    // The draft chain's two in-flight states (US-002). Same walk as above,
    // except there is nothing to backfill: no row can already be in them.
    const db = new DatabaseSync(IN_MEMORY) as Database;
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');

    const index = MIGRATIONS.findIndex((migration) => migration.id === REVIEW_STATES_MIGRATION);
    assert.ok(index > 0, `${REVIEW_STATES_MIGRATION} is missing`);
    for (const migration of MIGRATIONS.slice(0, index)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        '2026-09-01T00:00:00.000Z',
      );
    }

    const repository = seedLegacyRepository(db);
    const at = '2026-09-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO sessions
         (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
          pr_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'main', ?, 'main', ?, ?, ?)`,
    ).run('open', repository.id, 'open', 'pr-open', 'chief/open',
      'https://github.com/acme/app/pull/7', at, at);
    syncStories(db, 'open', [{ storyId: 'US-001', title: 'First', priority: 1, status: 'done' }]);

    assert.ok(runMigrations(db).includes(REVIEW_STATES_MIGRATION));

    // Nothing moved, and the stories came across the rebuild.
    assert.equal(getSession(db, 'open')?.status, 'pr-open');
    assert.equal(getSession(db, 'open')?.updatedAt, at);
    assert.equal(listStories(db, 'open').length, 1);

    // The widened constraint takes both new statuses and still refuses the rest.
    assert.equal(updateSession(db, 'open', { status: 'reviewing' })?.status, 'reviewing');
    assert.equal(updateSession(db, 'open', { status: 'fixing' })?.status, 'fixing');
    assert.throws(
      () => db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('bogus', 'open'),
      /CHECK/i,
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
      .all()
      .map((row) => row['name']);
    for (const name of ['idx_sessions_repository', 'idx_sessions_status', 'idx_sessions_queued_at']) {
      assert.ok(indexes.includes(name), `missing index ${name}`);
    }
    // The cascade survived the rebuild too.
    assert.ok(deleteSession(db, 'open'));
    assert.equal(listStories(db, 'open').length, 0);

    closeDatabase(db);
  });

  it('widens the failure stage check to `feedback`, stories intact', () => {
    const db = new DatabaseSync(IN_MEMORY) as Database;
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');

    const index = MIGRATIONS.findIndex((migration) => migration.id === FEEDBACK_STAGE_MIGRATION);
    assert.ok(index > 0, `${FEEDBACK_STAGE_MIGRATION} is missing`);
    for (const migration of MIGRATIONS.slice(0, index)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        '2026-09-01T00:00:00.000Z',
      );
    }

    const repository = seedLegacyRepository(db);
    const at = '2026-09-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO sessions
         (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
          pr_url, last_error, failure_stage, created_at, updated_at)
       VALUES (?, ?, ?, 'failed', 'main', ?, 'main', ?, 'the review died', 'review', ?, ?)`,
    ).run('failed', repository.id, 'failed', 'chief/failed',
      'https://github.com/acme/app/pull/7', at, at);
    syncStories(db, 'failed', [{ storyId: 'US-001', title: 'First', priority: 1, status: 'done' }]);

    assert.ok(runMigrations(db).includes(FEEDBACK_STAGE_MIGRATION));

    // The failed session came across the rebuild with its stage and stories.
    assert.equal(getSession(db, 'failed')?.failureStage, 'review');
    assert.equal(getSession(db, 'failed')?.lastError, 'the review died');
    assert.equal(listStories(db, 'failed').length, 1);

    // The widened constraint takes the new stage and still refuses the rest.
    assert.equal(failSession(db, 'failed', 'feedback', 'the run died')?.failureStage, 'feedback');
    assert.throws(
      () => db.prepare('UPDATE sessions SET failure_stage = ? WHERE id = ?').run('bogus', 'failed'),
      /CHECK/i,
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
      .all()
      .map((row) => row['name']);
    for (const name of ['idx_sessions_repository', 'idx_sessions_status', 'idx_sessions_queued_at']) {
      assert.ok(indexes.includes(name), `missing index ${name}`);
    }
    assert.ok(deleteSession(db, 'failed'));
    assert.equal(listStories(db, 'failed').length, 0);

    closeDatabase(db);
  });
});

describe('persistence across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-db-'));
  const file = path.join(dir, 'nested', 'chief-web.db');

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives closing and reopening the database file', () => {
    const first = openDatabase(file);
    const repository = seedRepository(first);
    const session = createSession(first, {
      repositoryId: repository.id,
      name: 'add_login',
      baseBranch: 'develop',
      prTargetBranch: 'develop',
    });
    setSetting(first, 'github_token', 'ghp_example');
    closeDatabase(first);

    const second = openDatabase(file);
    assert.equal(listRepositories(second).length, 1);
    assert.equal(listSessions(second).length, 1);
    assert.equal(listSessions(second)[0]?.id, session.id);
    assert.equal(getSetting(second, 'github_token'), 'ghp_example');
    closeDatabase(second);
  });
});

describe('repositories', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('creates, reads, updates and deletes', () => {
    const repository = seedRepository(db);

    assert.equal(repository.defaultBaseBranch, 'develop');
    assert.deepEqual(getRepository(db, repository.id), repository);

    const updated = updateRepository(db, repository.id, { name: 'renamed' });
    assert.equal(updated?.name, 'renamed');
    assert.equal(updated?.sshUrl, repository.sshUrl);

    assert.equal(deleteRepository(db, repository.id), true);
    assert.equal(getRepository(db, repository.id), null);
  });

  it('defaults the base branch to main', () => {
    const repository = createRepository(db, {
      name: 'other',
      sshUrl: 'git@github.com:o/other.git',
      githubSlug: 'o/other',
    });
    assert.equal(repository.defaultBaseBranch, 'main');
  });

  it('rejects duplicate names', () => {
    seedRepository(db);
    assert.throws(() => seedRepository(db), /UNIQUE/i);
  });

  it('cannot be deleted while a session references it', () => {
    const repository = seedRepository(db);
    createSession(db, {
      repositoryId: repository.id,
      name: 'feature-1',
      baseBranch: 'develop',
      prTargetBranch: 'main',
    });

    assert.throws(() => deleteRepository(db, repository.id), /FOREIGN KEY/i);
  });
});

describe('sessions', () => {
  let db: Database;
  let repository: Repository;
  beforeEach(() => {
    db = freshDb();
    repository = seedRepository(db);
  });

  it('creates a pending session with a derived feature branch', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'add-login',
      baseBranch: 'develop',
      prTargetBranch: 'main',
    });

    assert.equal(session.status, 'pending');
    assert.equal(session.featureBranch, 'chief/add-login');
    assert.equal(session.scheduledStartAt, null);
    assert.equal(session.queuedAt, null);
    assert.equal(session.containerId, null);
    assert.equal(session.prUrl, null);
    assert.equal(session.lastError, null);
    assert.equal(session.codeReview, false);
  });

  it('round-trips the code review flag', () => {
    const asked = createSession(db, {
      repositoryId: repository.id,
      name: 'reviewed',
      baseBranch: 'develop',
      prTargetBranch: 'main',
      codeReview: true,
    });

    assert.equal(asked.codeReview, true);
    // Read back from SQLite, where the flag is a 0/1 integer, not a boolean.
    assert.equal(getSession(db, asked.id)?.codeReview, true);

    assert.equal(updateSession(db, asked.id, { codeReview: false })?.codeReview, false);
    assert.equal(getSession(db, asked.id)?.codeReview, false);
    assert.equal(updateSession(db, asked.id, { codeReview: true })?.codeReview, true);
  });

  it('rejects names that are not slugs', () => {
    for (const name of ['has space', 'has/slash', '', 'héllo']) {
      assert.throws(
        () =>
          createSession(db, {
            repositoryId: repository.id,
            name,
            baseBranch: 'main',
            prTargetBranch: 'main',
          }),
        /Invalid session name/,
      );
    }
  });

  it('rejects an unknown repository and duplicate names per repository', () => {
    assert.throws(
      () =>
        createSession(db, {
          repositoryId: 'missing',
          name: 'x',
          baseBranch: 'main',
          prTargetBranch: 'main',
        }),
      /FOREIGN KEY/i,
    );

    createSession(db, {
      repositoryId: repository.id,
      name: 'dup',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });
    assert.throws(
      () =>
        createSession(db, {
          repositoryId: repository.id,
          name: 'dup',
          baseBranch: 'main',
          prTargetBranch: 'main',
        }),
      /UNIQUE/i,
    );
  });

  it('rejects invalid statuses and PR targets at the schema level', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'checked',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });

    assert.throws(
      () => db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run('bogus', session.id),
      /CHECK/i,
    );
    assert.throws(
      () =>
        db.prepare('UPDATE sessions SET pr_target_branch = ? WHERE id = ?').run('nope', session.id),
      /CHECK/i,
    );
  });

  it('updates only the provided fields and clears nullables', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'lifecycle',
      baseBranch: 'main',
      prTargetBranch: 'main',
      scheduledStartAt: '2026-09-01T02:00:00.000Z',
    });

    const building = updateSession(db, session.id, {
      status: 'building',
      containerId: 'container-abc',
      scheduledStartAt: null,
    });
    assert.equal(building?.status, 'building');
    assert.equal(building?.containerId, 'container-abc');
    assert.equal(building?.scheduledStartAt, null);
    assert.equal(building?.baseBranch, 'main');

    const failed = failSession(db, session.id, 'container_lost', 'container lost');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.lastError, 'container lost');
    // Both halves of the diagnosis, always written together (US-019).
    assert.equal(failed?.failureStage, 'container_lost');
    assert.equal(failed?.containerId, 'container-abc');

    // Recovering clears the stage without touching anything else.
    const retried = updateSession(db, session.id, { status: 'building', failureStage: null });
    assert.equal(retried?.failureStage, null);
    assert.equal(retried?.lastError, 'container lost');

    assert.equal(updateSession(db, 'missing', { status: 'ready' }), null);
  });

  it('names every failure stage the way the UI says it', () => {
    // The review sits with the push and the pull request: a delivery step the
    // retry re-runs on its own (US-006).
    assert.equal(failureStageLabel('review'), 'the code review');
    assert.equal(isDeliveryStage('review'), true);
    // And so does the feedback run the review's findings are handed to
    // (US-006): the pull request is open and reviewed by the time it runs.
    assert.equal(failureStageLabel('feedback'), 'the feedback run');
    assert.equal(isDeliveryStage('feedback'), true);
    assert.equal(isDeliveryStage('agent'), false);
    assert.equal(isDeliveryStage(null), false);
    // Every stage has a label; none of them falls through to undefined.
    for (const stage of FAILURE_STAGES) {
      assert.equal(typeof failureStageLabel(stage), 'string');
    }
  });

  it('stores a review failure like any other stage', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'reviewed',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });
    const failed = failSession(db, session.id, 'review', 'The code review did not post.');
    assert.equal(failed?.failureStage, 'review');
    assert.equal(getSession(db, session.id)?.failureStage, 'review');
  });

  it('refuses a failure stage the schema does not know', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'bad-stage',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });
    assert.throws(() =>
      db
        .prepare('UPDATE sessions SET failure_stage = ? WHERE id = ?')
        .run('whenever', session.id),
    );
  });

  it('filters, counts and orders the build queue', () => {
    const first = createSession(db, {
      repositoryId: repository.id,
      name: 'first',
      baseBranch: 'main',
      prTargetBranch: 'main',
      status: 'ready',
    });
    const second = createSession(db, {
      repositoryId: repository.id,
      name: 'second',
      baseBranch: 'main',
      prTargetBranch: 'main',
      status: 'building',
    });

    assert.equal(listSessions(db, { status: 'ready' }).length, 1);
    assert.equal(listSessions(db, { repositoryId: repository.id }).length, 2);
    assert.equal(listSessions(db, { repositoryId: 'other' }).length, 0);
    assert.equal(countSessionsByStatus(db, 'building'), 1);

    updateSession(db, second.id, { status: 'ready', queuedAt: '2026-08-29T10:00:00.000Z' });
    updateSession(db, first.id, { queuedAt: '2026-08-29T09:00:00.000Z' });

    assert.deepEqual(
      listQueuedSessions(db).map((session) => session.id),
      [first.id, second.id],
    );
    // The "#2" the UI shows, counted with the same order (US-018).
    assert.equal(queuePosition(db, { id: first.id, queuedAt: '2026-08-29T09:00:00.000Z' }), 1);
    assert.equal(queuePosition(db, { id: second.id, queuedAt: '2026-08-29T10:00:00.000Z' }), 2);
    assert.equal(queuePosition(db, { id: first.id, queuedAt: null }), null);

    updateSession(db, first.id, { queuedAt: null });
    assert.deepEqual(
      listQueuedSessions(db).map((session) => session.id),
      [second.id],
    );
    assert.equal(queuePosition(db, { id: second.id, queuedAt: '2026-08-29T10:00:00.000Z' }), 1);
  });

  it('orders two sessions queued in the same millisecond by id', () => {
    const at = '2026-08-29T11:00:00.000Z';
    const ids = ['alpha', 'beta', 'gamma'].map((name) => {
      const session = createSession(db, {
        repositoryId: repository.id,
        name,
        baseBranch: 'main',
        prTargetBranch: 'main',
        status: 'ready',
      });
      updateSession(db, session.id, { queuedAt: at });
      return session.id;
    });

    // A tie on the timestamp is broken on the id, so every reader — the queue
    // itself and the position shown next to a session — agrees on the order.
    assert.deepEqual(
      listQueuedSessions(db).map((session) => session.id),
      [...ids].sort(),
    );
    for (const [index, id] of [...ids].sort().entries()) {
      assert.equal(queuePosition(db, { id, queuedAt: at }), index + 1);
    }
  });

  it('finds ready sessions whose schedule is due', () => {
    const due = createSession(db, {
      repositoryId: repository.id,
      name: 'due',
      baseBranch: 'main',
      prTargetBranch: 'main',
      status: 'ready',
      scheduledStartAt: '2026-08-29T09:00:00.000Z',
    });
    createSession(db, {
      repositoryId: repository.id,
      name: 'later',
      baseBranch: 'main',
      prTargetBranch: 'main',
      status: 'ready',
      scheduledStartAt: '2026-08-29T23:00:00.000Z',
    });
    createSession(db, {
      repositoryId: repository.id,
      name: 'still-planning',
      baseBranch: 'main',
      prTargetBranch: 'main',
      scheduledStartAt: '2026-08-29T09:00:00.000Z',
    });

    assert.deepEqual(
      listDueScheduledSessions(db, '2026-08-29T12:00:00.000Z').map((session) => session.id),
      [due.id],
    );
  });

it('holds a session at `waiting` with the time it may resume', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'held',
      baseBranch: 'main',
      prTargetBranch: 'main',
      status: 'building',
    });
    assert.equal(session.waitingUntil, null);

    const held = updateSession(db, session.id, {
      status: 'waiting',
      waitingUntil: '2026-08-31T13:00:00.000Z',
    });
    assert.equal(held?.status, 'waiting');
    assert.equal(held?.waitingUntil, '2026-08-31T13:00:00.000Z');
    // It reads back the same way a fresh process would see it.
    assert.equal(getSession(db, session.id)?.waitingUntil, '2026-08-31T13:00:00.000Z');
    assert.equal(countSessionsByStatus(db, 'waiting'), 1);
    assert.equal(countSessionsByStatus(db, 'building'), 0);

    // Resuming puts the container back to work and drops the deadline.
    const resumed = updateSession(db, session.id, { status: 'building', waitingUntil: null });
    assert.equal(resumed?.status, 'building');
    assert.equal(resumed?.waitingUntil, null);
    assert.equal(listSessions(db, { status: 'waiting' }).length, 0);
  });

  it('round-trips the post-build states `pr-open` and `merged`', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'delivered',
      baseBranch: 'main',
      prTargetBranch: 'main',
      status: 'building',
    });

    // Delivery opens the pull request (US-002) and the session lands here.
    const open = updateSession(db, session.id, {
      status: 'pr-open',
      prUrl: 'https://github.com/acme/app/pull/7',
      containerId: 'container-abc',
    });
    assert.equal(open?.status, 'pr-open');
    // It reads back the same way a fresh process would see it.
    assert.equal(getSession(db, session.id)?.status, 'pr-open');
    assert.equal(getSession(db, session.id)?.prUrl, 'https://github.com/acme/app/pull/7');
    assert.equal(countSessionsByStatus(db, 'pr-open'), 1);
    assert.deepEqual(
      listSessions(db, { status: 'pr-open' }).map((s) => s.id),
      [session.id],
    );

    // The sync sees the merge and the container goes with it (US-003, US-005).
    const merged = updateSession(db, session.id, { status: 'merged', containerId: null });
    assert.equal(merged?.status, 'merged');
    assert.equal(merged?.containerId, null);
    // The pull request URL survives the merge; the UI still links to it.
    assert.equal(getSession(db, session.id)?.prUrl, 'https://github.com/acme/app/pull/7');
    assert.equal(getSession(db, session.id)?.status, 'merged');
    assert.equal(countSessionsByStatus(db, 'merged'), 1);
    assert.equal(countSessionsByStatus(db, 'pr-open'), 0);
    assert.equal(listSessions(db, { status: 'pr-open' }).length, 0);
  });

  it('deletes a session and cascades to its stories', () => {
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'doomed',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'Scaffold', priority: 1, status: 'done' },
    ]);

    assert.equal(deleteSession(db, session.id), true);
    assert.equal(listStories(db, session.id).length, 0);
  });
});

describe('stories', () => {
  let db: Database;
  let sessionId: string;
  beforeEach(() => {
    db = freshDb();
    const repository = seedRepository(db);
    sessionId = createSession(db, {
      repositoryId: repository.id,
      name: 'stories',
      baseBranch: 'main',
      prTargetBranch: 'main',
    }).id;
  });

  it('syncs parsed stories, ordered by priority', () => {
    const stories = syncStories(db, sessionId, [
      { storyId: 'US-002', title: 'Data layer', priority: 2, status: 'todo' },
      { storyId: 'US-001', title: 'Scaffold', priority: 1, status: 'done' },
    ]);

    assert.deepEqual(
      stories.map((story) => story.storyId),
      ['US-001', 'US-002'],
    );
    assert.equal(stories[0]?.status, 'done');
    assert.equal(stories[0]?.commitSha, null);
  });

  it('updates existing stories, keeps commit SHAs and drops removed ones', () => {
    syncStories(db, sessionId, [
      { storyId: 'US-001', title: 'Scaffold', priority: 1, status: 'done', commitSha: 'abc123' },
      { storyId: 'US-002', title: 'Data layer', priority: 2, status: 'todo' },
      { storyId: 'US-003', title: 'Dropped later', priority: 3, status: 'todo' },
    ]);

    const synced = syncStories(db, sessionId, [
      { storyId: 'US-001', title: 'Scaffold the project', priority: 1, status: 'done' },
      { storyId: 'US-002', title: 'Data layer', priority: 2, status: 'in-progress' },
    ]);

    assert.deepEqual(
      synced.map((story) => story.storyId),
      ['US-001', 'US-002'],
    );
    assert.equal(synced[0]?.title, 'Scaffold the project');
    assert.equal(synced[0]?.commitSha, 'abc123');
    assert.equal(synced[1]?.status, 'in-progress');
  });

  it('clears the story list when the PRD has none', () => {
    syncStories(db, sessionId, [
      { storyId: 'US-001', title: 'Scaffold', priority: 1, status: 'todo' },
    ]);
    assert.deepEqual(syncStories(db, sessionId, []), []);
  });

  it('selects the lowest-priority incomplete story', () => {
    syncStories(db, sessionId, [
      { storyId: 'US-001', title: 'Scaffold', priority: 1, status: 'done' },
      { storyId: 'US-003', title: 'Third', priority: 3, status: 'todo' },
      { storyId: 'US-002', title: 'Data layer', priority: 2, status: 'in-progress' },
    ]);

    assert.equal(nextIncompleteStory(db, sessionId)?.storyId, 'US-002');

    updateStory(db, sessionId, 'US-002', { status: 'done', commitSha: 'deadbeef' });
    assert.equal(nextIncompleteStory(db, sessionId)?.storyId, 'US-003');

    updateStory(db, sessionId, 'US-003', { status: 'done' });
    assert.equal(nextIncompleteStory(db, sessionId), null);
  });

  it('rejects unknown story statuses at the schema level', () => {
    syncStories(db, sessionId, [
      { storyId: 'US-001', title: 'Scaffold', priority: 1, status: 'todo' },
    ]);

    assert.throws(
      () => db.prepare('UPDATE stories SET status = ? WHERE session_id = ?').run('nope', sessionId),
      /CHECK/i,
    );
  });
});

describe('settings', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('stores, overwrites and reads key-value pairs', () => {
    assert.equal(getSetting(db, 'github_token'), null);

    setSetting(db, 'github_token', 'ghp_one');
    setSetting(db, 'github_token', 'ghp_two');
    setSetting(db, 'git_author_name', 'chief-web');

    assert.equal(getSetting(db, 'github_token'), 'ghp_two');
    assert.deepEqual(getAllSettings(db), {
      github_token: 'ghp_two',
      git_author_name: 'chief-web',
    });
  });

  it('reads numeric settings with a fallback', () => {
    assert.equal(getSettingNumber(db, 'max_concurrent_sessions', 3), 3);

    setSetting(db, 'max_concurrent_sessions', '5');
    assert.equal(getSettingNumber(db, 'max_concurrent_sessions', 3), 5);

    setSetting(db, 'max_concurrent_sessions', 'not-a-number');
    assert.equal(getSettingNumber(db, 'max_concurrent_sessions', 3), 3);
  });
});
