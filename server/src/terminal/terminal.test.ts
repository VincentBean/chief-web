import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { closeDatabase, IN_MEMORY, openDatabase } from '../db/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import {
  chooseApiVersion,
  DockerApi,
  DockerApiError,
  PREFERRED_DOCKER_API_VERSION,
} from '../docker/index.js';
import { WebSocketGateway } from '../ws/gateway.js';
import { TerminalError, TerminalManager } from './manager.js';
import { parseClientMessage } from './protocol.js';
import { terminalPidFile } from './command.js';
import { ScrollbackBuffer } from './scrollback.js';
import {
  createTerminalSocketRoute,
  terminalSocketPath,
  WS_CLOSE_TERMINAL_NOT_FOUND,
} from './socket.js';

const OPTIONS = { scrollbackLines: 500, scrollbackBytes: 1_000_000, maxTerminals: 3 };

/** ANSI colour sequences, written as escapes so the fixtures stay readable. */
const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const BLUE = '\u001b[34m';
const RESET = '\u001b[0m';

describe('ScrollbackBuffer', () => {
  it('keeps everything while under both budgets', () => {
    const buffer = new ScrollbackBuffer(500, 1000);
    buffer.append(Buffer.from('one\n'));
    buffer.append(Buffer.from('two\n'));

    assert.equal(buffer.snapshot().toString(), 'one\ntwo\n');
    assert.equal(buffer.byteLength, 8);
  });

  it('retains at least the last 500 lines of a long stream', () => {
    const buffer = new ScrollbackBuffer(500, 10_000_000);
    for (let line = 0; line < 5000; line += 1) buffer.append(Buffer.from(`line ${line}\n`));

    const kept = buffer
      .snapshot()
      .toString()
      .split('\n')
      .filter((line) => line !== '');
    assert.equal(kept.length, 500);
    assert.equal(kept[0], 'line 4500');
    assert.equal(kept.at(-1), 'line 4999');
  });

  it('drops whole lines, never a partial escape sequence', () => {
    const buffer = new ScrollbackBuffer(2, 1_000_000);
    buffer.append(Buffer.from(`${RED}red${RESET}\n`));
    buffer.append(Buffer.from(`${GREEN}green${RESET}\n`));
    buffer.append(Buffer.from(`${BLUE}blue${RESET}\n`));

    assert.equal(
      buffer.snapshot().toString(),
      `${GREEN}green${RESET}\n${BLUE}blue${RESET}\n`,
    );
  });

  it('honours the byte ceiling as well as the line ceiling', () => {
    const buffer = new ScrollbackBuffer(1000, 20);
    for (let line = 0; line < 20; line += 1) buffer.append(Buffer.from('0123456789\n'));

    assert.ok(buffer.byteLength <= 20, `expected <= 20 bytes, got ${buffer.byteLength}`);
    assert.equal(buffer.snapshot().toString(), '0123456789\n');
  });

  it('keeps an over-long single line rather than cutting mid-sequence', () => {
    const buffer = new ScrollbackBuffer(1000, 4);
    buffer.append(Buffer.from('a much longer line than the budget'));

    assert.equal(buffer.snapshot().toString(), 'a much longer line than the budget');
  });
});

describe('terminal control messages', () => {
  it('accepts a resize', () => {
    assert.deepEqual(parseClientMessage('{"type":"resize","cols":100,"rows":40}'), {
      type: 'resize',
      cols: 100,
      rows: 40,
    });
  });

  it('rejects malformed, unknown and out-of-range messages', () => {
    assert.equal(parseClientMessage('not json'), null);
    assert.equal(parseClientMessage('"a string"'), null);
    assert.equal(parseClientMessage('{"type":"eval","code":"1"}'), null);
    assert.equal(parseClientMessage('{"type":"resize","cols":0,"rows":40}'), null);
    assert.equal(parseClientMessage('{"type":"resize","cols":10,"rows":100000}'), null);
    assert.equal(parseClientMessage('{"type":"resize","cols":10.5,"rows":40}'), null);
  });
});

