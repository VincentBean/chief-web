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
import { createLoginRateLimiter, describeRetryAfter } from './ratelimit.js';
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

describe('login rate limiting', () => {
  const limiter = () => createLoginRateLimiter({ maxAttempts: 3, windowMs: 60_000 });

  it('allows attempts up to the limit and refuses the next one', () => {
    const logins = limiter();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.ok(logins.check('client', 1_000).allowed, `attempt ${attempt} should be allowed`);
      logins.recordFailure('client', 1_000);
    }

    const verdict = logins.check('client', 1_000);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.retryAfterSeconds, 60);
  });

  it('counts each client separately', () => {
    const logins = limiter();

    for (let attempt = 0; attempt < 3; attempt += 1) logins.recordFailure('noisy', 1_000);

    assert.equal(logins.check('noisy', 1_000).allowed, false);
    assert.ok(logins.check('quiet', 1_000).allowed);
  });

  it('lets the window slide off the oldest failure', () => {
    const logins = limiter();

    logins.recordFailure('client', 1_000);
    logins.recordFailure('client', 2_000);
    logins.recordFailure('client', 3_000);
    assert.equal(logins.check('client', 4_000).allowed, false);

    // The first failure has aged out, so one attempt is free again.
    assert.ok(logins.check('client', 61_001).allowed);
  });

  it('counts down the wait as the window slides', () => {
    const logins = limiter();

    for (let attempt = 0; attempt < 3; attempt += 1) logins.recordFailure('client', 1_000);

    assert.equal(logins.check('client', 31_000).retryAfterSeconds, 30);
  });

  it('forgets a client that signs in successfully', () => {
    const logins = limiter();

    for (let attempt = 0; attempt < 3; attempt += 1) logins.recordFailure('client', 1_000);
    logins.clear('client');

    assert.ok(logins.check('client', 1_000).allowed);
  });

  it('evicts the least recently seen client beyond the cap', () => {
    const logins = createLoginRateLimiter({ maxAttempts: 1, windowMs: 60_000, maxKeys: 2 });

    logins.recordFailure('first', 1_000);
    logins.recordFailure('second', 1_100);
    logins.recordFailure('third', 1_200);

    // `first` was pushed out, so it starts over; the two newest are still held.
    assert.ok(logins.check('first', 1_300).allowed);
    assert.equal(logins.check('second', 1_300).allowed, false);
    assert.equal(logins.check('third', 1_300).allowed, false);
  });

  it('describes the wait in whole seconds or minutes', () => {
    assert.equal(describeRetryAfter(1), '1 second');
    assert.equal(describeRetryAfter(45), '45 seconds');
    assert.equal(describeRetryAfter(60), '1 minute');
    assert.equal(describeRetryAfter(61), '2 minutes');
  });
});

describe('login endpoint throttling', () => {
  const db = openDatabase(IN_MEMORY);
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;

  before(async () => {
    const config = loadConfig({
      CHIEF_WEB_PASSWORD: 'pw',
      LOGIN_ATTEMPT_LIMIT: '2',
      LOGIN_ATTEMPT_WINDOW_MS: '60000',
    });

    server = createApp(config, createAuthService(config, db), db).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  const attempt = async (password: string): Promise<Response> =>
    fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });

  // Runs first: it proves a malformed body never uses up an attempt, which the
  // throttling test below then relies on to still have its full limit.
  it('does not count a malformed request against the limit', async () => {
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      assert.equal(response.status, 400);
    }
  });

  it('refuses further attempts with 429 once the limit is spent', async () => {
    assert.equal((await attempt('wrong')).status, 401);
    assert.equal((await attempt('wrong')).status, 401);

    const throttled = await attempt('wrong');
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get('retry-after'), '60');

    const body = (await throttled.json()) as { error: string; message: string };
    assert.equal(body.error, 'too_many_attempts');
    assert.match(body.message, /Try again in 1 minute\./);

    // The throttle holds even for the right password: the limit is on the door,
    // not on the guess.
    assert.equal((await attempt('pw')).status, 429);
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

    server = createApp(config, auth, db).listen(0, '127.0.0.1');
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
