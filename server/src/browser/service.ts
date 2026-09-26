/**
 * One headless Chromium per session, inside the session's container (voice
 * feedback US-005), shared by the session agent and the operator.
 *
 * Chromium's DevTools port stays on the container's loopback and no port is
 * published. The server talks CDP through `cdp-relay.js`, a script shipped in
 * the runner image and run with `attachExec`: one CDP message per line on its
 * stdin and stdout. Chromium itself runs as uid 1000 under the build agents'
 * pid-file wrapper, so {@link BrowserService.stop} can signal it the same way
 * the voice agents are signalled.
 *
 * Nothing reconnects. When Chromium or the relay goes, the browser is closed:
 * every pending {@link BrowserService.send} rejects with {@link BrowserError}
 * `browser_closed`, subscribers get a `closed` event carrying
 * {@link BROWSER_CLOSED_MESSAGE}, what is left of the pair is signalled, and
 * the next {@link BrowserService.start} starts a fresh one.
 *
 * Limits (US-012): one browser per session and at most `maxBrowsers` in all,
 * anything beyond answered {@link NO_BROWSER_MESSAGE}; a container with less
 * than {@link MIN_BROWSER_MEMORY_BYTES} of memory gets none; a browser that
 * had no frame request and no tool call for `idleMs` is stopped. A Chromium
 * that exits on its own within {@link STARTUP_WINDOW_MS} failed to start: its
 * stderr tail is logged and the cause is what the start (or the `closed`
 * event) reports.
 */
import { pidFileSignalSpec, wrapWithPidFile } from '../build/agent.js';
import type { AttachedExec, ExecOutput, ExecSpec, ExecState } from '../docker/index.js';
import { logger } from '../lib/logger.js';

/** Directory inside the session container for the browser's pid file and profile. */
export const BROWSER_DIR = '/tmp/.chief-browser';
/** Chromium's profile; inside {@link BROWSER_DIR}, which is also what identifies its processes. */
export const BROWSER_PROFILE_DIR = `${BROWSER_DIR}/profile`;
/** The DevTools port, on the container's loopback only. */
export const CDP_PORT = 9222;
/** The relay script the runner image ships (`runner/cdp-relay.js`). */
export const CDP_RELAY_SCRIPT = '/usr/local/lib/chief-web/cdp-relay.js';
/** The container's unprivileged user, the one agents and terminals run as. */
export const BROWSER_USER = '1000';
/** What the page view says, and a failed send reports, once the browser is gone. */
export const BROWSER_CLOSED_MESSAGE = 'Browser closed';

/** What the agent hears when every browser slot is taken. */
export const NO_BROWSER_MESSAGE = 'no browser available right now';
/** The memory a session container needs before Chromium is started in it. */
export const MIN_BROWSER_MEMORY_BYTES = 1024 ** 3;
/** How long a browser may go without a frame request or a tool call; `VOICE_BROWSER_IDLE_MS` in production. */
export const DEFAULT_BROWSER_IDLE_MS = 10 * 60_000;
/** A Chromium that exits on its own this soon after its start failed to start. */
export const STARTUP_WINDOW_MS = 5_000;

/** Part of every Chromium process's command line, so the signal hits only ours. */
const PROCESS_MATCH = 'chief-browser';
/** How long the relay may take to find Chromium's page and connect to it. */
const READY_TIMEOUT_MS = 20_000;
/** How long the TERM through the pid file may take. */
const SIGNAL_TIMEOUT_MS = 10_000;
/** How long {@link BrowserService.stop} waits for both execs to end before dropping them. */
const STOP_GRACE_MS = 5_000;
/** Stderr kept to explain a relay that never became ready, or a Chromium that died. */
const STDERR_TAIL_CHARS = 2_000;
/** How long the memory probe may take. */
const PROBE_TIMEOUT_MS = 10_000;
/** How TERM through the pid file ends Chromium (128 + 15); any other exit is its own. */
const TERM_EXIT_CODE = 143;

export function browserPidFile(sessionId: string): string {
  return `${BROWSER_DIR}/${sessionId}.pid`;
}