describe('Docker Engine API client', () => {
  let daemon: FakeDockerDaemon;
  let docker: DockerApi;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    daemon.addContainer({ id: 'c1', name: 'chief-session-one' });
    daemon.addContainer({ id: 'c2', name: 'chief-session-two', running: false });
    docker = new DockerApi(daemon.socketPath);
  });

  after(async () => daemon.close());

  it('negotiates an API version inside the daemon window', async () => {
    assert.equal(await docker.apiVersion(), PREFERRED_DOCKER_API_VERSION);
    assert.ok(
      daemon.requestedVersions.every((version) => version === PREFERRED_DOCKER_API_VERSION),
      `unexpected versions used: ${daemon.requestedVersions.join(', ')}`,
    );
  });

  it('clamps to the daemon window when the preferred version is outside it', () => {
    // Docker 29 refuses anything below 1.44; an old daemon understands nothing
    // above its own ApiVersion.
    assert.equal(chooseApiVersion('1.52', '1.44'), PREFERRED_DOCKER_API_VERSION);
    assert.equal(chooseApiVersion('1.41', '1.24'), '1.41');
    assert.equal(chooseApiVersion('1.52', '1.48'), '1.48');
    assert.equal(chooseApiVersion(undefined, undefined), PREFERRED_DOCKER_API_VERSION);
  });

  it('pings the daemon', async () => {
    assert.equal(await docker.ping(), true);
    assert.equal(await new DockerApi('/nonexistent/docker.sock').ping(), false);
  });

  it('lists running containers and strips the leading slash from names', async () => {
    const containers = await docker.listContainers();

    assert.deepEqual(
      containers.map((c) => c.name),
      ['chief-session-one'],
    );
    assert.equal(containers[0]?.state, 'running');
    assert.equal((await docker.listContainers({ all: true })).length, 2);
  });

  it('reports an unknown container as a 404', async () => {
    await assert.rejects(
      () => docker.inspectContainer('nope'),
      (error: unknown) => error instanceof DockerApiError && error.status === 404,
    );
  });

  it('runs a TTY exec over a hijacked stream and resizes it', async () => {
    const execId = await docker.createExec('c1', { cmd: ['/bin/sh'], env: ['TERM=xterm-256color'] });
    const stream = await docker.startExec(execId, { cols: 80, rows: 24 });

    const banner = await new Promise<Buffer>((resolve) => stream.once('data', resolve));
    assert.equal(banner.toString(), '# /bin/sh\r\n');

    const echoed = new Promise<Buffer>((resolve) => stream.once('data', resolve));
    stream.write(Buffer.from('whoami\r'));
    assert.equal((await echoed).toString(), 'whoami\r');

    await docker.resizeExec(execId, { cols: 120, rows: 40 });
    assert.deepEqual(daemon.exec(execId)?.resizes.at(-1), { cols: 120, rows: 40 });
    assert.deepEqual(daemon.exec(execId)?.env, ['TERM=xterm-256color']);

    const state = await docker.inspectExec(execId);
    assert.equal(state.running, true);
    assert.equal(state.exitCode, null);
    assert.ok(state.pid > 0);

    daemon.finish(execId, 0);
    stream.destroy();
  });
});

