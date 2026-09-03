import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  failSession,
  getSession,
  IN_MEMORY,
  openDatabase,
  type Session,
  setSetting,
  syncStories,
  updateSession,
} from '../db/index.js';
import type { ExecOutput } from '../docker/index.js';
import type { SessionContainerView } from '../orchestrator/index.js';

const PASSWORD = 'correct horse battery staple';
const TOKEN = 'ghp_exampleTokenValue1234';

interface DeliveryBody {
  ok: boolean;
  status: string;
  prUrl: string | null;
  adopted: boolean;
  code: string;
  message: string;
  stderr: string;
}

interface ErrorBody {
  error: string;
  message?: string;
}

describe('delivery api', () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;
  let github: http.Server;
  let session: Session;
  /** What the push inside the session container answers with. */
  let push: ExecOutput = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  /** Open pull requests the stub GitHub knows about. */
  let openPulls: unknown[] = [];
  let posted: unknown[] = [];

  const retry = (): Promise<Response> =>
    fetch(`${baseUrl}/api/sessions/${session.id}/delivery`, {
      method: 'POST',
      headers: { cookie },
    });

  before(async () => {
    github = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(openPulls));
          return;
        }
        posted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ number: 7, html_url: 'https://github.com/acme/demo/pull/7', state: 'open' }),
        );
      });
    });
    github.listen(0, '127.0.0.1');
    await new Promise((resolve) => github.once('listening', resolve));

    const config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      GITHUB_API_URL: `http://127.0.0.1:${(github.address() as AddressInfo).port}`,
    });

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
      status: 'failed',
    });
    setSetting(db, 'github_token', TOKEN);

    const app = createApp(config, createAuthService(config, db), db, {
      orchestrator: {
        start: (): Promise<SessionContainerView> =>
          Promise.resolve({
            id: 'container-1',
            name: 'chief-web-add-login',
            running: true,
            state: 'running',
          }),
        remove: (): Promise<void> => Promise.resolve(),
      },
      exec: { runExec: (): Promise<ExecOutput> => Promise.resolve(push) },
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
    await new Promise((resolve) => github.close(resolve));
    closeDatabase(db);
  });

  beforeEach(() => {
    push = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    openPulls = [];
    posted = [];
    updateSession(db, session.id, { status: 'failed', prUrl: null, lastError: 'push failed' });
    failSession(db, session.id, 'push', 'push failed');
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'Only story', priority: 1, status: 'done' },
    ]);
  });

  it('requires a session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/delivery`, {
      method: 'POST',
    });
    assert.equal(response.status, 401);
  });

  it('pushes, opens the pull request and leaves the session pr-open', async () => {
    const response = await retry();
    assert.equal(response.status, 200);

    const body = (await response.json()) as DeliveryBody;
    assert.equal(body.ok, true);
    assert.equal(body.status, 'pr-open');
    assert.equal(body.prUrl, 'https://github.com/acme/demo/pull/7');
    assert.equal(body.adopted, false);
    assert.deepEqual(posted, [
      {
        title: 'add-login',
        body: (posted[0] as { body: string }).body,
        head: 'chief/add-login',
        base: 'main',
        draft: true,
      },
    ]);

    const stored = getSession(db, session.id);
    assert.equal(stored?.status, 'pr-open');
    assert.equal(stored?.prUrl, 'https://github.com/acme/demo/pull/7');
  });

  it('adopts an open pull request instead of creating a second one', async () => {
    openPulls = [{ number: 3, html_url: 'https://github.com/acme/demo/pull/3', state: 'open' }];

    const body = (await (await retry()).json()) as DeliveryBody;
    assert.equal(body.ok, true);
    assert.equal(body.adopted, true);
    assert.equal(body.prUrl, 'https://github.com/acme/demo/pull/3');
    assert.deepEqual(posted, []);
  });

  it('answers 200 with git stderr when the push fails, and stays failed', async () => {
    push = { exitCode: 128, stdout: '', stderr: 'Permission denied (publickey).', timedOut: false };

    const response = await retry();
    assert.equal(response.status, 200);
    const body = (await response.json()) as DeliveryBody;
    assert.equal(body.ok, false);
    assert.equal(body.code, 'push_failed');
    assert.match(body.stderr, /Permission denied/);
    assert.equal(getSession(db, session.id)?.status, 'failed');
  });

  it('is 409 while a story is still outstanding', async () => {
    syncStories(db, session.id, [
      { storyId: 'US-001', title: 'Only story', priority: 1, status: 'todo' },
    ]);

    const response = await retry();
    assert.equal(response.status, 409);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error, 'session_not_complete');
  });

  it('retries only the delivery when that is the stage that failed (US-019)', async () => {
    // Nothing here stands in for Claude Code: a delivery retry never runs an
    // agent, so it must not be blocked on credentials it does not use.
    const response = await fetch(`${baseUrl}/api/sessions/${session.id}/retry`, {
      method: 'POST',
      headers: { cookie },
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      action: string;
      stage: string;
      ok: boolean;
      prUrl: string | null;
      delivery: DeliveryBody | null;
      build: unknown;
    };
    assert.equal(body.action, 'delivery');
    assert.equal(body.stage, 'push');
    assert.equal(body.ok, true);
    assert.equal(body.build, null);
    assert.equal(body.delivery?.code, 'ok');
    assert.equal(body.prUrl, 'https://github.com/acme/demo/pull/7');

    const stored = getSession(db, session.id);
    assert.equal(stored?.status, 'pr-open');
    assert.equal(stored?.failureStage, null);
  });

  it('is 404 for a session that does not exist', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/nope/delivery`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as ErrorBody).error, 'session_not_found');
  });
});