/** `chromium` with the flags of the story, headless and listening on the loopback. */
export function chromiumCommand(): string[] {
  return [
    'chromium',
    '--headless=new',
    `--remote-debugging-port=${String(CDP_PORT)}`,
    '--remote-debugging-address=127.0.0.1',
    '--no-sandbox',
    '--disable-gpu',
    '--window-size=1280,800',
    `--user-data-dir=${BROWSER_PROFILE_DIR}`,
  ];
}

/** Chromium as uid 1000 under the pid-file wrapper. */
export function chromiumExecSpec(sessionId: string): ExecSpec {
  return {
    cmd: wrapWithPidFile(BROWSER_DIR, browserPidFile(sessionId), 'chief-browser', chromiumCommand()),
    user: BROWSER_USER,
  };
}

/** The stdio relay to Chromium's page, as uid 1000. */
export function relayExecSpec(): ExecSpec {
  return { cmd: ['node', CDP_RELAY_SCRIPT], user: BROWSER_USER };
}

/** Prints the container's cgroup memory limit: v2's `memory.max`, else v1's `memory.limit_in_bytes`. */
export function memoryLimitSpec(): ExecSpec {
  return {
    cmd: [
      '/bin/sh',
      '-c',
      'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true',
    ],
    user: BROWSER_USER,
    tty: false,
    attachStdin: false,
  };
}

