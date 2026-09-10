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
  getSentryIssue,
  IN_MEMORY,
  listSentryIssuesAwaitingResolve,
  openDatabase,
  type SentryIssueStatus,
  setSetting,
  updateSentryIssue,
} from '../db/index.js';
import type { FixSessionResult, SentryFixer } from '../sentry/index.js';

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

  describe('deciding on a proposed plan (US-004)', () => {
    const PLAN = 'Guard the null in app/handler.ts before reading .name.';

    /** An issue at the one point where a decision can be made. */
    const planned = (sentryIssueId = '1', shortId = 'DEMO-1') => {
      const issue = seed(sentryIssueId, shortId, '2026-09-02T00:00:00.000Z');
      const updated = updateSentryIssue(db, issue.id, {
        status: 'planned',
        plan: PLAN,
        planProposedAt: '2026-09-02T01:00:00.000Z',
      });
      assert.ok(updated);
      return updated;
    };

    const post = async (path: string, body?: unknown) =>
      fetch(`${baseUrl}/api/sentry/${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });

    it('reports the plan and both of its timestamps on every issue', async () => {
      const issue = planned();
      const [undecided] = (await list()).issues;
      assert.ok(undecided);
      assert.equal(undecided.plan, PLAN);
      assert.equal(undecided.planProposedAt, '2026-09-02T01:00:00.000Z');
      assert.equal(undecided.planDecidedAt, null);

      assert.equal((await post(`issues/${issue.id}/approve`)).status, 200);

      const [decided] = (await list()).issues;
      assert.ok(decided);
      assert.ok(decided.planDecidedAt !== null && Date.parse(decided.planDecidedAt) > 0);
    });

    it('approves the proposed plan as it stands', async () => {
      const issue = planned();
      const response = await post(`issues/${issue.id}/approve`);
      assert.equal(response.status, 200);
      const view = (await response.json()) as { status: string; plan: string };
      assert.equal(view.status, 'approved');
      assert.equal(view.plan, PLAN);

      const stored = getSentryIssue(db, issue.id);
      assert.ok(stored);
      assert.equal(stored.status, 'approved');
      assert.equal(stored.plan, PLAN);
      assert.ok(stored.planDecidedAt !== null);
      // Approval owes Sentry nothing: the issue is still open there.
      assert.equal(stored.resolveUpstream, false);
      assert.deepEqual(listSentryIssuesAwaitingResolve(db), []);
    });

    it('replaces the plan with the operator’s edit before approving it', async () => {
      const issue = planned();
      const response = await post(`issues/${issue.id}/approve`, {
        plan: '  Add the missing await in app/queue.ts.  ',
      });
      assert.equal(response.status, 200);

      const stored = getSentryIssue(db, issue.id);
      assert.ok(stored);
      assert.equal(stored.status, 'approved');
      assert.equal(stored.plan, 'Add the missing await in app/queue.ts.');
      // The edit does not pretend a new plan was proposed.
      assert.equal(stored.planProposedAt, '2026-09-02T01:00:00.000Z');
    });

    it('refuses an empty or over-long plan without touching the issue', async () => {
      const issue = planned();
      for (const plan of ['', '   \n  ', 'x'.repeat(4001), 42]) {
        const response = await post(`issues/${issue.id}/approve`, { plan });
        assert.equal(response.status, 400, `plan ${JSON.stringify(plan).slice(0, 20)}`);
        const stored = getSentryIssue(db, issue.id);
        assert.ok(stored);
        assert.equal(stored.status, 'planned');
        assert.equal(stored.plan, PLAN);
        assert.equal(stored.planDecidedAt, null);
      }

      // The bound is the classifier's own, so a full-length plan is approvable.
      const ok = await post(`issues/${issue.id}/approve`, { plan: 'y'.repeat(4000) });
      assert.equal(ok.status, 200);
    });

    it('rejects the plan, keeps the reason and owes Sentry a resolve call', async () => {
      const issue = planned();
      const response = await post(`issues/${issue.id}/reject`, {
        reason: 'the error comes from a vendored dependency',
      });
      assert.equal(response.status, 200);

      const stored = getSentryIssue(db, issue.id);
      assert.ok(stored);
      assert.equal(stored.status, 'cannot_fix');
      assert.equal(stored.explanation, 'plan rejected: the error comes from a vendored dependency');
      assert.ok(stored.planDecidedAt !== null);
      // The plan itself stays readable next to the reason it was refused.
      assert.equal(stored.plan, PLAN);
      assert.equal(stored.resolveUpstream, true);
      assert.equal(stored.resolvedInSentry, false);
      assert.deepEqual(
        listSentryIssuesAwaitingResolve(db).map((queued) => queued.id),
        [issue.id],
      );
    });

    it('refuses a rejection with no reason', async () => {
      const issue = planned();
      for (const body of [{}, { reason: '  ' }, { reason: 7 }, { reason: null }]) {
        const response = await post(`issues/${issue.id}/reject`, body);
        assert.equal(response.status, 400, JSON.stringify(body));
        const stored = getSentryIssue(db, issue.id);
        assert.ok(stored);
        assert.equal(stored.status, 'planned');
        assert.equal(stored.explanation, null);
        assert.equal(stored.resolveUpstream, false);
      }
    });

    it('answers 409 for an issue that is not awaiting a decision', async () => {
      const issue = planned();
      for (const status of ['pending', 'approved', 'working', 'fixed', 'cannot_fix'] as const) {
        updateSentryIssue(db, issue.id, { status });
        for (const path of ['approve', 'reject']) {
          const response = await post(`issues/${issue.id}/${path}`, { reason: 'no' });
          assert.equal(response.status, 409, `${status} ${path}`);
          const body = (await response.json()) as { error: string; message: string };
          assert.equal(body.error, 'sentry_issue_not_planned');
          assert.ok(body.message.includes(status));
          assert.equal(getSentryIssue(db, issue.id)?.status, status);
        }
      }
    });

    it('answers 404 for an id nobody knows', async () => {
      for (const path of ['approve', 'reject']) {
        const response = await post(`issues/does-not-exist/${path}`, { reason: 'no' });
        assert.equal(response.status, 404);
        assert.equal(((await response.json()) as { error: string }).error, 'sentry_issue_not_found');
      }
    });

    it('rejects an unauthenticated decision', async () => {
      const issue = planned();
      for (const path of ['approve', 'reject']) {
        const response = await fetch(`${baseUrl}/api/sentry/issues/${issue.id}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'no' }),
        });
        assert.equal(response.status, 401);
      }
      assert.equal(getSentryIssue(db, issue.id)?.status, 'planned');
    });
  });

  it('rejects an unauthenticated read', async () => {
    const response = await fetch(`${baseUrl}/api/sentry/issues`);
    assert.equal(response.status, 401);
  });
});

