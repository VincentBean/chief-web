import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
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
} from '../db/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { PlanningService, type PlanningTerminals, type PlanningView } from '../planning/index.js';
import type { CreateTerminalInput, TerminalView } from '../terminal/index.js';

const PASSWORD = 'correct horse battery staple';

interface ErrorBody {
  error: string;
  message?: string;
}

/** Records what the route asked for; the manager itself is US-007's business. */
const created: CreateTerminalInput[] = [];
const views = new Map<string, TerminalView>();

const terminals: PlanningTerminals = {
  create: (input) => {
    created.push(input);
    const view: TerminalView = {
      id: `terminal-${String(created.length)}`,
      container: input.container,
      containerName: input.container,
      command: input.command ?? [],
      status: 'running',
      exitCode: null,
      cols: 80,
      rows: 24,
      clients: 0,
      scrollbackBytes: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    views.set(view.id, view);
    return Promise.resolve(view);
  },
  get: (id) => {
    const view = views.get(id);
    return view === undefined ? undefined : { toView: (): TerminalView => view };
  },
  remove: (id) => Promise.resolve(views.delete(id)),
};

describe('planning api', () => {
  let baseUrl: string;
  let config: Config;
  let cookie: string;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let session: Session;

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-planning-api-'));
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
      status: 'pending',
      scheduledStartAt: null,
    });
    // The clone the planning terminal runs in.
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });

    const app = createApp(config, createAuthService(config, db), db, {
      // `POST /sessions/:id/planning` is behind the Claude guard, which probes
      // with a container; this stands in for it.
      runCommand: () =>
        Promise.resolve({
          code: 0,
          stdout: '{"loggedIn": true, "authMethod": "claude.ai"}',
          stderr: '',
          timedOut: false,
        }),
      planning: new PlanningService(config, db, terminals, {
        start: () =>
          Promise.resolve({
            id: 'container-1',
            name: 'chief-web-add-login',
            running: true,
            state: 'running',
          }),
        remove: () => Promise.resolve(),
      }),
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

  beforeEach(async () => {
    created.length = 0;
    views.clear();
    await call('DELETE', `/api/sessions/${session.id}/planning`);
  });

  it('requires a session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/planning`);

    assert.equal(response.status, 401);
  });

  it('answers 404 for a session that does not exist', async () => {
    const response = await call('GET', '/api/sessions/nope/planning');
    const body = (await response.json()) as ErrorBody;

    assert.equal(response.status, 404);
    assert.equal(body.error, 'session_not_found');
  });

  it('reports the PRD state without starting anything', async () => {
    const response = await call('GET', `/api/sessions/${session.id}/planning`);
    const body = (await response.json()) as PlanningView;

    assert.equal(response.status, 200);
    assert.equal(body.terminalId, null);
    assert.equal(body.nextMode, 'create');
    assert.equal(body.prd.path, '.chief/prds/add-login/prd.md');
    assert.equal(body.prd.exists, false);
    assert.deepEqual(created, []);
  });

  it('starts the planning terminal and reports it as running', async () => {
    const response = await call('POST', `/api/sessions/${session.id}/planning`, {
      context: 'A login screen.',
    });
    const body = (await response.json()) as PlanningView;

    assert.equal(response.status, 201);
    assert.equal(body.running, true);
    assert.equal(body.mode, 'create');
    assert.equal(created.length, 1);
    assert.equal(created[0]?.cwd, '/workspace/repo');
    assert.equal(created[0]?.command?.[0], 'claude');
    assert.match(created[0]?.command?.[1] ?? '', /Chief PRD Generator/);

    const followUp = (await (
      await call('GET', `/api/sessions/${session.id}/planning`)
    ).json()) as PlanningView;
    assert.equal(followUp.terminalId, body.terminalId);
  });

  it('rejects a context that is not a string', async () => {
    const response = await call('POST', `/api/sessions/${session.id}/planning`, { context: 7 });
    const body = (await response.json()) as ErrorBody;

    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_context');
    assert.deepEqual(created, []);
  });

  it('closes the terminal on DELETE', async () => {
    await call('POST', `/api/sessions/${session.id}/planning`);

    const response = await call('DELETE', `/api/sessions/${session.id}/planning`);
    const body = (await response.json()) as PlanningView;

    assert.equal(response.status, 200);
    assert.equal(body.terminalId, null);
    assert.equal(views.size, 0);
  });
});
