import type { BrowserInfo, BrowserListener } from '../browser/index.js';
import type { AttachedExec, ExecOutput, ExecSpec, ExecState } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import type { CallClock } from './call.js';
import type { BrowserAskOutcome, BrowserCredentials, SavedLoginView, ServerMessage } from './protocol.js';

/**
 * The "watch with me" card (voice feedback US-007): the server's half of the
 * `chief` MCP server's `open_browser_with_operator` tool (`runner/chief-mcp.js`).
 *
 * The tool writes `<BROWSER_REQUEST_DIR>/<id>.request` in the session container
 * and waits for `<id>.answer`. When the session agent's stream shows the tool
 * call, the call asks this relay, which starts the session's browser, finds
 * the request, and sends the panel `browser.ask`. **Open** writes the URL and
 * the login into the answer file (mode 600, uid 1000, through stdin so the
 * password is never on a command line); **Cancel**, expiry and the end of the
 * call write `{ cancelled: true }`. Nothing of an answer is ever sent back
 * over the socket.
 */

/** Where the MCP server and the relay meet inside the container. */
export const BROWSER_REQUEST_DIR = '/tmp/.chief-voice/browser';
/** uid of the session agent, and so of its MCP server. */
export const BROWSER_ASK_USER = '1000';
/** How long the MCP server waits for an answer. */
export const BROWSER_ANSWER_TIMEOUT_MS = 5 * 60_000;
/**
 * How long the card stays up: a little less than the tool waits, so an
 * expiry is always written before the tool gives up, and a late **Open**
 * never leaves a login in a file nobody reads.
 */
export const BROWSER_ASK_TTL_MS = BROWSER_ANSWER_TIMEOUT_MS - 15_000;
/** How long the relay looks for the request file after the tool call showed up on the stream. */
export const REQUEST_DISCOVERY_MS = 10_000;
export const REQUEST_POLL_MS = 250;
const EXEC_TIMEOUT_MS = 10_000;

/** What the MCP server writes; the id names both files. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The answer file, as `runner/chief-mcp.js` reads it. */
export type BrowserAnswerFile =
  | {
      readonly id: string;
      readonly cancelled: false;
      readonly url: string;
      readonly credentials?: { readonly username: string; readonly password: string };
    }
  | { readonly id: string; readonly cancelled: true; readonly reason?: string };

/** Lists every pending request file, one JSON object per line. */
export function listRequestsSpec(): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', `for f in ${BROWSER_REQUEST_DIR}/*.request; do [ -f "$f" ] && cat "$f" && echo; done; true`],
    user: BROWSER_ASK_USER,
    tty: false,
    attachStdin: false,
  };
}

/**
 * Writes stdin to `<id>.answer`, owner-only, then renames it into place so
 * the MCP server never reads half a file. `id` must match {@link REQUEST_ID}.
 */
export function answerWriteSpec(id: string): ExecSpec {
  if (!REQUEST_ID.test(id)) throw new Error(`not a request id: ${id}`);
  const file = `${BROWSER_REQUEST_DIR}/${id}.answer`;
  return {
    cmd: ['/bin/sh', '-c', `umask 077 && mkdir -p ${BROWSER_REQUEST_DIR} && cat > ${file}.tmp && mv ${file}.tmp ${file}`],
    user: BROWSER_ASK_USER,
    tty: false,
    attachStdin: true,
  };
}

/** The slice of `DockerApi` the relay uses. */
export interface BrowserAskDocker {
  runExec(container: string, spec: ExecSpec, timeoutMs?: number): Promise<ExecOutput>;
  attachExec(container: string, spec: ExecSpec): Promise<AttachedExec>;
  inspectExec(execId: string): Promise<ExecState>;
}

/** A repository's saved logins (US-010); without them the card lists none. */
export interface BrowserSavedLogins {
  list(sessionId: string): readonly SavedLoginView[];
  /** The saved login's username and password, or null when it is not one of the session's repository. */
  resolve(sessionId: string, savedLoginId: string): { readonly username: string; readonly password: string } | null;
  /** "Save this login for <repository>" on **Open**. */
  save?(sessionId: string, login: { readonly url: string; readonly username: string; readonly password: string }): void;
}

/** What production builds once and every call shares. */
export interface BrowserAskDeps {
  readonly docker: BrowserAskDocker;
  /** The session's running container id, started if need be. */
  readonly container: (sessionId: string) => Promise<string>;
  /**
   * `BrowserService`: `start` is the browser the answer's URL opens in; the
   * rest (US-012) dismiss a card whose browser crashed, restart the idle clock
   * on a tool call, and stop every browser when the call ends.
   */
  readonly browsers: {
    start(sessionId: string): Promise<BrowserInfo>;
    subscribe?(sessionId: string, listener: BrowserListener): (() => void) | null;
    touch?(sessionId: string): void;
    stopAll?(): Promise<void>;
  };
  readonly savedLogins?: BrowserSavedLogins;
  readonly discoveryMs?: number;
  readonly pollMs?: number;
}

