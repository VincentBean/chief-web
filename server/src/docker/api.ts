import http from 'node:http';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/**
 * The slice of the Docker Engine API chief-web needs, spoken directly over the
 * unix socket.
 *
 * The CLI is not usable for terminals: `docker exec -it` insists on a real TTY
 * on *its own* stdin, which a WebSocket bridge does not have. The Engine API
 * has no such requirement — `POST /exec/{id}/start` hijacks the HTTP connection
 * and hands back a raw, bidirectional stream to the PTY inside the container,
 * with `POST /exec/{id}/resize` for window changes.
 *
 * The API version is negotiated with the daemon on first use rather than
 * pinned: a version below the daemon's `MinAPIVersion` is refused outright
 * (Docker 29 dropped everything under 1.44), and one above its `ApiVersion` is
 * not understood, so neither end of the range is safe to hard-code.
 */

/** What we ask for when the daemon supports it; 1.44 ships with Docker 25. */
export const PREFERRED_DOCKER_API_VERSION = '1.44';

/** A non-2xx answer from the daemon, carrying the message it sent. */
export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail === '' ? `Docker API responded with HTTP ${status}` : detail);
    this.name = 'DockerApiError';
  }
}

export interface ContainerSummary {
  readonly id: string;
  /** Primary name without Docker's leading slash. */
  readonly name: string;
  readonly image: string;
  /** `running`, `exited`, … */
  readonly state: string;
  /** Human-readable status such as `Up 4 minutes`. */
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface ContainerDetails {
  readonly id: string;
  /** Primary name without Docker's leading slash. */
  readonly name: string;
  readonly image: string;
  readonly running: boolean;
  /** `created`, `running`, `exited`, … as the daemon names it. */
  readonly state: string;
  /** Exit code once the container has stopped; `null` while it runs. */
  readonly exitCode: number | null;
  readonly labels: Readonly<Record<string, string>>;
}

/** What `POST /containers/create` needs; the fields chief-web actually sets. */
export interface ContainerSpec {
  readonly image: string;
  readonly cmd?: readonly string[];
  /** `KEY=value` entries. */
  readonly env?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  readonly workingDir?: string;
  readonly user?: string;
  /** `source:target[:ro]` entries, exactly as `docker run --volume` takes them. */
  readonly binds?: readonly string[];
}

export interface ListContainersOptions {
  /** Include stopped containers; by default only running ones are listed. */
  readonly all?: boolean;
  /** Label filters, either `key` or `key=value`, as the daemon expects them. */
  readonly labels?: readonly string[];
}

export interface VolumeDetails {
  readonly name: string;
  /**
   * Path **on the host** where the volume's contents live. Bind-mounting a
   * subdirectory of it is the only way to give a spawned container part of a
   * volume the server itself has mounted: the daemon resolves bind sources on
   * the host, not inside the requesting container.
   */
  readonly mountpoint: string;
}

export interface ExecSpec {
  readonly cmd: readonly string[];
  /** `KEY=value` entries added to the process environment. */
  readonly env?: readonly string[];
  readonly workingDir?: string;
  readonly user?: string;
  /**
   * Allocate a PTY. Defaults to true, which is what a browser terminal needs;
   * a *collected* command wants false, so stdout and stderr stay apart.
   */
  readonly tty?: boolean;
  /** Attach stdin. Defaults to true; see {@link tty}. */
  readonly attachStdin?: boolean;
}

/** The whole output of a command run to completion by {@link DockerApi.runExec}. */
export interface ExecOutput {
  /** `null` when the command was cut short by its timeout. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** One decoded piece of an exec's output, as it arrived. */
export interface ExecChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

/** How {@link DockerApi.streamExec} runs a command. */
export interface StreamExecOptions {
  /** Cap on the whole command; see {@link DockerApi.runExec}. */
  readonly timeoutMs?: number;
  /**
   * Called with each chunk the moment it arrives, so a caller can show output
   * while the command is still running. It must not throw.
   */
  readonly onOutput?: (chunk: ExecChunk) => void;
  /**
   * How much of each stream is retained for the returned {@link ExecOutput};
   * the *tail* is kept. `0` keeps nothing, which is what a caller that already
   * consumed everything through `onOutput` wants. Unset keeps all of it.
   */
  readonly maxOutputChars?: number;
}

export interface ExecState {
  readonly running: boolean;
  /** `null` while the process is still running. */
  readonly exitCode: number | null;
  /**
   * Pid in the **host** namespace; 0 once the process is gone. It cannot be
   * signalled from inside the container — see `terminal/command.ts`.
   */
  readonly pid: number;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

export class DockerApi {
  /** Resolved once, then reused; `null` until the first request negotiates it. */
  private negotiated: Promise<string> | null = null;

