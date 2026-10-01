import assert from 'node:assert/strict';
import type http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { addClaudeAccount } from '../claude/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  type Database,
  getClaudeAccount,
  IN_MEMORY,
  listClaudeAccounts,
  openDatabase,
  updateClaudeAccount,
} from '../db/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import { DockerApi } from '../docker/index.js';
import { claudeAccountDir, RUNNER_CLAUDE_DIR } from '../runner/index.js';
import type { CommandResult, CommandRunner } from '../ssh/index.js';
import { TerminalManager } from '../terminal/index.js';

const PASSWORD = 'correct horse battery staple';
/** Id the fake `docker run` reports, registered in the fake daemon below. */
const LOGIN_CONTAINER = 'login-container-id';

interface AccountStatus {
  id: string;
  nickname: string | null;
  email: string | null;
  organization: string | null;
  subscription: string | null;
  authenticated: boolean;
  error: string | null;
  checkedAt: string;
  usage: null;
}

interface StateBody {
  accounts: AccountStatus[];
  defaultAccountId: string | null;
  login: LoginState;
}

interface LoginState {
  active: boolean;
  accountId: string | null;
  terminalId: string | null;
  containerId: string | null;
  containerName: string | null;
}

/** What starting or ending an account's login answers. */
interface LoginBody {
  account: { id: string; email: string | null } | null;
  status: { authenticated: boolean } | null;
  login: LoginState;
}