describe('TerminalManager', () => {
  let daemon: FakeDockerDaemon;
  let manager: TerminalManager;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    daemon.addContainer({ id: 'c1', name: 'runner-one' });
    daemon.addContainer({ id: 'stopped', name: 'runner-stopped', running: false });
  });

  after(async () => daemon.close());

  beforeEach(() => {
    manager = new TerminalManager(new DockerApi(daemon.socketPath), OPTIONS);
  });

  it('opens a terminal with a login shell by default', async () => {
    const view = await manager.create({ container: 'c1' });

    assert.equal(view.status, 'running');
    assert.equal(view.containerName, 'runner-one');
    assert.equal(view.clients, 0);
    assert.equal(view.cols, 80);
    assert.ok(view.command.join(' ').includes('bash'));
    assert.deepEqual(
      manager.list().map((t) => t.id),
      [view.id],
    );
  });

  it('passes cwd and TERM through to the exec', async () => {
    const view = await manager.create({
      container: 'c1',
      command: ['/bin/sh'],
      cwd: '/workspace',
      env: { CHIEF_SESSION: 's1' },
    });

    const exec = daemon.execFor(view.id);
    assert.ok(exec, 'expected an exec for the new terminal');
    assert.equal(exec.workingDir, '/workspace');
    // The real command runs under a wrapper that records its pid; nothing in it
    // is re-parsed by the shell.
    assert.deepEqual(exec.cmd.slice(-2), ['chief-terminal', '/bin/sh']);
    assert.deepEqual(exec.env, ['TERM=xterm-256color', 'CHIEF_SESSION=s1']);
    assert.equal(manager.get(view.id)?.isRunning, true);
  });

  it('rejects an unknown or stopped container without a 401', async () => {
    await assert.rejects(
      () => manager.create({ container: 'ghost' }),
      (error: unknown) =>
        error instanceof TerminalError &&
        error.status === 404 &&
        error.code === 'container_not_found',
    );
    await assert.rejects(
      () => manager.create({ container: 'stopped' }),
      (error: unknown) =>
        error instanceof TerminalError &&
        error.status === 409 &&
        error.code === 'container_not_running',
    );
  });

  it('reports an unreachable daemon as 502', async () => {
    const offline = new TerminalManager(new DockerApi('/nonexistent/docker.sock'), OPTIONS);

    await assert.rejects(
      () => offline.create({ container: 'c1' }),
      (error: unknown) => error instanceof TerminalError && error.status === 502,
    );
  });

  it('caps the number of open terminals', async () => {
    for (let i = 0; i < OPTIONS.maxTerminals; i += 1) await manager.create({ container: 'c1' });

    await assert.rejects(
      () => manager.create({ container: 'c1' }),
      (error: unknown) => error instanceof TerminalError && error.status === 429,
    );
  });

  it('kills the process on remove and forgets the terminal', async () => {
    const view = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const exec = daemon.execFor(view.id);
    assert.ok(exec);

    assert.equal(await manager.remove(view.id), true);

    assert.equal(daemon.exec(exec.id)?.running, false);
    // SIGHUP, not SIGTERM: an interactive shell ignores the latter.
    assert.equal(daemon.exec(exec.id)?.exitCode, 129);
    assert.ok(daemon.execs().at(-1)?.cmd.join(' ').includes(`rm -f ${terminalPidFile(view.id)}`));
    assert.equal(manager.get(view.id), undefined);
    assert.equal(await manager.remove(view.id), false);
  });

  it('escalates to SIGKILL when the process ignores the hangup', async () => {
    daemon.ignoredSignals.add('HUP');
    const view = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const exec = daemon.execFor(view.id);
    assert.ok(exec);

    assert.equal(await manager.remove(view.id), true);

    assert.equal(daemon.exec(exec.id)?.running, false);
    assert.equal(daemon.exec(exec.id)?.exitCode, 137);
    assert.ok(daemon.execs().at(-1)?.cmd.join(' ').includes('kill -KILL'));
    daemon.ignoredSignals.delete('HUP');
  });

  it('marks a terminal exited when the process ends', async () => {
    const opened = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const exec = daemon.execFor(opened.id);
    assert.ok(exec);

    daemon.finish(exec.id, 3);
    await waitFor(() => manager.get(opened.id)?.isRunning === false);

    const closed = manager.get(opened.id)?.toView();
    assert.equal(closed?.status, 'exited');
    assert.equal(closed?.exitCode, 3);
  });
});

