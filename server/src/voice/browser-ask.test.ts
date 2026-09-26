import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { BrowserService } from '../browser/index.js';
import { loadConfig } from '../config.js';
import { DockerApi } from '../docker/index.js';
import { type FakeExec, FakeBrowser, FakeDockerDaemon } from '../docker/fake-daemon.js';
import {
  BROWSER_ASK_TTL_MS,
  type BrowserAskDeps,
  BrowserAsks,
  BROWSER_REQUEST_DIR,
  type BrowserSavedLogins,
} from './browser-ask.js';
import { type AgentEvent, type AgentInput, type CallClock, type CallTts, type VoiceAgent, VoiceCall } from './call.js';
import { chiefWorld } from './chief/__fixtures__/world.js';
import { parseBrowserUrl, parseClientMessage, type ServerMessage } from './protocol.js';
import type { SpeakResult } from './tts/index.js';

const PASSWORD = 'hunter2-s3cret!';
const REQUEST_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';
const OTHER_ID = '7a1c2d3e-4a5b-4c6d-8e7f-0123456789ab';

class FakeClock implements CallClock {
  t = Date.parse('2026-09-26T10:00:00.000Z');
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.t + ms, fn });
    return this.seq;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, timer] of [...this.timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > this.t) continue;
      this.timers.delete(id);
      timer.fn();
    }
  }
}

const until = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * The container's side of the relay: the request files the MCP server would
 * have written, and every answer file written through stdin.
 */
class FakeMcpSide {
  /** Request files per container. */
  readonly requests = new Map<string, { id: string; hint: string; createdAt: string }[]>();
  /** Answer files as written: container, exec, raw content. */
  readonly answers: { containerId: string; exec: FakeExec; content: string }[] = [];
  failWrites = false;

  constructor(daemon: FakeDockerDaemon) {
    const previous = daemon.onExec;
    daemon.onExec = (exec) => {
      const command = exec.cmd.join(' ');
      if (command.includes(`${BROWSER_REQUEST_DIR}/*.request`)) {
        const lines = (this.requests.get(exec.containerId) ?? []).map((request) => `${JSON.stringify(request)}\n`);
        return { stdout: lines.join('') };
      }
      if (command.includes('.answer.tmp') && exec.attachStdin) {
        let content = '';
        return {
          onLine: (line) => {
            content += line;
          },
          onStdinEnd: () => {
            this.answers.push({ containerId: exec.containerId, exec, content });
            daemon.finish(exec.id, this.failWrites ? 1 : 0);
          },
        };
      }
      return previous?.(exec) ?? {};
    };
  }

  request(containerId: string, id = REQUEST_ID, hint = 'the checkout page'): void {
    const list = this.requests.get(containerId) ?? [];
    list.push({ id, hint, createdAt: new Date().toISOString() });
    this.requests.set(containerId, list);
  }

  answersFor(containerId: string): Record<string, unknown>[] {
    return this.answers.filter((a) => a.containerId === containerId).map((a) => JSON.parse(a.content) as Record<string, unknown>);
  }
}

