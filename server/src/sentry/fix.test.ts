import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BuildError } from '../build/index.js';
import {
  closeDatabase,
  createRepository,
  createSentryIssue,
  createSession,
  type Database,
  deleteSession,
  enqueueBuild,
  featureBranchFor,
  getQueuedBuild,
  getSentryIssue,
  getSession,
  IN_MEMORY,
  listSessions,
  openDatabase,
  type Repository,
  type SentryIssue,
  type Session,
  setSetting,
  syncStories,
  updateSentryIssue,
  updateSession,
} from '../db/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { prdPathFor, readPrdDocument } from '../prd/index.js';
import type {
  CreateSessionRequest,
  ReadyResult,
  SessionSetupView,
  SessionView,
} from '../sessions/index.js';
import { sessionPrdFile, storyInputOf } from '../sessions/index.js';

import { SentryApiError, type SentryIssueDetails, type SentryIssueSummary } from './client.js';
import type { SentryDetailsGateway } from './classify.js';
import {
  type FixBuildService,
  type FixSessionResult,
  type FixSessionService,
  MAX_FIX_ATTEMPTS,
  SentryFixService,
} from './fix.js';

const databases: Database[] = [];
const workspaces: string[] = [];

after(() => {
  for (const db of databases) closeDatabase(db);
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

function summary(fields: Partial<SentryIssueSummary> = {}): SentryIssueSummary {
  return {
    id: '4507',
    shortId: 'PROJ-123',
    title: 'TypeError: cannot read property x of undefined',
    culprit: 'app/handlers.ts in handle',
    permalink: 'https://sentry.io/organizations/acme/issues/4507/',
    level: 'error',
    status: 'unresolved',
    count: 1043,
    firstSeen: '2026-08-01T10:00:00.000Z',
    lastSeen: '2026-09-04T22:15:00.000Z',
    ...fields,
  };
}

function details(fields: Partial<SentryIssueSummary> = {}): SentryIssueDetails {
  return {
    issue: summary(fields),
    latestEvent: {
      id: 'abc',
      message: 'cannot read property x of undefined',
      platform: 'node',
      dateCreated: '2026-09-04T22:15:00.000Z',
      exceptions: [
        {
          type: 'TypeError',
          value: 'cannot read property x of undefined',
          module: null,
          frames: [
            {
              filename: 'app/handlers.ts',
              function: 'handle',
              module: 'app.handlers',
              absPath: '/srv/app/handlers.ts',
              lineNo: 42,
              colNo: 7,
              contextLine: '  return payload.x.y;',
              inApp: true,
            },
          ],
        },
      ],
      tags: [{ key: 'environment', value: 'production' }],
      breadcrumbs: [],
    },
  };
}

/** Stands in for `GET /organizations/{org}/issues/{id}/`. */
class FakeSentry implements SentryDetailsGateway {
  readonly calls: { org: string; issueId: string }[] = [];
  /** What Sentry calls each issue, so a batch's stories are told apart. */
  readonly shortIds = new Map<string, string>();
  failure: Error | null = null;

  getIssueDetails(org: string, issueId: string): Promise<SentryIssueDetails> {
    this.calls.push({ org, issueId });
    if (this.failure !== null) return Promise.reject(this.failure);
    const shortId = this.shortIds.get(issueId);
    return Promise.resolve(details({ id: issueId, ...(shortId === undefined ? {} : { shortId }) }));
  }
}

/**
 * The real `SessionService` minus its container: rows are written, the clone is
 * an empty directory, and "Mark ready" parses whatever PRD was written into it
 * — so the generated PRD is put through the very check the API would apply.
 */
class FakeSessions implements FixSessionService {
  readonly created: CreateSessionRequest[] = [];
  readonly readied: string[] = [];
  readonly deleted: string[] = [];
  createFailure: Error | null = null;
  setupOk = true;
  /** Makes the clone a *file*, so nothing can be created underneath it. */
  prdUnwritable = false;

  constructor(
    private readonly config: { workspacesDir: string },
    private readonly db: Database,
  ) {}

  create(request: CreateSessionRequest): Promise<SessionSetupView> {
    this.created.push(request);
    if (this.createFailure !== null) return Promise.reject(this.createFailure);

    const session = createSession(this.db, {
      repositoryId: request.repositoryId,
      name: request.name,
      baseBranch: request.baseBranch ?? 'main',
      prTargetBranch: request.prTargetBranch,
      featureBranch: featureBranchFor(request.name),
      status: 'pending',
      scheduledStartAt: null,
      codeReview: request.codeReview ?? false,
    });
    if (this.setupOk) {
      const repoDir = sessionRepoDir(this.config, session.id);
      if (this.prdUnwritable) {
        fs.mkdirSync(path.dirname(repoDir), { recursive: true });
        fs.writeFileSync(repoDir, 'not a directory');
      } else {
        fs.mkdirSync(repoDir, { recursive: true });
      }
    }

    return Promise.resolve({
      session: view(session),
      setup: this.setupOk
        ? { ok: true, code: 'ok', message: 'Repository ready.', stderr: '' }
        : {
            ok: false,
            code: 'clone_failed',
            message: 'Permission denied (publickey).',
            stderr: '',
          },
    });
  }

  markReady(id: string): Promise<ReadyResult> {
    this.readied.push(id);
    const session = getSession(this.db, id);
    assert.ok(session !== null);
    const document = readPrdDocument(
      sessionPrdFile(this.config, session),
      prdPathFor(session.name),
    );
    const ok = document.parsed !== null && document.status.parses;
    const stories = ok
      ? syncStories(this.db, id, (document.parsed?.stories ?? []).map(storyInputOf))
      : [];
    const updated = ok ? (updateSession(this.db, id, { status: 'ready' }) ?? session) : session;
    return Promise.resolve({
      ok,
      started: false,
      session: view(updated),
      prd: document.status,
      stories,
    });
  }

  delete(id: string): Promise<void> {
    this.deleted.push(id);
    deleteSession(this.db, id);
    return Promise.resolve();
  }
}

/**
 * Stands in for the build loop: what a session start would do to the row,
 * without a container. `failure` is thrown exactly as `BuildService.start`
 * throws — including the usage-limit refusal, which comes *after* the session
 * has been queued.
 */
class FakeBuilds implements FixBuildService {
  readonly started: string[] = [];
  failure: Error | null = null;
  queueBeforeFailing = false;

  constructor(private readonly db: Database) {}

  start(sessionId: string): Promise<unknown> {
    this.started.push(sessionId);
    if (this.failure !== null) {
      if (this.queueBeforeFailing) {
        enqueueBuild(this.db, { kind: 'session', refId: sessionId });
      }
      return Promise.reject(this.failure);
    }
    updateSession(this.db, sessionId, { status: 'building' });
    return Promise.resolve({});
  }
}

/** Only `id` and `name` are read by the fixer; the rest is the row as it is. */
function view(session: Session): SessionView {
  return {
    ...session,
    queuedAt: null,
    repositoryName: 'demo',
    recurringTaskName: null,
    scheduleMissed: false,
    queuePosition: null,
    stories: { total: 0, done: 0 },
    cloned: true,
  };
}

interface World {
  readonly db: Database;
  readonly config: { workspacesDir: string };
  readonly sentry: FakeSentry;
  readonly sessions: FakeSessions;
  readonly builds: FakeBuilds;
  readonly fixer: SentryFixService;
  readonly repository: Repository;
  issue(fields?: { shortId?: string; attempts?: number; repositoryId?: string }): SentryIssue;
  /**
   * The operator's call: every issue this world has made, by id, in the order
   * they were made. Nothing scans any more, so a test that seeds no issue asks
   * for no session.
   */
  fix(issues?: SentryIssue[]): Promise<FixSessionResult>;
  reload(issue: SentryIssue): SentryIssue;
  prd(sessionName: string): string;
}

function world(options: { token?: boolean; link?: boolean; baseBranch?: string } = {}): World {
  const db = openDatabase(IN_MEMORY);
  databases.push(db);
  if (options.token !== false) setSetting(db, 'sentry_token', 'sntrys_token');

  const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-sentry-fix-'));
  workspaces.push(workspacesDir);
  const config = { workspacesDir };

  const repository = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
    defaultBaseBranch: options.baseBranch ?? 'trunk',
    ...(options.link === false ? {} : { sentryOrg: 'acme', sentryProject: 'web' }),
  });

  const sentry = new FakeSentry();
  const sessions = new FakeSessions(config, db);
  const builds = new FakeBuilds(db);
  const fixer = new SentryFixService(config, db, sessions, builds, (database) =>
    hasToken(database) ? sentry : null,
  );

  let seq = 0;
  const seeded: SentryIssue[] = [];
  return {
    db,
    config,
    sentry,
    sessions,
    builds,
    fixer,
    repository,
    issue(fields = {}) {
      seq += 1;
      const shortId = fields.shortId ?? `PROJ-${String(seq)}`;
      sentry.shortIds.set(`450${String(seq)}`, shortId);
      const row = createSentryIssue(db, {
        repositoryId: fields.repositoryId ?? repository.id,
        sentryIssueId: `450${String(seq)}`,
        shortId,
        title: 'TypeError: cannot read property x of undefined',
        culprit: 'app/handlers.ts in handle',
        permalink: 'https://sentry.io/organizations/acme/issues/4507/',
        level: 'error',
        eventCount: 12,
        firstSeen: '2026-08-01T10:00:00.000Z',
        lastSeen: '2026-09-04T22:15:00.000Z',
      });
      // Where the operator's button finds an issue: planned by the classifier,
      // explained, and approved by somebody.
      const approved = updateSentryIssue(db, row.id, {
        status: 'approved',
        explanation: 'The handler never checks x.',
        plan: 'Guard the read in app/handlers.ts.',
        attempts: fields.attempts ?? 0,
      });
      assert.ok(approved !== null);
      seeded.push(approved);
      return approved;
    },
    fix(issues) {
      return fixer.createFixSession((issues ?? seeded).map((issue) => issue.id));
    },
    reload(issue) {
      const row = getSentryIssue(db, issue.id);
      assert.ok(row !== null);
      return row;
    },
    prd(sessionName) {
      const session = listSessions(db, {}).find((row) => row.name === sessionName);
      assert.ok(session !== undefined, `no session named ${sessionName}`);
      return fs.readFileSync(sessionPrdFile(config, session), 'utf8');
    },
  };
}

