import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import {
  closeDatabase,
  type Database,
  getVoiceCall,
  IN_MEMORY,
  listVoiceTurns,
  openDatabase,
  setSetting,
} from '../db/index.js';
import { WebSocketGateway } from '../ws/gateway.js';
import { chiefWorld } from './chief/__fixtures__/world.js';
import { startScriptedOpenRouter, textReply, toolReply } from './chief/__fixtures__/scripted-openrouter.js';
import type { ChiefServices } from './chief/tools.js';
import type { AgentEvent, CallClock, CallStt, CallTts, VoiceAgent } from './call.js';
import { IDLE_GOODBYE } from './call.js';
import { createVoice, type Voice } from './index.js';
import {
  decodeFrame,
  encodeFrame,
  FRAME_KIND_AUDIO,
  FRAME_KIND_UTTERANCE,
  type ServerMessage,
  WS_CLOSE_CALL_ENDED,
  WS_CLOSE_CALL_IN_PROGRESS,
  WS_CLOSE_NOT_CONFIGURED,
  WS_CLOSE_TAKEN_OVER,
} from './protocol.js';
import { RESUME_WINDOW_MS } from './service.js';
import { originAllowed } from './socket.js';
import type { SttResult } from './stt/index.js';
import type { SpeakCallbacks, SpeakResult, TtsSink } from './tts/index.js';
import type { TtsSegment } from './tts/types.js';

const IDLE_MS = 120_000;
const REPLY = ['Nothing is building ', 'right now, and the queue is empty. ', 'Shall I start something?'];