/** The limit {@link memoryLimitSpec} printed, in bytes; null for none (`max`, cgroup v1's huge number) or unreadable. */
export function parseMemoryLimit(output: string): number | null {
  const text = output.trim().split('\n')[0]?.trim() ?? '';
  if (!/^\d+$/.test(text)) return null;
  const bytes = Number(text);
  // cgroup v1 reports "no limit" as a page-rounded 2^63.
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

/** "512 MB", "1.5 GB": what the refusal says. */
export function formatMemory(bytes: number): string {
  const mb = bytes / 1024 ** 2;
  if (mb < 1024) return `${String(Math.round(mb))} MB`;
  return `${String(Math.round((mb / 1024) * 10) / 10)} GB`;
}

/** What the page view says after an idle stop. */
export function idleClosedMessage(idleMs: number): string {
  const [amount, unit] = idleMs < 60_000 ? [Math.round(idleMs / 1_000), 'second'] : [Math.round(idleMs / 60_000), 'minute'];
  return `Browser closed after ${String(amount)} ${unit}${amount === 1 ? '' : 's'} without use`;
}

/**
 * Why Chromium did not start, from its exit code and stderr: a missing binary
 * (`exec` in the pid-file wrapper exits 127) or a crash with its last line.
 */
export function chromiumStartFailure(exitCode: number | null, stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const last = lines.at(-1)?.slice(0, 300) ?? '';
  if (exitCode === 127 || /chromium: (not found|No such file)/i.test(stderr)) {
    return `Chromium is not installed in the session container${last === '' ? '' : ` (${last})`}`;
  }
  const code = exitCode === null ? '' : ` with exit code ${String(exitCode)}`;
  return `Chromium crashed while starting${code}${last === '' ? '' : `: ${last}`}`;
}

/** Signals the session's Chromium through its pid file, and removes the file. */
export function browserSignalSpec(sessionId: string, signal = 'TERM'): ExecSpec {
  return pidFileSignalSpec(browserPidFile(sessionId), signal, { remove: true, match: PROCESS_MATCH });
}

/** A refusal or failure, with the code a route or tool reports. */
export class BrowserError extends Error {
  constructor(
    readonly code: 'browser_closed' | 'browser_unavailable' | 'browser_limit' | 'browser_memory' | 'cdp_error',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserError';
  }
}

/** What subscribers hear: every CDP event of the page, then `closed` once. */
export type BrowserEvent =
  | { readonly type: 'cdp'; readonly method: string; readonly params: Record<string, unknown> }
  | {
      readonly type: 'closed';
      /** False when {@link BrowserService.stop} was asked (or it idled out); true when Chromium or the relay died. */
      readonly crashed: boolean;
      /** {@link BROWSER_CLOSED_MESSAGE}, or why: an idle stop, or Chromium failing to start. */
      readonly message: string;
    };

export type BrowserListener = (event: BrowserEvent) => void;

/** A running browser, as {@link BrowserService.start} reports it. */
export interface BrowserInfo {
  readonly sessionId: string;
  readonly containerId: string;
  /** The page target the relay is attached to; the one tab everyone shares. */
  readonly targetId: string;
}

/** The slice of `DockerApi` the browser needs; the fake daemon's client in tests. */
export interface BrowserDocker {
  attachExec(container: string, spec: ExecSpec): Promise<AttachedExec>;
  runExec(container: string, spec: ExecSpec, timeoutMs?: number): Promise<ExecOutput>;
  inspectExec(execId: string): Promise<ExecState>;
}

export interface BrowserServiceDeps {
  readonly docker: BrowserDocker;
  /** The session's running container id, started if need be. */
  readonly container: (sessionId: string) => Promise<string>;
  /** Browsers running at once, all sessions together; `VOICE_MAX_SESSION_AGENTS` in production. */
  readonly maxBrowsers?: number;
  /** {@link DEFAULT_BROWSER_IDLE_MS} unless given. */
  readonly idleMs?: number;
  /** {@link STARTUP_WINDOW_MS} unless given; tests of a later crash pass 0. */
  readonly startupWindowMs?: number;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** One Chromium and its relay. */
class Browser {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<BrowserListener>();
  private closedFlag = false;
  private stopRequested = false;
  private targetId: string | null = null;
  private stderr = '';
  private chromiumStderr = '';
  /** Why Chromium failed to start, once it exited on its own inside the startup window. */
  private startFailure: string | null = null;
  /** What the `closed` event says when the stop was asked with a reason (an idle stop). */
  private stopMessage: string | null = null;
  private readonly startedAt = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private lastActivity = Date.now();
  private readyWaiter: { resolve(targetId: string): void; reject(error: Error): void } | null = null;
  readonly chromiumFinished: Promise<void>;
  readonly relayFinished: Promise<void>;

  constructor(
    private readonly docker: BrowserDocker,
    readonly sessionId: string,
    readonly containerId: string,
    private readonly chromium: AttachedExec,
    private readonly relay: AttachedExec,
    private readonly startupWindowMs: number,
  ) {
    this.chromiumFinished = this.drainChromium();
    this.relayFinished = this.readRelay();
  }

  /** The cause of a failed start, when Chromium itself failed; null when it did not (yet). */
  get failure(): string | null {
    return this.startFailure;
  }

  /** A frame request or a tool call: the idle clock starts over. */
  touch(): void {
    this.lastActivity = Date.now();
  }

  /** Calls `onIdle` once nothing touched the browser for `idleMs`. */
  watchIdle(idleMs: number, onIdle: () => void): void {
    const check = (): void => {
      this.idleTimer = null;
      if (this.closedFlag) return;
      const left = this.lastActivity + idleMs - Date.now();
      if (left > 0) {
        this.idleTimer = setTimeout(check, left);
        this.idleTimer.unref();
        return;
      }
      onIdle();
    };
    this.idleTimer = setTimeout(check, idleMs);
    this.idleTimer.unref();
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  info(): BrowserInfo {
    return { sessionId: this.sessionId, containerId: this.containerId, targetId: this.targetId ?? '' };
  }

  /** Resolves with the page's target id once the relay is connected. */
  ready(timeoutMs: number): Promise<string> {
    if (this.targetId !== null) return Promise.resolve(this.targetId);
    if (this.closedFlag) return Promise.reject(this.unavailable());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        reject(new BrowserError('browser_unavailable', 'The browser did not come up in time.'));
      }, timeoutMs);
      timer.unref();
      this.readyWaiter = {
        resolve: (targetId) => {
          clearTimeout(timer);
          resolve(targetId);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closedFlag) return Promise.reject(new BrowserError('browser_closed', BROWSER_CLOSED_MESSAGE));
    this.touch();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.relay.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  subscribe(listener: BrowserListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ends it on purpose; see {@link BrowserService.stop}. `message` is what the `closed` event says. */
  async stop(signal: string, message?: string): Promise<void> {
    this.stopRequested = true;
    if (message !== undefined) this.stopMessage = message;
    await this.signalChromium(signal);
    this.relay.stdin.end();
    this.chromium.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const both = Promise.all([this.chromiumFinished, this.relayFinished]);
    const grace = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), STOP_GRACE_MS);
      timer.unref();
    });
    const outcome = await Promise.race([both.then(() => 'ended' as const), grace]);
    clearTimeout(timer);
    if (outcome === 'late') {
      this.relay.stdin.destroy();
      this.chromium.stdin.destroy();
    }
    await both;
    this.close();
  }

  private async signalChromium(signal: string): Promise<void> {
    try {
      await this.docker.runExec(this.containerId, browserSignalSpec(this.sessionId, signal), SIGNAL_TIMEOUT_MS);
    } catch (cause) {
      logger.warn('could not signal the session browser', { session: this.sessionId, error: String(cause) });
    }
  }

  /** Chromium is chatty on stderr; an unread hijacked socket would stall it. Its end is its death. */
  private async drainChromium(): Promise<void> {
    try {
      for await (const chunk of this.chromium.output) {
        if (chunk.stream === 'stderr') this.chromiumStderr = (this.chromiumStderr + chunk.text).slice(-STDERR_TAIL_CHARS);
        logger.debug('session browser output', { session: this.sessionId, text: chunk.text.slice(0, 500) });
      }
      await this.explainExit();
    } finally {
      this.gone('chromium');
    }
  }

  /** A Chromium that ended on its own inside the startup window failed to start; say why. */
  private async explainExit(): Promise<void> {
    if (this.stopRequested || Date.now() - this.startedAt >= this.startupWindowMs) return;
    let exitCode: number | null = null;
    try {
      exitCode = (await this.docker.inspectExec(this.chromium.execId)).exitCode;
    } catch {
      // The cause then rests on stderr alone.
    }
    // Our own TERM (after the relay died) is not Chromium failing.
    if (exitCode === TERM_EXIT_CODE) return;
    this.startFailure = chromiumStartFailure(exitCode, this.chromiumStderr);
    logger.warn('the session browser failed to start', {
      session: this.sessionId,
      exitCode,
      cause: this.startFailure,
      stderr: this.chromiumStderr.slice(-1_000),
    });
  }

  private async readRelay(): Promise<void> {
    let partial = '';
    try {
      for await (const chunk of this.relay.output) {
        if (chunk.stream === 'stderr') {
          this.stderr = (this.stderr + chunk.text).slice(-STDERR_TAIL_CHARS);
          continue;
        }
        const lines = (partial + chunk.text).split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) this.onLine(line);
      }
      if (partial !== '') this.onLine(partial);
    } finally {
      this.gone('relay');
    }
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      logger.debug('session browser relay printed a non-JSON line', { session: this.sessionId, line: line.slice(0, 200) });
      return;
    }

    if (message['relay'] === 'ready') {
      this.targetId = typeof message['targetId'] === 'string' ? message['targetId'] : '';
      this.readyWaiter?.resolve(this.targetId);
      this.readyWaiter = null;
      return;
    }

    if (typeof message['id'] === 'number') {
      const waiter = this.pending.get(message['id']);
      if (waiter === undefined) return;
      this.pending.delete(message['id']);
      const error = message['error'];
      if (typeof error === 'object' && error !== null) {
        const text = (error as { message?: unknown }).message;
        waiter.reject(new BrowserError('cdp_error', typeof text === 'string' ? text : 'The browser refused the command.'));
      } else {
        waiter.resolve(message['result'] ?? {});
      }
      return;
    }

    if (typeof message['method'] === 'string') {
      const params = message['params'];
      this.emit({
        type: 'cdp',
        method: message['method'],
        params: typeof params === 'object' && params !== null ? (params as Record<string, unknown>) : {},
      });
    }
  }

  /** One half of the pair ended; the browser is closed, and the other half is made to follow. */
  private gone(which: 'chromium' | 'relay'): void {
    if (this.closedFlag) return;
    if (this.stopRequested) {
      this.close();
      return;
    }
    logger.warn('session browser exited', { session: this.sessionId, which, stderr: this.stderr.slice(-500) });
    // A Chromium left without its relay would keep the port and the profile
    // lock, and a relay without its Chromium has nothing to talk to.
    if (which === 'relay') void this.signalChromium('TERM');
    this.relay.stdin.end();
    this.chromium.stdin.end();
    if (which === 'chromium') {
      this.close();
      return;
    }
    // A relay usually dies *because* Chromium did: wait for Chromium's own exit,
    // so a failed start is reported as its cause and not as a lost connection.
    const grace = new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS).unref());
    void Promise.race([this.chromiumFinished, grace]).then(() => this.close());
  }

  private close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.readyWaiter?.reject(this.unavailable());
    this.readyWaiter = null;
    const error = new BrowserError('browser_closed', BROWSER_CLOSED_MESSAGE);
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.emit({
      type: 'closed',
      crashed: !this.stopRequested,
      message: this.stopMessage ?? this.startFailure ?? BROWSER_CLOSED_MESSAGE,
    });
    this.listeners.clear();
  }

  private unavailable(): BrowserError {
    if (this.startFailure !== null) return new BrowserError('browser_unavailable', this.startFailure);
    const detail = this.stderr.trim().split('\n').pop() ?? '';
    return new BrowserError(
      'browser_unavailable',
      detail === '' ? 'The browser could not be started.' : `The browser could not be started: ${detail}`,
    );
  }

  private emit(event: BrowserEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (cause) {
        logger.warn('a session browser listener threw', { session: this.sessionId, error: String(cause) });
      }
    }
  }
}