  constructor(private readonly socketPath: string) {}

  /**
   * Highest version both ends understand: our preference when the daemon's
   * window contains it, otherwise the nearest end of that window. Falls back to
   * the preference when `/version` cannot be read, so the caller still gets a
   * real error from the request it actually wanted to make.
   */
  apiVersion(): Promise<string> {
    this.negotiated ??= (async () => {
      try {
        const response = await this.send('GET', '/version');
        if (response.status < 200 || response.status >= 300) return PREFERRED_DOCKER_API_VERSION;
        const body = JSON.parse(response.body) as { ApiVersion?: string; MinAPIVersion?: string };
        return chooseApiVersion(body.ApiVersion, body.MinAPIVersion);
      } catch {
        return PREFERRED_DOCKER_API_VERSION;
      }
    })();
    return this.negotiated;
  }

  /** `GET /_ping`; resolves false when the daemon is unreachable. */
  async ping(): Promise<boolean> {
    try {
      const response = await this.send('GET', '/_ping');
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  async listContainers(options: ListContainersOptions = {}): Promise<ContainerSummary[]> {
    const query = new URLSearchParams({ all: options.all === true ? '1' : '0' });
    if (options.labels !== undefined && options.labels.length > 0) {
      query.set('filters', JSON.stringify({ label: [...options.labels] }));
    }
    const raw = await this.json<RawContainer[]>('GET', `/containers/json?${query.toString()}`);
    return raw.map(toContainerSummary);
  }

  /** Throws {@link DockerApiError} with status 404 when there is no such container. */
  async inspectContainer(id: string): Promise<ContainerDetails> {
    const raw = await this.json<RawContainerInspect>('GET', `/containers/${encodeURIComponent(id)}/json`);
    const state = raw.State ?? {};
    const running = state.Running === true;
    const image = raw.Config?.Image;
    const labels = raw.Config?.Labels;
    return {
      id: raw.Id,
      name: stripLeadingSlash(raw.Name ?? ''),
      image: typeof image === 'string' ? image : '',
      running,
      state: typeof state.Status === 'string' ? state.Status : running ? 'running' : 'unknown',
      exitCode: running ? null : typeof state.ExitCode === 'number' ? state.ExitCode : null,
      labels: isStringRecord(labels) ? labels : {},
    };
  }

  /**
   * Creates a container from {@link ContainerSpec}; it is not started yet.
   * Returns its id.
   */
  async createContainer(name: string, spec: ContainerSpec): Promise<string> {
    const body: Record<string, unknown> = {
      Image: spec.image,
      HostConfig: {
        Binds: spec.binds === undefined ? [] : [...spec.binds],
        // Restarting a session container behind the server's back would resume
        // a build nobody is watching; reconciliation decides what comes back.
        RestartPolicy: { Name: 'no' },
        AutoRemove: false,
      },
    };
    if (spec.cmd !== undefined) body['Cmd'] = [...spec.cmd];
    if (spec.env !== undefined) body['Env'] = [...spec.env];
    if (spec.labels !== undefined) body['Labels'] = { ...spec.labels };
    if (spec.workingDir !== undefined) body['WorkingDir'] = spec.workingDir;
    if (spec.user !== undefined) body['User'] = spec.user;

    const created = await this.json<{ Id?: string }>(
      'POST',
      `/containers/create?name=${encodeURIComponent(name)}`,
      body,
    );
    if (typeof created.Id !== 'string' || created.Id === '') {
      throw new DockerApiError(502, 'Docker did not return a container id.');
    }
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.json('POST', `/containers/${encodeURIComponent(id)}/start`);
  }

  /** SIGTERM, then SIGKILL after `timeoutSeconds`. */
  async stopContainer(id: string, timeoutSeconds = 10): Promise<void> {
    await this.json('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSeconds}`);
  }

  /**
   * Removes the container. `v` is deliberately never sent: anonymous volumes
   * declared by the runner image must outlive the containers using them, and a
   * session's workspace must survive its container (US-009).
   */
  async removeContainer(id: string, options: { force?: boolean } = {}): Promise<void> {
    const force = options.force === true ? 1 : 0;
    await this.json('DELETE', `/containers/${encodeURIComponent(id)}?force=${force}`);
  }

  /** Throws {@link DockerApiError} with status 404 when there is no such volume. */
  async inspectVolume(name: string): Promise<VolumeDetails> {
    const raw = await this.json<RawVolume>('GET', `/volumes/${encodeURIComponent(name)}`);
    if (typeof raw.Mountpoint !== 'string' || raw.Mountpoint === '') {
      throw new DockerApiError(502, `Docker reported no mountpoint for volume "${name}".`);
    }
    return { name: typeof raw.Name === 'string' ? raw.Name : name, mountpoint: raw.Mountpoint };
  }

  /** Creates an exec instance; returns its id. It is not started yet. */
  async createExec(container: string, spec: ExecSpec): Promise<string> {
    const body: Record<string, unknown> = {
      AttachStdin: spec.attachStdin ?? true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: spec.tty ?? true,
      Cmd: [...spec.cmd],
    };
    if (spec.env !== undefined) body['Env'] = [...spec.env];
    if (spec.workingDir !== undefined) body['WorkingDir'] = spec.workingDir;
    if (spec.user !== undefined) body['User'] = spec.user;

    const created = await this.json<{ Id?: string }>(
      'POST',
      `/containers/${encodeURIComponent(container)}/exec`,
      body,
    );
    if (typeof created.Id !== 'string' || created.Id === '') {
      throw new DockerApiError(502, 'Docker did not return an exec id.');
    }
    return created.Id;
  }

  /**
   * Starts the exec and hijacks the connection. With `Tty: true` the returned
   * stream is the raw PTY: no stdout/stderr multiplexing header, so bytes can
   * be forwarded to the browser untouched.
   */
  startExec(execId: string, size?: TerminalSize, tty = true): Promise<Duplex> {
    const body: Record<string, unknown> = { Detach: false, Tty: tty };
    if (size !== undefined) {
      body['ConsoleSize'] = [size.rows, size.cols];
    }
    return this.hijack(`/exec/${encodeURIComponent(execId)}/start`, body);
  }

  /**
   * Runs a command inside a container and collects everything it printed.
   *
   * No PTY and no stdin: the process must not be able to block on input, and
   * the daemon's multiplexed framing keeps stderr — the only thing a failing
   * git command really says — separate from stdout.
   *
   * A timeout only drops *our* end of the stream; the process inside the
   * container keeps running, so a caller that times out should also get rid of
   * the container.
   */
  async runExec(container: string, spec: ExecSpec, timeoutMs?: number): Promise<ExecOutput> {
    return this.streamExec(container, spec, timeoutMs === undefined ? {} : { timeoutMs });
  }

  /**
   * The same run, with the output delivered as it is produced (US-016).
   *
   * A build iteration is an hour-long `claude -p`, so waiting for the process
   * to exit before anyone can see a byte of it is not an option. The frames are
   * decoded incrementally by a {@link FrameDecoder} — a payload can be split
   * across two reads, and so can a UTF-8 sequence inside it — and handed to
   * `onOutput` chunk by chunk. What is retained for the return value is capped
   * separately, because the caller doing the streaming usually keeps its own.
   */
  async streamExec(
    container: string,
    spec: ExecSpec,
    options: StreamExecOptions = {},
  ): Promise<ExecOutput> {
    const execId = await this.createExec(container, { ...spec, tty: false, attachStdin: false });
    const stream = await this.startExec(execId, undefined, false);

    const decoder = new FrameDecoder();
    const stdout = new TailBuffer(options.maxOutputChars);
    const stderr = new TailBuffer(options.maxOutputChars);
    const take = (chunks: readonly ExecChunk[]): void => {
      for (const chunk of chunks) {
        (chunk.stream === 'stderr' ? stderr : stdout).push(chunk.text);
        options.onOutput?.(chunk);
      }
    };

    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            stream.destroy();
          }, options.timeoutMs);

    try {
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => take(decoder.push(chunk)));
        stream.on('end', resolve);
        stream.on('close', resolve);
        // A destroyed stream reports the abort as an error; that is the
        // timeout we caused, not a failure to report.
        stream.on('error', (error: Error) => (timedOut ? resolve() : reject(error)));
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      stream.destroy();
    }
    take(decoder.flush());

    if (timedOut) {
      return { exitCode: null, stdout: stdout.text, stderr: stderr.text, timedOut: true };
    }
    const state = await this.inspectExec(execId);
    return { exitCode: state.exitCode, stdout: stdout.text, stderr: stderr.text, timedOut: false };
  }