export interface BrowserAskCall {
  readonly clock: CallClock;
  /** The call's socket; nothing of an answer is ever passed to it. */
  send(message: ServerMessage): void;
}

interface Ask {
  readonly id: string;
  readonly sessionId: string;
  readonly containerId: string;
  timer: unknown;
  /** Listening for the browser crashing while the card is up. */
  unsubscribe?: (() => void) | null;
}

/** A tool call whose request file is still being looked for. */
interface Discovery {
  stopped: boolean;
}

/** The card as seen from the operator's side of a `browser.answer`. */
export interface BrowserAnswer {
  readonly id: string;
  readonly url: string;
  readonly credentials?: BrowserCredentials;
  readonly save?: boolean;
}

/** One call's cards; the call builds it and ends it with {@link cancelAll}. */
export class BrowserAsks {
  private readonly asks = new Map<string, Ask>();
  private readonly discoveries = new Map<string, Discovery>();
  /** Request ids this call already handled, so a stale file is never asked twice. */
  private readonly seen = new Set<string>();
  private closed = false;

  constructor(
    private readonly deps: BrowserAskDeps,
    private readonly call: BrowserAskCall,
  ) {}

  /** Cards waiting for the operator, by id. */
  pending(): readonly string[] {
    return [...this.asks.keys()];
  }

  /**
   * The session agent called `open_browser_with_operator`: start its browser,
   * find the request, show the card. Resolves once the card is up (or it was
   * given up on); never rejects.
   */
  async ask(sessionId: string): Promise<void> {
    if (this.closed || this.discoveries.has(sessionId)) return;
    if ([...this.asks.values()].some((ask) => ask.sessionId === sessionId)) return;
    const discovery: Discovery = { stopped: false };
    this.discoveries.set(sessionId, discovery);
    try {
      await this.open(sessionId, discovery);
    } catch (cause) {
      logger.warn('could not show the watch-with-me card', { session: sessionId, error: String(cause) });
    } finally {
      if (this.discoveries.get(sessionId) === discovery) this.discoveries.delete(sessionId);
    }
  }

  /**
   * The tool call ended on the agent's side (its result arrived, or the turn
   * was interrupted): whatever card it had is gone. No answer is written, since
   * nobody is waiting for it any more.
   */
  toolDone(sessionId: string): void {
    const discovery = this.discoveries.get(sessionId);
    if (discovery !== undefined) discovery.stopped = true;
    for (const ask of [...this.asks.values()]) {
      if (ask.sessionId !== sessionId) continue;
      this.drop(ask);
      this.call.send({ type: 'browser.resolved', id: ask.id, outcome: 'cancelled' });
    }
  }

  /** **Open**: the answer goes into the container; the panel hears only `opened`. */
  async answer(answer: BrowserAnswer): Promise<void> {
    const ask = this.asks.get(answer.id);
    if (ask === undefined) {
      this.call.send({ type: 'error', code: 'browser_ask_gone', message: 'That browser request is no longer open.', fatal: false });
      return;
    }
    let credentials: { username: string; password: string } | undefined;
    if (answer.credentials !== undefined && 'savedLoginId' in answer.credentials) {
      const saved = this.deps.savedLogins?.resolve(ask.sessionId, answer.credentials.savedLoginId) ?? null;
      if (saved === null) {
        this.call.send({ type: 'error', code: 'saved_login_gone', message: 'That saved login no longer exists.', fatal: false });
        return;
      }
      credentials = { username: saved.username, password: saved.password };
    } else if (answer.credentials !== undefined) {
      credentials = { username: answer.credentials.username, password: answer.credentials.password };
      if (answer.save === true) this.deps.savedLogins?.save?.(ask.sessionId, { url: answer.url, ...credentials });
    }
    this.drop(ask);
    this.call.send({ type: 'browser.resolved', id: ask.id, outcome: 'opened' });
    const written = await this.write(ask, {
      id: ask.id,
      cancelled: false,
      url: answer.url,
      ...(credentials === undefined ? {} : { credentials }),
    });
    if (!written) {
      this.call.send({ type: 'error', code: 'browser_answer_failed', message: 'The address could not be passed to the session agent.', fatal: false });
    }
  }

  /** **Cancel** on the card. */
  async cancel(id: string): Promise<void> {
    const ask = this.asks.get(id);
    if (ask === undefined) return;
    await this.resolveCancelled(ask, 'cancelled');
  }

  /** The call ended: every open card is answered `cancelled`, and no new one opens. */
  async cancelAll(): Promise<void> {
    this.closed = true;
    for (const discovery of this.discoveries.values()) discovery.stopped = true;
    await Promise.all([...this.asks.values()].map((ask) => this.resolveCancelled(ask, 'cancelled')));
  }