function hasToken(db: Database): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sentry_token'").get();
  return row !== undefined && row !== null;
}

describe('the Sentry fix session builder', () => {
  describe('creating the session', () => {
    it('names it after the short id, marks it ready and starts it', async () => {
      const w = world();
      const issue = w.issue({ shortId: 'PROJ-123' });

      assert.ok((await w.fix()).ok);

      assert.deepEqual(w.sessions.created, [
        {
          repositoryId: w.repository.id,
          name: 'sentry-proj-123',
          baseBranch: 'trunk',
          prTargetBranch: 'main',
          codeReview: true,
        },
      ]);
      const session = listSessions(w.db, {})[0];
      assert.ok(session !== undefined);
      assert.deepEqual(w.sessions.readied, [session.id]);
      // Nothing else would ever start it: it has no schedule, and the queue is
      // only ever fed by `builds.start`.
      assert.deepEqual(w.builds.started, [session.id]);
      assert.equal(session.status, 'building');
      assert.equal(session.codeReview, true);
      assert.equal(session.baseBranch, 'trunk');

      const row = w.reload(issue);
      assert.equal(row.status, 'working');
      assert.equal(row.sessionId, session.id);
      assert.equal(row.attempts, 0);
    });

    it('writes the PRD into the session workspace, with the Sentry detail in it', async () => {
      const w = world();
      w.issue({ shortId: 'PROJ-123' });

      await w.fix();

      const prd = w.prd('sentry-proj-123');
      assert.ok(prd.startsWith('# PRD: Fix the Sentry issue PROJ-123'));
      assert.ok(prd.includes('### US-001: Fix the production error reported as Sentry PROJ-123'));
      assert.ok(prd.includes('[app] app/handlers.ts:42 in handle'));
      assert.ok(prd.includes('Permalink: https://sentry.io/organizations/acme/issues/4507/'));
      assert.ok(prd.includes('Guard the read in app/handlers.ts.'));

      // Readable by the runner: uid 1000 cannot be chowned to in a test, so the
      // fallback the server takes when it is not root is what is asserted.
      const file = path.join(
        sessionRepoDir(w.config, listSessions(w.db, {})[0]?.id ?? ''),
        prdPathFor('sentry-proj-123'),
      );
      assert.ok(fs.statSync(file).mode & 0o004, 'the PRD has to be world-readable at least');
    });

    it('targets the base branch when the sessions table allows it', async () => {
      for (const [baseBranch, target] of [
        ['develop', 'develop'],
        ['main', 'main'],
        ['release/2026.09', 'main'],
      ] as const) {
        const w = world({ baseBranch });
        w.issue();

        await w.fix();

        assert.equal(w.sessions.created[0]?.baseBranch, baseBranch);
        assert.equal(w.sessions.created[0]?.prTargetBranch, target);
      }
    });

    it('appends a numeric suffix when the name is already taken', async () => {
      const w = world();
      createSession(w.db, {
        repositoryId: w.repository.id,
        name: 'sentry-proj-123',
        baseBranch: 'trunk',
        prTargetBranch: 'main',
        featureBranch: featureBranchFor('sentry-proj-123'),
        status: 'finished',
        scheduledStartAt: null,
        codeReview: false,
      });
      w.issue({ shortId: 'PROJ-123' });

      await w.fix();

      assert.equal(w.sessions.created[0]?.name, 'sentry-proj-123-2');
    });

    it('takes a whole batch into one dated session (US-006)', async () => {
      const w = world();
      const first = w.issue({ shortId: 'PROJ-1' });
      const second = w.issue({ shortId: 'PROJ-2' });
      const third = w.issue({ shortId: 'PROJ-3' });

      const result = await w.fix();
      assert.ok(result.ok);

      // One session, one branch, one pull request — not three.
      assert.equal(w.sessions.created.length, 1);
      const sessions = listSessions(w.db, {});
      assert.equal(sessions.length, 1);
      const [session] = sessions;
      assert.ok(session !== undefined);
      assert.equal(result.session.id, session.id);
      assert.equal(result.session.name, session.name);
      assert.match(session.name, /^sentry-batch-\d{8}$/);
      assert.deepEqual(w.sessions.readied, [session.id]);
      assert.deepEqual(w.builds.started, [session.id]);

      for (const issue of [first, second, third]) {
        const row = w.reload(issue);
        assert.equal(row.status, 'working');
        assert.equal(row.sessionId, session.id);
        assert.equal(row.attempts, 0);
      }
    });

    it('writes a story per issue, in the order it was given them', async () => {
      const w = world();
      const first = w.issue({ shortId: 'PROJ-1' });
      const second = w.issue({ shortId: 'PROJ-2' });
      const third = w.issue({ shortId: 'PROJ-3' });
      updateSentryIssue(w.db, second.id, { plan: null });

      // Deliberately not the order they were seeded in: the operator's order is
      // the order the stories are fixed in.
      assert.ok((await w.fix([third, first, second])).ok);

      const session = listSessions(w.db, {})[0];
      assert.ok(session !== undefined);
      const prd = w.prd(session.name);
      assert.ok(prd.startsWith('# PRD: Fix 3 Sentry issues'));
      assert.ok(prd.includes('### US-001: Fix the production error reported as Sentry PROJ-3'));
      assert.ok(prd.includes('### US-002: Fix the production error reported as Sentry PROJ-1'));
      assert.ok(prd.includes('### US-003: Fix the production error reported as Sentry PROJ-2'));
      // Every story is a real one the build loop can walk.
      assert.deepEqual(
        (readPrdDocument(sessionPrdFile(w.config, session), prdPathFor(session.name)).parsed
          ?.stories ?? []).map((story) => story.id),
        ['US-001', 'US-002', 'US-003'],
      );
      // The plan an operator approved rides along with each story that has one;
      // PROJ-2 has none, so its story simply carries no plan block.
      assert.equal(prd.match(/Approved fix plan for /g)?.length, 2);
    });

    it('refuses a batch that spans two repositories', async () => {
      const w = world();
      const other = createRepository(w.db, {
        name: 'other',
        sshUrl: 'git@github.com:acme/other.git',
        githubSlug: 'acme/other',
        defaultBaseBranch: 'main',
        sentryOrg: 'acme',
        sentryProject: 'other',
      });
      const here = w.issue({ shortId: 'PROJ-1' });
      const there = w.issue({ shortId: 'OTHER-1', repositoryId: other.id });

      const result = await w.fix([here, there]);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason.includes('one repository'));

      assert.equal(w.sessions.created.length, 0);
      // Refused, not failed: nobody spent an attempt on a request that was
      // never valid.
      for (const issue of [here, there]) {
        assert.equal(w.reload(issue).status, 'approved');
        assert.equal(w.reload(issue).attempts, 0);
      }
    });
  });

  describe('never twice', () => {
    it('leaves a working issue alone when it is named a second time', async () => {
      const w = world();
      const issue = w.issue();

      assert.ok((await w.fix()).ok);
      assert.equal((await w.fix()).ok, false);

      assert.equal(w.sessions.created.length, 1);
      assert.equal(listSessions(w.db, {}).length, 1);
      assert.equal(w.reload(issue).status, 'working');
    });

    it('skips an issue that somehow already has a session', async () => {
      const w = world();
      const issue = w.issue();
      const session = createSession(w.db, {
        repositoryId: w.repository.id,
        name: 'by-hand',
        baseBranch: 'trunk',
        prTargetBranch: 'main',
        featureBranch: featureBranchFor('by-hand'),
        status: 'ready',
        scheduledStartAt: null,
        codeReview: false,
      });
      updateSentryIssue(w.db, issue.id, { sessionId: session.id });

      assert.equal((await w.fix()).ok, false);

      assert.equal(w.sessions.created.length, 0);
      assert.equal(w.reload(issue).status, 'approved');
    });

    it('creates one session when the same id is named twice', async () => {
      const w = world();
      const issue = w.issue();

      assert.ok((await w.fix([issue, issue])).ok);

      assert.equal(w.sessions.created.length, 1);
    });
  });

  describe('only the issues it is given (US-003)', () => {
    it('leaves an approved issue nobody named alone', async () => {
      const w = world();
      const named = w.issue({ shortId: 'PROJ-1' });
      const other = w.issue({ shortId: 'PROJ-2' });

      assert.ok((await w.fix([named])).ok);

      assert.deepEqual(
        w.sessions.created.map((request) => request.name),
        ['sentry-proj-1'],
      );
      assert.equal(w.reload(other).status, 'approved');
      assert.equal(w.reload(other).sessionId, null);
    });

    it('skips an id nothing is known about', async () => {
      const w = world();
      const issue = w.issue();

      assert.ok((await w.fixer.createFixSession(['no-such-issue', issue.id])).ok);

      assert.equal(w.sessions.created.length, 1);
      assert.equal(w.reload(issue).status, 'working');
    });

    it('does nothing at all when every id is unknown', async () => {
      const w = world();

      assert.equal((await w.fixer.createFixSession(['no-such-issue'])).ok, false);

      assert.equal(w.sentry.calls.length, 0);
      assert.equal(w.sessions.created.length, 0);
    });
  });

  describe('starting the session', () => {
    it('leaves it queued, and the issue working, when Claude’s usage limit is on', async () => {
      const w = world();
      const issue = w.issue();
      w.builds.queueBeforeFailing = true;
      w.builds.failure = new BuildError(429, 'usage_limit_hold', 'Queued behind the hold.');

      assert.ok((await w.fix()).ok);

      // The refusal came after the queueing, so there is nothing to undo: the
      // pump starts it when the hold lifts.
      const session = listSessions(w.db, {})[0];
      assert.ok(session !== undefined);
      assert.equal(session.status, 'ready');
      assert.notEqual(getQueuedBuild(w.db, 'session', session.id), null);
      assert.equal(w.sessions.deleted.length, 0);

      const row = w.reload(issue);
      assert.equal(row.status, 'working');
      assert.equal(row.sessionId, session.id);
    });

    it('throws the session away and retries when the start really failed', async () => {
      const w = world();
      const issue = w.issue();
      w.builds.failure = new BuildError(409, 'session_not_ready', 'The session is finished.');

      assert.equal((await w.fix()).ok, false);

      assert.equal(w.sessions.deleted.length, 1);
      assert.equal(listSessions(w.db, {}).length, 0);
      const row = w.reload(issue);
      assert.equal(row.status, 'approved');
      assert.equal(row.attempts, 1);
      assert.equal(row.sessionId, null);

      w.builds.failure = null;
      assert.ok((await w.fix()).ok);
      assert.equal(w.reload(issue).status, 'working');
    });

    it('gives up after three failed starts, naming the failure', async () => {
      const w = world();
      const issue = w.issue({ attempts: MAX_FIX_ATTEMPTS - 1 });
      w.builds.failure = new BuildError(500, 'container_failed', 'no docker daemon');

      assert.equal((await w.fix()).ok, false);

      const row = w.reload(issue);
      assert.equal(row.status, 'cannot_fix');
      assert.equal(
        row.explanation,
        'No fix session could be created for this issue: ' +
          'the fix session could not be started: no docker daemon',
      );
    });
  });

  describe('when the session cannot be created', () => {
    it('leaves the issue approved so the operator can ask again', async () => {
      const w = world();
      const issue = w.issue();
      w.sessions.createFailure = new Error('"demo" has no private key on the data volume.');

      assert.equal((await w.fix()).ok, false);

      const row = w.reload(issue);
      assert.equal(row.status, 'approved');
      assert.equal(row.attempts, 1);
      assert.equal(row.sessionId, null);
      assert.equal(row.explanation, 'The handler never checks x.');

      w.sessions.createFailure = null;
      assert.ok((await w.fix()).ok);
      assert.equal(w.reload(issue).status, 'working');
    });

    it('gives up after three attempts, naming the failure', async () => {
      const w = world();
      const issue = w.issue({ attempts: MAX_FIX_ATTEMPTS - 1 });
      w.sessions.createFailure = new Error('no private key');

      assert.equal((await w.fix()).ok, false);

      const row = w.reload(issue);
      assert.equal(row.status, 'cannot_fix');
      assert.equal(row.attempts, MAX_FIX_ATTEMPTS);
      assert.equal(
        row.explanation,
        'No fix session could be created for this issue: no private key',
      );
    });

    it('rolls a whole batch back to approved when the PRD cannot be written', async () => {
      const w = world();
      const issues = [
        w.issue({ shortId: 'PROJ-1' }),
        w.issue({ shortId: 'PROJ-2' }),
        w.issue({ shortId: 'PROJ-3' }),
      ];
      // The clone directory is a file, so `.chief/prds/...` cannot be created
      // under it: exactly the "PRD unwritable" failure, without a mocked fs.
      w.sessions.prdUnwritable = true;

      const result = await w.fix();
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason.includes('the generated PRD could not be written'));

      assert.equal(w.sessions.deleted.length, 1);
      assert.equal(listSessions(w.db, {}).length, 0);
      for (const issue of issues) {
        const row = w.reload(issue);
        assert.equal(row.status, 'approved');
        assert.equal(row.attempts, 1);
        assert.equal(row.sessionId, null);
      }

      // And the operator can simply press the button again.
      w.sessions.prdUnwritable = false;
      assert.ok((await w.fix()).ok);
      for (const issue of issues) assert.equal(w.reload(issue).status, 'working');
    });

    it('gives every issue of a failed batch its own last attempt', async () => {
      const w = world();
      const spent = w.issue({ shortId: 'PROJ-1', attempts: MAX_FIX_ATTEMPTS - 1 });
      const fresh = w.issue({ shortId: 'PROJ-2' });
      w.sessions.createFailure = new Error('no private key');

      assert.equal((await w.fix()).ok, false);

      assert.equal(w.reload(spent).status, 'cannot_fix');
      assert.equal(
        w.reload(spent).explanation,
        'No fix session could be created for this issue: no private key',
      );
      // The other one has attempts left, so it stays where the operator put it.
      assert.equal(w.reload(fresh).status, 'approved');
      assert.equal(w.reload(fresh).attempts, 1);
    });

    it('throws the session away when its clone failed', async () => {
      const w = world();
      const issue = w.issue();
      w.sessions.setupOk = false;

      assert.equal((await w.fix()).ok, false);

      assert.equal(w.sessions.deleted.length, 1);
      assert.equal(listSessions(w.db, {}).length, 0);
      const row = w.reload(issue);
      assert.equal(row.status, 'approved');
      assert.equal(row.attempts, 1);
      assert.equal(row.sessionId, null);
    });

    it('does not spend an attempt when Sentry itself is unreachable', async () => {
      const w = world();
      const issue = w.issue();
      w.sentry.failure = new SentryApiError('sentry_unreachable', 'Sentry is down.');

      assert.equal((await w.fix()).ok, false);

      const row = w.reload(issue);
      assert.equal(row.status, 'approved');
      assert.equal(row.attempts, 0);
      assert.equal(w.sessions.created.length, 0);
    });

    it('does spend one when Sentry says the issue is gone', async () => {
      const w = world();
      const issue = w.issue();
      w.sentry.failure = new SentryApiError('sentry_not_found', 'No such issue.');

      assert.equal((await w.fix()).ok, false);

      assert.equal(w.reload(issue).attempts, 1);
    });
  });

  describe('when there is nothing to do', () => {
    it('does not look the token up when it is given no ids', async () => {
      const w = world();

      assert.equal((await w.fix()).ok, false);
      assert.equal(w.sentry.calls.length, 0);
    });

    it('waits for a token rather than failing the issue', async () => {
      const w = world({ token: false });
      const issue = w.issue();

      assert.equal((await w.fix()).ok, false);

      const row = w.reload(issue);
      assert.equal(row.status, 'approved');
      assert.equal(row.attempts, 0);
    });

    it('waits for the Sentry link to come back rather than failing the issue', async () => {
      const w = world({ link: false });
      const issue = w.issue();

      assert.equal((await w.fix()).ok, false);

      const row = w.reload(issue);
      assert.equal(row.status, 'approved');
      assert.equal(row.attempts, 0);
      assert.equal(w.sessions.created.length, 0);
    });
  });
});
