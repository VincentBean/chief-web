import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  closeDatabase,
  createRepository,
  createSentryIssue,
  createSession,
  type Database,
  deleteSession,
  featureBranchFor,
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
import { type FixSessionService, MAX_FIX_ATTEMPTS, SentryFixService } from './fix.js';

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
  failure: Error | null = null;

  getIssueDetails(org: string, issueId: string): Promise<SentryIssueDetails> {
    this.calls.push({ org, issueId });
    if (this.failure !== null) return Promise.reject(this.failure);
    return Promise.resolve(details({ id: issueId }));
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
    if (this.setupOk) fs.mkdirSync(sessionRepoDir(this.config, session.id), { recursive: true });

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

/** Only `id` and `name` are read by the fixer; the rest is the row as it is. */
function view(session: Session): SessionView {
  return {
    ...session,
    repositoryName: 'demo',
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
  readonly fixer: SentryFixService;
  readonly repository: Repository;
  issue(fields?: { shortId?: string; attempts?: number }): SentryIssue;
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
  const fixer = new SentryFixService(config, db, sessions, (database) =>
    hasToken(database) ? sentry : null,
  );

  let seq = 0;
  return {
    db,
    config,
    sentry,
    sessions,
    fixer,
    repository,
    issue(fields = {}) {
      seq += 1;
      const row = createSentryIssue(db, {
        repositoryId: repository.id,
        sentryIssueId: `450${String(seq)}`,
        shortId: fields.shortId ?? `PROJ-${String(seq)}`,
        title: 'TypeError: cannot read property x of undefined',
        culprit: 'app/handlers.ts in handle',
        permalink: 'https://sentry.io/organizations/acme/issues/4507/',
        level: 'error',
        eventCount: 12,
        firstSeen: '2026-08-01T10:00:00.000Z',
        lastSeen: '2026-09-04T22:15:00.000Z',
      });
      // The classifier's verdict: queued, explained, attempts back to zero.
      const queued = updateSentryIssue(db, row.id, {
        status: 'queued',
        explanation: 'The handler never checks x.',
        attempts: fields.attempts ?? 0,
      });
      assert.ok(queued !== null);
      return queued;
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
    it('names it after the short id and marks it ready', async () => {
      const w = world();
      const issue = w.issue({ shortId: 'PROJ-123' });

      assert.equal(await w.fixer.createFixSessions(), 1);

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
      assert.equal(session.status, 'ready');
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

      await w.fixer.createFixSessions();

      const prd = w.prd('sentry-proj-123');
      assert.ok(prd.startsWith('# PRD: Fix the Sentry issue PROJ-123'));
      assert.ok(prd.includes('### US-001: Fix the production error reported as Sentry PROJ-123'));
      assert.ok(prd.includes('[app] app/handlers.ts:42 in handle'));
      assert.ok(prd.includes('Permalink: https://sentry.io/organizations/acme/issues/4507/'));
      assert.ok(prd.includes('chief-web triage note: The handler never checks x.'));

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

        await w.fixer.createFixSessions();

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

      await w.fixer.createFixSessions();

      assert.equal(w.sessions.created[0]?.name, 'sentry-proj-123-2');
    });

    it('creates one session per queued issue', async () => {
      const w = world();
      w.issue({ shortId: 'PROJ-1' });
      w.issue({ shortId: 'PROJ-2' });

      assert.equal(await w.fixer.createFixSessions(), 2);
      assert.deepEqual(
        w.sessions.created.map((request) => request.name),
        ['sentry-proj-1', 'sentry-proj-2'],
      );
    });
  });

  describe('never twice', () => {
    it('leaves a working issue alone on the next tick', async () => {
      const w = world();
      const issue = w.issue();

      assert.equal(await w.fixer.createFixSessions(), 1);
      assert.equal(await w.fixer.createFixSessions(), 0);

      assert.equal(w.sessions.created.length, 1);
      assert.equal(listSessions(w.db, {}).length, 1);
      assert.equal(w.reload(issue).status, 'working');
    });

    it('skips a queued issue that somehow already has a session', async () => {
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

      assert.equal(await w.fixer.createFixSessions(), 0);

      assert.equal(w.sessions.created.length, 0);
      assert.equal(w.reload(issue).status, 'queued');
    });
  });

  describe('when the session cannot be created', () => {
    it('leaves the issue queued and retries next tick', async () => {
      const w = world();
      const issue = w.issue();
      w.sessions.createFailure = new Error('"demo" has no private key on the data volume.');

      assert.equal(await w.fixer.createFixSessions(), 0);

      const row = w.reload(issue);
      assert.equal(row.status, 'queued');
      assert.equal(row.attempts, 1);
      assert.equal(row.sessionId, null);
      assert.equal(row.explanation, 'The handler never checks x.');

      w.sessions.createFailure = null;
      assert.equal(await w.fixer.createFixSessions(), 1);
      assert.equal(w.reload(issue).status, 'working');
    });

    it('gives up after three attempts, naming the failure', async () => {
      const w = world();
      const issue = w.issue({ attempts: MAX_FIX_ATTEMPTS - 1 });
      w.sessions.createFailure = new Error('no private key');

      assert.equal(await w.fixer.createFixSessions(), 0);

      const row = w.reload(issue);
      assert.equal(row.status, 'cannot_fix');
      assert.equal(row.attempts, MAX_FIX_ATTEMPTS);
      assert.equal(
        row.explanation,
        'No fix session could be created for this issue: no private key',
      );
    });

    it('throws the session away when its clone failed', async () => {
      const w = world();
      const issue = w.issue();
      w.sessions.setupOk = false;

      assert.equal(await w.fixer.createFixSessions(), 0);

      assert.equal(w.sessions.deleted.length, 1);
      assert.equal(listSessions(w.db, {}).length, 0);
      const row = w.reload(issue);
      assert.equal(row.status, 'queued');
      assert.equal(row.attempts, 1);
      assert.equal(row.sessionId, null);
    });

    it('does not spend an attempt when Sentry itself is unreachable', async () => {
      const w = world();
      const issue = w.issue();
      w.sentry.failure = new SentryApiError('sentry_unreachable', 'Sentry is down.');

      assert.equal(await w.fixer.createFixSessions(), 0);

      const row = w.reload(issue);
      assert.equal(row.status, 'queued');
      assert.equal(row.attempts, 0);
      assert.equal(w.sessions.created.length, 0);
    });

    it('does spend one when Sentry says the issue is gone', async () => {
      const w = world();
      const issue = w.issue();
      w.sentry.failure = new SentryApiError('sentry_not_found', 'No such issue.');

      assert.equal(await w.fixer.createFixSessions(), 0);

      assert.equal(w.reload(issue).attempts, 1);
    });
  });

  describe('when there is nothing to do', () => {
    it('does not look the token up without a queued issue', async () => {
      const w = world();

      assert.equal(await w.fixer.createFixSessions(), 0);
      assert.equal(w.sentry.calls.length, 0);
    });

    it('waits for a token rather than failing the issue', async () => {
      const w = world({ token: false });
      const issue = w.issue();

      assert.equal(await w.fixer.createFixSessions(), 0);

      const row = w.reload(issue);
      assert.equal(row.status, 'queued');
      assert.equal(row.attempts, 0);
    });

    it('waits for the Sentry link to come back rather than failing the issue', async () => {
      const w = world({ link: false });
      const issue = w.issue();

      assert.equal(await w.fixer.createFixSessions(), 0);

      const row = w.reload(issue);
      assert.equal(row.status, 'queued');
      assert.equal(row.attempts, 0);
      assert.equal(w.sessions.created.length, 0);
    });
  });
});