  async resizeExec(execId: string, size: TerminalSize): Promise<void> {
    await this.json(
      'POST',
      `/exec/${encodeURIComponent(execId)}/resize?h=${size.rows}&w=${size.cols}`,
    );
  }

  async inspectExec(execId: string): Promise<ExecState> {
    const raw = await this.json<RawExecInspect>('GET', `/exec/${encodeURIComponent(execId)}/json`);
    const running = raw.Running === true;
    return {
      running,
      exitCode: running ? null : typeof raw.ExitCode === 'number' ? raw.ExitCode : null,
      pid: typeof raw.Pid === 'number' ? raw.Pid : 0,
    };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, `/v${await this.apiVersion()}${path}`, body);
    if (response.status < 200 || response.status >= 300) {
      throw new DockerApiError(response.status, messageOf(response.body));
    }
    if (response.body === '') return undefined as T;
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new DockerApiError(502, 'Docker returned a body that is not JSON.');
    }
  }

  private send(method: string, path: string, body?: unknown): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      const request = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            host: 'docker',
            ...(payload === undefined
              ? {}
              : { 'content-type': 'application/json', 'content-length': payload.length }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );

      request.on('error', reject);
      request.end(payload);
    });
  }

  /**
   * Issues a request that upgrades to a raw TCP stream. Any bytes the daemon
   * already sent alongside the 101 arrive in `head` and are pushed back onto
   * the stream so the caller sees a single ordered sequence.
   */
  private async hijack(path: string, body: unknown): Promise<Duplex> {
    const versioned = `/v${await this.apiVersion()}${path}`;
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const request = http.request({
        socketPath: this.socketPath,
        path: versioned,
        method: 'POST',
        // Pooling would hand this socket to a later request; it belongs to the
        // PTY for as long as the process lives.
        agent: false,
        headers: {
          host: 'docker',
          'content-type': 'application/json',
          'content-length': payload.length,
          connection: 'Upgrade',
          upgrade: 'tcp',
        },
      });

      request.on('upgrade', (_response, socket: Duplex, head: Buffer) => {
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });

      // The daemon answers normally (rather than upgrading) when it refuses.
      request.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          reject(
            new DockerApiError(
              response.statusCode ?? 0,
              messageOf(Buffer.concat(chunks).toString('utf8')),
            ),
          );
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }
}

