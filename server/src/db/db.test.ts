import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  getAllSettings,
  getRepository,
  getSetting,
  getSettingNumber,
  IN_MEMORY,
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
