import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  createPrConflictFix,
  createPrReview,
  createPrRun,
  createRepository,
  createSession,
  type Database,
  enqueueBuild,
  featureBranchFor,
  IN_MEMORY,
  listSessions,
  openDatabase,
  prRefId,
  syncStories,
  updatePrReview,
  updatePrRun,
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
    assert.equal(body.builds.active, 1);
    assert.equal(body.builds.queued, 0);
    assert.equal(body.builds.max, 4);
    assert.equal(body.builds.free, 3);
    assert.deepEqual(
      body.builds.slots.map((slot) => [slot.kind, slot.label]),
      [['session', 'two']],
    );
    assert.equal(body.builds.queue.length, 0);
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

  /*
   * Also declared last: it puts a slot of every kind in use, which the totals
   * the tests above assert would otherwise have to allow for.
   */
  describe('build slots and the queue (US-006)', () => {
    let buildingId: string;

    before(() => {
      const sessions = listSessions(db);
      const of = (name: string): string => {
        const found = sessions.find((session) => session.name === name);
        if (found === undefined) throw new Error(`no session ${name}`);
        return found.id;
      };
      buildingId = of('two');
      // `three` was `failed`; `four` had a pull request open. Both of them
      // holding a slot now is what a full pool looks like.
      updateSession(db, of('three'), { status: 'waiting' });
      updateSession(db, of('four'), { status: 'reviewing' });

      const pr = (prNumber: number) => ({
        repositoryId,
        prNumber,
        prUrl: `https://github.com/acme/demo/pull/${String(prNumber)}`,
        prTitle: 'Booking totals in minor units',
        headBranch: 'chief/booking-minor-units',
        baseBranch: 'main',
      });
      const run = createPrRun(db, pr(31));
      updatePrRun(db, run.id, { status: 'running' });
      const review = createPrReview(db, pr(12));
      updatePrReview(db, review.id, { status: 'running' });
      createPrConflictFix(db, { ...pr(7), headSha: 'head1111', baseSha: 'base1111' });

      enqueueBuild(db, { kind: 'session', refId: of('one'), queuedAt: '2026-09-05T10:00:00.000Z' });
      enqueueBuild(db, {
        kind: 'pr-review',
        refId: prRefId(repositoryId, 44),
        queuedAt: '2026-09-05T10:00:01.000Z',
      });
    });

    it('counts every kind of slot the cap counts, and names each one', async () => {
      const response = await fetch(`${baseUrl}/api/stats`, { headers: { cookie } });
      const body = (await response.json()) as StatsView;

      // Three sessions, a feedback run, a review and a conflict fix: exactly
      // what `freeSlots()` subtracts, and more than the cap of 4 allows.
      assert.equal(body.builds.active, 6);
      assert.equal(body.builds.max, 4);
      assert.equal(body.builds.free, -2);
      assert.equal(body.builds.slots.length, body.builds.active);
      assert.deepEqual(
        [...body.builds.slots]
          .map((slot) => `${slot.kind}/${slot.label}`)
          .sort((a, b) => a.localeCompare(b)),
        [
          'pr-conflict-fix/Conflict fix: PR #7',
          'pr-feedback/Feedback on PR #31',
          'pr-review/Review of PR #12',
          'session/four',
          'session/three',
          'session/two',
        ],
      );
      assert.equal(
        body.builds.slots.find((slot) => slot.label === 'two')?.refId,
        buildingId,
      );
    });

    it('reports the unified queue in FIFO order', async () => {
      const response = await fetch(`${baseUrl}/api/stats`, { headers: { cookie } });
      const body = (await response.json()) as StatsView;

      assert.equal(body.builds.queued, 2);
      assert.equal(body.builds.queue.length, body.builds.queued);
      assert.deepEqual(
        body.builds.queue.map((entry) => [entry.position, entry.kind, entry.label]),
        [
          [1, 'session', 'one'],
          [2, 'pr-review', 'Review of PR #44'],
        ],
      );
    });
  });
});
