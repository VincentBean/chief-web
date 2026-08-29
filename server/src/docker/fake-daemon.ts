import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in for the Docker Engine API, spoken over a real unix socket.
 *
 * The test suite must not need a Docker daemon (the same rule that gave US-005
 * its injectable `CommandRunner`), but the terminal bridge is mostly *protocol*
 * — connection hijacking, raw TTY streams, resize calls — so stubbing the
 * client would test almost nothing. This implements just enough of the daemon
 * for those paths to run for real.
 *
 * Excluded from the production build in `tsconfig.build.json`.
 */

export interface FakeContainerSpec {
  readonly id: string;
  readonly name: string;
  readonly image?: string;
  readonly running?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  running: boolean;
  readonly labels: Readonly<Record<string, string>>;
  /** `source:target[:ro]` entries the container was created with. */
  readonly binds: readonly string[];
  readonly env: readonly string[];
  readonly workingDir: string | null;
  /** Set by `POST /containers/{id}/stop`. */
  stopped: boolean;
  /** Whether removal was asked to force-kill a running container. */
  removedForce: boolean;
}

export interface FakeExec {
  readonly id: string;
  readonly containerId: string;
  readonly cmd: readonly string[];
  readonly env: readonly string[];
  readonly workingDir: string | null;
  /** Terminal id when this exec is a wrapped terminal shell; else `null`. */
  readonly terminalId: string | null;
  readonly pid: number;
  running: boolean;
  exitCode: number;
  /** Every `POST /exec/{id}/resize` seen, in order. */
  readonly resizes: { cols: number; rows: number }[];
  /** Bytes the client wrote to the PTY. */
  input: Buffer;
  socket: Socket | null;
}

/** Byte that makes the fake shell exit cleanly, mimicking Ctrl-D. */
export const FAKE_EOT = 0x04;

/** Exit codes a signalled process reports, as a shell would (128 + signo). */
const SIGNAL_EXIT: Record<string, number> = { HUP: 129, TERM: 143, KILL: 137 };

export class FakeDockerDaemon {
  /** API version the daemon advertises as its highest and lowest supported. */
  apiVersion = '1.51';
  minApiVersion = '1.44';
  /** Versions the client actually used, in request order. */
  readonly requestedVersions: string[] = [];
  /**
   * Signal names the fake processes ignore, e.g. `HUP` to model an interactive
   * shell that only dies when it is killed outright.
   */
  readonly ignoredSignals = new Set<string>();

