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
  type Database,
  deleteSession,
  IN_MEMORY,
  listSessions,
  openDatabase,
  type Repository,
} from '../db/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import type { SessionView, SetupResult } from '../sessions/index.js';
import { setupScript } from '../sessions/index.js';
import { writePrivateKey } from '../ssh/index.js';

const PASSWORD = 'correct horse battery staple';
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';

interface SetupBody {
  session: SessionView;
  setup: SetupResult;
}

interface ErrorBody {
  error: string;
  message?: string;
}

/** Containers the stub orchestrator was asked to start, newest last. */
let started: string[] = [];
let removed: string[] = [];
/** What the scripted git commands answer with, keyed by setup step. */
let gitExit: Record<string, Partial<ExecOutput>> = {};

describe('sessions api', () => {
  let baseUrl: string;
  let cookie: string;
  let config: Config;
  let dataDir: string;
  let db: Database;
  let repository: Repository;
  let server: http.Server;

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const create = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ status: number; body: SetupBody & ErrorBody }> => {
    const response = await call('POST', '/api/sessions', {
      repositoryId: repository.id,
      name: 'add-login',
      prTargetBranch: 'develop',
      ...overrides,
    });
    return { status: response.status, body: (await response.json()) as SetupBody & ErrorBody };
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-sessions-'));
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, DATA_DIR: dataDir });
    fs.mkdirSync(config.workspacesDir, { recursive: true });
    fs.mkdirSync(config.sshKeysDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'develop',
    });
    writePrivateKey(config, repository.id, PRIVATE_KEY);

    const app = createApp(config, createAuthService(config, db), db, {
      // The Claude guard in front of `POST /sessions` runs a probe container;
      // this is the only thing standing in for Docker in these tests.
      runCommand: () =>
        Promise.resolve({
          code: 0,
          stdout: '{"loggedIn": true, "authMethod": "claude.ai"}',
          stderr: '',
          timedOut: false,
        }),
      orchestrator: {
        start: (session): Promise<SessionContainerView> => {
          started.push(session.id);
          return Promise.resolve({
            id: `container-${session.id.slice(0, 4)}`,
            name: `chief-web-${session.name}`,
            running: true,
            state: 'running',
          });
        },
        remove: (sessionId): Promise<void> => {
          removed.push(sessionId);
          return Promise.resolve();
        },
      },
      exec: {
        runExec: (_container, spec: ExecSpec): Promise<ExecOutput> => {
          const script = spec.cmd[2] ?? '';
          const step =
            script === setupScript('check-branch')
              ? 'check-branch'
              : script === setupScript('clone')
                ? 'clone'
                : 'branch';
          return Promise.resolve({
            exitCode: step === 'check-branch' ? 2 : 0,
            stdout: '',
            stderr: '',
            timedOut: false,
            ...gitExit[step],
          });
        },
      },
    });

    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    started = [];
    removed = [];
    gitExit = {};
    for (const session of listSessions(db)) deleteSession(db, session.id);
  });

  it('requires a session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/sessions`);

    assert.equal(response.status, 401);
  });

  it('creates a pending session, starts its container and clones', async () => {
    const { status, body } = await create();

    assert.equal(status, 201);
    assert.equal(body.setup.ok, true);
    assert.equal(body.session.status, 'pending');
    assert.equal(body.session.name, 'add-login');
    assert.equal(body.session.featureBranch, 'chief/add-login');
    assert.equal(body.session.baseBranch, 'develop');
    assert.equal(body.session.prTargetBranch, 'develop');
    assert.equal(body.session.repositoryName, 'demo');
    assert.equal(body.session.lastError, null);
    assert.deepEqual(started, [body.session.id]);
    assert.deepEqual(removed, []);
  });

  it('stores a scheduled start as UTC', async () => {
    const { body } = await create({ scheduledStartAt: '2026-09-01T10:30:00+02:00' });

    assert.equal(body.session.scheduledStartAt, '2026-09-01T08:30:00.000Z');
  });

  it('defaults the base branch to the repository and the PR target to main', async () => {
    const { body } = await create({ prTargetBranch: undefined, baseBranch: undefined });

    assert.equal(body.session.baseBranch, 'develop');
    assert.equal(body.session.prTargetBranch, 'main');
  });

  it('rejects a name that is not a slug', async () => {
    const { status, body } = await create({ name: 'add login' });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_session_name');
    assert.match(body.message ?? '', /hyphens and underscores/);
  });

  it('rejects an unknown PR target branch', async () => {
    const { status, body } = await create({ prTargetBranch: 'master' });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_pr_target_branch');
  });

  it('rejects an unparseable scheduled start', async () => {
    const { status, body } = await create({ scheduledStartAt: 'next tuesday' });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_scheduled_start');
  });

  it('rejects an unknown repository', async () => {
    const { status, body } = await create({ repositoryId: 'nope' });

    assert.equal(status, 400);
    assert.equal(body.error, 'repository_not_found');
  });

  it('refuses a name already used in the same repository', async () => {
    await create();

    const { status, body } = await create();

    assert.equal(status, 409);
    assert.equal(body.error, 'session_name_taken');
  });

  it('reports a taken remote branch without failing the session', async () => {
    gitExit['check-branch'] = { exitCode: 0, stdout: 'abc\trefs/heads/chief/add-login\n' };

    const { status, body } = await create();

    assert.equal(status, 201);
    assert.equal(body.setup.ok, false);
    assert.equal(body.setup.code, 'feature_branch_exists');
    assert.equal(body.session.status, 'pending');
    assert.equal(body.session.cloned, false);
    assert.match(body.session.lastError ?? '', /already exists on origin/);
    // The container of a failed setup is cleaned up, ready for a retry.
    assert.deepEqual(removed, [body.session.id]);
  });

  it('surfaces git stderr from a failed clone', async () => {
    gitExit['clone'] = {
      exitCode: 128,
      stderr: 'fatal: Remote branch develop not found in upstream origin',
    };

    const { body } = await create();

    assert.equal(body.setup.ok, false);
    assert.equal(body.setup.code, 'clone_failed');
    assert.match(body.setup.stderr, /Remote branch develop not found/);
  });

  it('retries the setup of a pending session', async () => {
    gitExit['clone'] = { exitCode: 128, stderr: 'fatal: could not read from remote' };
    const { body: first } = await create();
    assert.equal(first.setup.ok, false);

    gitExit = {};
    const response = await call('POST', `/api/sessions/${first.session.id}/setup`);
    const retried = (await response.json()) as SetupBody;

    assert.equal(response.status, 200);
    assert.equal(retried.setup.ok, true);
    assert.equal(retried.session.lastError, null);
    assert.equal(started.length, 2);
  });

  it('answers 404 for the setup of an unknown session', async () => {
    const response = await call('POST', '/api/sessions/nope/setup');

    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as ErrorBody).error, 'session_not_found');
  });

  it('lists sessions and filters them by repository', async () => {
    await create();
    const other = createRepository(db, {
      name: 'other',
      sshUrl: 'git@github.com:acme/other.git',
      githubSlug: 'acme/other',
    });

    const all = (await (await call('GET', '/api/sessions')).json()) as { sessions: SessionView[] };
    const filtered = (await (
      await call('GET', `/api/sessions?repositoryId=${other.id}`)
    ).json()) as { sessions: SessionView[] };

    assert.equal(all.sessions.length, 1);
    assert.equal(all.sessions[0]?.featureBranch, 'chief/add-login');
    assert.deepEqual(filtered.sessions, []);
  });

  it('returns one session, and 404 for an unknown id', async () => {
    const { body } = await create();

    const found = await call('GET', `/api/sessions/${body.session.id}`);
    const missing = await call('GET', '/api/sessions/does-not-exist');

    assert.equal(found.status, 200);
    assert.equal(((await found.json()) as SessionView).name, 'add-login');
    assert.equal(missing.status, 404);
  });
});
