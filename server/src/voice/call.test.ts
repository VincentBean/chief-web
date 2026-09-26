import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { after, before, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { createAuthService } from '../auth/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  featureBranchFor,
  getRecurringTaskByName,
  getSession,
  getVoiceCall,
  getVoiceSessionAgent,
  IN_MEMORY,
  listSessions,
  listVoiceTurns,
  openDatabase,
  setSetting,
  updateSession,
} from '../db/index.js';
import { DockerApi } from '../docker/index.js';
import { FakeDockerDaemon } from '../docker/fake-daemon.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { prdPathFor } from '../prd/index.js';
import { sessionPrdFile } from '../sessions/index.js';
import { WebSocketGateway } from '../ws/gateway.js';
import { type ChiefWorld, chiefWorld } from './chief/__fixtures__/world.js';
import {
  type ScriptedOpenRouter,
  SPEECH_BYTES_PER_CHAR,
  startScriptedOpenRouter,
  textReply,
  toolReply,
} from './chief/__fixtures__/scripted-openrouter.js';
import type { ChiefServices } from './chief/tools.js';
import type { AgentEvent, CallClock, CallEarcons, CallStt, CallTts, VoiceAgent } from './call.js';
import { EVENT_QUIET_MS, IDLE_GOODBYE } from './call.js';
import { draftedLine, type VoiceBusEvent, VoiceEventBus } from './events.js';
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
import { detachPrompt, resumePrompt } from './session-agent/prompt.js';
import { CLAUDE_SESSION, FakeClaude, LONG_OPENING } from './session-agent/__fixtures__/fake-claude.js';
import { SessionAgentRegistry } from './session-agent/registry.js';
import { originAllowed } from './socket.js';
import type { SttResult } from './stt/index.js';
import { type SpeakCallbacks, type SpeakResult, SWITCHED_TOAST, type TtsSink } from './tts/index.js';
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

/** Hears the next canned line per utterance, and "what's building?" once they run out. */
class FakeStt implements CallStt {
  calls = 0;
  readonly canned: string[] = [];
  transcribe(): Promise<SttResult> {
    this.calls += 1;
    const text = this.canned.shift() ?? "what's building?";
    return Promise.resolve({ kind: 'text', text, durationMs: 900, costUsd: 0.001, seconds: 0.9 });
  }
}

