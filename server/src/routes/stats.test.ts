import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  featureBranchFor,
  IN_MEMORY,
  openDatabase,
  syncStories,
  updateSession,
  updateStory,
} from '../db/index.js';
import type { StatsView } from './stats.js';

const PASSWORD = 'correct horse battery staple';

describe('stats api', () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;
  let repositoryId: string;

  before(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, MAX_CONCURRENT_SESSIONS: '4' });
    db = openDatabase(IN_MEMORY);
    const app = createApp(config, createAuthService(config, db), db);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'main',
    });
    repositoryId = repository.id;
    const seed = (name: string, status: 'ready' | 'finished' | 'failed' | 'building') =>
      createSession(db, {
        repositoryId: repository.id,
        name,
        baseBranch: 'main',
        prTargetBranch: 'main',
        featureBranch: featureBranchFor(name),
        status,
        scheduledStartAt: null,
      });
    const finished = seed('one', 'finished');
    updateSession(db, finished.id, { prUrl: 'https://github.com/acme/demo/pull/1' });
    syncStories(db, finished.id, [
      { storyId: 'US-001', title: 'a', priority: 1, status: 'done' },
      { storyId: 'US-002', title: 'b', priority: 2, status: 'done' },
    ]);
    const building = seed('two', 'building');
    syncStories(db, building.id, [
      { storyId: 'US-001', title: 'a', priority: 1, status: 'todo' },
      { storyId: 'US-002', title: 'b', priority: 2, status: 'in-progress' },
    ]);
    updateStory(db, building.id, 'US-001', { status: 'done' });
    seed('three', 'failed');
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  it('requires the session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/stats`);
    assert.equal(response.status, 401);
  });

  it('aggregates sessions, stories and build slots', async () => {
    const response = await fetch(`${baseUrl}/api/stats`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as StatsView;

    assert.equal(body.sessions.total, 3);
    assert.equal(body.sessions.byStatus.finished, 1);
    assert.equal(body.sessions.byStatus.building, 1);
    assert.equal(body.sessions.byStatus.failed, 1);
    assert.equal(body.sessions.byStatus.pending, 0);

    assert.deepEqual(body.stories, { total: 4, done: 3, inProgress: 1, todo: 0 });
    assert.equal(body.pullRequestsOpened, 1);
    assert.deepEqual(body.builds, { active: 1, queued: 0, max: 4 });
    assert.equal(body.hold.until, null);

    assert.equal(body.activity.length, 14);
    const today = new Date().toISOString().slice(0, 10);
    const last = body.activity[body.activity.length - 1];
    assert.equal(last?.day, today);
    assert.equal(last?.storiesDone, 3);
    assert.equal(last?.sessionsFinished, 1);
    assert.equal(last?.sessionsCreated, 3);

    assert.equal(body.repositories.length, 1);
    assert.equal(body.repositories[0]?.name, 'demo');
    assert.equal(body.repositories[0]?.sessions, 3);
    assert.equal(body.repositories[0]?.storiesDone, 3);
    assert.equal(body.repositories[0]?.storiesTotal, 4);
    assert.equal(body.repositories[0]?.finished, 1);
    assert.equal(body.repositories[0]?.failed, 1);
    assert.equal(body.repositories[0]?.active, 1);
  });

  it('clamps the window', async () => {
    const response = await fetch(`${baseUrl}/api/stats?days=3`, { headers: { cookie } });
    const body = (await response.json()) as StatsView;
    assert.equal(body.activity.length, 3);
  });

  /*
   * Declared last on purpose: it seeds two more sessions, which the totals the
   * tests above assert are counted from.
   */
  describe('sessions delivered and merged (US-006)', () => {
    before(() => {
      for (const [name, status] of [
        ['four', 'pr-open'],
        ['five', 'merged'],
      ] as const) {
        const session = createSession(db, {
          repositoryId,
          name,
          baseBranch: 'main',
          prTargetBranch: 'main',
          featureBranch: featureBranchFor(name),
          status,
          scheduledStartAt: null,
        });
        updateSession(db, session.id, { prUrl: `https://github.com/acme/demo/pull/${name}` });
      }
    });

    it('counts pr-open and merged sessions as finished', async () => {
      const response = await fetch(`${baseUrl}/api/stats`, { headers: { cookie } });
      const body = (await response.json()) as StatsView;

      assert.equal(body.sessions.total, 5);
      assert.equal(body.sessions.byStatus['pr-open'], 1);
      assert.equal(body.sessions.byStatus.merged, 1);
      assert.equal(body.sessions.byStatus.finished, 1);
      assert.equal(body.pullRequestsOpened, 3);

      // The three ended sessions, not just the one still called `finished`.
      assert.equal(body.repositories[0]?.finished, 3);
      assert.equal(body.activity[body.activity.length - 1]?.sessionsFinished, 3);
    });
  });
});
