import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import {
  type AgentResult,
  type AgentRunner,
  createBuildLogStore,
  createBuildService,
} from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  getSession,
  IN_MEMORY,
  openDatabase,
  type Session,
  syncStories,
  updateSession,
} from '../db/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import { parsePrd, prdPathFor, setStoryStatus } from '../prd/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
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

/**
 * The scheduler as `createApp` wires it (US-017): a real `SchedulerService`
 * around a real `BuildService`, polling a real database. Only the agent itself
 * is a mock, so what this proves is that a session with nothing but a
 * timestamp on it starts on its own, with no request from anybody.
 */
describe('scheduled starts, end to end', () => {
  let baseUrl: string;
  let config: Config;
  let cookie: string;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let session: Session;
  let prdFile: string;

  const runner: AgentRunner = {
    run: (): Promise<AgentResult> => {
      const written = setStoryStatus(fs.readFileSync(prdFile, 'utf8'), 'US-001', 'done');
      fs.writeFileSync(prdFile, written.content);
      return Promise.resolve({ exitCode: 0, output: '', timedOut: false });
    },
    stop: (): Promise<void> => Promise.resolve(),
    headSha: (): Promise<string | null> => Promise.resolve('sha-1'),
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-scheduler-'));
    // The shortest interval the configuration allows, so the test waits a
    // second rather than half a minute.
    config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      DATA_DIR: dataDir,
      SCHEDULER_INTERVAL_MS: '1000',
    });
    fs.mkdirSync(config.workspacesDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    const repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    });
    session = createSession(db, {
      repositoryId: repository.id,
      name: 'overnight',
      baseBranch: 'main',
      prTargetBranch: 'main',
      status: 'ready',
      // Its moment passed while the stack was down; the catch-up owns it.
      scheduledStartAt: '2020-01-01T00:00:00.000Z',
    });

    prdFile = path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(prdFile), { recursive: true });
    fs.writeFileSync(prdFile, PRD);
    syncStories(db, session.id, parsePrd(PRD).stories.map(storyInputOf));

    const containers = {
      start: (): Promise<SessionContainerView> =>
        Promise.resolve({ id: 'container-1', name: 'chief-web-overnight', running: true, state: 'running' }),
      remove: (): Promise<void> => Promise.resolve(),
    };
    const app = createApp(config, createAuthService(config, db), db, {
      orchestrator: containers,
      builds: createBuildService(
        config,
        db,
        containers,
        runner,
        undefined,
        createBuildLogStore(config, db),
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

  it('starts a session that came due while the stack was down, with no request', async () => {
    // The catch-up runs inside `createApp`, before anything is served.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (getSession(db, session.id)?.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const row = getSession(db, session.id);
    assert.equal(row?.status, 'finished');
    // One-shot: the timestamp was spent on the way into `building`.
    assert.equal(row?.scheduledStartAt, null);
  });

  it('serves the session with its schedule cleared', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/${session.id}`, { headers: { cookie } });
    const body = (await response.json()) as { scheduledStartAt: string | null; scheduleMissed: boolean };

    assert.equal(response.status, 200);
    assert.equal(body.scheduledStartAt, null);
    assert.equal(body.scheduleMissed, false);
  });

  it('does not fire again for a session that is put back to ready', async () => {
    updateSession(db, session.id, { status: 'ready' });

    // Two intervals is plenty: nothing is due, because nothing is scheduled.
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    assert.equal(getSession(db, session.id)?.status, 'ready');
  });
});