/** {@link SPEECH_BYTES_PER_CHAR} bytes of "audio" per character, in one chunk. */
class FakeTts implements CallTts {
  readonly providerName = 'elevenlabs' as const;
  readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
  readonly spoken: string[] = [];
  readonly cancelled: number[] = [];
  constructor(private readonly sink: TtsSink) {}
  open(): Promise<void> {
    return Promise.resolve();
  }
  speak(seg: TtsSegment, _signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult> {
    if (seg.text !== '') {
      this.spoken.push(seg.text);
      callbacks.onStart?.(this.format, 'elevenlabs');
      callbacks.onAudio(Buffer.alloc(seg.text.length * SPEECH_BYTES_PER_CHAR, 1));
      this.sink.chars({ provider: 'elevenlabs', segmentId: seg.segmentId, turn: seg.turn, chars: seg.text.length });
    }
    return Promise.resolve({ spoken: true, provider: 'elevenlabs', chars: seg.text.length });
  }
  cancelTurn(turn: number): void {
    this.cancelled.push(turn);
  }
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
  readonly config: Config;
  readonly clock: FakeClock;
  readonly stt: FakeStt;
  readonly agents: ScriptedAgent[];
  readonly ttses: FakeTts[];
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
/** `sessionAgents`: real session voice agents over this registry (and no scripted agent). */
/** `providerTts`: the real `TtsService` against `ELEVENLABS_API_URL`/`OPENROUTER_API_URL` instead of {@link FakeTts}. */
async function world(
  env: Record<string, string> = {},
  opts: {
    chief?: (db: Database) => ChiefServices;
    sessionAgents?: (db: Database, config: Config) => SessionAgentRegistry;
    earcons?: CallEarcons;
    events?: VoiceEventBus;
    providerTts?: boolean;
  } = {},
): Promise<World> {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', VOICE_IDLE_TIMEOUT_MS: String(IDLE_MS), ...env });
  const db = openDatabase(IN_MEMORY);
  setSetting(db, 'voice_enabled', '1');
  setSetting(db, 'openrouter_api_key', 'sk-or-test');
  const auth = createAuthService(config, db);
  const cookie = auth.sessionCookie().split(';')[0] ?? '';
  const clock = new FakeClock();
  const stt = new FakeStt();
  const agents: ScriptedAgent[] = [];
  const ttses: FakeTts[] = [];
  let calls = 0;
  const chief = opts.chief?.(db);
  const sessionAgents = opts.sessionAgents?.(db, config);
  const voice = createVoice(config, db, {
    stt,
    ...(opts.providerTts === true
      ? {
          // Without these the service would render earcons and read usage from the providers.
          earcons: opts.earcons ?? { load: () => Promise.resolve([]) },
          usage: { subscription: () => Promise.resolve(null), generationCost: () => Promise.resolve(null) },
        }
      : {
          tts: (sink: TtsSink) => {
            const tts = new FakeTts(sink);
            ttses.push(tts);
            return tts;
          },
          ...(opts.earcons === undefined ? {} : { earcons: opts.earcons }),
        }),
    ...(sessionAgents === undefined ? {} : { sessionAgents }),
    ...(opts.events === undefined ? {} : { events: opts.events }),
    ...(chief === undefined && sessionAgents === undefined
      ? {
          agent: () => {
            const agent = new ScriptedAgent();
            agents.push(agent);
            return agent;
          },
        }
      : chief === undefined
        ? {}
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
    config,
    clock,
    stt,
    agents,
    ttses,
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
    // `listening` goes out once the turn has wound down, a tick after `agent.done`.
    await client.until('state', 4);
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

  it('times every stage of a normal turn, in order, and stores the browser\'s first-audio-played', async () => {
    const w = await world();
    // Each reading of the call's clock is 5 ms after the last, so the stages are ordered in time.
    const tick = w.clock.now.bind(w.clock);
    let skew = 0;
    w.clock.now = () => tick() + (skew += 5);
    const { client, callId } = await w.call();

    client.socket.send(encodeFrame(FRAME_KIND_UTTERANCE, 0, Buffer.from('RIFF-not-really')));
    await client.until('agent.done');
    const reply = listVoiceTurns(w.db, callId).find((t) => t.speaker === 'chief');
    assert.ok(reply?.tFirstAudioSent);
    // The browser heard it 40 ms after it went out.
    const played = new Date(Date.parse(reply.tFirstAudioSent) + 40).toISOString();
    client.send({ type: 'metrics', turn: 1, firstAudioPlayedAt: played });
    // A second report for the same turn does not move it.
    client.send({ type: 'metrics', turn: 1, firstAudioPlayedAt: new Date(Date.parse(played) + 999).toISOString() });
    client.send({ type: 'metrics', turn: 7, firstAudioPlayedAt: played });
    const last = await client.until('latency', 3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.messages('latency').length, 3);
    assert.equal(last.turn, 1);

    const [user, chief] = listVoiceTurns(w.db, callId);
    assert.equal(user?.speaker, 'user');
    assert.equal(chief?.speaker, 'chief');
    const stages = [
      user?.tSpeechEnd,
      user?.tTranscript,
      chief?.tFirstToken,
      chief?.tFirstChunk,
      chief?.tFirstAudioSent,
      chief?.tFirstAudioPlayed,
    ];
    for (const stage of stages) assert.equal(typeof stage, 'string');
    const ms = stages.map((stage) => Date.parse(stage as string));
    for (let i = 1; i < ms.length; i++) assert.ok((ms[i] as number) > (ms[i - 1] as number), `stage ${i} is not after stage ${i - 1}: ${stages.join(', ')}`);
    assert.equal(chief?.tFirstAudioPlayed, played);

    // The overlay's copy says the same.
    assert.deepEqual(last.times, {
      speechEnd: user?.tSpeechEnd,
      transcript: user?.tTranscript,
      firstToken: chief?.tFirstToken,
      firstChunk: chief?.tFirstChunk,
      firstAudioSent: chief?.tFirstAudioSent,
      firstAudioPlayed: played,
    });
    // The first `latency` went out with the transcript, before the agent answered.
    const first = client.messages('latency')[0];
    assert.deepEqual(first?.times, { ...last.times, firstToken: null, firstChunk: null, firstAudioSent: null, firstAudioPlayed: null });
    assert.ok(client.types.indexOf('latency') < client.types.indexOf('agent.delta'));
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

describe('barge-in', () => {
  let daemon: FakeDockerDaemon;
  let claude: FakeClaude;
  let dataDir: string;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-barge-in-'));
  });

  after(async () => {
    await daemon.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** A call focused on a pending session whose agent is the fake `claude`. */
  const sessionCall = async (name: string, earcons?: CallEarcons): Promise<{ w: World; client: Client; callId: string; stdin: () => string[]; lines: () => Record<string, unknown>[] }> => {
    claude = new FakeClaude(daemon);
    let sessionId = '';
    const w = await world({ DATA_DIR: dataDir }, {
      sessionAgents: (db, config) => {
        const repository = createRepository(db, { name: `repo-${name}`, sshUrl: 'git@github.com:acme/demo.git', githubSlug: 'acme/demo', defaultBaseBranch: 'main' });
        const session = createSession(db, {
          repositoryId: repository.id,
          name,
          baseBranch: 'main',
          prTargetBranch: 'main',
          featureBranch: featureBranchFor(name),
          status: 'pending',
          scheduledStartAt: null,
        });
        sessionId = session.id;
        fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
        daemon.addContainer({ id: `c-${session.id}`, name: `chief-web-${name}` });
        return new SessionAgentRegistry({
          config,
          db,
          docker: new DockerApi(daemon.socketPath),
          containers: {
            start: () => Promise.resolve({ id: `c-${session.id}`, name: `chief-web-${name}`, running: true, state: 'running' as const }),
            remove: () => Promise.resolve(),
          },
          hold: { active: () => false, until: () => null },
        });
      },
      ...(earcons === undefined ? {} : { earcons }),
    });
    const { client, callId } = await w.call(`?focus=session:${sessionId}`);
    const exec = (): string => claude.agentExecs().find((entry) => entry.containerId === `c-${sessionId}`)?.id ?? '';
    // The opening turn: a fresh conversation hears the planning prompt.
    client.send({ type: 'text', text: 'hello' });
    await client.until('agent.done');
    return {
      w,
      client,
      callId,
      stdin: () => claude.userTexts(exec()),
      lines: () => claude.stdin.get(exec()) ?? [],
    };
  };

  it('plays "one sec" while the session agent boots, and not once it runs (US-021)', async () => {
    const earcons: CallEarcons = {
      load: () => Promise.resolve([{ name: 'one_sec', language: 'nl', sampleRate: 24000, pcm: Buffer.alloc(480) }]),
    };
    const { client } = await sessionCall('earcon-boot', earcons);
    const ready = client.messages('ready')[0];
    assert.equal(ready?.earcons[0]?.name, 'one_sec');
    assert.deepEqual(client.messages('earcon'), [{ type: 'earcon', name: 'one_sec' }]);
    const types = client.types;
    assert.ok(types.indexOf('earcon') < types.indexOf('agent.delta'));

    client.send({ type: 'text', text: 'and then?' });
    await client.until('agent.done', 2);
    assert.equal(client.messages('earcon').length, 1);
  });

  it('cuts a reply the operator talks over: tts.stop, interrupt on stdin, cut-off note on the next message', async () => {
    const { w, client, callId, stdin, lines } = await sessionCall('barge-in-voice');
    const segmentsBefore = client.messages('tts.segment').length;
    client.send({ type: 'text', text: '#long #hang tell me more' });
    const segment = await client.until('tts.segment', segmentsBefore + 1);
    assert.equal(segment.turn, 2);
    assert.equal(segment.text, LONG_OPENING);
    await waitFor(() => client.received.some((r) => r.kind === 'audio' && r.segmentId === segment.segmentId));

    // The browser stopped halfway through the sentence, reported it, then said so.
    const lengthMs = ((segment.text.length * 2) / 2 / 24000) * 1000;
    client.send({ type: 'playback.progress', segmentId: segment.segmentId, playedMs: lengthMs / 2, done: false });
    client.send({ type: 'speech.start' });

    assert.deepEqual(await client.until('tts.stop'), { type: 'tts.stop', turn: 2 });
    assert.deepEqual(w.ttses[0]?.cancelled, [2]);
    assert.deepEqual(await client.until('agent.done', 2), { type: 'agent.done', turn: 2, interrupted: true });
    assert.equal(lines().filter((entry) => entry['type'] === 'control_request').length, 1);
    assert.deepEqual((lines().find((entry) => entry['type'] === 'control_request') as { request: unknown }).request, { subtype: 'interrupt' });

    client.send({ type: 'text', text: 'shorter please' });
    await client.until('agent.done', 3);
    const heard = segment.text.slice(0, Math.round(segment.text.length / 2)).trimEnd();
    assert.equal(stdin().at(-1), `[voice] [You were interrupted after saying: "${heard}"] shorter please`);

    const reply = listVoiceTurns(w.db, callId).find((t) => t.turn === 2 && t.speaker === 'session');
    assert.equal(reply?.interrupted, true);
    assert.equal(getVoiceSessionAgent(w.db, reply?.sessionId ?? '')?.claudeSessionId, CLAUDE_SESSION);
  });

  it('a misfire after a barge-in resumes nothing, and the aborted audio is not replayed', async () => {
    const { client } = await sessionCall('barge-in-misfire');
    const before = client.messages('tts.segment').length;
    client.send({ type: 'text', text: '#long #hang go on' });
    await client.until('tts.segment', before + 1);
    client.send({ type: 'speech.start' });
    await client.until('agent.done', 2);
    client.send({ type: 'speech.cancel' });
    await flush();
    await waitFor(() => client.messages('state').at(-1)?.phase === 'listening');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.messages('tts.segment').length, before + 1);
    assert.equal(client.messages('user.transcript').length, 2);
    assert.equal(client.messages('agent.done').length, 2);
  });

  it('with voice_barge_in off, speech during playback is ignored and push-to-talk still interrupts', async () => {
    const { w, client } = await sessionCall('barge-in-off');
    setSetting(w.db, 'voice_barge_in', 'off');
    const before = client.messages('tts.segment').length;
    client.send({ type: 'text', text: '#long #hang keep going' });
    await client.until('tts.segment', before + 1);
    client.send({ type: 'speech.start' });
    client.send({ type: 'speech.cancel' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.messages('tts.stop').length, 0);
    assert.equal(client.messages('agent.done').length, 1);

    client.send({ type: 'ptt', down: true });
    assert.deepEqual(await client.until('tts.stop'), { type: 'tts.stop', turn: 2 });
    assert.deepEqual(await client.until('agent.done', 2), { type: 'agent.done', turn: 2, interrupted: true });
  });
});

describe('a scripted call end to end (US-027)', () => {
  let daemon: FakeDockerDaemon;
  let claude: FakeClaude;
  let openrouter: ScriptedOpenRouter;
  let dataDir: string;

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    claude = new FakeClaude(daemon);
    openrouter = await startScriptedOpenRouter();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-e2e-call-'));
  });

  after(async () => {
    await openrouter.close();
    await daemon.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * A call on the real chief over the seeded install, scripted through
   * {@link openrouter}, with the pending `onboarding-copy` session's agent
   * running as the fake `claude` on the fake daemon. `say` goes through STT as
   * an utterance and waits for `turns` turns to finish.
   */
  const scriptedCall = async (opts: { env?: Record<string, string>; providerTts?: boolean; before?: (db: Database) => void } = {}) => {
    openrouter.replies.length = 0;
    openrouter.requests.length = 0;
    openrouter.speech.length = 0;
    const events = new VoiceEventBus();
    let seeded: ChiefWorld | null = null;
    let registry: SessionAgentRegistry | null = null;
    const agents = (): SessionAgentRegistry => registry ?? assert.fail('no session agent registry');
    const w = await world(
      { DATA_DIR: dataDir, OPENROUTER_API_URL: openrouter.baseUrl, ...opts.env },
      {
        events,
        ...(opts.providerTts === true ? { providerTts: true } : {}),
        chief: (db) => {
          seeded = chiefWorld(db);
          // Like app.ts: chief reaches the registry built after it.
          return { ...seeded.services, sessionAgents: { acquire: (id) => agents().acquire(id), isAlive: (id) => agents().isAlive(id) } };
        },
        sessionAgents: (db, config) => {
          const id = (seeded ?? assert.fail('chief was not seeded')).ids['onboarding'] ?? '';
          fs.mkdirSync(path.join(sessionRepoDir(config, id), '.git'), { recursive: true });
          daemon.addContainer({ id: `c-${id}`, name: `chief-web-onboarding-copy-${id}` });
          registry = new SessionAgentRegistry({
            config,
            db,
            docker: new DockerApi(daemon.socketPath),
            containers: {
              start: () => Promise.resolve({ id: `c-${id}`, name: `chief-web-onboarding-copy-${id}`, running: true, state: 'running' as const }),
              remove: () => Promise.resolve(),
            },
            hold: { active: () => false, until: () => null },
          });
          return registry;
        },
      },
    );
    const chief: ChiefWorld = seeded ?? assert.fail('chief was not seeded');
    opts.before?.(w.db);
    const { client, callId } = await w.call();
    const say = async (text: string, turns = 1): Promise<void> => {
      const done = client.messages('agent.done').length;
      w.stt.canned.push(text);
      client.socket.send(encodeFrame(FRAME_KIND_UTTERANCE, 0, Buffer.from('RIFF-not-really')));
      await client.until('agent.done', done + turns);
      await waitFor(() => client.messages('state').at(-1)?.phase === 'listening');
    };
    const hangUp = async (): Promise<void> => {
      client.send({ type: 'hangup' });
      assert.equal((await client.closed).code, WS_CLOSE_CALL_ENDED);
    };
    return { w, chief, events, client, callId, say, hangUp, agents };
  };

  /** The deltas of one turn, joined. */
  const said = (client: Client, turn: number): string =>
    client.messages('agent.delta').filter((d) => d.turn === turn).map((d) => d.text).join('');

  /** Every segment of the turn was voiced, at {@link SPEECH_BYTES_PER_CHAR} bytes a character; returns what was spoken. */
  const spoken = (client: Client, turn: number): string => {
    const segments = client.messages('tts.segment').filter((s) => s.turn === turn);
    assert.ok(segments.length > 0, `turn ${String(turn)} spoke nothing`);
    for (const segment of segments) {
      const bytes = client.received.reduce((n, r) => n + (r.kind === 'audio' && r.segmentId === segment.segmentId ? r.bytes : 0), 0);
      assert.equal(bytes, segment.text.length * SPEECH_BYTES_PER_CHAR, `segment "${segment.text}"`);
    }
    return segments.map((s) => s.text).join(' ');
  };

  /** The `[name, status, summary]` of every finished tool card of a turn. */
  const toolCards = (client: Client, turn: number): string[][] =>
    client.messages('tool').filter((m) => m.turn === turn && m.status !== 'running').map((m) => [m.name, m.status, m.summary ?? '']);

  /** The last message chief's model was sent. */
  const lastModelInput = (): string => {
    const messages = (openrouter.requests.at(-1)?.['messages'] ?? []) as { content: string | null }[];
    return messages.at(-1)?.content ?? '';
  };

  it('"what\'s building" → a spoken answer from the snapshot, with no tool call', async () => {
    const s = await scriptedCall();
    openrouter.replies.push(textReply(['billing-export is building story 3 of 7. ', 'Nothing else is running.']));
    await s.say("what's building");

    assert.deepEqual(s.client.messages('user.transcript'), [{ type: 'user.transcript', turn: 1, text: "what's building" }]);
    assert.equal(openrouter.requests.length, 1);
    assert.deepEqual(s.client.messages('tool'), []);
    assert.equal(said(s.client, 1), 'billing-export is building story 3 of 7. Nothing else is running.');
    assert.match(spoken(s.client, 1), /story 3 of 7\. Nothing else is running\.$/);
    assert.deepEqual(
      listVoiceTurns(s.w.db, s.callId).map((t) => [t.speaker, t.toolsJson]),
      [
        ['user', null],
        ['chief', null],
      ],
    );
    await s.hangUp();
  });

  it('"create a session …" → confirm → "yes" → created, opened, and the setup event spoken after a quiet moment', async () => {
    const s = await scriptedCall();
    openrouter.replies.push(
      toolReply([{ id: 'c1', name: 'create_session', args: '{"repository":"shop-api","name":"CSV export"}' }]),
      textReply(['Shall I create csv-export in shop-api?']),
    );
    await s.say('create a session for the CSV export on shop-api');
    const pill = s.client.messages('confirm').at(-1);
    assert.equal(pill?.prompt, 'Create session csv-export in shop-api, from develop with a pull request into main?');
    assert.deepEqual(toolCards(s.client, 1).map(([name]) => name), ['create_session']);
    assert.equal(s.chief.state.calls.length, 0, 'nothing is created before the yes');
    spoken(s.client, 1);

    openrouter.replies.push(textReply(['Done. csv-export is being set up.']));
    await s.say('yes');
    assert.deepEqual(s.chief.state.calls.map((c) => c.method), ['sessions.create']);
    const session = listSessions(s.w.db, { repositoryId: s.chief.ids['shop'] ?? '' }).find((row) => row.name === 'csv-export');
    assert.ok(session);
    assert.deepEqual(toolCards(s.client, 2), [['create_session', 'ok', 'Created session: csv-export']]);
    assert.ok(s.client.messages('ui').some((m) => m.action === 'navigate' && m.path === `/sessions/${session.id}`));
    assert.equal(s.client.messages('confirm.resolved').at(-1)?.outcome, 'confirmed');
    assert.equal(spoken(s.client, 2), 'Done. csv-export is being set up.');

    // The clone finishes: toasted at once, spoken only once the call has been quiet.
    const done = s.client.messages('agent.done').length;
    s.events.publish({ kind: 'session.setup', sessionId: session.id, name: 'csv-export', ok: true, message: null });
    await waitFor(() => s.client.messages('ui').some((m) => m.action === 'toast' && m.text.includes('csv-export is cloned')));
    await flush();
    assert.equal(s.client.messages('agent.done').length, done);
    openrouter.replies.push(textReply(['csv-export is cloned and ready to plan.']));
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);
    assert.match(lastModelInput(), /^\[event\] csv-export is cloned and ready to plan\./);
    assert.equal(spoken(s.client, 3), 'csv-export is cloned and ready to plan.');
    await s.hangUp();
  });

  it('"pause the nightly rector task" → confirm → "ja" → paused and read back', async () => {
    const s = await scriptedCall();
    openrouter.replies.push(
      toolReply([{ id: 'p1', name: 'pause_recurring_task', args: '{"task":"nightly rector"}' }]),
      textReply(['Zal ik nightly-rector pauzeren?']),
    );
    await s.say('pause the nightly rector task');
    assert.equal(s.client.messages('confirm').at(-1)?.prompt, 'Pause the recurring task nightly-rector?');
    const task = (): boolean | undefined => getRecurringTaskByName(s.w.db, s.chief.ids['shop'] ?? '', 'nightly-rector')?.paused;
    assert.equal(task(), false);

    const requests = openrouter.requests.length;
    openrouter.replies.push(textReply(['nightly-rector is gepauzeerd; ', 'hij draait vannacht niet.']));
    await s.say('ja');
    assert.equal(task(), true);
    assert.deepEqual(toolCards(s.client, 2), [['pause_recurring_task', 'ok', 'Paused: nightly-rector']]);
    // One model round trip: chief reads the outcome back.
    assert.equal(openrouter.requests.length, requests + 1);
    assert.deepEqual(JSON.parse(lastModelInput()), { ok: true, name: 'nightly-rector', paused: true, nextRun: null });
    assert.equal(spoken(s.client, 2), 'nightly-rector is gepauzeerd; hij draait vannacht niet.');
    await s.hangUp();
  });

  it('"change PR 213: …" → confirm → "yes" → the request is posted and a feedback run started', async () => {
    const s = await scriptedCall();
    const list = s.chief.state.pullRequests;
    const [shop] = list?.repositories ?? [];
    const template = shop?.pullRequests[0];
    assert.ok(list && shop && template);
    const csv = { ...template, number: 213, title: 'CSV import', url: 'https://github.com/acme/shop-api/pull/213', headRef: 'csv-import', sessionId: null };
    s.chief.state.pullRequests = { ...list, repositories: [{ ...shop, pullRequests: [...shop.pullRequests, csv] }] };
    openrouter.replies.push(
      toolReply([{ id: 'r1', name: 'request_pr_change', args: '{"repository":"shop-api","number":213,"instruction":"use league csv instead of fgetcsv"}' }]),
      textReply(['Shall I ask for that on 213?']),
    );
    await s.say('change PR 213: use league csv instead of fgetcsv');
    const prompt = s.client.messages('confirm').at(-1)?.prompt ?? '';
    assert.match(prompt, /213, "CSV import", ask for: "use league csv instead of fgetcsv"\?$/);
    assert.equal(s.chief.state.calls.length, 0);

    openrouter.replies.push(textReply(['Posted, and a run is picking it up.']));
    await s.say('yes');
    assert.deepEqual(s.chief.state.calls.map((c) => c.method), ['pullRequests.feedback', 'github.postReview', 'prFeedback.start']);
    const posted = s.chief.state.calls[1]?.arg as { prNumber: number; body: string };
    assert.equal(posted.prNumber, 213);
    assert.match(posted.body, /use league csv instead of fgetcsv/);
    assert.deepEqual(s.chief.state.calls[2]?.arg, { repositoryId: s.chief.ids['shop'], prNumber: 213 });
    assert.deepEqual(toolCards(s.client, 2).map(([name, status]) => [name, status]), [['request_pr_change', 'ok']]);
    spoken(s.client, 2);
    await s.hangUp();
  });

  it('focus a session → its agent boots → the reply streams → "back to chief"', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    // Chief's turn, then the session agent's opening.
    await s.say("let's plan the onboarding copy", 2);
    assert.deepEqual(toolCards(s.client, 1), [['focus_session', 'ok', 'Handed the call to onboarding-copy']]);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    assert.ok(s.client.messages('ui').some((m) => m.action === 'navigate' && m.path === `/sessions/${sessionId}`));
    const opening = s.client.messages('agent.delta').filter((d) => d.agent === 'session');
    assert.ok(opening.length >= 2, 'the reply streams in pieces');
    assert.equal(opening.map((d) => d.text).join(''), 'Heard you. What next?');
    const openingTurn = opening[0]?.turn ?? 0;
    assert.equal(spoken(s.client, openingTurn), 'Heard you. What next?');

    await s.say('add a download button');
    const reply = s.client.messages('agent.delta').filter((d) => d.agent === 'session' && d.turn > openingTurn);
    assert.equal(reply.map((d) => d.text).join(''), 'Heard you. What next?');
    assert.equal(getVoiceSessionAgent(s.w.db, sessionId)?.claudeSessionId, CLAUDE_SESSION);

    const requests = openrouter.requests.length;
    await s.say('back to chief');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.match(said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), /^Je bent weer bij mij\./);
    assert.equal(openrouter.requests.length, requests, 'the handback is a fixed line, not a model call');
    await s.hangUp();
  });

  /** Every user message the session's fake `claude` processes were sent, across restarts. */
  const sessionStdin = (sessionId: string): string[] =>
    claude
      .agentExecs()
      .filter((exec) => exec.containerId === `c-${sessionId}`)
      .flatMap((exec) => claude.userTexts(exec.id));

  it('brief a session → "back to chief" → it drafts alone while chief answers (US-005)', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    const before = sessionStdin(sessionId).length;
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    await s.say('add a download button');
    assert.equal(s.agents().detachedState(sessionId).running, false);

    await s.say('back to chief');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.match(said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), /^Je bent weer bij mij\./);
    const detach = detachPrompt(prdPathFor('onboarding-copy'));
    await waitFor(() => sessionStdin(sessionId).slice(before).includes(detach));
    assert.deepEqual(sessionStdin(sessionId).slice(before).slice(-1), [detach]);
    await s.agents().detachedTurnEnded(sessionId);
    assert.equal(s.agents().detachedState(sessionId).lastOutcome, 'ok');
    assert.ok(listVoiceTurns(s.w.db, s.callId).some((t) => t.speaker === 'agent' && t.text.startsWith('[detached]')));

    // Chief goes on as usual.
    openrouter.replies.push(textReply(['Nothing else is running.']));
    await s.say("what's building");
    assert.equal(said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), 'Nothing else is running.');
    await s.hangUp();
  });

  it('a session left before the operator said anything to it is not detached (US-005)', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    const before = sessionStdin(sessionId).length;
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    await s.say('back to chief');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    await flush();
    assert.equal(s.agents().detachedState(sessionId).running, false);
    assert.equal(s.agents().detachedState(sessionId).lastOutcome, null);
    assert.equal(sessionStdin(sessionId).slice(before).length, 1, 'only the opening was sent');
    await s.hangUp();
  });

  it('"werk het uit" sends a planning session off and chief takes the call (US-006)', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    const before = sessionStdin(sessionId).length;
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    const requests = openrouter.requests.length;
    await s.say('Werk het maar uit.');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.equal(
      said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0),
      'Oké, onboarding-copy gaat ermee aan de slag. Je bent weer bij mij.',
    );
    assert.equal(openrouter.requests.length, requests, 'a fixed line, not a model call');
    const detach = detachPrompt(prdPathFor('onboarding-copy'));
    await waitFor(() => sessionStdin(sessionId).slice(before).includes(detach));
    assert.equal(sessionStdin(sessionId).includes('Werk het maar uit.'), false, 'the intent never reaches the agent');
    await s.agents().detachedTurnEnded(sessionId);
    assert.equal(s.agents().detachedState(sessionId).lastOutcome, 'ok');
    await s.hangUp();
  });