describe('terminal WebSocket bridge', () => {
  const db = openDatabase(IN_MEMORY);
  const auth = createAuthService(loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }), db);
  const cookie = auth.sessionCookie().split(';')[0] ?? '';

  let daemon: FakeDockerDaemon;
  let manager: TerminalManager;
  let httpServer: Server;
  let gateway: WebSocketGateway;
  let baseUrl: string;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    daemon.addContainer({ id: 'c1', name: 'runner-one' });
    manager = new TerminalManager(new DockerApi(daemon.socketPath), {
      ...OPTIONS,
      maxTerminals: 20,
    });

    gateway = new WebSocketGateway(auth);
    gateway.register(createTerminalSocketRoute(manager));
    httpServer = createServer((_req, res) => res.end());
    gateway.attach(httpServer);
    httpServer.listen(0, '127.0.0.1');
    await new Promise((resolve) => httpServer.once('listening', resolve));
    baseUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    gateway.close();
    await new Promise((resolve) => httpServer.close(resolve));
    await daemon.close();
    closeDatabase(db);
  });

  const attach = (id: string): Promise<Client> =>
    Client.open(new WebSocket(`${baseUrl}${terminalSocketPath(id)}`, { headers: { cookie } }));

  const liveExec = (terminalId: string): { id: string } => {
    const exec = daemon.execFor(terminalId);
    assert.ok(exec, `expected an exec for terminal ${terminalId}`);
    return exec;
  };

  it('closes with 4404 when the terminal does not exist', async () => {
    const socket = new WebSocket(`${baseUrl}${terminalSocketPath('missing')}`, {
      headers: { cookie },
    });
    const closed = await new Promise<number>((resolve) =>
      socket.on('close', (code: number) => resolve(code)),
    );

    assert.equal(closed, WS_CLOSE_TERMINAL_NOT_FOUND);
  });

  it('announces the terminal, replays the banner and relays keystrokes', async () => {
    const view = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const client = await attach(view.id);

    const attached = await client.nextControl();
    assert.equal(attached.type, 'attached');
    assert.equal(attached.terminal?.id, view.id);

    await waitFor(() => client.output().includes('chief-terminal /bin/sh'));

    client.socket.send(Buffer.from('echo hi\r'), { binary: true });
    await waitFor(() => client.output().includes('echo hi\r'));

    assert.equal(manager.get(view.id)?.toView().clients, 1);
    await client.close();
    await manager.remove(view.id);
  });

  it('forwards a resize to the daemon', async () => {
    const view = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const exec = liveExec(view.id);
    const client = await attach(view.id);
    await client.nextControl();

    client.socket.send(JSON.stringify({ type: 'resize', cols: 132, rows: 43 }));
    await waitFor(() => (daemon.exec(exec.id)?.resizes.length ?? 0) === 1);

    assert.deepEqual(daemon.exec(exec.id)?.resizes.at(-1), { cols: 132, rows: 43 });
    assert.equal(manager.get(view.id)?.toView().cols, 132);

    await client.close();
    await manager.remove(view.id);
  });

  it('survives a page refresh: the process lives on and the scrollback replays', async () => {
    const view = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const exec = liveExec(view.id);

    const first = await attach(view.id);
    await first.nextControl();
    first.socket.send(Buffer.from('before-refresh\r'), { binary: true });
    await waitFor(() => first.output().includes('before-refresh'));

    // Closing the tab must not touch the process.
    await first.close();
    await waitFor(() => manager.get(view.id)?.toView().clients === 0);
    assert.equal(daemon.exec(exec.id)?.running, true);
    assert.equal(manager.get(view.id)?.isRunning, true);

    // Output produced while nobody was watching is still captured.
    daemon.emit(exec.id, 'while-detached\r\n');
    await waitFor(() =>
      (manager.get(view.id)?.replay().toString() ?? '').includes('while-detached'),
    );

    const second = await attach(view.id);
    const attached = await second.nextControl();
    assert.equal(attached.type, 'attached');
    assert.ok((attached.replayBytes ?? 0) > 0);

    await waitFor(() => second.output().includes('while-detached'));
    const replayed = second.output();
    assert.ok(replayed.includes('before-refresh'), 'expected pre-refresh output to be replayed');
    assert.ok(
      replayed.includes('chief-terminal /bin/sh'),
      'expected the whole scrollback, not just the tail',
    );

    // And the same PTY still accepts input.
    second.socket.send(Buffer.from('after-refresh\r'), { binary: true });
    await waitFor(() => second.output().includes('after-refresh'));

    await second.close();
    await manager.remove(view.id);
  });

  it('tells attached clients when the process exits', async () => {
    const view = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const exec = liveExec(view.id);
    const client = await attach(view.id);
    await client.nextControl();

    daemon.finish(exec.id, 7);

    const message = await client.nextControl();
    assert.equal(message.type, 'exit');
    assert.equal(message.exitCode, 7);

    // A client attaching afterwards is told immediately.
    const late = await attach(view.id);
    assert.equal((await late.nextControl()).type, 'attached');
    assert.equal((await late.nextControl()).type, 'exit');

    await client.close();
    await late.close();
    await manager.remove(view.id);
  });

  it('answers an unsupported control message with an error instead of closing', async () => {
    const view = await manager.create({ container: 'c1', command: ['/bin/sh'] });
    const client = await attach(view.id);
    await client.nextControl();

    client.socket.send('{"type":"exec","cmd":"rm -rf /"}');
    const message = await client.nextControl();

    assert.equal(message.type, 'error');
    assert.equal(client.socket.readyState, WebSocket.OPEN);

    await client.close();
    await manager.remove(view.id);
  });
});

interface ControlMessage {
  type?: string;
  exitCode?: number | null;
  replayBytes?: number;
  terminal?: { id?: string };
}

/** Collects text control messages and binary output from one connection. */
class Client {
  private readonly control: ControlMessage[] = [];
  private chunks = '';

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.chunks += data.toString('utf8');
      else this.control.push(JSON.parse(data.toString('utf8')) as ControlMessage);
    });
  }

  static async open(socket: WebSocket): Promise<Client> {
    const client = new Client(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return client;
  }

  output(): string {
    return this.chunks;
  }

  async nextControl(): Promise<ControlMessage> {
    await waitFor(() => this.control.length > 0);
    return this.control.shift() as ControlMessage;
  }

  async close(): Promise<void> {
    this.socket.close();
    await new Promise((resolve) => this.socket.once('close', resolve));
  }
}

/** Polls until `predicate` holds; the fake daemon is asynchronous end to end. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
