import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { BuildService } from '../build/index.js';
import type { AgentResult, AgentRunner } from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  deleteSession,
  type Database,
  deleteSetting,
  featureBranchFor,
  getSession,
  IN_MEMORY,
  listSessions,
  openDatabase,
  type Session,
  setSettingNumber,
  syncStories,
  updateSession,
} from '../db/index.js';
import { UsageLimitHold } from '../limits/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { parsePrd, prdPathFor } from '../prd/index.js';
import { storyInputOf } from '../sessions/index.js';

const PASSWORD = 'correct horse battery staple';

const PRD = `# PRD: Demo

### US-001: Only story
**Status:** todo
**Priority:** 1
**Description:** As a user, I want the thing.

**Acceptance Criteria:**
- [ ] It works
`;

interface HoldBody {
  until: string | null;
}

interface ClearBody {
  ok?: boolean;
  resumed?: number;
  error?: string;
  message?: string;
}

describe('usage limit api', () => {
  let baseUrl: string;
  let config: Config;
  let cookie: string;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let hold: UsageLimitHold;
  let repositoryId: string;

  const call = (method: string, target: string): Promise<Response> =>
    fetch(`${baseUrl}${target}`, { method, headers: { cookie } });

  // The agent never answers, so a resumed session stays `building` for as long
  // as the test looks at it. What is being tested is who was started, not what
  // the loop then did with them.
  const runner: AgentRunner = {
    run: (): Promise<AgentResult> => new Promise<AgentResult>(() => undefined),
    stop: (): Promise<void> => Promise.resolve(),
    reap: (): Promise<void> => Promise.resolve(),
    headSha: (): Promise<string | null> => Promise.resolve('sha-0'),
  };

  /**
   * A fresh session with a workspace, a `prd.md` and its stories.
   *
   * One per test rather than one for the file: the agent above never returns,
   * so a session resumed by one test is still running in the next, and the
   * build service skips a session it is already driving.
   */
  const seed = (name: string): Session => {
    const session = createSession(db, {
      repositoryId,
      name,
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor(name),
      status: 'ready',
      scheduledStartAt: null,
    });
    const prdFile = path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(prdFile), { recursive: true });
    fs.writeFileSync(prdFile, PRD);
    syncStories(db, session.id, parsePrd(PRD).stories.map(storyInputOf));
    return session;
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-limits-api-'));
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, DATA_DIR: dataDir });
    fs.mkdirSync(config.workspacesDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    hold = new UsageLimitHold(db);
    const repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'main',
    });
    repositoryId = repository.id;

    const app = createApp(config, createAuthService(config, db), db, {
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

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  // The hold is a settings row and the cap is a settings row, both shared by
  // every test in the file. The sessions of the previous test go too: the agent
  // never returns, so one left `building` would still be holding a slot.
  beforeEach(() => {
    hold.clear();
    deleteSetting(db, 'max_concurrent_sessions');
    for (const session of listSessions(db)) deleteSession(db, session.id);
  });

  it('requires a session cookie', async () => {
    const read = await fetch(`${baseUrl}/api/limits/hold`);
    const clear = await fetch(`${baseUrl}/api/limits/hold/clear`, { method: 'POST' });

    assert.equal(read.status, 401);
    assert.equal(clear.status, 401);
  });

  it('reports no hold when nothing is held', async () => {
    const response = await call('GET', '/api/limits/hold');
    const body = (await response.json()) as HoldBody;

    assert.equal(response.status, 200);
    assert.equal(body.until, null);
  });

  it('reports the expiry of an active hold', async () => {
    const until = hold.arm();

    const response = await call('GET', '/api/limits/hold');
    const body = (await response.json()) as HoldBody;

    assert.equal(response.status, 200);
    assert.equal(body.until, until);
  });

  it('exposes when a held session may resume', async () => {
    const held = seed('read-waiting-until');
    updateSession(db, held.id, { status: 'waiting', waitingUntil: '2026-08-31T13:00:00.000Z' });

    const response = await call('GET', `/api/sessions/${held.id}`);
    const body = (await response.json()) as { waitingUntil: string | null };

    assert.equal(response.status, 200);
    assert.equal(body.waitingUntil, '2026-08-31T13:00:00.000Z');
  });

  it('clears the hold and resumes every waiting session', async () => {
    const held = [seed('resume-one'), seed('resume-two')];
    const until = hold.arm();
    for (const session of held) {
      updateSession(db, session.id, { status: 'waiting', waitingUntil: until });
    }

    const response = await call('POST', '/api/limits/hold/clear');
    const body = (await response.json()) as ClearBody;

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.resumed, 2);
    // The hold is gone, so nothing parks these sessions again.
    assert.equal(hold.until(), null);
    for (const session of held) {
      const resumed = getSession(db, session.id);
      assert.equal(resumed?.status, 'building');
      assert.equal(resumed?.waitingUntil, null);
    }
  });

  it('queues the held sessions that do not fit under the cap', async () => {
    setSettingNumber(db, 'max_concurrent_sessions', 1);
    const held = [seed('capped-one'), seed('capped-two')];
    const until = hold.arm();
    for (const session of held) {
      updateSession(db, session.id, { status: 'waiting', waitingUntil: until });
    }

    const response = await call('POST', '/api/limits/hold/clear');
    const body = (await response.json()) as ClearBody;

    assert.equal(response.status, 200);
    assert.equal(body.resumed, 1);
    const building = held.filter((s) => getSession(db, s.id)?.status === 'building');
    const queued = held.filter((s) => getSession(db, s.id)?.queuedAt !== null);
    assert.equal(building.length, 1);
    assert.equal(queued.length, 1);
    assert.equal(getSession(db, queued[0]?.id ?? '')?.status, 'ready');
  });

  it('answers 409 when no hold is active', async () => {
    const response = await call('POST', '/api/limits/hold/clear');
    const body = (await response.json()) as ClearBody;

    assert.equal(response.status, 409);
    assert.equal(body.error, 'no_usage_limit_hold');
    assert.equal(body.resumed, undefined);
  });
});
