import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { CLAUDE_LOGIN_CONTAINER_NAME } from '../claude/index.js';
import { type Config, loadConfig } from '../config.js';
import { closeDatabase, type Database, IN_MEMORY, openDatabase } from '../db/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import { DockerApi } from '../docker/index.js';
import { RUNNER_CLAUDE_DIR } from '../runner/index.js';
import type { CommandResult, CommandRunner } from '../ssh/index.js';
import { TerminalManager } from '../terminal/index.js';

const PASSWORD = 'correct horse battery staple';
const AUTH_VOLUME = 'chief-web-claude-auth';
/** Id the fake `docker run` reports, registered in the fake daemon below. */
const LOGIN_CONTAINER = 'login-container-id';

interface StateBody {
  status: {
    authenticated: boolean;
    account: string | null;
    subscription: string | null;
    error: string | null;
  };
  login: { active: boolean; terminalId: string | null; containerName: string };
}

describe('claude api', () => {
  let baseUrl: string;
  let cookie: string;
  let config: Config;
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
    daemon.addContainer({ id: LOGIN_CONTAINER, name: CLAUDE_LOGIN_CONTAINER_NAME });

    config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      CLAUDE_AUTH_VOLUME: AUTH_VOLUME,
      // Every request re-probes, so a test can change the answer at will.
      CLAUDE_STATUS_CACHE_MS: '0',
    });
    db = openDatabase(IN_MEMORY);
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
  });

  beforeEach(() => {
    commands = [];
    probeResult = {};
    loggedOut();
  });

  it('requires the session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/claude`);

    assert.equal(response.status, 401);
  });

  it('probes a container with the shared credentials volume mounted', async () => {
    const body = await state();

    assert.equal(body.status.authenticated, false);
    assert.equal(body.status.error, null);
    const probe = commands.find((args) => args.includes('status'));
    assert.ok(probe, 'a probe container should have been started');
    assert.ok(probe.includes('--rm'));
    assert.ok(probe.includes(`${AUTH_VOLUME}:${RUNNER_CLAUDE_DIR}`));
  });

  it('reports the account once the volume holds credentials', async () => {
    loggedIn();

    const body = await state();

    assert.equal(body.status.authenticated, true);
    assert.equal(body.status.account, 'dev@example.com');
    assert.equal(body.status.subscription, 'max');
  });

  it('fails closed when Docker cannot answer', async () => {
    probeResult = { code: 125, stdout: '', stderr: 'Cannot connect to the Docker daemon' };

    const body = await state();

    assert.equal(body.status.authenticated, false);
    assert.match(body.status.error ?? '', /Cannot connect to the Docker daemon/);
  });

  it('blocks session creation while Claude is not authenticated', async () => {
    const response = await call('POST', '/api/sessions', { name: 'demo' });
    const body = (await response.json()) as { error: string; message: string };

    assert.equal(response.status, 409);
    assert.equal(body.error, 'claude_not_authenticated');
    assert.match(body.message, /Set up Claude/);
  });

  it('lets session creation through once Claude is authenticated', async () => {
    loggedIn();

    const response = await call('POST', '/api/sessions', { name: 'demo' });

    // The guard is out of the way, so the sessions router (US-010) is what
    // answers now — here by rejecting a body with no repository in it.
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'invalid_repository_id');
  });

  it('opens a login terminal in a temporary container', async () => {
    const response = await call('POST', '/api/claude/login');
    const body = (await response.json()) as StateBody;

    assert.equal(response.status, 201);
    assert.equal(body.login.active, true);
    assert.equal(body.login.containerName, CLAUDE_LOGIN_CONTAINER_NAME);
    assert.ok(body.login.terminalId);

    const run = loginRuns()[0];
    assert.ok(run, 'the login container should have been started');
    assert.ok(run.includes(`${AUTH_VOLUME}:${RUNNER_CLAUDE_DIR}`));

    const exec = daemon.execFor(body.login.terminalId ?? '');
    assert.ok(exec, 'the terminal should be an exec in the login container');
    assert.equal(exec.containerId, LOGIN_CONTAINER);
    assert.match(exec.cmd.join(' '), /claude auth login/);
  });

  it('returns the same terminal instead of starting a second login', async () => {
    const first = (await (await call('POST', '/api/claude/login')).json()) as StateBody;
    commands = [];

    const second = (await (await call('POST', '/api/claude/login')).json()) as StateBody;

    assert.equal(second.login.terminalId, first.login.terminalId);
    assert.equal(loginRuns().length, 0, 'no second container should be started');
  });

  it('reports the login in progress to a page that reloads', async () => {
    const started = (await (await call('POST', '/api/claude/login')).json()) as StateBody;

    const reloaded = await state();

    assert.equal(reloaded.login.active, true);
    assert.equal(reloaded.login.terminalId, started.login.terminalId);
  });

  it('closes the terminal, removes the container and re-checks the status', async () => {
    const started = (await (await call('POST', '/api/claude/login')).json()) as StateBody;
    const terminalId = started.login.terminalId ?? '';
    // The operator signs in; the credentials now live in the shared volume.
    loggedIn();
    commands = [];

    const response = await call('DELETE', '/api/claude/login');
    const body = (await response.json()) as StateBody;

    assert.equal(response.status, 200);
    assert.equal(body.status.authenticated, true);
    assert.equal(body.login.active, false);
    assert.equal(body.login.terminalId, null);
    assert.equal(manager.get(terminalId), undefined, 'the terminal should be gone');
    const removed = commands.find((args) => args[0] === 'rm');
    assert.ok(removed, 'the login container should have been removed');
    assert.deepEqual(removed, ['rm', '--force', CLAUDE_LOGIN_CONTAINER_NAME]);
    assert.ok(commands.some((args) => args.includes('status')), 'the status should be re-checked');
  });

  it('replaces a login container left behind by a previous attempt', async () => {
    await call('POST', '/api/claude/login');
    const first = await state();
    // Model a server restart: the terminal registry is empty but the named
    // container still exists.
    await manager.remove(first.login.terminalId ?? '');
    commands = [];

    const response = await call('POST', '/api/claude/login');
    const body = (await response.json()) as StateBody;

    assert.equal(response.status, 201);
    assert.notEqual(body.login.terminalId, first.login.terminalId);
    assert.ok(
      commands.some((args) => args[0] === 'rm' && args.includes(CLAUDE_LOGIN_CONTAINER_NAME)),
      'the stale container should be removed before the new one starts',
    );

    await call('DELETE', '/api/claude/login');
  });

  it('reports a login container that could not be started', async () => {
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

    const response = await fetch(`http://127.0.0.1:${port}/api/claude/login`, {
      method: 'POST',
      headers: { cookie },
    });
    const body = (await response.json()) as { error: string; message: string };

    assert.equal(response.status, 502);
    assert.equal(body.error, 'claude_login_container_failed');
    assert.match(body.message, /Unable to find image/);

    await new Promise((resolve) => brokenServer.close(resolve));
  });
});