  private readonly containers = new Map<string, FakeContainer>();
  private readonly execsById = new Map<string, FakeExec>();
  private readonly sockets = new Set<Socket>();
  private nextExec = 1;
  private nextPid = 1000;
  private nextContainer = 1;
  /** Volumes `GET /volumes/{name}` reports, name → host mountpoint. */
  private readonly volumes = new Map<string, string>();
  /** Ids passed to `DELETE /containers/{id}`, in order. */
  readonly removed: string[] = [];

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    private readonly directory: string,
  ) {}

  static async start(): Promise<FakeDockerDaemon> {
    // Unix socket paths are length-limited, so keep the directory short.
    const directory = mkdtempSync(path.join(os.tmpdir(), 'chief-docker-'));
    const socketPath = path.join(directory, 'd.sock');
    const server = createServer();
    const daemon = new FakeDockerDaemon(server, socketPath, directory);

    server.on('request', (req, res) => daemon.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => daemon.onUpgrade(req, socket as Socket, head));
    server.on('connection', (socket: Socket) => daemon.sockets.add(socket));

    server.listen(socketPath);
    await new Promise((resolve) => server.once('listening', resolve));
    return daemon;
  }

  addContainer(spec: FakeContainerSpec): void {
    this.containers.set(spec.id, {
      id: spec.id,
      name: spec.name,
      image: spec.image ?? 'chief-web-runner:latest',
      running: spec.running ?? true,
      labels: spec.labels ?? {},
      binds: [],
      env: [],
      workingDir: null,
      stopped: false,
      removedForce: false,
    });
  }

  /** Makes `GET /volumes/{name}` answer for `name`. */
  addVolume(name: string, mountpoint: string): void {
    this.volumes.set(name, mountpoint);
  }

  container(id: string): FakeContainer | undefined {
    return this.containers.get(id);
  }

  /** Every container the daemon still knows about, creation order preserved. */
  listContainers(): FakeContainer[] {
    return [...this.containers.values()];
  }

  /** Every exec created, oldest first. */
  execs(): FakeExec[] {
    return [...this.execsById.values()];
  }

  exec(id: string): FakeExec | undefined {
    return this.execsById.get(id);
  }

  /** The exec backing terminal `terminalId`, if one was started. */
  execFor(terminalId: string): FakeExec | undefined {
    return this.execs().findLast((exec) => exec.terminalId === terminalId);
  }

  /** Pushes output into a live exec, as the process inside would. */
  emit(execId: string, data: string): void {
    this.execsById.get(execId)?.socket?.write(Buffer.from(data, 'utf8'));
  }

  /** Ends a live exec with `exitCode`, as the process inside exiting would. */
  finish(execId: string, exitCode = 0): void {
    const exec = this.execsById.get(execId);
    if (exec === undefined || !exec.running) return;
    exec.running = false;
    exec.exitCode = exitCode;
    exec.socket?.end();
    exec.socket = null;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise((resolve) => this.server.close(resolve));
    await rm(this.directory, { recursive: true, force: true });
  }

  /** Strips the `/vX.Y` prefix, remembering which version was asked for. */
  private record(pathname: string): string {
    const match = /^\/v(\d+\.\d+)/.exec(pathname);
    if (match !== null) this.requestedVersions.push(match[1] as string);
    return stripVersion(pathname);
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://docker');
    const route = this.record(url.pathname);

    if (route === '/version') {
      json(res, 200, { ApiVersion: this.apiVersion, MinAPIVersion: this.minApiVersion });
      return;
    }

    if (route === '/_ping') {
      res.writeHead(200).end('OK');
      return;
    }

    if (route === '/containers/json') {
      const all = url.searchParams.get('all') === '1';
      const wanted = parseLabelFilters(url.searchParams.get('filters'));
      const list = [...this.containers.values()]
        .filter((container) => all || container.running)
        .filter((container) => wanted.every((filter) => matchesLabel(container.labels, filter)))
        .map((container) => ({
          Id: container.id,
          Names: [`/${container.name}`],
          Image: container.image,
          State: container.running ? 'running' : 'exited',
          Status: container.running ? 'Up 1 minute' : 'Exited (0) 1 minute ago',
          Labels: container.labels,
        }));
      json(res, 200, list);
      return;
    }

    if (route === '/containers/create') {
      void readBody(req).then((body) => {
        const spec = JSON.parse(body === '' ? '{}' : body) as {
          Image?: string;
          Env?: string[];
          Labels?: Record<string, string>;
          WorkingDir?: string;
          HostConfig?: { Binds?: string[] };
        };
        const name = url.searchParams.get('name') ?? `generated-${this.nextContainer}`;
        if ([...this.containers.values()].some((existing) => existing.name === name)) {
          json(res, 409, { message: `Conflict. The container name "/${name}" is already in use` });
          return;
        }
        const id = `container-${this.nextContainer++}`;
        this.containers.set(id, {
          id,
          name,
          image: spec.Image ?? '',
          running: false,
          labels: spec.Labels ?? {},
          binds: spec.HostConfig?.Binds ?? [],
          env: spec.Env ?? [],
          workingDir: spec.WorkingDir ?? null,
          stopped: false,
          removedForce: false,
        });
        json(res, 201, { Id: id, Warnings: [] });
      });
      return;
    }

    const volume = /^\/volumes\/([^/]+)$/.exec(route);
    if (volume !== null) {
      const name = decodeURIComponent(volume[1] as string);
      const mountpoint = this.volumes.get(name);
      if (mountpoint === undefined) {
        json(res, 404, { message: `get ${name}: no such volume` });
        return;
      }
      json(res, 200, { Name: name, Driver: 'local', Mountpoint: mountpoint });
      return;
    }

    const lifecycle = /^\/containers\/([^/]+)\/(start|stop|kill)$/.exec(route);
    if (lifecycle !== null) {
      const container = this.containers.get(decodeURIComponent(lifecycle[1] as string));
      if (container === undefined) {
        json(res, 404, { message: 'No such container' });
        return;
      }
      if (lifecycle[2] === 'start') {
        container.running = true;
      } else {
        container.running = false;
        container.stopped = true;
      }
      res.writeHead(204).end();
      return;
    }

    const inspect = /^\/containers\/([^/]+)\/json$/.exec(route);
    if (inspect !== null) {
      const container = this.containers.get(decodeURIComponent(inspect[1] as string));
      if (container === undefined) {
        json(res, 404, { message: 'No such container' });
        return;
      }
      json(res, 200, {
        Id: container.id,
        Name: `/${container.name}`,
        State: {
          Running: container.running,
          Status: container.running ? 'running' : 'exited',
          ExitCode: container.running ? 0 : 137,
        },
        Config: { Image: container.image, Labels: container.labels },
      });
      return;
    }

    if (req.method === 'DELETE') {
      const target = /^\/containers\/([^/]+)$/.exec(route);
      if (target !== null) {
        const id = decodeURIComponent(target[1] as string);
        const container = this.containers.get(id);
        if (container === undefined) {
          json(res, 404, { message: 'No such container' });
          return;
        }
        const force = url.searchParams.get('force') === '1';
        if (container.running && !force) {
          json(res, 409, { message: 'You cannot remove a running container' });
          return;
        }
        // `v=1` would take the volumes with it; the client must never send it.
        if (url.searchParams.get('v') === '1') {
          json(res, 500, { message: 'fake daemon: refusing to remove volumes' });
          return;
        }
        container.removedForce = force;
        this.containers.delete(id);
        this.removed.push(id);
        res.writeHead(204).end();
        return;
      }
    }

    const createExec = /^\/containers\/([^/]+)\/exec$/.exec(route);
    if (createExec !== null) {
      const containerId = decodeURIComponent(createExec[1] as string);
      if (!this.containers.has(containerId)) {
        json(res, 404, { message: 'No such container' });
        return;
      }
      void readBody(req).then((body) => {
        const spec = JSON.parse(body === '' ? '{}' : body) as {
          Cmd?: string[];
          Env?: string[];
          WorkingDir?: string;
        };
        const cmd = spec.Cmd ?? [];
        const id = `exec-${this.nextExec++}`;
        this.execsById.set(id, {
          id,
          containerId,
          cmd,
          env: spec.Env ?? [],
          workingDir: spec.WorkingDir ?? null,
          terminalId: cmd.join(' ').includes('echo $$') ? pidFileOwner(cmd) : null,
          pid: this.nextPid++,
          running: false,
          exitCode: 0,
          resizes: [],
          input: Buffer.alloc(0),
          socket: null,
        });
        json(res, 201, { Id: id });
      });
      return;
    }

    const resize = /^\/exec\/([^/]+)\/resize$/.exec(route);
    if (resize !== null) {
      const exec = this.execsById.get(decodeURIComponent(resize[1] as string));
      if (exec === undefined) {
        json(res, 404, { message: 'No such exec' });
        return;
      }
      exec.resizes.push({
        cols: Number(url.searchParams.get('w')),
        rows: Number(url.searchParams.get('h')),
      });
      res.writeHead(200).end();
      return;
    }

    const inspectExec = /^\/exec\/([^/]+)\/json$/.exec(route);
    if (inspectExec !== null) {
      const exec = this.execsById.get(decodeURIComponent(inspectExec[1] as string));
      if (exec === undefined) {
        json(res, 404, { message: 'No such exec' });
        return;
      }
      json(res, 200, {
        Running: exec.running,
        ExitCode: exec.running ? null : exec.exitCode,
        Pid: exec.running ? exec.pid : 0,
      });
      return;
    }

    json(res, 404, { message: `fake daemon: unhandled ${req.method ?? '?'} ${route}` });
  }

  private onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const route = this.record(new URL(req.url ?? '/', 'http://docker').pathname);
    const start = /^\/exec\/([^/]+)\/start$/.exec(route);
    const exec = start === null ? undefined : this.execsById.get(decodeURIComponent(start[1] as string));

    if (exec === undefined) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
      return;
    }

    this.sockets.add(socket);
    socket.write(
      'HTTP/1.1 101 UPGRADED\r\n' +
        'Content-Type: application/vnd.docker.raw-stream\r\n' +
        'Connection: Upgrade\r\n' +
        'Upgrade: tcp\r\n\r\n',
    );

    exec.running = true;
    exec.socket = socket;

    // Closing a terminal runs a second exec that signals the pid recorded in
    // the terminal's pid file; model that so the path is covered end to end.
    const signal = /kill -([A-Z]+)/.exec(exec.cmd.join(' '));
    const owner = pidFileOwner(exec.cmd);
    if (signal !== null && owner !== null) {
      const name = signal[1] as string;
      const target = this.execFor(owner);
      if (target !== undefined && target.running && !this.ignoredSignals.has(name)) {
        this.finish(target.id, SIGNAL_EXIT[name] ?? 143);
      }
      this.finish(exec.id, 0);
      return;
    }

    socket.write(Buffer.from(`# ${exec.cmd.join(' ')}\r\n`, 'utf8'));

    // The request body arrives on the same socket; skip exactly its bytes so
    // it is not mistaken for keystrokes.
    let remaining = Number(req.headers['content-length'] ?? 0);
    const consume = (chunk: Buffer): void => {
      let payload = chunk;
      if (remaining > 0) {
        const skipped = Math.min(remaining, payload.length);
        remaining -= skipped;
        payload = payload.subarray(skipped);
      }
      if (payload.length === 0) return;
      exec.input = Buffer.concat([exec.input, payload]);
      // The fake shell echoes what it is typed, and exits on Ctrl-D.
      const eot = payload.indexOf(FAKE_EOT);
      socket.write(eot === -1 ? payload : payload.subarray(0, eot));
      if (eot !== -1) this.finish(exec.id, 0);
    };

    if (head.length > 0) consume(head);
    socket.on('data', consume);
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (exec.running) {
        exec.running = false;
        exec.socket = null;
      }
    });
    socket.on('error', () => socket.destroy());
  }
}

/** `{"label":["a","b=c"]}` → `['a', 'b=c']`. */
function parseLabelFilters(raw: string | null): string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as { label?: unknown };
    return Array.isArray(parsed.label) ? parsed.label.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** Docker matches `key` on presence and `key=value` on equality. */
function matchesLabel(labels: Readonly<Record<string, string>>, filter: string): boolean {
  const separator = filter.indexOf('=');
  if (separator === -1) return filter in labels;
  return labels[filter.slice(0, separator)] === filter.slice(separator + 1);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The terminal id in a `.../<id>.pid` path mentioned by a command, if any. */
function pidFileOwner(cmd: readonly string[]): string | null {
  const match = /([0-9a-fA-F-]{36})\.pid/.exec(cmd.join(' '));
  return match === null ? null : (match[1] as string);
}

/** `/v1.41/containers/json` → `/containers/json`. */
function stripVersion(pathname: string): string {
  return pathname.replace(/^\/v\d+\.\d+/, '');
}
