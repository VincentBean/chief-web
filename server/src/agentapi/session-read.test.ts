import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  IN_MEMORY,
  openDatabase,
  runMigrations,
  updateSession,
} from '../db/index.js';
import { generateToken } from './index.js';

describe('GET /api/agent/sessions/:id', () => {
  let baseUrl: string;
  let db: Database;
  let server: http.Server;
  let token: string;

  const start = async (publicUrl: string): Promise<void> => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: 'correct horse battery staple', PUBLIC_URL: publicUrl });
    const app = createApp(config, createAuthService(config, db), db);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    token = generateToken(db);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  const read = (id: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }): Promise<Response> =>
    fetch(`${baseUrl}/api/agent/sessions/${encodeURIComponent(id)}`, { headers });

  const seed = (): string => {
    const repository = createRepository(db, { name: 'demo', sshUrl: 'git@github.com:acme/demo.git', githubSlug: 'acme/demo' });
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'add-login',
      baseBranch: 'main',
      prTargetBranch: 'main',
      scheduledStartAt: '2026-10-09T06:00:00.000Z',
      pendingPrd: '# PRD: secret plan',
    });
    updateSession(db, session.id, {
      containerId: 'container-abc123',
      lastError: 'Cloning the repository failed.',
      prUrl: 'https://github.com/acme/demo/pull/7',
      prDescription: 'A description',
    });
    return session.id;
  };

  it('answers the session status and its review url, and nothing else', async () => {
    await start('');
    const id = seed();

    const res = await read(id);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), {
      session: {
        id,
        name: 'add-login',
        status: 'pending',
        branch: 'chief/add-login',
        setupError: 'Cloning the repository failed.',
        scheduledStartAt: '2026-10-09T06:00:00.000Z',
        pullRequestUrl: 'https://github.com/acme/demo/pull/7',
      },
      url: `${baseUrl}/sessions/${id}`,
    });
    for (const leak of ['container-abc123', 'secret plan', 'workspaces', 'A description']) {
      assert.ok(!text.includes(leak), leak);
    }
  });

  it('answers null for a session with no setup error, schedule or pull request', async () => {
    await start('');
    const repository = createRepository(db, { name: 'demo', sshUrl: 'git@github.com:acme/demo.git', githubSlug: 'acme/demo' });
    const session = createSession(db, {
      repositoryId: repository.id,
      name: 'plain',
      baseBranch: 'main',
      prTargetBranch: 'develop',
    });

    const body = (await (await read(session.id)).json()) as { session: Record<string, unknown> };
    assert.equal(body.session.setupError, null);
    assert.equal(body.session.scheduledStartAt, null);
    assert.equal(body.session.pullRequestUrl, null);
  });

  it('builds the url from PUBLIC_URL when it is set', async () => {
    await start('https://chief.example.com/');
    const id = seed();

    const body = (await (await read(id)).json()) as { url: string };
    assert.equal(body.url, `https://chief.example.com/sessions/${id}`);
  });

  it('answers 404 session_not_found for an unknown id', async () => {
    await start('');
    const res = await read('00000000-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'session_not_found');
  });

  it('answers 401 without the bearer token', async () => {
    await start('');
    const id = seed();
    const res = await read(id, {});
    assert.equal(res.status, 401);
  });
});
