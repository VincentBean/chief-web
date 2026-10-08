import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { closeDatabase, type Database, getSetting, IN_MEMORY, openDatabase, runMigrations } from '../db/index.js';
import { generateToken, revokeToken } from './index.js';

const PASSWORD = 'correct horse battery staple';
const ATTEMPT_LIMIT = 3;
const UNAUTHORIZED = { error: 'unauthorized', message: 'Missing or invalid API token.' };

describe('agent api bearer guard', () => {
  let baseUrl: string;
  let db: Database;
  let server: http.Server;

  beforeEach(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD, LOGIN_ATTEMPT_LIMIT: String(ATTEMPT_LIMIT) });
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
    const app = createApp(config, createAuthService(config, db), db);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${baseUrl}${path}`, { headers });

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

  const login = async (): Promise<string> => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    assert.ok(cookie !== '', 'logged in');
    return cookie;
  };

  it('answers 401 without an Authorization header', async () => {
    generateToken(db);
    const res = await get('/api/agent/anything');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), UNAUTHORIZED);
  });

  it('answers 401 for a malformed Authorization header', async () => {
    const token = generateToken(db);
    for (const header of [token, `Basic ${token}`, 'Bearer ']) {
      const res = await get('/api/agent/anything', { authorization: header });
      assert.equal(res.status, 401, header);
      assert.deepEqual(await res.json(), UNAUTHORIZED);
    }
  });

  it('answers 401 for a wrong token', async () => {
    generateToken(db);
    const res = await get('/api/agent/anything', bearer('chief_not-the-token'));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), UNAUTHORIZED);
  });

  it('answers 401 with the same body when no token is configured', async () => {
    const res = await get('/api/agent/anything', bearer('chief_whatever'));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), UNAUTHORIZED);
  });

  it('does not accept the login cookie in place of the token', async () => {
    generateToken(db);
    const res = await get('/api/agent/anything', { cookie: await login() });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), UNAUTHORIZED);
  });

  it('lets a valid token through, answering unknown paths with the API 404', async () => {
    const token = generateToken(db);
    const res = await get('/api/agent/no-such-route', bearer(token));
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not_found' });
    assert.notEqual(getSetting(db, 'agent_api_token_last_used_at'), undefined);

    // The same body as an unknown route outside the agent API.
    const other = await get('/api/no-such-route', { cookie: await login() });
    assert.equal(other.status, 404);
    assert.deepEqual(await other.json(), { error: 'not_found' });
  });

  it('rejects a revoked token', async () => {
    const token = generateToken(db);
    assert.equal((await get('/api/agent/x', bearer(token))).status, 404);
    revokeToken(db);
    const res = await get('/api/agent/x', bearer(token));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), UNAUTHORIZED);
  });

  it('rate limits failed attempts with 429, even for the right token', async () => {
    const token = generateToken(db);
    for (let i = 0; i < ATTEMPT_LIMIT; i++) {
      assert.equal((await get('/api/agent/x', bearer('chief_wrong'))).status, 401);
    }
    const res = await get('/api/agent/x', bearer(token));
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.equal(((await res.json()) as { error: string }).error, 'too_many_attempts');
  });

  it('counts its failures apart from failed sign-ins', async () => {
    const token = generateToken(db);
    for (let i = 0; i < ATTEMPT_LIMIT; i++) {
      await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
    }
    assert.equal((await get('/api/agent/x', bearer(token))).status, 404);
  });

  it('clears the failure count after a successful request', async () => {
    const token = generateToken(db);
    for (let i = 0; i < ATTEMPT_LIMIT - 1; i++) {
      await get('/api/agent/x', bearer('chief_wrong'));
    }
    assert.equal((await get('/api/agent/x', bearer(token))).status, 404);
    await get('/api/agent/x', bearer('chief_wrong'));
    assert.equal((await get('/api/agent/x', bearer(token))).status, 404);
  });

  it('rejects a bearer token on cookie-only routes', async () => {
    const token = generateToken(db);
    for (const path of ['/api/sessions', '/api/settings', '/api/settings/agent-token', '/api/no-such-route']) {
      const res = await get(path, bearer(token));
      assert.equal(res.status, 401, path);
    }
    const create = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ repositoryId: 1, name: 'x' }),
    });
    assert.equal(create.status, 401);
  });
});
