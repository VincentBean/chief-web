import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  type Database,
  getSetting,
  IN_MEMORY,
  openDatabase,
  runMigrations,
  setSetting,
} from '../db/index.js';
import { generateToken, revokeToken, tokenStatus, verifyToken } from './token.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('agent API token', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(IN_MEMORY);
    runMigrations(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('reports no token before one is generated', () => {
    assert.deepEqual(tokenStatus(db), { configured: false, createdAt: null, lastUsedAt: null });
  });

  it('generates a chief_ token and stores only its SHA-256 digest', () => {
    const token = generateToken(db);

    assert.match(token, /^chief_[A-Za-z0-9_-]{43}$/);
    const hash = getSetting(db, 'agent_api_token_hash');
    assert.equal(hash, createHash('sha256').update(token).digest('hex'));
    assert.notEqual(hash, token);

    const status = tokenStatus(db);
    assert.equal(status.configured, true);
    assert.match(status.createdAt ?? '', ISO_UTC);
    assert.equal(status.lastUsedAt, null);
    assert.deepEqual(Object.keys(status).sort(), ['configured', 'createdAt', 'lastUsedAt']);
  });

  it('generates a different token every time', () => {
    assert.notEqual(generateToken(db), generateToken(db));
  });

  it('verifies the right token and records its last use', () => {
    const token = generateToken(db);

    assert.equal(verifyToken(db, token), true);
    assert.match(tokenStatus(db).lastUsedAt ?? '', ISO_UTC);
  });

  it('rejects a wrong token without recording a use', () => {
    const token = generateToken(db);

    assert.equal(verifyToken(db, `${token.slice(0, -1)}x`), false);
    assert.equal(verifyToken(db, 'chief_nope'), false);
    assert.equal(tokenStatus(db).lastUsedAt, null);
  });

  it('rejects an empty string', () => {
    generateToken(db);

    assert.equal(verifyToken(db, ''), false);
    assert.equal(tokenStatus(db).lastUsedAt, null);
  });

  it('rejects everything when no token is configured', () => {
    assert.equal(verifyToken(db, 'chief_anything'), false);
    assert.equal(verifyToken(db, ''), false);
    assert.equal(getSetting(db, 'agent_api_token_last_used_at'), null);
  });

  it('rejects a token against a corrupted stored hash instead of throwing', () => {
    setSetting(db, 'agent_api_token_hash', 'not-hex');

    assert.equal(verifyToken(db, 'chief_anything'), false);
  });

  it('regenerating replaces the token, so the old one stops verifying', () => {
    const first = generateToken(db);
    assert.equal(verifyToken(db, first), true);

    const second = generateToken(db);

    assert.equal(verifyToken(db, first), false);
    assert.equal(tokenStatus(db).lastUsedAt, null);
    assert.equal(verifyToken(db, second), true);
  });

  it('revoking deletes the hash and both timestamps', () => {
    const token = generateToken(db);
    verifyToken(db, token);

    revokeToken(db);

    assert.equal(getSetting(db, 'agent_api_token_hash'), null);
    assert.equal(getSetting(db, 'agent_api_token_created_at'), null);
    assert.equal(getSetting(db, 'agent_api_token_last_used_at'), null);
    assert.deepEqual(tokenStatus(db), { configured: false, createdAt: null, lastUsedAt: null });
    assert.equal(verifyToken(db, token), false);
  });

  it('revoking with no token configured is a no-op', () => {
    assert.doesNotThrow(() => revokeToken(db));
  });
});