  private async open(sessionId: string, discovery: Discovery): Promise<void> {
    const containerId = await this.deps.container(sessionId);
    // Chromium boots while the request is looked for.
    const browser = this.deps.browsers.start(sessionId).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    const request = await this.discover(containerId, discovery);
    if (request === null) {
      logger.warn('no browser request file appeared', { session: sessionId });
      return;
    }
    this.seen.add(request.id);
    const failure = await browser;
    if (this.closed || discovery.stopped) {
      if (!discovery.stopped) await this.write({ id: request.id, sessionId, containerId, timer: null }, { id: request.id, cancelled: true });
      return;
    }
    if (failure !== null) {
      // No card: the operator gets a toast, the agent the cause as its tool's error.
      logger.warn('the session browser did not start', { session: sessionId, error: failure });
      this.toast(failure);
      await this.write({ id: request.id, sessionId, containerId, timer: null }, { id: request.id, cancelled: true, reason: failure });
      return;
    }
    // The tool's own five minutes started when it wrote the request, before the
    // browser booted: the card never outlives them.
    const now = this.call.clock.now();
    const created = Date.parse(request.createdAt);
    const expiresAt = Number.isNaN(created) ? now + BROWSER_ASK_TTL_MS : Math.min(now + BROWSER_ASK_TTL_MS, created + BROWSER_ASK_TTL_MS);
    const ask: Ask = { id: request.id, sessionId, containerId, timer: null };
    ask.timer = this.call.clock.setTimeout(() => {
      ask.timer = null;
      void this.resolveCancelled(ask, 'expired');
    }, Math.max(0, expiresAt - now));
    this.asks.set(ask.id, ask);
    // A Chromium that crashes while the operator is still typing takes the card with it.
    ask.unsubscribe =
      this.deps.browsers.subscribe?.(sessionId, (event) => {
        if (event.type !== 'closed' || !event.crashed) return;
        this.toast(event.message);
        void this.resolveCancelled(ask, 'cancelled', event.message);
      }) ?? null;
    this.call.send({
      type: 'browser.ask',
      id: ask.id,
      sessionId,
      hint: request.hint,
      savedLogins: this.deps.savedLogins?.list(sessionId) ?? [],
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /** The newest request file this call has not handled yet, looked for until the tool call is over. */
  private async discover(containerId: string, discovery: Discovery): Promise<{ id: string; hint: string; createdAt: string } | null> {
    const deadline = Date.now() + (this.deps.discoveryMs ?? REQUEST_DISCOVERY_MS);
    for (;;) {
      if (discovery.stopped || this.closed) return null;
      const found = await this.listRequests(containerId);
      const fresh = found.filter((request) => !this.seen.has(request.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (fresh[0] !== undefined) return fresh[0];
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? REQUEST_POLL_MS));
    }
  }

  private async listRequests(containerId: string): Promise<{ id: string; hint: string; createdAt: string }[]> {
    let output: ExecOutput;
    try {
      output = await this.deps.docker.runExec(containerId, listRequestsSpec(), EXEC_TIMEOUT_MS);
    } catch (cause) {
      logger.warn('could not list browser requests', { container: containerId, error: String(cause) });
      return [];
    }
    const requests: { id: string; hint: string; createdAt: string }[] = [];
    for (const line of output.stdout.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const { id, hint, createdAt } = parsed;
        if (typeof id !== 'string' || !REQUEST_ID.test(id)) continue;
        requests.push({
          id,
          hint: typeof hint === 'string' ? hint.slice(0, 200) : '',
          createdAt: typeof createdAt === 'string' ? createdAt : '',
        });
      } catch {
        // A file the MCP server is still writing is renamed into place, so this is junk; skip it.
      }
    }
    return requests;
  }

  private async resolveCancelled(ask: Ask, outcome: Exclude<BrowserAskOutcome, 'opened'>, reason?: string): Promise<void> {
    if (this.asks.get(ask.id) !== ask) return;
    this.drop(ask);
    this.call.send({ type: 'browser.resolved', id: ask.id, outcome });
    await this.write(ask, { id: ask.id, cancelled: true, ...(reason === undefined ? {} : { reason }) });
  }

  /** The panel shows `browser_unavailable` as a toast. */
  private toast(cause: string): void {
    const message = `No browser: ${cause}`;
    this.call.send({ type: 'error', code: 'browser_unavailable', message, fatal: false });
  }

  private drop(ask: Ask): void {
    ask.unsubscribe?.();
    ask.unsubscribe = null;
    if (ask.timer !== null) this.call.clock.clearTimeout(ask.timer);
    ask.timer = null;
    this.asks.delete(ask.id);
  }

  /** Writes the answer file through stdin; false when that failed (logged without its content). */
  private async write(ask: Ask, answer: BrowserAnswerFile): Promise<boolean> {
    try {
      const exec = await this.deps.docker.attachExec(ask.containerId, answerWriteSpec(ask.id));
      exec.stdin.end(JSON.stringify(answer));
      let stderr = '';
      for await (const chunk of exec.output) if (chunk.stream === 'stderr') stderr += chunk.text;
      const state = await this.deps.docker.inspectExec(exec.execId);
      if (state.exitCode !== 0) {
        logger.warn('could not write the browser answer', { session: ask.sessionId, exitCode: state.exitCode, stderr: stderr.trim().slice(0, 200) });
        return false;
      }
      return true;
    } catch (cause) {
      logger.warn('could not write the browser answer', { session: ask.sessionId, error: String(cause) });
      return false;
    }
  }
}