interface RawContainer {
  Id?: unknown;
  Names?: unknown;
  Image?: unknown;
  State?: unknown;
  Status?: unknown;
  Labels?: unknown;
}

interface RawContainerInspect {
  Id: string;
  Name?: string;
  State?: { Running?: boolean; Status?: string; ExitCode?: number };
  Config?: { Image?: string; Labels?: unknown };
}

interface RawVolume {
  Name?: unknown;
  Mountpoint?: unknown;
}

interface RawExecInspect {
  Running?: boolean;
  ExitCode?: number;
  Pid?: number;
}

function toContainerSummary(raw: RawContainer): ContainerSummary {
  const names = Array.isArray(raw.Names) ? raw.Names.filter((n) => typeof n === 'string') : [];
  const id = typeof raw.Id === 'string' ? raw.Id : '';
  return {
    id,
    name: stripLeadingSlash(names[0] ?? id.slice(0, 12)),
    image: typeof raw.Image === 'string' ? raw.Image : '',
    state: typeof raw.State === 'string' ? raw.State : 'unknown',
    status: typeof raw.Status === 'string' ? raw.Status : '',
    labels: isStringRecord(raw.Labels) ? raw.Labels : {},
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripLeadingSlash(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

/** `1.44` → `[1, 44]`; anything unparseable sorts lowest. */
function parseVersion(value: string): [number, number] {
  const match = /^(\d+)\.(\d+)$/.exec(value.trim());
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])];
}

function isAtLeast(value: string, floor: string): boolean {
  const [major, minor] = parseVersion(value);
  const [floorMajor, floorMinor] = parseVersion(floor);
  return major > floorMajor || (major === floorMajor && minor >= floorMinor);
}

/** Clamps {@link PREFERRED_DOCKER_API_VERSION} into the daemon's window. */
export function chooseApiVersion(highest?: string, lowest?: string): string {
  if (highest !== undefined && !isAtLeast(highest, PREFERRED_DOCKER_API_VERSION)) return highest;
  if (lowest !== undefined && !isAtLeast(PREFERRED_DOCKER_API_VERSION, lowest)) return lowest;
  return PREFERRED_DOCKER_API_VERSION;
}

/** Docker error bodies are `{"message":"…"}`; fall back to the raw text. */
function messageOf(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && 'message' in parsed) {
      const message = (parsed as { message: unknown }).message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Not JSON.
  }
  return body.trim();
}