/** The browsers of every session: at most one each. */
export class BrowserService {
  private readonly browsers = new Map<string, Browser>();
  private readonly starting = new Map<string, Promise<Browser>>();

  constructor(private readonly deps: BrowserServiceDeps) {}

  /** The session's running browser, started when there is none; two calls share one start. */
  async start(sessionId: string): Promise<BrowserInfo> {
    const live = this.live(sessionId);
    if (live !== null) return live.info();
    let run = this.starting.get(sessionId);
    if (run === undefined) {
      const others = [...new Set([...this.browsers.keys(), ...this.starting.keys()])].filter(
        (id) => id !== sessionId && (this.starting.has(id) || this.live(id) !== null),
      );
      if (others.length >= (this.deps.maxBrowsers ?? Infinity)) {
        logger.info('no session browser slot left', { session: sessionId, running: others.length });
        throw new BrowserError('browser_limit', NO_BROWSER_MESSAGE);
      }
      run = this.launch(sessionId).finally(() => this.starting.delete(sessionId));
      this.starting.set(sessionId, run);
    }
    return (await run).info();
  }

  /**
   * The session's browser once a start already under way has finished; `null`
   * when none is running or starting. Never launches one, so a viewer
   * reconnecting after a crash cannot bring a fresh Chromium up by itself.
   */
  async whenRunning(sessionId: string): Promise<BrowserInfo | null> {
    const starting = this.starting.get(sessionId);
    if (starting !== undefined) await starting.catch(() => undefined);
    return this.live(sessionId)?.info() ?? null;
  }