/**
 * `POST /sentry/fix-sessions` (US-006).
 *
 * Its own app, because the real fixer clones the repository and starts a
 * container: what is under test here is the rule about *which* batches may
 * become a session, and what the answer is when the service says no.
 */
describe('creating a fix session from approved issues (US-006)', () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;
  let repositoryId: string;
  let otherRepositoryId: string;
  /** What the stub fixer was asked for, and what it answers with. */
  let asked: string[][];
  let answer: FixSessionResult;

  before(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD });
    db = openDatabase(IN_MEMORY);
    asked = [];
    answer = { ok: true, session: { id: 'ses_1', name: 'sentry-batch-20260909' } };
    const fixer: SentryFixer = {
      createFixSession: (issueIds) => {
        asked.push(issueIds);
        return Promise.resolve(answer);
      },
    };
    const app = createApp(config, createAuthService(config, db), db, { sentryFixer: fixer });
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
    otherRepositoryId = createRepository(db, {
      name: 'other',
      sshUrl: 'git@github.com:acme/other.git',
      githubSlug: 'acme/other',
      defaultBaseBranch: 'main',
    }).id;
  });

  beforeEach(() => {
    db.prepare('DELETE FROM sentry_issues').run();
    asked.length = 0;
    answer = { ok: true, session: { id: 'ses_1', name: 'sentry-batch-20260909' } };
  });

  after(() => {
    server.close();
    closeDatabase(db);
  });

  let seq = 0;
  const approved = (options: { repository?: string; status?: SentryIssueStatus } = {}) => {
    seq += 1;
    const row = createSentryIssue(db, {
      repositoryId: options.repository ?? repositoryId,
      sentryIssueId: `45${String(seq)}`,
      shortId: `DEMO-${String(seq)}`,
      title: 'boom',
      culprit: 'app/handler.ts',
      permalink: 'https://sentry.io/organizations/acme/issues/451/',
      level: 'error',
      eventCount: 3,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-02T00:00:00.000Z',
    });
    const decided = updateSentryIssue(db, row.id, {
      status: options.status ?? 'approved',
      plan: 'Guard the read.',
    });
    assert.ok(decided !== null);
    return decided;
  };

  const create = (body: unknown) =>
    fetch(`${baseUrl}/api/sentry/fix-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });

  const errorOf = async (response: Response) =>
    ((await response.json()) as { error: string }).error;

  it('creates one session for a three-issue batch', async () => {
    const issues = [approved(), approved(), approved()];

    const response = await create({ issueIds: issues.map((issue) => issue.id) });

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { id: 'ses_1', name: 'sentry-batch-20260909' });
    // In the order the operator ticked them, which is the order of the stories.
    assert.deepEqual(asked, [issues.map((issue) => issue.id)]);
  });

  it('names an id twice only once', async () => {
    const issue = approved();

    assert.equal((await create({ issueIds: [issue.id, issue.id] })).status, 201);

    assert.deepEqual(asked, [[issue.id]]);
  });

  it('refuses a batch that spans two repositories', async () => {
    const here = approved();
    const there = approved({ repository: otherRepositoryId });

    const response = await create({ issueIds: [here.id, there.id] });

    assert.equal(response.status, 400);
    assert.equal(await errorOf(response), 'sentry_issues_span_repositories');
    assert.deepEqual(asked, []);
  });

  it('refuses an id nothing is known about', async () => {
    const issue = approved();

    const response = await create({ issueIds: [issue.id, 'no-such-issue'] });

    assert.equal(response.status, 400);
    assert.equal(await errorOf(response), 'sentry_issue_not_found');
    assert.deepEqual(asked, []);
  });

  it('refuses an issue that is not approved, whatever else it is', async () => {
    for (const status of ['pending', 'planned', 'working', 'fixed', 'cannot_fix'] as const) {
      const ok = approved();
      const not = approved({ status });

      const response = await create({ issueIds: [ok.id, not.id] });

      assert.equal(response.status, 400, status);
      assert.equal(await errorOf(response), 'sentry_issue_not_approved');
      assert.deepEqual(asked, []);
      // And neither issue moved.
      assert.equal(getSentryIssue(db, ok.id)?.status, 'approved');
      assert.equal(getSentryIssue(db, not.id)?.status, status);
    }
  });

  it('refuses a batch of the wrong size or shape', async () => {
    const issues = Array.from({ length: 11 }, () => approved());
    for (const body of [
      {},
      { issueIds: 'one' },
      { issueIds: [] },
      { issueIds: [''] },
      { issueIds: [1, 2] },
      { issueIds: issues.map((issue) => issue.id) },
    ]) {
      const response = await create(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(await errorOf(response), 'invalid_issue_ids');
    }
    assert.equal((await create([])).status, 400);
    assert.deepEqual(asked, []);
  });

  it('answers 500 with the reason when the session could not be built', async () => {
    const issues = [approved(), approved()];
    answer = { ok: false, reason: '"demo" has no private key on the data volume.' };

    const response = await create({ issueIds: issues.map((issue) => issue.id) });

    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: string; message: string };
    assert.equal(body.error, 'fix_session_failed');
    assert.equal(body.message, '"demo" has no private key on the data volume.');
    // The rollback itself is the service's (see `sentry/fix.test.ts`); what
    // matters here is that the route wrote nothing of its own on the way past.
    for (const issue of issues) assert.equal(getSentryIssue(db, issue.id)?.status, 'approved');
  });

  it('rejects an unauthenticated request', async () => {
    const issue = approved();
    const response = await fetch(`${baseUrl}/api/sentry/fix-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issueIds: [issue.id] }),
    });

    assert.equal(response.status, 401);
    assert.deepEqual(asked, []);
  });
});