/** Stream ids in the daemon's multiplexed exec framing. */
const STREAM_STDIN = 0;
const STREAM_STDERR = 2;
/** `[stream, 0, 0, 0, size:uint32be]`. */
const FRAME_HEADER_BYTES = 8;

/**
 * Splits a non-TTY exec stream into stdout and stderr.
 *
 * Docker prefixes every write with an 8-byte header naming the stream and the
 * payload length. Anything that does not look like a header — a TTY stream that
 * reached this function by mistake, or a truncated frame — is taken as stdout
 * rather than dropped: output the caller can read beats a parse error.
 */
export function demultiplex(raw: Buffer): { stdout: string; stderr: string } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let offset = 0;

  while (offset < raw.length) {
    if (offset + FRAME_HEADER_BYTES > raw.length || !isFrameHeader(raw, offset)) {
      stdout.push(raw.subarray(offset));
      break;
    }
    const stream = raw.readUInt8(offset);
    const size = raw.readUInt32BE(offset + 4);
    const start = offset + FRAME_HEADER_BYTES;
    const end = Math.min(start + size, raw.length);
    (stream === STREAM_STDERR ? stderr : stdout).push(raw.subarray(start, end));
    offset = end;
  }

  return {
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  };
}

function isFrameHeader(raw: Buffer, offset: number): boolean {
  const stream = raw.readUInt8(offset);
  if (stream < STREAM_STDIN || stream > STREAM_STDERR) return false;
  return raw.readUInt8(offset + 1) === 0 && raw.readUInt8(offset + 2) === 0 && raw.readUInt8(offset + 3) === 0;
}

/**
 * Incremental version of {@link demultiplex} for a stream read chunk by chunk.
 *
 * Two things can be split across two reads and neither may be guessed at: a
 * frame (its 8-byte header, or its payload) and a UTF-8 sequence *inside* a
 * payload. So the bytes are held until a whole frame is there, and each stream
 * gets its own {@link StringDecoder} that carries a half-finished character
 * over to the next chunk.
 *
 * Anything that does not look like a header puts the decoder into raw mode for
 * good and is reported as stdout — the same leniency as `demultiplex`, and what
 * makes a TTY stream that reached it by mistake still readable.
 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);
  private raw = false;
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  };

  /** Everything `chunk` completed, oldest first. */
  push(chunk: Buffer): ExecChunk[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const out: ExecChunk[] = [];

    for (;;) {
      if (this.raw) {
        this.emit(out, 'stdout', this.pending);
        this.pending = Buffer.alloc(0);
        return out;
      }
      if (this.pending.length < FRAME_HEADER_BYTES) return out;
      if (!isFrameHeader(this.pending, 0)) {
        this.raw = true;
        continue;
      }
      const size = this.pending.readUInt32BE(4);
      if (this.pending.length < FRAME_HEADER_BYTES + size) return out;
      const stream = this.pending.readUInt8(0) === STREAM_STDERR ? 'stderr' : 'stdout';
      this.emit(out, stream, this.pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + size));
      this.pending = this.pending.subarray(FRAME_HEADER_BYTES + size);
    }
  }

  /** Whatever is left when the stream ends: a truncated frame is not dropped. */
  flush(): ExecChunk[] {
    const out: ExecChunk[] = [];
    if (this.pending.length > 0) {
      const framed = !this.raw && this.pending.length >= FRAME_HEADER_BYTES && isFrameHeader(this.pending, 0);
      const stream = framed && this.pending.readUInt8(0) === STREAM_STDERR ? 'stderr' : 'stdout';
      this.emit(out, stream, framed ? this.pending.subarray(FRAME_HEADER_BYTES) : this.pending);
      this.pending = Buffer.alloc(0);
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const tail = this.decoders[stream].end();
      if (tail !== '') out.push({ stream, text: tail });
    }
    return out;
  }

  private emit(out: ExecChunk[], stream: 'stdout' | 'stderr', payload: Buffer): void {
    const text = this.decoders[stream].write(payload);
    if (text !== '') out.push({ stream, text });
  }
}

/**
 * A string that only ever keeps its last `max` characters.
 *
 * The interesting end of a command that produced megabytes is the end of it,
 * and an unbounded accumulator behind an hour-long agent run is a leak.
 */
class TailBuffer {
  private value = '';

  constructor(private readonly max?: number) {}

  get text(): string {
    return this.value;
  }

  push(chunk: string): void {
    this.value += chunk;
    if (this.max !== undefined && this.value.length > this.max) {
      this.value = this.value.slice(this.value.length - this.max);
    }
  }
}
