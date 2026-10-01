import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  createClaudeAccount,
  type Database,
  deleteClaudeAccount,
  getClaudeAccount,
  IN_MEMORY,
  listClaudeAccounts,
  openDatabase,
  updateClaudeAccount,
} from './index.js';

describe('claude accounts', () => {
  let db: Database;

  before(() => {
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    db.exec('DELETE FROM claude_accounts');
  });

  it('creates an account with a URL-safe id and null profile fields', () => {
    const account = createClaudeAccount(db);

    assert.match(account.id, /^[0-9a-f]{16}$/);
    assert.equal(account.nickname, null);
    assert.equal(account.email, null);
    assert.equal(account.organization, null);
    assert.equal(account.subscription, null);
    assert.equal(account.authMethod, null);
    assert.equal(account.position, 1);
    assert.equal(account.createdAt, account.updatedAt);
    assert.deepEqual(getClaudeAccount(db, account.id), account);
  });

  it('gives every account its own id', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createClaudeAccount(db).id));
    assert.equal(ids.size, 20);
  });

  it('stores the fields it is given', () => {
    const account = createClaudeAccount(db, {
      nickname: 'Work',
      email: 'alice@example.com',
      organization: 'Example Inc',
      subscription: 'max',
      authMethod: 'claude.ai',
      position: 7,
    });

    assert.deepEqual(getClaudeAccount(db, account.id), {
      ...account,
      nickname: 'Work',
      email: 'alice@example.com',
      organization: 'Example Inc',
      subscription: 'max',
      authMethod: 'claude.ai',
      position: 7,
    });
  });

  it('places a new account after the last one', () => {
    createClaudeAccount(db, { position: 4 });
    assert.equal(createClaudeAccount(db).position, 5);
  });

  it('lists accounts in position order', () => {
    const third = createClaudeAccount(db, { nickname: 'third', position: 3 });
    const first = createClaudeAccount(db, { nickname: 'first', position: 1 });
    const second = createClaudeAccount(db, { nickname: 'second', position: 2 });

    assert.deepEqual(
      listClaudeAccounts(db).map((account) => account.id),
      [first.id, second.id, third.id],
    );
  });

  it('returns null for an unknown account', () => {
    assert.equal(getClaudeAccount(db, 'missing'), null);
  });

  it('updates only the fields provided and bumps updated_at', async () => {
    const account = createClaudeAccount(db, { nickname: 'Work', email: 'old@example.com' });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = updateClaudeAccount(db, account.id, {
      email: 'new@example.com',
      subscription: 'pro',
    });

    assert.ok(updated);
    assert.equal(updated.nickname, 'Work');
    assert.equal(updated.email, 'new@example.com');
    assert.equal(updated.subscription, 'pro');
    assert.equal(updated.createdAt, account.createdAt);
    assert.ok(updated.updatedAt > account.updatedAt);
  });

  it('clears a field set to null', () => {
    const account = createClaudeAccount(db, { nickname: 'Work' });
    assert.equal(updateClaudeAccount(db, account.id, { nickname: null })?.nickname, null);
  });

  it('leaves the row alone on an empty patch', () => {
    const account = createClaudeAccount(db);
    assert.deepEqual(updateClaudeAccount(db, account.id, {}), account);
  });

  it('returns null when updating an unknown account', () => {
    assert.equal(updateClaudeAccount(db, 'missing', { nickname: 'x' }), null);
  });

  it('deletes an account', () => {
    const account = createClaudeAccount(db);

    assert.equal(deleteClaudeAccount(db, account.id), true);
    assert.equal(getClaudeAccount(db, account.id), null);
    assert.equal(deleteClaudeAccount(db, account.id), false);
  });
});