/** Timers that only fire when the test advances the clock. */
class FakeClock implements CallClock {
  private t = Date.parse('2026-09-25T10:00:00.000Z');
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

class FakeStt implements CallStt {
  calls = 0;
  transcribe(): Promise<SttResult> {
    this.calls += 1;
    return Promise.resolve({ kind: 'text', text: "what's building?", durationMs: 900, costUsd: 0.001, seconds: 0.9 });
  }
}

/** Two bytes of "audio" per character, in one chunk. */
class FakeTts implements CallTts {
  readonly providerName = 'elevenlabs' as const;
  readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
  readonly spoken: string[] = [];
  constructor(private readonly sink: TtsSink) {}
  open(): Promise<void> {
    return Promise.resolve();
  }
  speak(seg: TtsSegment, _signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult> {
    if (seg.text !== '') {
      this.spoken.push(seg.text);
      callbacks.onStart?.(this.format, 'elevenlabs');
      callbacks.onAudio(Buffer.alloc(seg.text.length * 2, 1));
      this.sink.chars({ provider: 'elevenlabs', segmentId: seg.segmentId, turn: seg.turn, chars: seg.text.length });
    }
    return Promise.resolve({ spoken: true, provider: 'elevenlabs', chars: seg.text.length });
  }
  cancelTurn(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Replies with {@link REPLY}, one delta per piece. */
class ScriptedAgent implements VoiceAgent {
  readonly kind = 'chief' as const;
  readonly heard: string[] = [];
  async *run(input: { text: string }): AsyncGenerator<AgentEvent> {
    this.heard.push(input.text);
    yield { type: 'tool', id: 't1', name: 'overview', status: 'running', summary: 'Looking' };
    yield { type: 'tool', id: 't1', name: 'overview', status: 'ok', summary: 'Nothing building' };
    for (const text of REPLY) {
      await Promise.resolve();
      yield { type: 'delta', text };
    }
    yield { type: 'usage', costUsd: 0.002 };
  }
}

type Received = { kind: 'json'; message: ServerMessage } | { kind: 'audio'; segmentId: number; bytes: number };

/** A browser end of the call socket that records everything it receives. */
class Client {
  readonly received: Received[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: (() => void)[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const frame = decodeFrame(data);
        assert.ok(frame);
        assert.equal(frame.kind, FRAME_KIND_AUDIO);
        this.received.push({ kind: 'audio', segmentId: frame.segmentId, bytes: frame.payload.length });
      } else {
        this.received.push({ kind: 'json', message: JSON.parse(data.toString()) as ServerMessage });
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
    });
  }

  get types(): string[] {
    return this.received.map((r) => (r.kind === 'audio' ? 'binary' : r.message.type));
  }

  messages<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.received.flatMap((r) =>
      r.kind === 'json' && r.message.type === type ? [r.message as Extract<ServerMessage, { type: T }>] : [],
    );
  }

  async until<T extends ServerMessage['type']>(type: T, count = 1): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const found = this.messages(type);
      if (found.length >= count) return found[count - 1] as Extract<ServerMessage, { type: T }>;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  hello(sttMode = 'openrouter'): void {
    this.send({ type: 'hello', sttMode, sampleRateOut: 24000, clientVersion: 'test' });
  }
}

interface World {
  readonly db: Database;
  readonly clock: FakeClock;
  readonly stt: FakeStt;
  readonly agents: ScriptedAgent[];
  readonly voice: Voice;
  connect(query?: string): Promise<Client>;
  /** Connects, says hello and waits for `ready`. */
  call(query?: string): Promise<{ client: Client; callId: string }>;
}

const worlds: { gateway: WebSocketGateway; server: Server; db: Database }[] = [];

after(async () => {
  for (const { gateway, server, db } of worlds) {
    gateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  }
});

/** `chief`: the real chief agent over these services instead of {@link ScriptedAgent}. */
async function world(env: Record<string, string> = {}, opts: { chief?: (db: Database) => ChiefServices } = {}): Promise<World> {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', VOICE_IDLE_TIMEOUT_MS: String(IDLE_MS), ...env });
  const db = openDatabase(IN_MEMORY);
  setSetting(db, 'voice_enabled', '1');
  setSetting(db, 'openrouter_api_key', 'sk-or-test');
  const auth = createAuthService(config, db);
  const cookie = auth.sessionCookie().split(';')[0] ?? '';
  const clock = new FakeClock();
  const stt = new FakeStt();
  const agents: ScriptedAgent[] = [];
  let calls = 0;
  const chief = opts.chief?.(db);
  const voice = createVoice(config, db, {
    stt,
    tts: (sink) => new FakeTts(sink),
    ...(chief === undefined
      ? {
          agent: () => {
            const agent = new ScriptedAgent();
            agents.push(agent);
            return agent;
          },
        }
      : { chief }),
    clock,
    newCallId: () => `call-${++calls}`,
  });
  const gateway = new WebSocketGateway(auth);
  gateway.register(voice.socketRoute);
  const server = createServer((_req, res) => res.end());
  gateway.attach(server);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  worlds.push({ gateway, server, db });
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/voice/stream`;

  const connect = async (query = ''): Promise<Client> => {
    const client = new Client(new WebSocket(`${base}${query}`, { headers: { cookie } }));
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', resolve);
      client.socket.once('error', reject);
    });
    return client;
  };
  return {
    db,
    clock,
    stt,
    agents,
    voice,
    connect,
    call: async (query = '') => {
      const client = await connect(query);
      client.hello();
      const ready = await client.until('ready');
      return { client, callId: ready.callId };
    },
  };
}

describe('voice call socket', () => {
  it('closes with 4422 while voice is off or the OpenRouter key is missing', async () => {
    const w = await world();
    setSetting(w.db, 'voice_enabled', '0');
    const off = await w.connect();
    assert.deepEqual(await off.closed, { code: WS_CLOSE_NOT_CONFIGURED, reason: 'voice_disabled' });

    setSetting(w.db, 'voice_enabled', '1');
    w.db.prepare("DELETE FROM settings WHERE key = 'openrouter_api_key'").run();
    const keyless = await w.connect();
    assert.deepEqual(await keyless.closed, { code: WS_CLOSE_NOT_CONFIGURED, reason: 'openrouter_key_missing' });
  });

  it('holds a call: hello → ready, WAV → transcript → reply → audio → done', async () => {
    const w = await world();
    const client = await w.connect('?focus=chief');
    // Scribe is not configured, so the call falls back to OpenRouter STT.
    client.hello('elevenlabs-realtime');
    const ready = await client.until('ready');
    assert.equal(ready.sttMode, 'openrouter');
    assert.equal(ready.resumed, false);
    assert.deepEqual(ready.focus, { kind: 'chief' });
    assert.equal(ready.sampleRate, 24000);
    assert.equal(getVoiceCall(w.db, ready.callId)?.sttProvider, 'openrouter');
    assert.equal(w.voice.service.activeCallId, ready.callId);

    client.socket.send(encodeFrame(FRAME_KIND_UTTERANCE, 0, Buffer.from('RIFF-not-really')));
    const done = await client.until('agent.done');
    assert.deepEqual(done, { type: 'agent.done', turn: 1, interrupted: false });
    assert.equal(w.stt.calls, 1);
    assert.deepEqual(w.agents[0]?.heard, ["what's building?"]);

    const types = client.types;
    const at = (type: string): number => types.indexOf(type);
    assert.ok(at('user.transcript') > at('ready'));
    assert.ok(at('tool') > at('user.transcript'));
    assert.ok(at('agent.delta') > at('user.transcript'));
    assert.ok(at('tts.segment') > at('agent.delta'));
    assert.ok(at('binary') > at('tts.segment'));
    assert.ok(at('tts.end') > at('binary'));
    assert.ok(at('agent.done') > at('tts.end'));
    assert.deepEqual(client.messages('user.transcript'), [{ type: 'user.transcript', turn: 1, text: "what's building?" }]);
    assert.equal(client.messages('agent.delta').map((d) => d.text).join(''), REPLY.join(''));
    assert.deepEqual(
      client.messages('state').map((s) => s.phase),
      ['listening', 'thinking', 'speaking', 'listening'],
    );

    // Every segment's audio follows its own tts.segment and ends with tts.end.
    const segments = client.messages('tts.segment');
    assert.ok(segments.length >= 1);
    for (const segment of segments) {
      assert.equal(segment.turn, 1);
      assert.equal(segment.format, 'pcm16');
      const audio = client.received.filter((r) => r.kind === 'audio' && r.segmentId === segment.segmentId);
      assert.equal(audio.length, 1);
      assert.ok(client.messages('tts.end').some((e) => e.segmentId === segment.segmentId));
    }
    assert.equal(segments.map((s) => s.text).join(' '), REPLY.join('').trim());

    const turns = listVoiceTurns(w.db, ready.callId);
    assert.deepEqual(
      turns.map((t) => [t.turn, t.speaker, t.text, t.interrupted]),
      [
        [1, 'user', "what's building?", false],
        [1, 'chief', REPLY.join(''), false],
      ],
    );
    assert.ok(turns[0]?.tSpeechEnd !== null && turns[0]?.tTranscript !== null);
    assert.deepEqual(JSON.parse(turns[1]?.toolsJson ?? 'null'), [{ name: 'overview', status: 'ok', summary: 'Nothing building' }]);
    const row = getVoiceCall(w.db, ready.callId);
    assert.equal(row?.elChars, segments.reduce((n, s) => n + s.text.length, 0));
    assert.ok(Math.abs((row?.orCostUsd ?? 0) - 0.003) < 1e-9);
    assert.equal(row?.sttSeconds, 0.9);

    client.send({ type: 'hangup' });
    assert.equal((await client.closed).code, WS_CLOSE_CALL_ENDED);
    assert.equal(getVoiceCall(w.db, ready.callId)?.endReason, 'hangup');
    assert.equal(w.voice.service.activeCallId, null);
  });

  it('takes a typed message through the same pipeline without STT', async () => {
    const w = await world();
    const { client, callId } = await w.call();
    client.send({ type: 'text', text: 'hello chief' });
    await client.until('agent.done');
    assert.equal(w.stt.calls, 0);
    assert.deepEqual(client.messages('user.transcript'), [{ type: 'user.transcript', turn: 1, text: 'hello chief' }]);
    assert.deepEqual(
      listVoiceTurns(w.db, callId).map((t) => t.speaker),
      ['user', 'chief'],
    );
    client.socket.close();
  });

  it("answers \"what's building?\" through the real chief from the snapshot, with zero tool calls (US-008)", async () => {
    const openrouter = await startScriptedOpenRouter();
    after(() => openrouter.close());
    const w = await world({ OPENROUTER_API_URL: openrouter.baseUrl }, { chief: (db) => chiefWorld(db).services });
    openrouter.replies.push(textReply(['billing-export is building story 3 of 7. ', 'Nothing else is running.'], 0.003));
    const { client, callId } = await w.call();
    client.socket.send(encodeFrame(FRAME_KIND_UTTERANCE, 0, Buffer.from('RIFF-not-really')));
    await client.until('agent.done');

    assert.equal(openrouter.requests.length, 1);
    assert.deepEqual(client.messages('tool'), []);
    const system = ((openrouter.requests[0]?.['messages'] ?? []) as { content: string }[])[0]?.content ?? '';
    assert.match(system, /^- billing-export \[shop-api\] building story 3\/7/m);
    assert.equal(
      client.messages('agent.delta').map((d) => d.text).join(''),
      'billing-export is building story 3 of 7. Nothing else is running.',
    );
    assert.ok(client.messages('tts.segment').length >= 1);
    assert.deepEqual(
      listVoiceTurns(w.db, callId).map((t) => [t.speaker, t.toolsJson]),
      [
        ['user', null],
        ['chief', null],
      ],
    );
    await waitFor(() => (getVoiceCall(w.db, callId)?.orCostUsd ?? 0) >= 0.003);

    // end_call hangs up only after the goodbye in the same turn was spoken.
    openrouter.replies.push(toolReply([{ id: 'bye', name: 'end_call', args: '{}' }], 'Tot later! '), textReply(['']));
    client.send({ type: 'text', text: 'Dat was het.' });
    const closed = await client.closed;
    assert.equal(closed.code, WS_CLOSE_CALL_ENDED);
    const types = client.types;
    assert.ok(types.lastIndexOf('tts.end') > types.lastIndexOf('tool'));
    assert.ok(types.lastIndexOf('agent.done') > types.lastIndexOf('tts.end'));
    assert.equal(getVoiceCall(w.db, callId)?.endReason, 'hangup');
  });

  it('refuses a second call with 4409, and ?takeover=1 closes the first with 4410', async () => {
    const w = await world();
    const first = await w.call();

    const second = await w.connect();
    assert.deepEqual(await second.closed, { code: WS_CLOSE_CALL_IN_PROGRESS, reason: 'call_in_progress' });
    assert.equal(w.voice.service.activeCallId, first.callId);

    const third = await w.call('?takeover=1');
    assert.deepEqual(await first.client.closed, { code: WS_CLOSE_TAKEN_OVER, reason: 'taken_over' });
    assert.equal(getVoiceCall(w.db, first.callId)?.endReason, 'taken_over');
    assert.notEqual(third.callId, first.callId);
    assert.equal(w.voice.service.activeCallId, third.callId);
    third.client.socket.close();
  });

  it('continues a dropped call on ?resume= within 30 s, and starts a new one after', async () => {
    const w = await world();
    const { client, callId } = await w.call('?focus=session:s-1');
    client.socket.terminate();
    await client.closed;
    await waitFor(() => !w.voice.service.activeCall?.attached);

    w.clock.advance(RESUME_WINDOW_MS - 1000);
    const back = await w.connect(`?resume=${callId}`);
    back.hello();
    const ready = await back.until('ready');
    assert.equal(ready.callId, callId);
    assert.equal(ready.resumed, true);
    assert.deepEqual(ready.focus, { kind: 'session', sessionId: 's-1' });
    back.send({ type: 'text', text: 'still there?' });
    await back.until('agent.done');
    assert.equal(back.messages('agent.done')[0]?.turn, 1);
    assert.equal(w.agents.length, 1, 'the same agent carries on');
    assert.equal(getVoiceCall(w.db, callId)?.endedAt, null);

    back.socket.terminate();
    await back.closed;
    await waitFor(() => !w.voice.service.activeCall?.attached);
    w.clock.advance(RESUME_WINDOW_MS);
    await waitFor(() => w.voice.service.activeCallId === null);
    assert.equal(getVoiceCall(w.db, callId)?.endReason, 'error');

    const fresh = await w.call(`?resume=${callId}`);
    assert.notEqual(fresh.callId, callId);
    fresh.client.socket.close();
  });

  it('says goodbye and ends the call after VOICE_IDLE_TIMEOUT_MS of silence', async () => {
    const w = await world();
    const { client, callId } = await w.call();
    w.clock.advance(IDLE_MS - 1);
    client.send({ type: 'speech.start' });
    // Anything unknown is answered in order, so its error means the server saw speech.start.
    client.send({ type: 'ping' });
    await client.until('error');
    // The speech moved the deadline: the old one passes without ending anything.
    await flush();
    w.clock.advance(1000);
    await flush();
    assert.equal(getVoiceCall(w.db, callId)?.endedAt, null);

    w.clock.advance(IDLE_MS);
    const closed = await client.closed;
    assert.equal(closed.code, WS_CLOSE_CALL_ENDED);
    const goodbye = IDLE_GOODBYE['nl'] as string;
    assert.equal(client.messages('agent.delta').at(-1)?.text, goodbye);
    assert.ok(client.messages('tts.segment').some((s) => s.text === goodbye));
    assert.ok(client.types.includes('binary'));
    assert.equal(client.messages('state').at(-1)?.phase, 'ended');
    assert.equal(getVoiceCall(w.db, callId)?.endReason, 'idle');
    assert.deepEqual(
      listVoiceTurns(w.db, callId).map((t) => [t.speaker, t.text]),
      [['chief', goodbye]],
    );
  });

  it('answers GET /api/voice/status with a cached ElevenLabs balance', async () => {
    let hits = 0;
    const elevenlabs = createServer((_req, res) => {
      hits += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ character_count: 1000, character_limit: 121000, next_character_count_reset_unix: 1790000000 }));
    });
    elevenlabs.listen(0, '127.0.0.1');
    await new Promise((resolve) => elevenlabs.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${(elevenlabs.address() as AddressInfo).port}`;
      const w = await world({ ELEVENLABS_API_URL: url });
      const before = await w.voice.service.status();
      assert.equal(before.elBalance, null);
      assert.equal(hits, 0);

      setSetting(w.db, 'elevenlabs_api_key', 'sk_el');
      const { client, callId } = await w.call();
      const status = await w.voice.service.status();
      assert.deepEqual(status, {
        configured: true,
        reason: null,
        providers: { stt: 'openrouter', tts: 'openrouter', chiefModel: status.providers.chiefModel, openrouter: true, elevenlabs: true },
        elBalance: { remaining: 120000, limit: 121000, resetsAt: new Date(1790000000 * 1000).toISOString() },
        activeCallId: callId,
      });
      await w.voice.service.status();
      assert.equal(hits, 1);
      w.clock.advance(60_000);
      await w.voice.service.status();
      assert.equal(hits, 2);
      client.socket.close();
    } finally {
      elevenlabs.closeAllConnections();
      await new Promise((resolve) => elevenlabs.close(resolve));
    }
  });

  it('checks Origin against PUBLIC_URL only when it is set', () => {
    const req = (origin?: string): IncomingMessage =>
      ({ headers: origin === undefined ? {} : { origin } }) as IncomingMessage;
    assert.equal(originAllowed(req(), ''), true);
    assert.equal(originAllowed(req('https://chief.example'), 'https://chief.example'), true);
    assert.equal(originAllowed(req('https://chief.example'), 'https://chief.example/app'), true);
    assert.equal(originAllowed(req('https://evil.example'), 'https://chief.example'), false);
    assert.equal(originAllowed(req(), 'https://chief.example'), false);
  });
});

/** Lets pending socket and promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition never became true');
}
