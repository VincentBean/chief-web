import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Request, Response } from 'express';

import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  type Database,
  deleteClaudeAccount,
  deleteSetting,
  getClaudeAccount,
  IN_MEMORY,
  listClaudeAccounts,
  openDatabase,
} from '../db/index.js';
import { DockerApi } from '../docker/index.js';
import { HostPaths } from '../orchestrator/index.js';
import type { CommandResult, CommandRunner } from '../ssh/index.js';
import { TerminalManager } from '../terminal/index.js';
import { addClaudeAccount } from './accounts.js';
import { CLAUDE_NOT_AUTHENTICATED, requireClaudeAuth } from './guard.js';
import { CLAUDE_STATUS_PROBE_CONCURRENCY, ClaudeService } from './service.js';

const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });

function loggedIn(email: string): string {
  return JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    email,
    orgName: 'Example Inc',
    subscriptionType: 'max',
  });
}

/** The account directory a probe mounted, i.e. which account it checked. */
function probedAccount(args: readonly string[]): string {
  const bind = args[args.indexOf('--volume') + 1] ?? '';
  return path.basename(bind.split(':')[0] ?? '');
}

describe('claude service: per-account status', () => {
  let dataDir: string;
  let config: Config;
  let db: Database;
  let service: ClaudeService;
  /** Accounts whose probe answers "signed in", by id → email. */
  let signedIn: Map<string, string>;
  /** Every probe, by account id. */
  let probes: string[];
  let inFlight: number;
  let maxInFlight: number;
  /** Lets a test hold every probe open until it resolves this. */
  let gate: Promise<void>;

  const run: CommandRunner = async (_command, args): Promise<CommandResult> => {
    // `docker rm -f` of a login container.
    if (args[0] !== 'run') return { code: 0, stdout: '', stderr: '', timedOut: false };
    const account = probedAccount(args);
    probes.push(account);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight -= 1;
    const email = signedIn.get(account);
    return {
      code: email === undefined ? 1 : 0,
      stdout: email === undefined ? LOGGED_OUT : loggedIn(email),
      stderr: '',
      timedOut: false,
    };
  };

  const fresh = (cacheMs = 60_000): ClaudeService => {
    config = loadConfig({ DATA_DIR: dataDir, CLAUDE_STATUS_CACHE_MS: String(cacheMs) });
    const terminals = new TerminalManager(new DockerApi(path.join(dataDir, 'no-docker.sock')), {
      scrollbackLines: 10,
      scrollbackBytes: 1000,
      maxTerminals: 1,
    });
    const paths = new HostPaths(config, {
      inspectVolume: (name) => Promise.resolve({ name, mountpoint: dataDir }),
    });
    return new ClaudeService(config, db, terminals, paths, run);
  };

  /** Runs the guard once and says whether it let the request through. */
  const guard = async (): Promise<{ passed: boolean; status: number | null; body: unknown }> => {
    let status: number | null = null;
    let body: unknown = null;
    return new Promise((resolve) => {
      const res = {
        status(code: number) {
          status = code;
          return this;
        },
        json(value: unknown) {
          body = value;
          resolve({ passed: false, status, body });
          return this;
        },
      } as unknown as Response;
      requireClaudeAuth(service)({} as Request, res, () => resolve({ passed: true, status, body }));
    });
  };

  before(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'chief-claude-service-'));
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const account of listClaudeAccounts(db)) deleteClaudeAccount(db, account.id);
    signedIn = new Map();
    probes = [];
    inFlight = 0;
    maxInFlight = 0;
    gate = Promise.resolve();
    service = fresh();
  });

  it('caches each account separately and probes only the one asked for', async () => {
    config = loadConfig({ DATA_DIR: dataDir });
    const a = addClaudeAccount(config, db);
    const b = addClaudeAccount(config, db);
    signedIn.set(a.id, 'a@example.com');

    assert.equal((await service.status(a.id)).authenticated, true);
    assert.equal((await service.status(b.id)).authenticated, false);
    assert.deepEqual(probes, [a.id, b.id]);

    // Both cached now; a forced re-check of one leaves the other alone.
    await service.status(a.id);
    await service.status(b.id);
    await service.status(b.id, true);
    assert.deepEqual(probes, [a.id, b.id, b.id]);
  });

  it('shares one probe between concurrent callers of the same account', async () => {
    const a = addClaudeAccount(config, db);
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));

    const pending = [service.status(a.id), service.status(a.id), service.status(a.id, true)];
    open();
    await Promise.all(pending);

    assert.deepEqual(probes, [a.id]);
  });

  it('re-probes once the cached answer is older than CLAUDE_STATUS_CACHE_MS', async () => {
    service = fresh(0);
    const a = addClaudeAccount(config, db);

    await service.status(a.id);
    await service.status(a.id);

    assert.deepEqual(probes, [a.id, a.id]);
  });

  it('writes the probed profile back onto the account row', async () => {
    const a = addClaudeAccount(config, db);
    signedIn.set(a.id, 'probed@example.com');

    await service.status(a.id);

    const row = getClaudeAccount(db, a.id);
    assert.equal(row?.email, 'probed@example.com');
    assert.equal(row?.organization, 'Example Inc');
    assert.equal(row?.subscription, 'max');
    assert.equal(row?.authMethod, 'claude.ai');
  });

  it('keeps the last known profile when an account is signed out', async () => {
    const a = addClaudeAccount(config, db);
    signedIn.set(a.id, 'was@example.com');
    await service.status(a.id);
    signedIn.delete(a.id);

    const [view] = await service.statuses(true);

    assert.equal(view?.authenticated, false);
    assert.equal(view?.email, 'was@example.com');
  });

  it('lists every account in order, probing at most three at once', async () => {
    const accounts = Array.from({ length: 7 }, () => addClaudeAccount(config, db));
    signedIn.set(accounts[4]?.id ?? '', 'five@example.com');
    let open!: () => void;
    gate = new Promise((resolve) => (open = resolve));

    const pending = service.statuses();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inFlight, CLAUDE_STATUS_PROBE_CONCURRENCY);
    open();
    const views = await pending;

    assert.equal(CLAUDE_STATUS_PROBE_CONCURRENCY, 3);
    assert.equal(maxInFlight, 3);
    assert.deepEqual(
      views.map((view) => view.id),
      accounts.map((account) => account.id),
    );
    assert.deepEqual(
      views.map((view) => view.authenticated),
      [false, false, false, false, true, false, false],
    );
    assert.equal(views[4]?.email, 'five@example.com');
    assert.equal(views[4]?.usage, null);
  });

  it('ending a login re-probes only that account', async () => {
    const a = addClaudeAccount(config, db);
    const b = addClaudeAccount(config, db);
    await service.statuses();
    signedIn.set(a.id, 'a@example.com');

    const stopped = await service.stopLogin(a.id);
    await service.statuses();

    assert.equal(stopped.status?.authenticated, true);
    assert.equal(stopped.account?.email, 'a@example.com');
    assert.deepEqual(probes, [a.id, b.id, a.id]);
  });

  it('answers 404 for an account that does not exist', async () => {
    await assert.rejects(service.status('ffffffffffffffff'), { code: 'claude_account_not_found' });
  });

  it('blocks a launch when there is no account at all', async () => {
    const result = await guard();

    assert.equal(result.passed, false);
    assert.equal(result.status, 409);
    const body = result.body as { error: string; message: string };
    assert.equal(body.error, CLAUDE_NOT_AUTHENTICATED);
    assert.match(body.message, /add an account in Settings/i);
    assert.deepEqual(probes, []);
  });

  it('blocks a launch when no account is signed in', async () => {
    addClaudeAccount(config, db);
    addClaudeAccount(config, db);

    const result = await guard();

    assert.equal(result.passed, false);
    assert.equal(result.status, 409);
  });

  it('lets a launch through when one account is signed in', async () => {
    addClaudeAccount(config, db);
    const b = addClaudeAccount(config, db);
    signedIn.set(b.id, 'b@example.com');

    const result = await guard();

    assert.equal(result.passed, true);
  });

  it('resolves the implicit default to the first signed-in account, and follows a sign-out (US-007)', async () => {
    service = fresh(0);
    const a = addClaudeAccount(config, db);
    const b = addClaudeAccount(config, db);
    signedIn.set(a.id, 'a@example.com');
    signedIn.set(b.id, 'b@example.com');

    let state = await service.state();
    assert.equal(state.defaultAccountId, a.id);
    assert.equal(state.defaultIsExplicit, false);

    // The CLI now says `a` is signed out: the default moves on to `b`.
    signedIn.delete(a.id);
    state = await service.state();
    assert.equal(state.defaultAccountId, b.id);
    assert.equal(state.defaultIsExplicit, false);
    assert.equal(getClaudeAccount(db, a.id)?.authMethod, null);
    // The profile stays for display.
    assert.equal(getClaudeAccount(db, a.id)?.email, 'a@example.com');

    service.makeDefault(a.id);
    state = await service.state();
    assert.equal(state.defaultAccountId, a.id);
    assert.equal(state.defaultIsExplicit, true);
    deleteSetting(db, 'default_claude_account_id');
  });

  it('removes the last account even though it is the default (US-006)', async () => {
    config = loadConfig({ DATA_DIR: dataDir });
    const only = addClaudeAccount(config, db);

    await service.remove(only.id);

    assert.equal(getClaudeAccount(db, only.id), null);
    assert.deepEqual((await service.state()).accounts, []);
    assert.equal((await service.state()).defaultAccountId, null);
  });
});
