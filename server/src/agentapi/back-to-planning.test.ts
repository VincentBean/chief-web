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
  deleteSession,
  enqueueBuild,
  featureBranchFor,
  getQueuedBuild,
  getSession,
  IN_MEMORY,
  listSessions,
  openDatabase,
  removeQueuedBuild,
  type Session,
  type SessionStatus,
} from '../db/index.js';
import { generateToken } from './index.js';

const PASSWORD = 'correct horse battery staple';

interface BackToPlanningBody {
  session?: { id: string; name: string; status: string; branch: string; scheduledStartAt: string | null };
  url?: string;
  error?: string;
  message?: string;
}

describe('POST /api/agent/sessions/:id/back-to-planning', () => {
  let baseUrl: string;
  let config: Config;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let token: string;
  let repositoryId: string;

  // Nothing here starts a build; the runner only has to exist.
  const runner: AgentRunner = {
    run: (): Promise<AgentResult> => new Promise<AgentResult>(() => undefined),
    stop: (): Promise<void> => Promise.resolve(),
    reap: (): Promise<void> => Promise.resolve(),
    headSha: (): Promise<string | null> => Promise.resolve('sha-0'),
  };

  const backToPlanning = async (
    id: string,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ): Promise<{ status: number; body: BackToPlanningBody }> => {
    const response = await fetch(
      `${baseUrl}/api/agent/sessions/${encodeURIComponent(id)}/back-to-planning`,
      { method: 'POST', headers },
    );
    return { status: response.status, body: (await response.json()) as BackToPlanningBody };
  };

  const seed = (name: string, status: SessionStatus, scheduledStartAt: string | null = null): Session =>
    createSession(db, {
      repositoryId,
      name,
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor(name),
      status,
      scheduledStartAt,
    });

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-agent-back-to-planning-'));
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

  beforeEach(() => {
    token = generateToken(db);
    for (const session of listSessions(db)) {
      removeQueuedBuild(db, 'session', session.id);
      deleteSession(db, session.id);
    }
  });

  it('returns a ready session to pending and answers only the public session fields', async () => {
    const session = seed('ready-back', 'ready');

    const { status, body } = await backToPlanning(session.id);

    assert.equal(status, 200);
    assert.deepEqual(body.session, {
      id: session.id,
      name: 'ready-back',
      status: 'pending',
      branch: session.featureBranch,
      scheduledStartAt: null,
    });
    assert.deepEqual(Object.keys(body).sort(), ['session', 'url']);
    assert.match(body.url ?? '', new RegExp(`/sessions/${session.id}$`));
    assert.equal(getSession(db, session.id)?.status, 'pending');
  });

  it('takes a queued session off the build queue before returning it to pending', async () => {
    const session = seed('queued-back', 'ready');
    enqueueBuild(db, { kind: 'session', refId: session.id });
    assert.notEqual(getQueuedBuild(db, 'session', session.id), null);

    const { status, body } = await backToPlanning(session.id);

    assert.equal(status, 200);
    assert.equal(body.session?.status, 'pending');
    assert.equal(getQueuedBuild(db, 'session', session.id), null);
    assert.equal(getSession(db, session.id)?.status, 'pending');
  });

  it('leaves a scheduled start as it is', async () => {
    const session = seed('scheduled-back', 'ready', '2099-09-01T02:00:00.000Z');

    const { status, body } = await backToPlanning(session.id);

    assert.equal(status, 200);
    assert.equal(body.session?.scheduledStartAt, '2099-09-01T02:00:00.000Z');
    assert.equal(getSession(db, session.id)?.scheduledStartAt, '2099-09-01T02:00:00.000Z');
  });

  for (const running of ['building', 'waiting', 'deciding'] as const) {
    it(`refuses a ${running} session and points at Stop build`, async () => {
      const session = seed(`${running}-back`, running);

      const { status, body } = await backToPlanning(session.id);

      assert.equal(status, 409);
      assert.equal(body.error, 'session_not_ready');
      assert.match(body.message ?? '', new RegExp(`is ${running}\\.`));
      assert.match(body.message ?? '', /Stop build/);
      assert.equal(getSession(db, session.id)?.status, running);
    });
  }

  it('refuses a pending session without mentioning Stop build', async () => {
    const session = seed('pending-back', 'pending');

    const { status, body } = await backToPlanning(session.id);

    assert.equal(status, 409);
    assert.equal(body.error, 'session_not_ready');
    assert.match(body.message ?? '', /is pending\./);
    assert.doesNotMatch(body.message ?? '', /Stop build/);
    assert.equal(getSession(db, session.id)?.status, 'pending');
  });

  it('answers 404 for an unknown session', async () => {
    const { status, body } = await backToPlanning('no-such-session');

    assert.equal(status, 404);
    assert.equal(body.error, 'session_not_found');
  });

  it('requires the bearer token', async () => {
    const session = seed('no-token', 'ready');

    const { status } = await backToPlanning(session.id, {});

    assert.equal(status, 401);
    assert.equal(getSession(db, session.id)?.status, 'ready');
  });
});
