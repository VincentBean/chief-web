import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { closeDatabase, getSetting, IN_MEMORY, openDatabase } from '../db/index.js';
import { parseCookieHeader, serializeCookie } from './cookies.js';
import { generatePassword, hashPassword, secretsMatch, verifyPasswordHash } from './password.js';
import { deriveSigningKey, issueSessionToken, verifySessionToken } from './session.js';
import { createAuthService, SESSION_COOKIE } from './service.js';

describe('password hashing', () => {
  it('verifies a password against its own hash', () => {
    const hash = hashPassword('s3cret');

    assert.ok(verifyPasswordHash('s3cret', hash));
    assert.equal(verifyPasswordHash('s3cre', hash), false);
    assert.equal(verifyPasswordHash('', hash), false);
  });

  it('salts each hash, so the same password hashes differently', () => {
    assert.notEqual(hashPassword('same'), hashPassword('same'));
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    for (const stored of ['', 'nonsense', 'bcrypt$1$2$3$4$5', 'scrypt$a$b$c$d$e']) {
      assert.equal(verifyPasswordHash('s3cret', stored), false);
    }
  });

  it('compares plaintext secrets of differing length safely', () => {
    assert.ok(secretsMatch('abc', 'abc'));
    assert.equal(secretsMatch('abc', 'abcd'), false);
  });

  it('generates distinct URL-safe passwords', () => {
    const password = generatePassword();

    assert.match(password, /^[A-Za-z0-9_-]{16,}$/);
    assert.notEqual(password, generatePassword());
  });
});

describe('session tokens', () => {
  const key = deriveSigningKey('secret', 'fingerprint');

  it('round-trips a freshly issued token', () => {
    assert.ok(verifySessionToken(key, issueSessionToken(key, 60_000)));
  });

  it('rejects expired tokens', () => {
    const token = issueSessionToken(key, 1_000, 0);

    assert.equal(verifySessionToken(key, token, 2_000), false);
  });

  it('rejects tokens signed with another key', () => {
    const token = issueSessionToken(key, 60_000);

    assert.equal(verifySessionToken(deriveSigningKey('secret', 'other'), token), false);
    assert.equal(verifySessionToken(deriveSigningKey('other', 'fingerprint'), token), false);
  });

  it('rejects tampered payloads and malformed tokens', () => {
    const token = issueSessionToken(key, 60_000);
    const [version, expiresAt, signature] = token.split('.');

    assert.equal(verifySessionToken(key, `${version}.${Number(expiresAt) + 1}.${signature}`), false);
    assert.equal(verifySessionToken(key, 'v2.1.2'), false);
    assert.equal(verifySessionToken(key, 'garbage'), false);
    assert.equal(verifySessionToken(key, ''), false);
  });
});

describe('cookies', () => {
  it('parses a cookie header', () => {
    assert.deepEqual(parseCookieHeader('a=1; b=two%20words'), { a: '1', b: 'two words' });
    assert.deepEqual(parseCookieHeader(undefined), {});
    assert.deepEqual(parseCookieHeader('broken'), {});
  });

  it('serializes attributes', () => {
    const cookie = serializeCookie('x', 'y', { httpOnly: true, secure: true, maxAge: 60 });

    assert.match(cookie, /^x=y; Path=\/; Max-Age=60; Expires=.+; SameSite=Lax; HttpOnly; Secure$/);
  });
});

describe('shared password resolution', () => {
  it('generates and persists a hash when CHIEF_WEB_PASSWORD is unset', () => {
    const db = openDatabase(IN_MEMORY);
    try {
      const auth = createAuthService(loadConfig({}), db);
      const hash = getSetting(db, 'password_hash');

      assert.ok(hash, 'expected the generated hash to be persisted');
      assert.ok(getSetting(db, 'session_secret'), 'expected a session secret to be persisted');
      // The generated password is only ever logged, so verify via the hash.
      assert.equal(auth.verifyPassword('not the generated one'), false);

      // A second boot must reuse the stored hash rather than regenerate it.
      createAuthService(loadConfig({}), db);
      assert.equal(getSetting(db, 'password_hash'), hash);
    } finally {
      closeDatabase(db);
    }
  });

  it('lets CHIEF_WEB_PASSWORD take precedence over a stored hash', () => {
    const db = openDatabase(IN_MEMORY);
    try {
      createAuthService(loadConfig({}), db);
      const stored = getSetting(db, 'password_hash');

      const auth = createAuthService(loadConfig({ CHIEF_WEB_PASSWORD: 'from-env' }), db);

      assert.ok(auth.verifyPassword('from-env'));
      // The stored hash is left untouched, so clearing the env var restores it.
      assert.equal(getSetting(db, 'password_hash'), stored);
    } finally {
      closeDatabase(db);
    }
  });

  it('invalidates cookies issued under a different password', () => {
    const db = openDatabase(IN_MEMORY);
    try {
      const before = createAuthService(loadConfig({ CHIEF_WEB_PASSWORD: 'one' }), db);
      const cookie = before.sessionCookie().split(';')[0] ?? '';

      const after = createAuthService(loadConfig({ CHIEF_WEB_PASSWORD: 'two' }), db);

      assert.ok(before.isAuthenticated({ headers: { cookie } }));
      assert.equal(after.isAuthenticated({ headers: { cookie } }), false);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('page authentication', () => {
  const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-'));
  const db = openDatabase(IN_MEMORY);
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let cookie: string;

  before(async () => {
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>chief</title>');
    fs.writeFileSync(path.join(webRoot, 'app.js'), 'export {};');

    const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', WEB_ROOT: webRoot });
    const auth = createAuthService(config, db);
    cookie = auth.sessionCookie().split(';')[0] ?? '';

    server = createApp(config, auth).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  it('redirects unauthenticated page requests to /login', async () => {
    for (const target of ['/', '/sessions/42']) {
      const response = await fetch(`${baseUrl}${target}`, { redirect: 'manual' });

      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/login');
    }
  });

  it('serves /login without a cookie', async () => {
    const response = await fetch(`${baseUrl}/login`, { redirect: 'manual' });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>chief<\/title>/);
  });

  it('serves static assets without a cookie so the login page can boot', async () => {
    const response = await fetch(`${baseUrl}/app.js`, { redirect: 'manual' });

    assert.equal(response.status, 200);
  });

  it('serves pages to an authenticated visitor', async () => {
    const response = await fetch(`${baseUrl}/sessions/42`, {
      headers: { cookie },
      redirect: 'manual',
    });

    assert.equal(response.status, 200);
  });

  it('names the cookie consistently', () => {
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  });
});