describe('claude api', () => {
  let baseUrl: string;
  let cookie: string;
  let config: Config;
  let dataDir: string;
  /** The account every probe and login container mounts. */
  let accountId: string;
  const accountBind = (): string => `${claudeAccountDir(config, accountId)}:${RUNNER_CLAUDE_DIR}`;
  let daemon: FakeDockerDaemon;
  let db: Database;
  let manager: TerminalManager;
  let server: http.Server;

  /** Every `docker` invocation the server made, newest last. */
  let commands: string[][] = [];
  /** What the probe container prints; swapped per test to model a login. */
  let probeStdout = '';
  let probeResult: Partial<CommandResult> = {};

  const runCommand: CommandRunner = (_command, args) => {
    commands.push([...args]);
    if (args.includes('status')) {
      return Promise.resolve({
        code: probeStdout.includes('"loggedIn": true') ? 0 : 1,
        stdout: probeStdout,
        stderr: '',
        timedOut: false,
        ...probeResult,
      });
    }
    if (args[0] === 'run') {
      return Promise.resolve({
        code: 0,
        stdout: `${LOGIN_CONTAINER}\n`,
        stderr: '',
        timedOut: false,
      });
    }
    return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
  };

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const state = async (path = '/api/claude'): Promise<StateBody> =>
    (await (await call('GET', path)).json()) as StateBody;

  /**
   * The probe container is also a `docker run`, so "did we start the login
   * container?" is asked by looking for the detached one.
   */
  const loginRuns = (): string[][] =>
    commands.filter((args) => args[0] === 'run' && args.includes('--detach'));

  const loggedOut = (): void => {
    probeStdout = JSON.stringify({ loggedIn: false, authMethod: 'none' }, null, 2);
  };
  const loggedIn = (): void => {
    probeStdout = JSON.stringify(
      { loggedIn: true, authMethod: 'claude.ai', email: 'dev@example.com', subscriptionType: 'max' },
      null,
      2,
    );
  };

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    daemon.addContainer({ id: LOGIN_CONTAINER, name: 'chief-web-claude-login-fake' });

    dataDir = mkdtempSync(path.join(os.tmpdir(), 'chief-claude-api-'));
    config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      DATA_DIR: dataDir,
      // Every request re-probes, so a test can change the answer at will.
      CLAUDE_STATUS_CACHE_MS: '0',
    });
    db = openDatabase(IN_MEMORY);
    accountId = addClaudeAccount(config, db).id;
    manager = new TerminalManager(new DockerApi(daemon.socketPath), {
      scrollbackLines: 500,
      scrollbackBytes: 100_000,
      maxTerminals: 4,
    });

    const auth = createAuthService(config, db);
    cookie = auth.sessionCookie().split(';')[0] ?? '';
    server = createApp(config, auth, db, { terminals: manager, runCommand }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    manager.closeAll();
    await new Promise((resolve) => server.close(resolve));
    await daemon.close();
    closeDatabase(db);
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Only one login may be open; close whatever the previous test left.
    const open = (await state()).login.accountId;
    if (open !== null) await call('DELETE', `/api/claude/accounts/${open}/login`);
    commands = [];
    probeResult = {};
    loggedOut();
  });

  it('requires the session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/claude`);

    assert.equal(response.status, 401);
  });

  /** The entry of the account every test shares. */
  const own = (body: StateBody): AccountStatus => {
    const entry = body.accounts.find((account) => account.id === accountId);
    assert.ok(entry, 'the account should be listed');
    return entry;
  };

  it('probes a container with the account directory mounted', async () => {
    const body = await state();

    assert.equal(own(body).authenticated, false);
    assert.equal(own(body).error, null);
    assert.equal(own(body).usage, null);
    assert.equal(body.defaultAccountId, accountId);
    const probe = commands.find((args) => args.includes('status'));
    assert.ok(probe, 'a probe container should have been started');
    assert.ok(probe.includes('--rm'));
    assert.ok(probe.includes(accountBind()));
  });

  it('reports the account once the volume holds credentials', async () => {
    loggedIn();

    const body = await state();

    assert.equal(own(body).authenticated, true);
    assert.equal(own(body).email, 'dev@example.com');
    assert.equal(own(body).subscription, 'max');
    // Written back, so a list can show it without a probe.
    assert.equal(getClaudeAccount(db, accountId)?.email, 'dev@example.com');
  });

  it('fails closed when Docker cannot answer', async () => {
    probeResult = { code: 125, stdout: '', stderr: 'Cannot connect to the Docker daemon' };

    const body = await state();

    assert.equal(own(body).authenticated, false);
    assert.match(own(body).error ?? '', /Cannot connect to the Docker daemon/);
  });

  it('blocks session creation while Claude is not authenticated', async () => {
    const response = await call('POST', '/api/sessions', { name: 'demo' });
    const body = (await response.json()) as { error: string; message: string };

    assert.equal(response.status, 409);
    assert.equal(body.error, 'claude_not_authenticated');
    assert.match(body.message, /Add an account in Settings/);
  });

  it('lets session creation through once Claude is authenticated', async () => {
    loggedIn();

    const response = await call('POST', '/api/sessions', { name: 'demo' });

    // The guard is out of the way, so the sessions router (US-010) is what
    // answers now — here by rejecting a body with no repository in it.
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'invalid_repository_id');
  });

  /** `POST /api/claude/accounts`: a new account and its login terminal. */
  const addAccount = async (): Promise<{ response: Response; body: LoginBody }> => {
    const response = await call('POST', '/api/claude/accounts');
    return { response, body: (await response.json()) as LoginBody };
  };

  it('adds an account and opens its login terminal in a container of its own', async () => {
    const { response, body } = await addAccount();

    assert.equal(response.status, 201);
    const account = body.account;
    assert.ok(account, 'the new account should be returned');
    assert.notEqual(account.id, accountId);
    assert.ok(getClaudeAccount(db, account.id), 'the account row should exist');
    assert.ok(existsSync(claudeAccountDir(config, account.id)), 'its directory should exist');

    assert.equal(body.login.active, true);
    assert.equal(body.login.accountId, account.id);
    assert.equal(body.login.containerId, LOGIN_CONTAINER);
    assert.equal(body.login.containerName, `chief-web-claude-login-${account.id}`);
    assert.ok(body.login.terminalId);

    const run = loginRuns()[0];
    assert.ok(run, 'the login container should have been started');
    assert.deepEqual(run.slice(2, 4), ['--name', `chief-web-claude-login-${account.id}`]);
    // Only the new account's directory: never another account's login.
    assert.ok(run.includes(`${claudeAccountDir(config, account.id)}:${RUNNER_CLAUDE_DIR}`));
    assert.equal(run.filter((arg) => arg === '--volume').length, 1);

    const exec = daemon.execFor(body.login.terminalId ?? '');
    assert.ok(exec, 'the terminal should be an exec in the login container');
    assert.equal(exec.containerId, LOGIN_CONTAINER);
    assert.match(exec.cmd.join(' '), /claude auth login/);
  });

  it('refuses a second login while one is open, naming its account', async () => {
    const { body: first } = await addAccount();
    const openId = first.account?.id ?? '';
    commands = [];

    const second = await call('POST', '/api/claude/accounts');
    const refused = (await second.json()) as { error: string; message: string; accountId: string };
    const relogin = await call('POST', `/api/claude/accounts/${accountId}/login`);

    assert.equal(second.status, 409);
    assert.equal(refused.error, 'claude_login_in_progress');
    assert.equal(refused.accountId, openId);
    assert.match(refused.message, new RegExp(openId));
    assert.equal(relogin.status, 409);
    assert.equal(loginRuns().length, 0, 'no second container should be started');
    assert.equal(
      (await state()).login.terminalId,
      first.login.terminalId,
      'the open login should be untouched',
    );
  });

  it('reports the login in progress to a page that reloads', async () => {
    const { body: started } = await addAccount();

    const reloaded = await state();

    assert.equal(reloaded.login.active, true);
    assert.equal(reloaded.login.accountId, started.account?.id);
    assert.equal(reloaded.login.terminalId, started.login.terminalId);
  });

  it('signs an existing account in again', async () => {
    const response = await call('POST', `/api/claude/accounts/${accountId}/login`);
    const body = (await response.json()) as LoginBody;

    assert.equal(response.status, 201);
    assert.equal(body.account?.id, accountId);
    assert.equal(body.login.accountId, accountId);
    assert.ok(body.login.terminalId);
    const run = loginRuns()[0];
    assert.ok(run, 'the login container should have been started');
    assert.deepEqual(run.slice(2, 4), ['--name', `chief-web-claude-login-${accountId}`]);
    assert.ok(run.includes(accountBind()));
  });

  it('answers 404 for an account that does not exist', async () => {
    const start = await call('POST', '/api/claude/accounts/ffffffffffffffff/login');
    const stop = await call('DELETE', '/api/claude/accounts/ffffffffffffffff/login');

    assert.equal(start.status, 404);
    assert.equal(stop.status, 404);
    assert.equal(loginRuns().length, 0);
  });

  it('closes the terminal, removes the container and re-probes that account', async () => {
    const { body: started } = await addAccount();
    const id = started.account?.id ?? '';
    const terminalId = started.login.terminalId ?? '';
    // The operator signs in; the credentials now live in the account directory.
    loggedIn();
    commands = [];

    const response = await call('DELETE', `/api/claude/accounts/${id}/login`);
    const body = (await response.json()) as LoginBody;

    assert.equal(response.status, 200);
    assert.equal(body.status?.authenticated, true);
    assert.equal(body.account?.id, id);
    assert.equal(body.account?.email, 'dev@example.com', 'the probed email is kept on the row');
    assert.equal(getClaudeAccount(db, id)?.email, 'dev@example.com');
    assert.equal(body.login.active, false);
    assert.equal(body.login.terminalId, null);
    assert.equal(manager.get(terminalId), undefined, 'the terminal should be gone');
    assert.ok(
      commands.some((args) => args.join(' ') === `rm --force chief-web-claude-login-${id}`),
      'the login container should have been removed',
    );
    const probe = commands.find((args) => args.includes('status'));
    assert.ok(probe, 'the status should be re-checked');
    assert.ok(probe.includes(`${claudeAccountDir(config, id)}:${RUNNER_CLAUDE_DIR}`));
  });

  it('deletes the account of an abandoned login that never signed in', async () => {
    const { body: started } = await addAccount();
    const id = started.account?.id ?? '';

    const response = await call('DELETE', `/api/claude/accounts/${id}/login`);
    const body = (await response.json()) as LoginBody;

    assert.equal(response.status, 200);
    assert.equal(body.account, null);
    assert.equal(body.status?.authenticated, false);
    assert.equal(getClaudeAccount(db, id), null, 'the row should be gone');
    assert.equal(existsSync(claudeAccountDir(config, id)), false, 'the directory should be gone');
  });

  it('keeps an existing account whose re-login was abandoned', async () => {
    await call('POST', `/api/claude/accounts/${accountId}/login`);

    const response = await call('DELETE', `/api/claude/accounts/${accountId}/login`);
    const body = (await response.json()) as LoginBody;

    assert.equal(response.status, 200);
    assert.equal(body.status?.authenticated, false);
    assert.equal(body.account?.id, accountId);
    assert.ok(getClaudeAccount(db, accountId));
    assert.ok(existsSync(claudeAccountDir(config, accountId)));
  });

  it('keeps an account created by a login that was once authenticated', async () => {
    const { body: started } = await addAccount();
    const id = started.account?.id ?? '';
    // A previous probe saw it signed in; this login signed it out again.
    updateClaudeAccount(db, id, { email: 'old@example.com', authMethod: 'claude.ai' });

    const body = (await (await call('DELETE', `/api/claude/accounts/${id}/login`)).json()) as LoginBody;

    assert.equal(body.status?.authenticated, false);
    assert.equal(body.account?.id, id);
    assert.ok(getClaudeAccount(db, id));
  });

  it('starts a new login once the open terminal was closed elsewhere', async () => {
    const { body: first } = await addAccount();
    // Model a server restart or the terminal page: the terminal is gone, the
    // container is not.
    await manager.remove(first.login.terminalId ?? '');
    commands = [];

    const response = await call('POST', `/api/claude/accounts/${accountId}/login`);
    const body = (await response.json()) as LoginBody;

    assert.equal(response.status, 201);
    assert.notEqual(body.login.terminalId, first.login.terminalId);
    const removed = commands.filter((args) => args[0] === 'rm').map((args) => args[2]);
    assert.ok(removed.includes(`chief-web-claude-login-${first.account?.id ?? ''}`));
    assert.ok(
      removed.includes(`chief-web-claude-login-${accountId}`),
      'a stale container of this account is cleared before the new one starts',
    );
  });

  it('removes the account again when its login container cannot be started', async () => {
    const failing: string[][] = [];
    const brokenServer = createApp(config, createAuthService(config, db), db, {
      terminals: manager,
      runCommand: (_command, args) => {
        failing.push([...args]);
        if (args.includes('status')) {
          return Promise.resolve({ code: 1, stdout: probeStdout, stderr: '', timedOut: false });
        }
        return Promise.resolve({
          code: 125,
          stdout: '',
          stderr: 'Unable to find image',
          timedOut: false,
        });
      },
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => brokenServer.once('listening', resolve));
    const port = (brokenServer.address() as AddressInfo).port;
    const before = listClaudeAccounts(db).length;

    const response = await fetch(`http://127.0.0.1:${port}/api/claude/accounts`, {
      method: 'POST',
      headers: { cookie },
    });
    const body = (await response.json()) as { error: string; message: string };

    assert.equal(response.status, 502);
    assert.equal(body.error, 'claude_login_container_failed');
    assert.match(body.message, /Unable to find image/);
    assert.equal(listClaudeAccounts(db).length, before, 'no account should be left behind');

    await new Promise((resolve) => brokenServer.close(resolve));
  });

  it('no longer serves the single-account login routes', async () => {
    assert.equal((await call('POST', '/api/claude/login')).status, 404);
    assert.equal((await call('DELETE', '/api/claude/login')).status, 404);
  });
});