  isRunning(sessionId: string): boolean {
    return this.live(sessionId) !== null;
  }

  /** The agent used the browser (a tool call): its idle clock starts over. Every {@link send} does the same. */
  touch(sessionId: string): void {
    this.live(sessionId)?.touch();
  }

  /**
   * One CDP command to the shared page; resolves with its `result`. Rejects
   * with {@link BrowserError}: `browser_closed` when there is no browser or it
   * died meanwhile, `cdp_error` when Chromium refused the command.
   */
  send(sessionId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const browser = this.live(sessionId);
    if (browser === null) return Promise.reject(new BrowserError('browser_closed', BROWSER_CLOSED_MESSAGE));
    return browser.send(method, params);
  }

  /**
   * Every CDP event of the session's page (enable a domain with {@link send}
   * first), then one `closed` event. Returns the unsubscribe; `null` when no
   * browser is running.
   */
  subscribe(sessionId: string, listener: BrowserListener): (() => void) | null {
    return this.live(sessionId)?.subscribe(listener) ?? null;
  }

  /** Stops the session's browser, if it has one: TERM through the pid file, then the relay's stdin closed. */
  async stop(sessionId: string, signal = 'TERM', message?: string): Promise<void> {
    const starting = this.starting.get(sessionId);
    if (starting !== undefined) await starting.catch(() => undefined);
    const browser = this.browsers.get(sessionId);
    this.browsers.delete(sessionId);
    await browser?.stop(signal, message);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...new Set([...this.browsers.keys(), ...this.starting.keys()])].map((id) => this.stop(id)));
  }

  private live(sessionId: string): Browser | null {
    const browser = this.browsers.get(sessionId);
    if (browser === undefined) return null;
    if (!browser.closed) return browser;
    this.browsers.delete(sessionId);
    return null;
  }

  private async launch(sessionId: string): Promise<Browser> {
    let containerId: string;
    try {
      containerId = await this.deps.container(sessionId);
    } catch (cause) {
      throw new BrowserError(
        'browser_unavailable',
        `The session container could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    await this.checkMemory(sessionId, containerId);
    const chromium = await this.deps.docker.attachExec(containerId, chromiumExecSpec(sessionId));
    let relay: AttachedExec;
    try {
      relay = await this.deps.docker.attachExec(containerId, relayExecSpec());
    } catch (cause) {
      chromium.stdin.destroy();
      await this.deps.docker
        .runExec(containerId, browserSignalSpec(sessionId), SIGNAL_TIMEOUT_MS)
        .catch(() => undefined);
      throw cause;
    }
    const browser = new Browser(
      this.deps.docker,
      sessionId,
      containerId,
      chromium,
      relay,
      this.deps.startupWindowMs ?? STARTUP_WINDOW_MS,
    );
    try {
      await browser.ready(READY_TIMEOUT_MS);
    } catch (cause) {
      await browser.stop('TERM');
      // The relay can give up before Chromium's exit is read: name Chromium's cause when it has one.
      const failure = browser.failure;
      throw failure === null ? cause : new BrowserError('browser_unavailable', failure);
    }
    this.browsers.set(sessionId, browser);
    const idleMs = this.deps.idleMs ?? DEFAULT_BROWSER_IDLE_MS;
    browser.watchIdle(idleMs, () => {
      if (this.browsers.get(sessionId) !== browser) return;
      logger.info('stopping an idle session browser', { session: sessionId, idleMs });
      this.stop(sessionId, 'TERM', idleClosedMessage(idleMs)).catch((cause: unknown) => {
        logger.warn('could not stop an idle session browser', { session: sessionId, error: String(cause) });
      });
    });
    return browser;
  }

  /** Chromium needs {@link MIN_BROWSER_MEMORY_BYTES}; a container with a lower limit gets no browser. */
  private async checkMemory(sessionId: string, containerId: string): Promise<void> {
    let limit: number | null = null;
    try {
      limit = parseMemoryLimit((await this.deps.docker.runExec(containerId, memoryLimitSpec(), PROBE_TIMEOUT_MS)).stdout);
    } catch (cause) {
      logger.warn('could not read the session container memory limit', { session: sessionId, error: String(cause) });
    }
    if (limit === null || limit >= MIN_BROWSER_MEMORY_BYTES) return;
    logger.warn('refusing to start a browser in a small container', { session: sessionId, limitBytes: limit });
    throw new BrowserError(
      'browser_memory',
      `the session container has only ${formatMemory(limit)} of memory and the browser needs at least ${formatMemory(MIN_BROWSER_MEMORY_BYTES)}; raise CONTAINER_MEMORY_LIMIT_MB`,
    );
  }
}
