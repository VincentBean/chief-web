import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../app.js';
import { createAuthService } from '../auth/index.js';
import { type Config, loadConfig } from '../config.js';
import { closeDatabase, type Database, IN_MEMORY, openDatabase } from '../db/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import { DockerApi } from '../docker/index.js';
import { TerminalManager, type TerminalView } from '../terminal/index.js';

const PASSWORD = 'correct horse battery staple';

interface ContainerBody {
  id: string;
  name: string;
  image: string;
  state: string;
}

describe('terminals api', () => {
  let baseUrl: string;
  let cookie: string;
  let config: Config;
  let daemon: FakeDockerDaemon;
  let db: Database;
  let manager: TerminalManager;
  let server: http.Server;

  const call = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const open = async (
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; error?: string }> => {
    const response = await call('POST', '/api/terminals', { container: 'c1', ...body });
    const parsed = (await response.json()) as { error?: string };
    return { status: response.status, ...parsed };
  };

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    daemon.addContainer({ id: 'c1', name: 'runner-one' });
    daemon.addContainer({ id: 'stopped', name: 'runner-stopped', running: false });

    config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD });
    db = openDatabase(IN_MEMORY);
    manager = new TerminalManager(new DockerApi(daemon.socketPath), {
      scrollbackLines: 500,
      scrollbackBytes: 100_000,
      maxTerminals: 4,
    });

    const auth = createAuthService(config, db);
    cookie = auth.sessionCookie().split(';')[0] ?? '';
    server = createApp(config, auth, db, { terminals: manager }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    manager.closeAll();
    await new Promise((resolve) => server.close(resolve));
    await daemon.close();
    closeDatabase(db);
  });

  it('requires the session cookie', async () => {
    const response = await fetch(`${baseUrl}/api/terminals`);

    assert.equal(response.status, 401);
  });

  it('lists the running containers a terminal can target', async () => {
    const response = await call('GET', '/api/containers');
    const body = (await response.json()) as { containers: ContainerBody[] };

    assert.equal(response.status, 200);
    assert.deepEqual(
      body.containers.map((container) => container.name),
      ['runner-one'],
    );
  });

  it('opens, lists, reads and closes a terminal', async () => {
    const created = await call('POST', '/api/terminals', {
      container: 'c1',
      command: ['/bin/sh'],
      cols: 100,
      rows: 30,
    });
    const view = (await created.json()) as TerminalView;

    assert.equal(created.status, 201);
    assert.equal(view.status, 'running');
    assert.equal(view.containerName, 'runner-one');
    assert.deepEqual(view.command, ['/bin/sh']);
    assert.equal(view.cols, 100);
    assert.equal(view.rows, 30);

    const listed = (await (await call('GET', '/api/terminals')).json()) as {
      terminals: TerminalView[];
    };
    assert.deepEqual(
      listed.terminals.map((terminal) => terminal.id),
      [view.id],
    );

    const fetched = await call('GET', `/api/terminals/${view.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(((await fetched.json()) as TerminalView).id, view.id);

    assert.equal((await call('DELETE', `/api/terminals/${view.id}`)).status, 204);
    assert.equal((await call('GET', `/api/terminals/${view.id}`)).status, 404);
    assert.equal((await call('DELETE', `/api/terminals/${view.id}`)).status, 404);
  });

  it('reports an unknown container as 404 and a stopped one as 409', async () => {
    const missing = await open({ container: 'ghost' });
    assert.equal(missing.status, 404);
    assert.equal(missing.error, 'container_not_found');

    const stopped = await open({ container: 'stopped' });
    assert.equal(stopped.status, 409);
    assert.equal(stopped.error, 'container_not_running');
  });

  it('validates the request body', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ container: '' }, 'invalid_container'],
      [{ container: 'c1', command: [] }, 'invalid_command'],
      [{ container: 'c1', command: 'bash' }, 'invalid_command'],
      [{ container: 'c1', command: [42] }, 'invalid_command'],
      [{ container: 'c1', cwd: '' }, 'invalid_cwd'],
      [{ container: 'c1', cols: 100 }, 'invalid_size'],
      [{ container: 'c1', cols: 0, rows: 10 }, 'invalid_size'],
      [{ container: 'c1', cols: 100, rows: 10_000 }, 'invalid_size'],
    ];

    for (const [body, code] of cases) {
      const response = await call('POST', '/api/terminals', body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.equal(((await response.json()) as { error: string }).error, code);
    }

    assert.deepEqual(
      ((await (await call('GET', '/api/terminals')).json()) as { terminals: TerminalView[] })
        .terminals,
      [],
      'no terminal should have been opened by a rejected request',
    );
  });

  it('refuses to open more terminals than the cap allows', async () => {
    const opened: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const response = await call('POST', '/api/terminals', { container: 'c1' });
      assert.equal(response.status, 201);
      opened.push(((await response.json()) as TerminalView).id);
    }

    const rejected = await call('POST', '/api/terminals', { container: 'c1' });
    assert.equal(rejected.status, 429);
    assert.equal(((await rejected.json()) as { error: string }).error, 'too_many_terminals');

    for (const id of opened) await call('DELETE', `/api/terminals/${id}`);
  });

  it('reports an unreachable daemon as 502, never 401', async () => {
    const offlineDb = openDatabase(IN_MEMORY);
    const auth = createAuthService(config, offlineDb);
    const offline = createApp(config, auth, offlineDb, {
      terminals: new TerminalManager(new DockerApi('/nonexistent/docker.sock'), {
        scrollbackLines: 10,
        scrollbackBytes: 100,
        maxTerminals: 1,
      }),
    }).listen(0, '127.0.0.1');
    await new Promise((resolve) => offline.once('listening', resolve));
    const url = `http://127.0.0.1:${(offline.address() as AddressInfo).port}`;
    const offlineCookie = auth.sessionCookie().split(';')[0] ?? '';

    const response = await fetch(`${url}/api/containers`, { headers: { cookie: offlineCookie } });

    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as { error: string }).error, 'docker_unavailable');

    await new Promise((resolve) => offline.close(resolve));
    closeDatabase(offlineDb);
  });
});
