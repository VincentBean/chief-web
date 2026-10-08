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
  type Database,
  deleteClaudeAccount,
  deleteSession,
  getSession,
  listClaudeAccounts,
  IN_MEMORY,
  listSessions,
  openDatabase,
  type Repository,
} from '../db/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { type SessionContainerView, sessionRepoDir } from '../orchestrator/index.js';
import { sessionPrdFile, setupScript } from '../sessions/index.js';
import { writePrivateKey } from '../ssh/index.js';
import { generateToken } from './index.js';

const PASSWORD = 'correct horse battery staple';
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----';

const PRD = `# PRD: Login

## Introduction

A login form.

## User Stories

### US-001: Add the form
**Status:** todo
**Priority:** 1
**Description:** As a user, I want a login form.

**Acceptance Criteria:**
- [ ] The form has an email and a password field
- [ ] Typecheck passes
`;

interface CreateBody {
  session: { id: string; name: string; status: string; branch: string; scheduledStartAt: string | null };
  setup: { ok: boolean; message: string };
  prdWritten: boolean;
  url: string;
  error?: string;
  errors?: { line: number; message: string }[];
}

/** What the scripted git commands answer with, keyed by setup step. */
let gitExit: Record<string, Partial<ExecOutput>> = {};

describe('POST /api/agent/sessions', () => {
  let baseUrl: string;
  let config: Config;
  let cookie: string;
  let dataDir: string;
  let db: Database;
  let repository: Repository;
  let server: http.Server;
  let token: string;

  const create = async (overrides: Record<string, unknown> = {}): Promise<{ status: number; body: CreateBody }> => {
    const response = await fetch(`${baseUrl}/api/agent/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryId: repository.id, name: 'add-login', prd: PRD, ...overrides }),
    });
    return { status: response.status, body: (await response.json()) as CreateBody };
  };

  const prdOnDisk = (id: string, name = 'add-login'): string | null => {
    const file = sessionPrdFile(config, { id, name });
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };

  before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-agent-sessions-'));
    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, DATA_DIR: dataDir, PUBLIC_URL: '' });
    fs.mkdirSync(config.workspacesDir, { recursive: true });
    fs.mkdirSync(config.sshKeysDir, { recursive: true });

    db = openDatabase(IN_MEMORY);
    addClaudeAccount(config, db);
    repository = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'develop',
      openPullRequestDefault: false,
    });
    writePrivateKey(config, repository.id, PRIVATE_KEY);

    const app = createApp(config, createAuthService(config, db), db, {
      runCommand: () =>
        Promise.resolve({
          code: 0,
          stdout: '{"loggedIn": true, "authMethod": "claude.ai"}',
          stderr: '',
          timedOut: false,
        }),
      orchestrator: {
        // The real orchestrator creates the workspace the clone lands in.
        start: (session): Promise<SessionContainerView> => {
          fs.mkdirSync(sessionRepoDir(config, session.id), { recursive: true });
          return Promise.resolve({
            id: `container-${session.id.slice(0, 4)}`,
            name: `chief-web-${session.name}`,
            running: true,
            state: 'running',
          });
        },
        remove: (): Promise<void> => Promise.resolve(),
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
    gitExit = {};
    token = generateToken(db);
    for (const session of listSessions(db)) deleteSession(db, session.id);
  });

  it('creates a pending session and writes the PRD into its clone', async () => {
    const { status, body } = await create();

    assert.equal(status, 201);
    assert.equal(body.session.name, 'add-login');
    assert.equal(body.session.status, 'pending');
    assert.equal(body.session.branch, 'chief/add-login');
    assert.equal(body.session.scheduledStartAt, null);
    assert.deepEqual(Object.keys(body).sort(), ['prdWritten', 'session', 'setup', 'url']);
    assert.equal(body.setup.ok, true);
    assert.equal(typeof body.setup.message, 'string');
    assert.equal(body.prdWritten, true);
    assert.equal(body.url, `${baseUrl}/sessions/${body.session.id}`);

    assert.equal(prdOnDisk(body.session.id), PRD);
    const stored = getSession(db, body.session.id);
    assert.equal(stored?.status, 'pending');
    assert.equal(stored?.pendingPrd, null);
  });

  it('applies the defaults from the repository', async () => {
    const { body } = await create();

    const stored = getSession(db, body.session.id);
    assert.equal(stored?.baseBranch, 'develop');
    assert.equal(stored?.prTargetBranch, 'develop');
    assert.equal(stored?.codeReview, false);
    assert.equal(stored?.openPullRequest, false);
  });

  it('defaults the PR target to main when the base branch is not develop', async () => {
    const other = createRepository(db, {
      name: 'other',
      sshUrl: 'git@github.com:acme/other.git',
      githubSlug: 'acme/other',
      defaultBaseBranch: 'trunk',
    });
    writePrivateKey(config, other.id, PRIVATE_KEY);

    const { status, body } = await create({ repositoryId: other.id });

    assert.equal(status, 201);
    const stored = getSession(db, body.session.id);
    assert.equal(stored?.baseBranch, 'trunk');
    assert.equal(stored?.prTargetBranch, 'main');
  });

  it('takes the optional fields from the request', async () => {
    const { status, body } = await create({
      baseBranch: 'release',
      prTargetBranch: 'main',
      codeReview: true,
      openPullRequest: true,
      scheduledStartAt: '2030-01-02T03:04:05+02:00',
    });

    assert.equal(status, 201);
    assert.equal(body.session.scheduledStartAt, '2030-01-02T01:04:05.000Z');
    const stored = getSession(db, body.session.id);
    assert.equal(stored?.baseBranch, 'release');
    assert.equal(stored?.prTargetBranch, 'main');
    assert.equal(stored?.codeReview, true);
    assert.equal(stored?.openPullRequest, true);
  });

  it('rejects a PRD that does not parse and creates nothing', async () => {
    const { status, body } = await create({ prd: '# PRD: Nothing\n\nNo stories here.\n' });

    assert.equal(status, 400);
    assert.equal(body.error, 'invalid_prd');
    assert.ok((body.errors ?? []).length > 0);
    for (const error of body.errors ?? []) {
      assert.deepEqual(Object.keys(error).sort(), ['line', 'message']);
    }
    assert.equal(listSessions(db).length, 0);
  });

  it('rejects an empty or oversized PRD and creates nothing', async () => {
    for (const prd of [undefined, '', '   ', 42, 'x'.repeat(200_001)]) {
      const { status, body } = await create({ prd });
      assert.equal(status, 400, String(prd).slice(0, 10));
      assert.equal(body.error, 'invalid_prd');
    }
    assert.equal(listSessions(db).length, 0);
  });

  it('validates the name like POST /api/sessions', async () => {
    for (const name of ['has spaces', 'a'.repeat(61), undefined]) {
      const { status, body } = await create({ name });
      assert.equal(status, 400);
      assert.equal(body.error, 'invalid_session_name');
    }
    const { status } = await create({ prTargetBranch: 'trunk' });
    assert.equal(status, 400);
    assert.equal(listSessions(db).length, 0);
  });

  it('answers 404 for an unknown repository', async () => {
    const { status, body } = await create({ repositoryId: 'nope' });

    assert.equal(status, 404);
    assert.equal(body.error, 'repository_not_found');
    assert.equal(listSessions(db).length, 0);
  });

  it('refuses a name already used in the repository', async () => {
    await create();

    const { status, body } = await create();

    assert.equal(status, 409);
    assert.equal(body.error, 'session_name_taken');
    assert.equal(listSessions(db).length, 1);
  });

  it('is blocked until Claude Code is signed in', async () => {
    // No account at all is the one state the cached status probe cannot hide.
    for (const account of listClaudeAccounts(db)) deleteClaudeAccount(db, account.id);

    let result: Awaited<ReturnType<typeof create>>;
    try {
      result = await create();
    } finally {
      addClaudeAccount(config, db);
    }
    const { status, body } = result;

    assert.equal(status, 409);
    assert.equal(body.error, 'claude_not_authenticated');
    assert.equal(listSessions(db).length, 0);
  });

  it('keeps the PRD through a failed setup and writes it on a successful retry', async () => {
    gitExit['check-branch'] = { exitCode: 0, stdout: 'abc\trefs/heads/chief/add-login\n' };

    const { status, body } = await create();

    assert.equal(status, 201);
    assert.equal(body.setup.ok, false);
    assert.match(body.setup.message, /already exists on origin/);
    assert.equal(body.prdWritten, false);
    assert.equal(body.session.status, 'pending');
    assert.equal(prdOnDisk(body.session.id), null);
    assert.equal(getSession(db, body.session.id)?.pendingPrd, PRD);

    gitExit = {};
    const retry = await fetch(`${baseUrl}/api/sessions/${body.session.id}/setup`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { setup: { ok: boolean } }).setup.ok, true);

    assert.equal(prdOnDisk(body.session.id), PRD);
    const stored = getSession(db, body.session.id);
    assert.equal(stored?.pendingPrd, null);
    assert.equal(stored?.status, 'pending');
  });

  it('can be marked ready afterwards like any session', async () => {
    const { body } = await create();

    const response = await fetch(`${baseUrl}/api/sessions/${body.session.id}/ready`, {
      method: 'POST',
      headers: { cookie },
    });
    const ready = (await response.json()) as { ok: boolean; session: { status: string } };

    assert.equal(response.status, 200);
    assert.equal(ready.ok, true);
    assert.equal(ready.session.status, 'ready');
  });

  it('builds the url from PUBLIC_URL when it is set', async () => {
    const other = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, PUBLIC_URL: 'https://chief.example.com/' });
    const { sessionUrl } = await import('./sessions.js');
    const req = { protocol: 'http', get: () => 'ignored:1' } as unknown as Parameters<typeof sessionUrl>[1];

    assert.equal(sessionUrl(other, req, 'abc'), 'https://chief.example.com/sessions/abc');
  });

  it('requires the bearer token', async () => {
    const response = await fetch(`${baseUrl}/api/agent/sessions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryId: repository.id, name: 'add-login', prd: PRD }),
    });

    assert.equal(response.status, 401);
    assert.equal(listSessions(db).length, 0);
  });
});
