import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { BuildService, type BuildView } from '../build/index.js';
import type { AgentInvocation, AgentResult, AgentRunner } from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  featureBranchFor,
  IN_MEMORY,
  openDatabase,
  type Session,
  syncStories,
  updateSession,
} from '../db/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { parsePrd, prdPathFor, setStoryStatus } from '../prd/index.js';
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

interface ErrorBody {
  error: string;
  message?: string;
}

describe('build api', () => {
  let baseUrl: string;
  let config: Config;
  let cookie: string;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let session: Session;
  let prdFile: string;
  let invocations: AgentInvocation[];

  const call = (method: string, target: string): Promise<Response> =>
    fetch(`${baseUrl}${target}`, { method, headers: { cookie } });

  /** Finishes the only story and commits, exactly as a real agent would. */
  let head: string;
  const runner: AgentRunner = {
    run: (invocation): Promise<AgentResult> => {
      invocations.push(invocation);
      const written = setStoryStatus(fs.readFileSync(prdFile, 'utf8'), 'US-001', 'done');
      fs.writeFileSync(prdFile, written.content);
      head = 'sha-1';
      return Promise.resolve({ exitCode: 0, output: '', timedOut: false });
    },
    stop: (): Promise<void> => Promise.resolve(),
    headSha: (): Promise<string | null> => Promise.resolve(head),
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-build-api-'));
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, DATA_DIR: dataDir });
    fs.mkdirSync(config.workspacesDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    const repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'main',
    });
    session = createSession(db, {
      repositoryId: repository.id,
      name: 'add-login',
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor('add-login'),
      status: 'ready',
      scheduledStartAt: null,
    });
    prdFile = path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
    fs.mkdirSync(path.dirname(prdFile), { recursive: true });

    const app = createApp(config, createAuthService(config, db), db, {
      // `POST /sessions/:id/build` is behind the Claude guard, which probes
      // with a container; this stands in for it.
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
          start: () =>
            Promise.resolve({
              id: 'container-1',
              name: 'chief-web-add-login',
              running: true,
              state: 'running',
            }),
          remove: () => Promise.resolve(),
        },
        runner,
        {
          complete: (finished): Promise<void> => {
            updateSession(db, finished.id, { status: 'finished' });
            return Promise.resolve();
          },
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

  beforeEach(() => {
    invocations = [];
    head = 'sha-0';
    fs.writeFileSync(prdFile, PRD);
    syncStories(db, session.id, parsePrd(PRD).stories.map(storyInputOf));
    updateSession(db, session.id, { status: 'ready', lastError: null });
  });

  it('requires a session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/build`);

    assert.equal(response.status, 401);
  });

  it('answers 404 for a session that does not exist', async () => {
    const response = await call('GET', '/api/sessions/nope/build');
    const body = (await response.json()) as ErrorBody;

    assert.equal(response.status, 404);
    assert.equal(body.error, 'session_not_found');
  });

  it('reports the build state without starting anything', async () => {
    const response = await call('GET', `/api/sessions/${session.id}/build`);
    const body = (await response.json()) as BuildView;

    assert.equal(response.status, 200);
    assert.equal(body.running, false);
    assert.equal(body.status, 'ready');
    assert.equal(body.iteration, 0);
    assert.equal(body.stories.length, 1);
    assert.equal(invocations.length, 0);
  });

  it('starts the loop and runs the PRD to completion', async () => {
    const response = await call('POST', `/api/sessions/${session.id}/build`);
    const body = (await response.json()) as BuildView;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'building');

    // The loop is asynchronous; poll the same endpoint the UI does.
    let view = body;
    for (let attempt = 0; attempt < 100 && view.status === 'building'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      view = (await (await call('GET', `/api/sessions/${session.id}/build`)).json()) as BuildView;
    }

    assert.equal(view.status, 'finished');
    assert.equal(view.stories[0]?.status, 'done');
    assert.equal(view.stories[0]?.commitSha, 'sha-1');
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0]?.containerId, 'container-1');
  });

  it('refuses to start a session that is not ready', async () => {
    updateSession(db, session.id, { status: 'pending' });
    const response = await call('POST', `/api/sessions/${session.id}/build`);
    const body = (await response.json()) as ErrorBody;

    assert.equal(response.status, 409);
    assert.equal(body.error, 'session_not_ready');
  });

  it('refuses to stop a session that is not building', async () => {
    const response = await call('DELETE', `/api/sessions/${session.id}/build`);
    const body = (await response.json()) as ErrorBody;

    assert.equal(response.status, 409);
    assert.equal(body.error, 'session_not_building');
  });
});
