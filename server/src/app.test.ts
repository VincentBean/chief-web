import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from './app.js';
import { createAuthService, SESSION_COOKIE } from './auth/index.js';
import { loadConfig } from './config.js';
import { closeDatabase, type Database, IN_MEMORY, openDatabase } from './db/index.js';

const PASSWORD = 'correct horse battery staple';

describe('api', () => {
  let baseUrl: string;
  let db: Database;
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;

  before(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD });
    db = openDatabase(IN_MEMORY);
    const app = createApp(config, createAuthService(config, db));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  const login = async (password = PASSWORD): Promise<Response> =>
    fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });

  const cookieFrom = (response: Response): string => {
    const header = response.headers.get('set-cookie');
    assert.ok(header, 'expected a Set-Cookie header');
    return header.split(';')[0] ?? '';
  };

  it('GET /api/health returns 200 {"status":"ok"} without a cookie', async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  it('rejects API requests without a session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/auth/session`);

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'unauthorized' });
  });

  it('rejects unknown API routes without a session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);

    assert.equal(response.status, 401);
  });

  it('rejects a wrong password', async () => {
    const response = await login('wrong');

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'invalid_password' });
    assert.equal(response.headers.get('set-cookie'), null);
  });

  it('rejects a missing password', async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
  });

  it('sets an HttpOnly session cookie on successful login', async () => {
    const response = await login();

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authenticated: true });

    const header = response.headers.get('set-cookie') ?? '';
    assert.match(header, new RegExp(`^${SESSION_COOKIE}=`));
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\//);
  });

  it('accepts API requests carrying the session cookie', async () => {
    const cookie = cookieFrom(await login());

    const response = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie } });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authenticated: true });
  });

  it('unknown API routes return a JSON 404 once authenticated', async () => {
    const cookie = cookieFrom(await login());

    const response = await fetch(`${baseUrl}/api/does-not-exist`, { headers: { cookie } });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });

  it('rejects a tampered session cookie', async () => {
    const cookie = cookieFrom(await login());

    const response = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie: `${cookie}tampered` },
    });

    assert.equal(response.status, 401);
  });

  it('logout clears the cookie', async () => {
    const cookie = cookieFrom(await login());

    const response = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie },
    });

    assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie') ?? '';
    assert.match(header, new RegExp(`^${SESSION_COOKIE}=;`));
    assert.match(header, /Max-Age=0/);
  });
});