  it('"carry on" under chief focus is an ordinary utterance (US-006)', async () => {
    const s = await scriptedCall();
    openrouter.replies.push(textReply(['Carrying on with what?']));
    await s.say('carry on');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.equal(said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), 'Carrying on with what?');
    await s.hangUp();
  });

  it('"carry on" to a qa session goes to its agent (US-006)', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    updateSession(s.w.db, sessionId, { status: 'ready' });
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's talk about the onboarding copy", 2);
    await s.say('carry on');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    assert.equal(said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), 'Heard you. What next?');
    assert.ok(sessionStdin(sessionId).some((text) => text.includes('carry on')));
    await s.hangUp();
  });

  it('a detached turn that ends is announced at the next quiet moment, once, in the call language (US-008)', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    const seen: VoiceBusEvent[] = [];
    s.events.subscribe((event) => {
      if (event.kind === 'planning.drafted' || event.kind === 'prd.valid') seen.push(event);
    });
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    await s.say('Werk het maar uit.');
    await s.agents().detachedTurnEnded(sessionId);
    await waitFor(() => seen.length > 0);
    const event = seen[0];
    assert.equal(event?.kind, 'planning.drafted');
    assert.equal(event.ok, true);
    assert.equal(event.reason, 'ok');
    assert.equal(event.sessionId, sessionId);
    assert.equal(event.name, 'onboarding-copy');
    const line = draftedLine('nl', event);
    await waitFor(() => s.client.messages('ui').some((m) => m.action === 'toast' && m.text === draftedLine('en', event)));

    // The PRD also became valid in the same stretch: said once, by the fixed line.
    s.events.publish({ kind: 'prd.valid', sessionId, name: 'onboarding-copy', stories: event.stories });
    const done = s.client.messages('agent.done').length;
    const requests = openrouter.requests.length;
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);
    await flush();
    assert.equal(s.client.messages('agent.done').length, done + 1);
    assert.equal(openrouter.requests.length, requests, 'a fixed line, not a model call');
    assert.equal(spoken(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), line);
    await s.hangUp();
  });

  it('a finished draft of another session is spoken while a session agent has the focus (US-008)', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    const done = s.client.messages('agent.done').length;
    s.events.publish({
      kind: 'planning.drafted',
      sessionId: 'another-session',
      name: 'csv-export',
      repository: 'shop-api',
      stories: 5,
      openQuestions: 4,
      ok: true,
      reason: 'ok',
    });
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);
    assert.equal(spoken(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), 'Je sessie csv-export op shop-api is klaar met 4 open vragen.');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    await s.hangUp();
  });

  it('returning to a waiting session asks its open questions, and an answer re-reads the PRD (US-011)', async () => {
    const s = await scriptedCall();
    const sessionId = s.chief.ids['onboarding'] ?? '';
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    await s.say('add a download button');
    await s.say('back to chief');
    // Persists until the chip refocuses it; `running` may be over before `say` returns.
    await waitFor(() => s.agents().detachedState(sessionId).lastOutcome === 'ok');
    // The panel saw it drafting, then back from its turn (US-013).
    const states = (): (string | undefined)[] =>
      s.client.messages('planning').map(({ sessions }) => sessions.find((view) => view.sessionId === sessionId)?.state);
    await waitFor(() => states().length > 0 && states().at(-1) !== 'drafting');
    assert.ok(states().includes('drafting'), `drafting was shown: ${states().join(', ')}`);

    // The draft it left behind: two questions for the operator.
    const session = getSession(s.w.db, sessionId) ?? assert.fail('no session');
    const prd = sessionPrdFile(s.w.config, session);
    const draft = (questions: string[]): void => {
      fs.mkdirSync(path.dirname(prd), { recursive: true });
      fs.writeFileSync(prd, `# PRD: Onboarding copy\n\n## Open Questions\n${questions.map((q) => `- ${q}\n`).join('')}`);
    };
    const questions = ['Should the button say Download or Export?', 'Which file formats?'];
    draft(questions);

    // The chip moves the call back: the agent is sent the questions, not left waiting.
    const done = s.client.messages('agent.done').length;
    s.client.send({ type: 'focus', target: { sessionId } });
    await s.client.until('agent.done', done + 1);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    assert.equal(sessionStdin(sessionId).at(-1), resumePrompt(questions, { state: 'waiting' }));
    const planned = (): unknown[] => s.client.messages('planning').map(({ sessions }) => sessions.find((view) => view.sessionId === sessionId));
    assert.deepEqual(planned().at(-1), { sessionId, name: session.name, repository: 'chief-web', state: 'waiting', openQuestions: 2, stories: 0 });

    // The operator answers the first; the agent takes it off the list.
    const sent = s.client.messages('planning').length;
    draft(questions.slice(1));
    await s.say('Download');
    assert.ok(sessionStdin(sessionId).at(-1)?.includes('Download'));
    assert.equal(sessionStdin(sessionId).at(-1)?.includes('open questions'), false, 'the resume is sent once');
    assert.deepEqual(planned().slice(sent), [{ sessionId, name: session.name, repository: 'chief-web', state: 'waiting', openQuestions: 1, stories: 0 }]);
    await s.hangUp();
  });

  it('ElevenLabs answering 402 → the call speaks through OpenRouter and toasts', async () => {
    const elevenlabs = createServer((req, res) => {
      if ((req.url ?? '').startsWith('/v1/user/subscription')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ character_count: 10_000, character_limit: 10_000, next_character_count_reset_unix: 1_790_000_000 }));
        return;
      }
      res.writeHead(404).end();
    });
    elevenlabs.on('upgrade', (_req: IncomingMessage, socket: Duplex) => {
      const body = JSON.stringify({ detail: { type: 'payment_required', code: 'insufficient_credits', message: 'Out of credits' } });
      socket.end(`HTTP/1.1 402 Payment Required\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\nconnection: close\r\n\r\n${body}`);
    });
    elevenlabs.listen(0, '127.0.0.1');
    await new Promise((resolve) => elevenlabs.once('listening', resolve));
    try {
      const s = await scriptedCall({
        env: { ELEVENLABS_API_URL: `http://127.0.0.1:${String((elevenlabs.address() as AddressInfo).port)}` },
        providerTts: true,
        before: (db) => {
          setSetting(db, 'elevenlabs_api_key', 'sk_el_test');
          setSetting(db, 'voice_voice_id', 'voice123');
        },
      });
      openrouter.replies.push(textReply(['billing-export is building story 3 of 7. ', 'Nothing else is running.']));
      await s.say("what's building");

      assert.ok(s.client.messages('ui').some((m) => m.action === 'toast' && m.text === SWITCHED_TOAST));
      assert.equal(spoken(s.client, 1), openrouter.speech.map((body) => String(body['input'])).join(' '));
      assert.ok(openrouter.speech.length > 0);
      assert.equal(getVoiceCall(s.w.db, s.callId)?.ttsProvider, 'openrouter');
      await s.hangUp();
    } finally {
      elevenlabs.closeAllConnections();
      await new Promise((resolve) => elevenlabs.close(resolve));
    }
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
