import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { type AgentResult, type AgentRunner, BuildService } from '../build/index.js';
import { addClaudeAccount } from '../claude/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  deleteClaudeAccount,
  deleteSession,
  featureBranchFor,
  getQueuedBuild,
  getSession,
  IN_MEMORY,
  listClaudeAccounts,
  listSessions,
  openDatabase,
  removeQueuedBuild,
  type Session,
  type SessionStatus,
  setSettingNumber,
  syncStories,
} from '../db/index.js';
import { UsageLimitHold } from '../limits/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { parsePrd, prdPathFor } from '../prd/index.js';
import { storyInputOf } from '../sessions/index.js';
import { generateToken } from './index.js';

const PASSWORD = 'correct horse battery staple';

const PRD = `# PRD: Demo

### US-001: Only story
**Status:** todo
**Priority:** 1
**Description:** As a user, I want the thing.

**Acceptance Criteria:**
- [ ] It works
`;

interface StartBody {
  session?: { id: string; name: string; status: string; branch: string; scheduledStartAt: string | null };
  outcome?: string;
  queued?: boolean;
  queuePosition?: number | null;
  message?: string;
  url?: string;
  error?: string;
  errors?: { line: number; message: string }[];
}

describe('POST /api/agent/sessions/:id/start', () => {
  let baseUrl: string;
  let config: Config;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let token: string;
  let repositoryId: string;

  // The agent never answers, so a started session stays `building` for as long
  // as the test looks at it.
  const runner: AgentRunner = {
    run: (): Promise<AgentResult> => new Promise<AgentResult>(() => undefined),
    stop: (): Promise<void> => Promise.resolve(),
    reap: (): Promise<void> => Promise.resolve(),
    headSha: (): Promise<string | null> => Promise.resolve('sha-0'),
  };

  const start = async (
    id: string,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ): Promise<{ status: number; body: StartBody }> => {
    const response = await fetch(`${baseUrl}/api/agent/sessions/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      headers,
    });
    return { status: response.status, body: (await response.json()) as StartBody };
  };

  /** A session with a workspace and a `prd.md`, as setup leaves it. */
  const seed = (
    name: string,
    status: SessionStatus,
    { prd = PRD, scheduledStartAt = null }: { prd?: string; scheduledStartAt?: string | null } = {},
  ): Session => {
    const session = createSession(db, {
      repositoryId,
      name,
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor(name),
      status,
      scheduledStartAt,
    });
    const prdFile = path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(prdFile), { recursive: true });
    fs.writeFileSync(prdFile, prd);
    if (status !== 'pending') syncStories(db, session.id, parsePrd(PRD).stories.map(storyInputOf));
    return session;
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-agent-start-'));
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, DATA_DIR: dataDir, PUBLIC_URL: '' });
    fs.mkdirSync(config.workspacesDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    addClaudeAccount(config, db);
    repositoryId = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'main',
    }).id;

    const app = createApp(config, createAuthService(config, db), db, {
      runCommand: () =>
        Promise.resolve({
          code: 0,
          stdout: '{"loggedIn": true, "authMethod": "claude.ai"}',
          stderr: '',
          timedOut: false,
        }),
      builds: new BuildService(
        config,
        db,
        {
          start: (session) =>
            Promise.resolve({
              id: `container-${session.name}`,
              name: `chief-web-${session.name}`,
              running: true,
              state: 'running',
            }),
          remove: () => Promise.resolve(),
        },
        runner,
        {
          push: (): Promise<void> => Promise.resolve(),
          complete: (): Promise<void> => Promise.resolve(),
        },
      ),
    });

    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // A started session never stops building, so each test starts from an empty
  // pool, an empty queue and a cap with room to spare.
  beforeEach(() => {
    token = generateToken(db);
    new UsageLimitHold(db).clearAll();
    setSettingNumber(db, 'max_concurrent_sessions', 10);
    for (const session of listSessions(db)) {
      removeQueuedBuild(db, 'session', session.id);
      deleteSession(db, session.id);
    }
  });

  it('marks a pending session ready and starts its build', async () => {
    const session = seed('pending-start', 'pending');

    const { status, body } = await start(session.id);

    assert.equal(status, 200);
    assert.equal(body.outcome, 'started');
    assert.equal(body.queued, false);
    assert.equal(body.queuePosition, null);
    assert.deepEqual(body.session, {
      id: session.id,
      name: 'pending-start',
      status: 'building',
      branch: session.featureBranch,
      scheduledStartAt: null,
    });
    assert.match(body.url ?? '', new RegExp(`/sessions/${session.id}$`));
    assert.equal(getSession(db, session.id)?.status, 'building');
  });

  it('starts a ready session straight away', async () => {
    const session = seed('ready-start', 'ready');

    const { status, body } = await start(session.id);

    assert.equal(status, 200);
    assert.equal(body.outcome, 'started');
    assert.equal(body.session?.status, 'building');
  });

  it('queues the build when no slot is free', async () => {
    setSettingNumber(db, 'max_concurrent_sessions', 1);
    seed('already-building', 'building');
    const session = seed('waits-for-slot', 'pending');

    const { status, body } = await start(session.id);

    assert.equal(status, 200);
    assert.equal(body.outcome, 'queued');
    assert.equal(body.queued, true);
    assert.equal(body.queuePosition, 1);
    assert.equal(body.session?.status, 'ready');
    assert.notEqual(getQueuedBuild(db, 'session', session.id), null);
  });

  it('answers 200 queued, not 429, while Claude’s usage limit holds', async () => {
    const hold = new UsageLimitHold(db);
    for (const account of listClaudeAccounts(db)) hold.arm(account.id);
    const session = seed('held', 'ready');

    const { status, body } = await start(session.id);

    assert.equal(status, 200);
    assert.equal(body.outcome, 'queued');
    assert.equal(body.queued, true);
    assert.equal(body.queuePosition, 1);
    assert.ok((body.message ?? '').length > 0);
    assert.notEqual(getQueuedBuild(db, 'session', session.id), null);
  });

  it('marks a session with a future schedule ready and leaves it to the scheduler', async () => {
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    const session = seed('scheduled', 'pending', { scheduledStartAt: later });

    const { status, body } = await start(session.id);

    assert.equal(status, 200);
    assert.equal(body.outcome, 'scheduled');
    assert.equal(body.queued, false);
    assert.equal(body.session?.status, 'ready');
    assert.equal(body.session?.scheduledStartAt, later);
    assert.equal(getQueuedBuild(db, 'session', session.id), null);
  });

  it('refuses a PRD that does not parse and leaves the session pending', async () => {
    const session = seed('broken-prd', 'pending', { prd: '# PRD: Broken\n\n### US-001 no colon\n' });

    const { status, body } = await start(session.id);

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_prd');
    assert.ok((body.errors ?? []).length > 0);
    for (const error of body.errors ?? []) {
      assert.equal(typeof error.line, 'number');
      assert.equal(typeof error.message, 'string');
    }
    assert.equal(getSession(db, session.id)?.status, 'pending');
  });

  it('refuses a session that is neither pending nor ready', async () => {
    const session = seed('done-already', 'finished');

    const { status, body } = await start(session.id);

    assert.equal(status, 409);
    assert.equal(body.error, 'session_not_startable');
    assert.match(body.message ?? '', /finished/);
    assert.equal(getSession(db, session.id)?.status, 'finished');
  });

  it('answers 404 for an unknown session', async () => {
    const { status, body } = await start('no-such-session');

    assert.equal(status, 404);
    assert.equal(body.error, 'session_not_found');
  });

  it('requires the bearer token', async () => {
    const session = seed('no-token', 'ready');

    const { status } = await start(session.id, {});

    assert.equal(status, 401);
    assert.equal(getSession(db, session.id)?.status, 'ready');
  });

  it('is blocked until Claude Code is signed in', async () => {
    const session = seed('signed-out', 'ready');
    // No account at all is the one state the cached status probe cannot hide.
    for (const account of listClaudeAccounts(db)) deleteClaudeAccount(db, account.id);

    let result: Awaited<ReturnType<typeof start>>;
    try {
      result = await start(session.id);
    } finally {
      addClaudeAccount(config, db);
    }

    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'claude_not_authenticated');
    assert.equal(getSession(db, session.id)?.status, 'ready');
  });
});