describe('the watch-with-me card relay (voice feedback US-007)', () => {
  let daemon: FakeDockerDaemon;
  let docker: DockerApi;
  let mcp: FakeMcpSide;
  let clock: FakeClock;
  let sent: ServerMessage[];
  let seq = 0;

  const newSession = (): { sessionId: string; containerId: string } => {
    seq += 1;
    const sessionId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    const containerId = `c-${sessionId}`;
    daemon.addContainer({ id: containerId, name: `chief-web-s${String(seq)}` });
    return { sessionId, containerId };
  };

  const deps = (overrides: Partial<BrowserAskDeps> = {}): BrowserAskDeps => ({
    docker,
    container: (sessionId) => Promise.resolve(`c-${sessionId}`),
    browsers: new BrowserService({ docker, container: (sessionId) => Promise.resolve(`c-${sessionId}`) }),
    discoveryMs: 300,
    pollMs: 5,
    ...overrides,
  });

  const relay = (overrides: Partial<BrowserAskDeps> = {}): BrowserAsks =>
    new BrowserAsks(deps(overrides), { clock, send: (message) => sent.push(message) });

  const asks = (): Extract<ServerMessage, { type: 'browser.ask' }>[] =>
    sent.flatMap((m) => (m.type === 'browser.ask' ? [m] : []));
  const resolved = (): Extract<ServerMessage, { type: 'browser.resolved' }>[] =>
    sent.flatMap((m) => (m.type === 'browser.resolved' ? [m] : []));

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    docker = new DockerApi(daemon.socketPath);
  });

  after(async () => {
    await daemon.close();
  });

  beforeEach(() => {
    daemon.onExec = null;
    mcp = new FakeMcpSide(daemon);
    new FakeBrowser(daemon);
    clock = new FakeClock();
    sent = [];
  });

  it('starts the browser and sends browser.ask with the request id, hint and expiry', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    await relay().ask(sessionId);

    assert.deepEqual(asks(), [
      {
        type: 'browser.ask',
        id: REQUEST_ID,
        sessionId,
        hint: 'the checkout page',
        savedLogins: [],
        expiresAt: new Date(clock.now() + BROWSER_ASK_TTL_MS).toISOString(),
      },
    ]);
    assert.ok(BROWSER_ASK_TTL_MS < 5 * 60_000, 'the card expires before the tool gives up');
    const chromium = daemon.execs().find((exec) => exec.containerId === containerId && exec.cmd.includes('chromium'));
    assert.ok(chromium?.running, 'Chromium runs in the session container');
  });

  it('waits for a request file that appears after the tool event', async () => {
    const { sessionId, containerId } = newSession();
    const asking = relay().ask(sessionId);
    setTimeout(() => mcp.request(containerId), 40);
    await asking;
    assert.equal(asks()[0]?.id, REQUEST_ID);
  });

  it('writes the URL and credentials into the container as uid 1000, mode 600, and never sends them back', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    const cards = relay();
    await cards.ask(sessionId);
    await cards.answer({ id: REQUEST_ID, url: 'http://host.docker.internal:3000/login', credentials: { username: 'ann', password: PASSWORD } });

    assert.deepEqual(mcp.answersFor(containerId), [
      { id: REQUEST_ID, cancelled: false, url: 'http://host.docker.internal:3000/login', credentials: { username: 'ann', password: PASSWORD } },
    ]);
    const write = mcp.answers[mcp.answers.length - 1];
    assert.ok(write);
    assert.equal(write.exec.user, '1000');
    assert.match(write.exec.cmd[2] ?? '', /^umask 077 && mkdir -p \/tmp\/\.chief-voice\/browser && cat > (\S+)\.tmp && mv \1\.tmp \1$/);
    assert.ok(write.exec.cmd.join(' ').includes(`${BROWSER_REQUEST_DIR}/${REQUEST_ID}.answer`));
    assert.ok(!write.exec.cmd.join(' ').includes(PASSWORD), 'the password is not on the command line');

    assert.deepEqual(resolved(), [{ type: 'browser.resolved', id: REQUEST_ID, outcome: 'opened' }]);
    assert.ok(!JSON.stringify(sent).includes(PASSWORD), 'nothing of the answer goes back over the socket');
    assert.ok(!JSON.stringify(sent).includes('ann'));
    assert.deepEqual(cards.pending(), []);
  });

  it('writes an answer without credentials when none were typed', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    const cards = relay();
    await cards.ask(sessionId);
    await cards.answer({ id: REQUEST_ID, url: 'https://example.com/' });
    assert.deepEqual(mcp.answersFor(containerId), [{ id: REQUEST_ID, cancelled: false, url: 'https://example.com/' }]);
  });

  it('resolves a saved login on the server and stores a login the operator asked to save', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    const saved: { url: string; username: string; password: string }[] = [];
    const savedLogins: BrowserSavedLogins = {
      list: () => [{ id: 'login-1', label: 'Staging admin', url: 'https://staging.example.com' }],
      resolve: (_sessionId, id) => (id === 'login-1' ? { username: 'admin', password: PASSWORD } : null),
      save: (_sessionId, login) => saved.push(login),
    };
    const cards = relay({ savedLogins });
    await cards.ask(sessionId);
    assert.deepEqual(asks()[0]?.savedLogins, [{ id: 'login-1', label: 'Staging admin', url: 'https://staging.example.com' }]);

    await cards.answer({ id: REQUEST_ID, url: 'https://staging.example.com/', credentials: { savedLoginId: 'nope' } });
    assert.equal(sent[sent.length - 1]?.type, 'error');
    assert.deepEqual(cards.pending(), [REQUEST_ID], 'an unknown saved login leaves the card open');

    await cards.answer({ id: REQUEST_ID, url: 'https://staging.example.com/', credentials: { savedLoginId: 'login-1' } });
    assert.deepEqual(mcp.answersFor(containerId), [
      { id: REQUEST_ID, cancelled: false, url: 'https://staging.example.com/', credentials: { username: 'admin', password: PASSWORD } },
    ]);
    assert.ok(!JSON.stringify(sent).includes(PASSWORD));

    mcp.request(containerId, OTHER_ID);
    await cards.ask(sessionId);
    await cards.answer({ id: OTHER_ID, url: 'https://x.example/', credentials: { username: 'bob', password: 'pw' }, save: true });
    assert.deepEqual(saved, [{ url: 'https://x.example/', username: 'bob', password: 'pw' }]);
  });

  it('Cancel writes cancelled: true', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    const cards = relay();
    await cards.ask(sessionId);
    await cards.cancel(REQUEST_ID);
    assert.deepEqual(mcp.answersFor(containerId), [{ id: REQUEST_ID, cancelled: true }]);
    assert.deepEqual(resolved(), [{ type: 'browser.resolved', id: REQUEST_ID, outcome: 'cancelled' }]);

    await cards.answer({ id: REQUEST_ID, url: 'https://example.com/' });
    assert.deepEqual(sent[sent.length - 1], {
      type: 'error',
      code: 'browser_ask_gone',
      message: 'That browser request is no longer open.',
      fatal: false,
    });
    assert.equal(mcp.answersFor(containerId).length, 1, 'a late Open writes nothing');
  });

  it('an expired card writes cancelled: true', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    await relay().ask(sessionId);
    clock.advance(BROWSER_ASK_TTL_MS - 1);
    assert.deepEqual(resolved(), []);
    clock.advance(1);
    await until(() => mcp.answersFor(containerId).length === 1);
    assert.deepEqual(mcp.answersFor(containerId), [{ id: REQUEST_ID, cancelled: true }]);
    assert.deepEqual(resolved(), [{ type: 'browser.resolved', id: REQUEST_ID, outcome: 'expired' }]);
  });

  it('the end of the call writes cancelled: true and opens no new card', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    const cards = relay();
    await cards.ask(sessionId);
    await cards.cancelAll();
    assert.deepEqual(mcp.answersFor(containerId), [{ id: REQUEST_ID, cancelled: true }]);

    mcp.request(containerId, OTHER_ID);
    await cards.ask(sessionId);
    assert.equal(asks().length, 1);
  });

  it('a tool call that ended on the agent side drops its card without writing an answer', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    const cards = relay();
    await cards.ask(sessionId);
    cards.toolDone(sessionId);
    assert.deepEqual(resolved(), [{ type: 'browser.resolved', id: REQUEST_ID, outcome: 'cancelled' }]);
    assert.deepEqual(mcp.answersFor(containerId), []);
  });

  it('never asks twice for a request it already handled, and gives up when no request appears', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    const cards = relay();
    await cards.ask(sessionId);
    await cards.cancel(REQUEST_ID);
    // The MCP server has not removed the old file yet: it is not a new request.
    await cards.ask(sessionId);
    assert.equal(asks().length, 1);
  });

  it('answers cancelled with a reason when the browser cannot start', async () => {
    const { sessionId, containerId } = newSession();
    mcp.request(containerId);
    await relay({ browsers: { start: () => Promise.reject(new Error('no chromium')) } }).ask(sessionId);
    assert.deepEqual(asks(), []);
    assert.deepEqual(mcp.answersFor(containerId), [{ id: REQUEST_ID, cancelled: true, reason: 'the browser could not start' }]);
    assert.ok(sent.some((m) => m.type === 'error' && m.code === 'browser_unavailable'));
  });

  describe('through the call socket', () => {
    class SilentTts implements CallTts {
      readonly providerName = 'elevenlabs' as const;
      readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
      open(): Promise<void> {
        return Promise.resolve();
      }
      speak(): Promise<SpeakResult> {
        return Promise.resolve({ spoken: true, provider: 'elevenlabs', chars: 0 });
      }
      cancelTurn(): void {}
      close(): Promise<void> {
        return Promise.resolve();
      }
    }
    class QuietAgent implements VoiceAgent {
      readonly kind = 'chief' as const;
      // eslint-disable-next-line require-yield
      async *run(_input: AgentInput): AsyncGenerator<AgentEvent> {
        await Promise.resolve();
      }
    }

    const liveCall = async (): Promise<VoiceCall> => {
      const w = chiefWorld();
      const call = new VoiceCall('call-browser', { kind: 'chief' }, {
        db: w.db,
        config: loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }),
        stt: { transcribe: () => Promise.reject(new Error('no audio here')) },
        tts: () => new SilentTts(),
        agent: () => new QuietAgent(),
        clock,
        browser: deps(),
      });
      call.attach({ send: (message) => sent.push(message), sendAudio: () => undefined, close: () => undefined });
      await call.start('openrouter');
      return call;
    };

    it('relays browser.answer frames into the container and echoes none of it', async () => {
      const call = await liveCall();
      const { sessionId, containerId } = newSession();
      mcp.request(containerId);
      call.askBrowser(sessionId);
      await until(() => asks().length === 1);

      const frame = JSON.stringify({
        type: 'browser.answer',
        id: REQUEST_ID,
        url: 'http://host.docker.internal:8080/admin',
        credentials: { username: 'ann', password: PASSWORD },
        save: false,
      });
      call.handleFrame(Buffer.from(frame), false);
      await until(() => mcp.answersFor(containerId).length === 1);
      assert.deepEqual(mcp.answersFor(containerId)[0], {
        id: REQUEST_ID,
        cancelled: false,
        url: 'http://host.docker.internal:8080/admin',
        credentials: { username: 'ann', password: PASSWORD },
      });
      assert.ok(!JSON.stringify(sent).includes(PASSWORD));
      await call.end('hangup');
    });

    it('rejects an answer whose URL is not http(s), keeping the card open', async () => {
      const call = await liveCall();
      const { sessionId, containerId } = newSession();
      mcp.request(containerId);
      call.askBrowser(sessionId);
      await until(() => asks().length === 1);
      call.handleFrame(Buffer.from(JSON.stringify({ type: 'browser.answer', id: REQUEST_ID, url: 'javascript:alert(1)' })), false);
      assert.equal(sent[sent.length - 1]?.type, 'error');
      assert.deepEqual(mcp.answersFor(containerId), []);
      await call.end('hangup');
      assert.deepEqual(mcp.answersFor(containerId), [{ id: REQUEST_ID, cancelled: true }], 'hanging up cancels the open card');
    });

    it('browser.cancel writes cancelled: true', async () => {
      const call = await liveCall();
      const { sessionId, containerId } = newSession();
      mcp.request(containerId);
      call.askBrowser(sessionId);
      await until(() => asks().length === 1);
      call.handleFrame(Buffer.from(JSON.stringify({ type: 'browser.cancel', id: REQUEST_ID })), false);
      await until(() => mcp.answersFor(containerId).length === 1);
      assert.deepEqual(mcp.answersFor(containerId), [{ id: REQUEST_ID, cancelled: true }]);
      await call.end('hangup');
    });
  });
});

