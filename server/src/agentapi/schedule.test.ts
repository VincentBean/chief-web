import assert from 'node:assert/strict';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
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
  getSession,
  IN_MEMORY,
  listClaudeAccounts,
  listSessions,
  openDatabase,
  type Session,
  type SessionStatus,
} from '../db/index.js';
import { generateToken } from './index.js';

const PASSWORD = 'correct horse battery staple';

interface ScheduleBody {
  session?: { id: string; name: string; status: string; branch: string; scheduledStartAt: string | null };
  url?: string;
  error?: string;
  message?: string;
}

describe('PUT /api/agent/sessions/:id/schedule', () => {
  let baseUrl: string;
  let config: Config;
  let dataDir: string;
  let db: Database;
  let server: http.Server;
  let token: string;
  let repositoryId: string;

  const schedule = async (
    id: string,
    body: unknown,
    headers: Record<string, string> = { authorization: `Bearer ${token}` },
  ): Promise<{ status: number; body: ScheduleBody }> => {
    const response = await fetch(`${baseUrl}/api/agent/sessions/${encodeURIComponent(id)}/schedule`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as ScheduleBody };
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-agent-schedule-'));
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
    for (const session of listSessions(db)) deleteSession(db, session.id);
  });

  it('sets the scheduled start and answers only the public session fields', async () => {
    const session = seed('set-schedule', 'pending');

    const { status, body } = await schedule(session.id, { scheduledStartAt: '2099-09-01T04:00:00+02:00' });

    assert.equal(status, 200);
    assert.deepEqual(body.session, {
      id: session.id,
      name: 'set-schedule',
      status: 'pending',
      branch: session.featureBranch,
      scheduledStartAt: '2099-09-01T02:00:00.000Z',
    });
    assert.deepEqual(Object.keys(body).sort(), ['session', 'url']);
    assert.match(body.url ?? '', new RegExp(`/sessions/${session.id}$`));
    assert.equal(getSession(db, session.id)?.scheduledStartAt, '2099-09-01T02:00:00.000Z');
  });

  it('changes the scheduled start of a ready session', async () => {
    const session = seed('change-schedule', 'ready', '2099-09-01T02:00:00.000Z');

    const { status, body } = await schedule(session.id, { scheduledStartAt: '2099-09-02T02:00:00.000Z' });

    assert.equal(status, 200);
    assert.equal(body.session?.status, 'ready');
    assert.equal(body.session?.scheduledStartAt, '2099-09-02T02:00:00.000Z');
    assert.equal(getSession(db, session.id)?.scheduledStartAt, '2099-09-02T02:00:00.000Z');
  });

  it('clears the schedule with null', async () => {
    const session = seed('clear-schedule', 'pending', '2099-09-01T02:00:00.000Z');

    const { status, body } = await schedule(session.id, { scheduledStartAt: null });

    assert.equal(status, 200);
    assert.equal(body.session?.scheduledStartAt, null);
    assert.equal(getSession(db, session.id)?.scheduledStartAt, null);
  });

  it('refuses a body without scheduledStartAt', async () => {
    const session = seed('missing-key', 'pending', '2099-09-01T02:00:00.000Z');

    const { status, body } = await schedule(session.id, {});

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_scheduled_start');
    assert.equal(getSession(db, session.id)?.scheduledStartAt, '2099-09-01T02:00:00.000Z');
  });

  it('refuses a timestamp that does not parse', async () => {
    const session = seed('bad-timestamp', 'pending');

    const { status, body } = await schedule(session.id, { scheduledStartAt: 'tomorrow-ish' });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_scheduled_start');
    assert.equal(getSession(db, session.id)?.scheduledStartAt, null);
  });

  it('refuses a session that is neither pending nor ready', async () => {
    const session = seed('already-building', 'building');

    const { status, body } = await schedule(session.id, { scheduledStartAt: '2099-09-01T02:00:00.000Z' });

    assert.equal(status, 409);
    assert.equal(body.error, 'session_not_schedulable');
    assert.equal(getSession(db, session.id)?.scheduledStartAt, null);
  });

  it('answers 404 for an unknown session', async () => {
    const { status, body } = await schedule('no-such-session', { scheduledStartAt: null });

    assert.equal(status, 404);
    assert.equal(body.error, 'session_not_found');
  });

  it('requires the bearer token', async () => {
    const session = seed('no-token', 'pending');

    const { status } = await schedule(session.id, { scheduledStartAt: '2099-09-01T02:00:00.000Z' }, {});

    assert.equal(status, 401);
    assert.equal(getSession(db, session.id)?.scheduledStartAt, null);
  });

  it('works while Claude Code is signed out, since it starts nothing', async () => {
    const session = seed('signed-out', 'pending');
    for (const account of listClaudeAccounts(db)) deleteClaudeAccount(db, account.id);

    let result: Awaited<ReturnType<typeof schedule>>;
    try {
      result = await schedule(session.id, { scheduledStartAt: '2099-09-01T02:00:00.000Z' });
    } finally {
      addClaudeAccount(config, db);
    }

    assert.equal(result.status, 200);
    assert.equal(result.body.session?.scheduledStartAt, '2099-09-01T02:00:00.000Z');
  });
});
