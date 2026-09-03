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
  deleteSetting,
  IN_MEMORY,
  listSessions,
  openDatabase,
  type Repository,
  setSetting,
  updateSession,
} from '../db/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';
import type { ReadyResult, SessionView, SetupResult } from '../sessions/index.js';
import { sessionPrdFile, setupScript } from '../sessions/index.js';
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
    assert.equal(body.session.codeReview, false);
    assert.deepEqual(started, [body.session.id]);
    assert.deepEqual(removed, []);
  });

  it('accepts the code review flag on create and toggles it afterwards', async () => {
    const { body } = await create({ codeReview: true });
    assert.equal(body.session.codeReview, true);

    const off = await call('PUT', `/api/sessions/${body.session.id}/code-review`, {
      codeReview: false,
    });
    assert.equal(off.status, 200);
    assert.equal(((await off.json()) as SessionView).codeReview, false);

    // It is on every session payload, not just the one the write answered with.
    const fetched = await call('GET', `/api/sessions/${body.session.id}`);
    assert.equal(((await fetched.json()) as SessionView).codeReview, false);
  });

  it('applies the global default when the create request does not say (US-004)', async () => {
    setSetting(db, 'code_review_default', '1');
    try {
      // No `codeReview` field at all: the server, not the web form, is what
      // applies the default, so an API-created session gets it too.
      const on = await create({ name: 'default-on' });
      assert.equal(on.body.session.codeReview, true);

      // An explicit false still wins over a default of on.
      const off = await create({ name: 'default-overridden', codeReview: false });
      assert.equal(off.body.session.codeReview, false);
    } finally {
      deleteSetting(db, 'code_review_default');
    }
  });

  it('rejects a code review flag that is not a boolean', async () => {
    const { body } = await create();

    const response = await call('PUT', `/api/sessions/${body.session.id}/code-review`, {
      codeReview: 'yes',
    });

    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as ErrorBody).error, 'invalid_code_review');
  });

  it('refuses to change the code review flag of a finished session', async () => {
    const { body } = await create();
    updateSession(db, body.session.id, { status: 'finished' });

    const response = await call('PUT', `/api/sessions/${body.session.id}/code-review`, {
      codeReview: true,
    });

    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as ErrorBody).error, 'code_review_locked');
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

  it('deletes a session, its container and its workspace', async () => {
    const { body } = await create();
    const id = body.session.id;
    fs.mkdirSync(path.join(config.workspacesDir, id, 'repo'), { recursive: true });

    const response = await call('DELETE', `/api/sessions/${id}`);

    assert.equal(response.status, 204);
    assert.deepEqual(removed, [id]);
    assert.equal(fs.existsSync(path.join(config.workspacesDir, id)), false);
    assert.deepEqual(listSessions(db), []);

    const gone = await call('DELETE', `/api/sessions/${id}`);
    assert.equal(gone.status, 404);
    assert.equal(((await gone.json()) as ErrorBody).error, 'session_not_found');
  });

  it('reports the story progress of every session', async () => {
    const { body } = await create();
    const id = body.session.id;
    // Nothing has been parsed yet, so there is no progress to report.
    assert.deepEqual(body.session.stories, { total: 0, done: 0 });

    writePrd(id, 'add-login', PRD);
    await call('POST', `/api/sessions/${id}/ready`);

    const listed = (await (await call('GET', '/api/sessions')).json()) as {
      sessions: SessionView[];
    };
    // The PRD has US-001 todo and US-002 done.
    assert.deepEqual(listed.sessions[0]?.stories, { total: 2, done: 1 });
  });

  it('marks a session ready, lists its stories and sends it back to planning', async () => {
    const { body } = await create();
    const id = body.session.id;
    writePrd(id, 'add-login', PRD);

    const marked = await call('POST', `/api/sessions/${id}/ready`);
    const readied = (await marked.json()) as ReadyResult;

    assert.equal(marked.status, 200);
    assert.equal(readied.ok, true);
    assert.equal(readied.session.status, 'ready');
    assert.deepEqual(
      readied.stories.map((story) => [story.storyId, story.priority, story.status]),
      [
        ['US-001', 1, 'todo'],
        ['US-002', 2, 'done'],
      ],
    );

    const listed = (await (await call('GET', `/api/sessions/${id}/stories`)).json()) as {
      stories: ReadyResult['stories'];
    };
    assert.equal(listed.stories.length, 2);
    assert.equal(listed.stories[0]?.title, 'Add the form');

    const back = await call('DELETE', `/api/sessions/${id}/ready`);
    assert.equal(back.status, 200);
    assert.equal(((await back.json()) as ReadyResult).session.status, 'pending');
  });

  it('answers 200 with the parse errors when the PRD is not usable', async () => {
    const { body } = await create();
    const id = body.session.id;
    writePrd(id, 'add-login', '### US-001: First\n**Priority:** later\n\n- [ ] Ships\n');

    const response = await call('POST', `/api/sessions/${id}/ready`);
    const result = (await response.json()) as ReadyResult;

    assert.equal(response.status, 200);
    assert.equal(result.ok, false);
    assert.equal(result.session.status, 'pending');
    assert.equal(result.prd.errors[0]?.line, 2);
    assert.match(result.prd.errors[0]?.message ?? '', /invalid priority "later"/);
  });

  it('refuses to send a pending session back to planning', async () => {
    const { body } = await create();

    const response = await call('DELETE', `/api/sessions/${body.session.id}/ready`);

    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as ErrorBody).error, 'session_not_ready');
  });

  it('sets, changes and clears a schedule while a session is pending', async () => {
    const { body } = await create();
    const id = body.session.id;

    const set = await call('PUT', `/api/sessions/${id}/schedule`, {
      scheduledStartAt: '2026-09-01T10:30:00+02:00',
    });
    assert.equal(set.status, 200);
    const scheduled = (await set.json()) as SessionView;
    assert.equal(scheduled.scheduledStartAt, '2026-09-01T08:30:00.000Z');
    assert.equal(scheduled.scheduleMissed, false);

    const moved = await call('PUT', `/api/sessions/${id}/schedule`, {
      scheduledStartAt: '2026-09-02T08:30:00.000Z',
    });
    assert.equal(
      ((await moved.json()) as SessionView).scheduledStartAt,
      '2026-09-02T08:30:00.000Z',
    );

    const cleared = await call('PUT', `/api/sessions/${id}/schedule`, { scheduledStartAt: null });
    assert.equal(((await cleared.json()) as SessionView).scheduledStartAt, null);
  });

  it('reports a schedule that passed while the session was still pending as missed', async () => {
    const { body } = await create();
    const id = body.session.id;

    await call('PUT', `/api/sessions/${id}/schedule`, {
      scheduledStartAt: '2020-01-01T00:00:00.000Z',
    });

    const response = await call('GET', `/api/sessions/${id}`);
    const session = (await response.json()) as SessionView;
    assert.equal(session.scheduleMissed, true);
    assert.equal(session.status, 'pending');
  });

  it('rejects a schedule that is neither a timestamp nor null', async () => {
    const { body } = await create();
    const id = body.session.id;

    const bad = await call('PUT', `/api/sessions/${id}/schedule`, {
      scheduledStartAt: 'next tuesday',
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as ErrorBody).error, 'invalid_scheduled_start');

    // Omitting the field is a mistake, not "leave it alone".
    const missing = await call('PUT', `/api/sessions/${id}/schedule`, {});
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as ErrorBody).message ?? '', /send null to clear/);
  });

  it('answers 404 when scheduling an unknown session', async () => {
    const response = await call('PUT', '/api/sessions/nope/schedule', { scheduledStartAt: null });

    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as ErrorBody).error, 'session_not_found');
  });

  it('answers 404 for the stories of an unknown session', async () => {
    const response = await call('GET', '/api/sessions/nope/stories');

    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as ErrorBody).error, 'session_not_found');
  });

  /** Puts a PRD where the session's clone keeps it. */
  function writePrd(sessionId: string, name: string, content: string): void {
    const file = sessionPrdFile(config, { id: sessionId, name });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
});

const PRD = `### US-001: Add the form
**Status:** todo
**Priority:** 1

- [ ] The form has an email and a password field

### US-002: Rate limit it
**Status:** done
**Priority:** 2

- [x] Five attempts per minute
`;