describe('browser.answer parsing (voice feedback US-007)', () => {
  it('accepts only absolute http and https URLs', () => {
    assert.equal(parseBrowserUrl('http://host.docker.internal:3000/checkout'), 'http://host.docker.internal:3000/checkout');
    assert.equal(parseBrowserUrl('  https://example.com  '), 'https://example.com/');
    for (const bad of ['', 'example.com', '/checkout', 'ftp://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      assert.equal(parseBrowserUrl(bad), null, bad);
    }
    assert.equal(parseBrowserUrl(`https://example.com/${'a'.repeat(2000)}`), null);
  });

  it('parses a typed login, a saved login, and nothing else', () => {
    const parse = (message: Record<string, unknown>) => parseClientMessage(JSON.stringify({ type: 'browser.answer', id: 'r1', url: 'https://a.example', ...message }));
    assert.deepEqual(parse({}), { type: 'browser.answer', id: 'r1', url: 'https://a.example/' });
    assert.deepEqual(parse({ credentials: { username: 'ann', password: 'pw' }, save: true }), {
      type: 'browser.answer',
      id: 'r1',
      url: 'https://a.example/',
      credentials: { username: 'ann', password: 'pw' },
      save: true,
    });
    assert.deepEqual(parse({ credentials: { savedLoginId: 'login-1' } }), {
      type: 'browser.answer',
      id: 'r1',
      url: 'https://a.example/',
      credentials: { savedLoginId: 'login-1' },
    });
    assert.equal(parse({ credentials: { username: 'ann' } }), null);
    assert.equal(parse({ credentials: { username: 'ann', password: '' } }), null);
    assert.equal(parse({ credentials: 'ann:pw' }), null);
    assert.equal(parse({ save: 'yes' }), null);
    assert.equal(parse({ url: 'localhost:3000' }), null);
    assert.equal(parseClientMessage(JSON.stringify({ type: 'browser.answer', url: 'https://a.example' })), null);
    assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'browser.cancel', id: 'r1' })), { type: 'browser.cancel', id: 'r1' });
    assert.equal(parseClientMessage(JSON.stringify({ type: 'browser.cancel' })), null);
  });
});
