import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import {
  closeDatabase,
  createClaudeAccount,
  type Database,
  getClaudeAccount,
  IN_MEMORY,
  listClaudeAccounts,
  openDatabase,
} from '../db/index.js';
import { claudeAccountDir } from '../runner/index.js';
import { getDefaultClaudeAccount } from '../settings/index.js';
import { addClaudeAccount, importLegacyClaudeAuth, removeClaudeAccount } from './accounts.js';

const CREDENTIALS = JSON.stringify({ claudeAiOauth: { accessToken: 'token' } });
const CLAUDE_JSON = JSON.stringify({ hasCompletedOnboarding: true, projects: {} });

describe('claude account directories', () => {
  let db: Database;
  let root: string;
  let config: { dataDir: string; claudeAuthDir: string };

  before(() => {
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    db.exec('DELETE FROM claude_accounts');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
    config = { dataDir: path.join(root, 'data'), claudeAuthDir: path.join(root, 'claude-auth') };
  });

  afterEach(() => {
    mock.restoreAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const modeOf = (target: string) => fs.statSync(target).mode & 0o777;

  const writeLegacyLogin = () => {
    fs.mkdirSync(path.join(config.claudeAuthDir, 'projects', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(config.claudeAuthDir, '.credentials.json'), CREDENTIALS);
    fs.writeFileSync(path.join(config.claudeAuthDir, '.claude.json'), CLAUDE_JSON);
    fs.writeFileSync(path.join(config.claudeAuthDir, 'projects', 'workspace', 'a.jsonl'), '{}\n');
  };

  it('puts an account directory under <DATA_DIR>/claude-accounts/<id>', () => {
    assert.equal(
      claudeAccountDir({ dataDir: '/data' }, 'abc123'),
      '/data/claude-accounts/abc123',
    );
  });

  it('creates the directory with mode 0700 together with the row', () => {
    const account = addClaudeAccount(config, db, { nickname: 'Work' });
    const dir = claudeAccountDir(config, account.id);

    assert.ok(getClaudeAccount(db, account.id));
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(modeOf(dir), 0o700);
  });

  it('removes the directory together with the row', () => {
    const account = addClaudeAccount(config, db);
    const dir = claudeAccountDir(config, account.id);
    fs.writeFileSync(path.join(dir, '.credentials.json'), CREDENTIALS);

    assert.equal(removeClaudeAccount(config, db, account.id), true);
    assert.equal(getClaudeAccount(db, account.id), null);
    assert.equal(fs.existsSync(dir), false);
  });

  it('still deletes the row when the directory cannot be removed', () => {
    const account = addClaudeAccount(config, db);
    mock.method(fs, 'rmSync', () => {
      throw new Error('EBUSY');
    });

    assert.equal(removeClaudeAccount(config, db, account.id), true);
    assert.equal(getClaudeAccount(db, account.id), null);
  });

  it('reports false for an unknown account', () => {
    assert.equal(removeClaudeAccount(config, db, 'missing'), false);
  });

  describe('legacy import', () => {
    it('copies the whole legacy directory into a first account', () => {
      writeLegacyLogin();

      const account = importLegacyClaudeAuth(config, db);

      assert.ok(account);
      assert.equal(account.nickname, null);
      assert.equal(account.position, 1);
      assert.deepEqual(listClaudeAccounts(db), [account]);
      // It is the login every launch used until now: the explicit default.
      assert.deepEqual(getDefaultClaudeAccount(db), { id: account.id, explicit: true });

      const dir = claudeAccountDir(config, account.id);
      assert.equal(modeOf(dir), 0o700);
      assert.equal(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'), CREDENTIALS);
      assert.equal(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'), CLAUDE_JSON);
      assert.equal(fs.readFileSync(path.join(dir, 'projects', 'workspace', 'a.jsonl'), 'utf8'), '{}\n');

      // The legacy directory is left exactly as it was.
      assert.equal(
        fs.readFileSync(path.join(config.claudeAuthDir, '.credentials.json'), 'utf8'),
        CREDENTIALS,
      );
      assert.equal(
        fs.readFileSync(path.join(config.claudeAuthDir, '.claude.json'), 'utf8'),
        CLAUDE_JSON,
      );
    });

    it('runs only once', () => {
      writeLegacyLogin();

      assert.ok(importLegacyClaudeAuth(config, db));
      assert.equal(importLegacyClaudeAuth(config, db), null);
      assert.equal(listClaudeAccounts(db).length, 1);
    });

    it('skips when accounts already exist', () => {
      writeLegacyLogin();
      const existing = createClaudeAccount(db, { nickname: 'Existing' });

      assert.equal(importLegacyClaudeAuth(config, db), null);
      assert.deepEqual(listClaudeAccounts(db), [existing]);
    });

    it('skips when the legacy directory has no credentials', () => {
      fs.mkdirSync(config.claudeAuthDir, { recursive: true });
      fs.writeFileSync(path.join(config.claudeAuthDir, '.claude.json'), CLAUDE_JSON);

      assert.equal(importLegacyClaudeAuth(config, db), null);
      assert.deepEqual(listClaudeAccounts(db), []);
    });

    it('skips when there is no legacy directory at all', () => {
      assert.equal(importLegacyClaudeAuth(config, db), null);
      assert.deepEqual(listClaudeAccounts(db), []);
    });

    it('leaves no account behind when the copy fails', () => {
      writeLegacyLogin();
      mock.method(fs, 'cpSync', () => {
        throw new Error('ENOSPC');
      });

      assert.equal(importLegacyClaudeAuth(config, db), null);
      assert.deepEqual(listClaudeAccounts(db), []);
      assert.deepEqual(fs.readdirSync(path.join(config.dataDir, 'claude-accounts')), []);
    });
  });
});
