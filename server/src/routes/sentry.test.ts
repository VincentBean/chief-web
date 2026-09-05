import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSentryIssue,
  createSession,
  type Database,
  deleteSession,
  deleteSetting,
  featureBranchFor,
  IN_MEMORY,
  openDatabase,
  setSetting,
  updateSentryIssue,
} from '../db/index.js';
import type { SentryIssueList } from './sentry.js';

const PASSWORD = 'correct horse battery staple';

describe('sentry issues api', () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;
  let repositoryId: string;

  before(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD });
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

    repositoryId = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'main',
    }).id;
  });

  beforeEach(() => {
    db.prepare('DELETE FROM sentry_issues').run();
    db.prepare('DELETE FROM sessions').run();
    deleteSetting(db, 'sentry_token');
  });

  after(() => {
    server.close();
    closeDatabase(db);
  });

  const list = async (): Promise<SentryIssueList> => {
    const response = await fetch(`${baseUrl}/api/sentry/issues`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return (await response.json()) as SentryIssueList;
  };

  const seed = (sentryIssueId: string, shortId: string, lastSeen: string) =>
    createSentryIssue(db, {
      repositoryId,
      sentryIssueId,
      shortId,
      title: `boom in ${shortId}`,
      culprit: 'app/handler.ts',
      permalink: `https://sentry.io/organizations/acme/issues/${sentryIssueId}/`,
      level: 'error',
      eventCount: 3,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen,
    });

  it('answers with an empty list and no token when nothing is tracked', async () => {
    const view = await list();
    assert.deepEqual(view.issues, []);
    assert.equal(view.tokenConfigured, false);
    assert.ok(Date.parse(view.generatedAt) > 0);
  });

  it('reports a configured token without leaking it', async () => {
    setSetting(db, 'sentry_token', 'sntrys_secret');
    const view = await list();
    assert.equal(view.tokenConfigured, true);
    assert.ok(!JSON.stringify(view).includes('sntrys_secret'));
  });

  it('returns every tracked issue, newest activity first', async () => {
    seed('1', 'DEMO-1', '2026-09-02T00:00:00.000Z');
    seed('2', 'DEMO-2', '2026-09-04T00:00:00.000Z');
    seed('3', 'DEMO-3', '2026-09-03T00:00:00.000Z');
    const view = await list();
    assert.deepEqual(
      view.issues.map((issue) => issue.shortId),
      ['DEMO-2', 'DEMO-3', 'DEMO-1'],
    );
  });

  it('decorates each issue with its repository name and pipeline state', async () => {
    const issue = seed('1', 'DEMO-1', '2026-09-02T00:00:00.000Z');
    updateSentryIssue(db, issue.id, { status: 'cannot_fix', explanation: 'the error is in a vendored dependency' });
    const [view] = (await list()).issues;
    assert.ok(view);
    assert.equal(view.repositoryName, 'demo');
    assert.equal(view.status, 'cannot_fix');
    assert.equal(view.explanation, 'the error is in a vendored dependency');
    assert.equal(view.permalink, 'https://sentry.io/organizations/acme/issues/1/');
    assert.equal(view.culprit, 'app/handler.ts');
    assert.equal(view.sessionId, null);
    assert.equal(view.sessionName, null);
    assert.equal(view.firstSeen, '2026-09-01T00:00:00.000Z');
    assert.equal(view.lastSeen, '2026-09-02T00:00:00.000Z');
  });

  it('names the session working on an issue, and survives its deletion', async () => {
    const session = createSession(db, {
      repositoryId,
      name: 'fix-demo-1',
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor('fix-demo-1'),
      status: 'building',
      scheduledStartAt: null,
    });
    const issue = seed('1', 'DEMO-1', '2026-09-02T00:00:00.000Z');
    updateSentryIssue(db, issue.id, { status: 'working', sessionId: session.id });

    const linked = (await list()).issues[0];
    assert.ok(linked);
    assert.equal(linked.sessionId, session.id);
    assert.equal(linked.sessionName, 'fix-demo-1');

    // The link is ON DELETE SET NULL, so the row outlives its session.
    deleteSession(db, session.id);
    const orphaned = (await list()).issues[0];
    assert.ok(orphaned);
    assert.equal(orphaned.sessionId, null);
    assert.equal(orphaned.sessionName, null);
  });

  it('rejects an unauthenticated read', async () => {
    const response = await fetch(`${baseUrl}/api/sentry/issues`);
    assert.equal(response.status, 401);
  });
});
