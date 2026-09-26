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
import { BrowserService } from '../browser/index.js';
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
  upsertVoiceSessionAgent,
} from '../db/index.js';
import { DockerApi } from '../docker/index.js';
import { FakeBrowser, FakeDockerDaemon } from '../docker/fake-daemon.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { prdPathFor } from '../prd/index.js';
import { createBrowserSavedLogins } from '../repositories/index.js';
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
import { RESUME_WINDOW_MS, type VoiceServiceDeps } from './service.js';
import { answerPrompt, detachPrompt, resumePrompt } from './session-agent/prompt.js';
import { CLAUDE_SESSION, FakeClaude, LONG_OPENING, SECRET_LOGIN } from './session-agent/__fixtures__/fake-claude.js';
import { PlanningStates } from './session-agent/planning-state.js';
import { SessionAgentRegistry } from './session-agent/registry.js';
import { originAllowed } from './socket.js';
import { switchingOver } from './speakable.js';
import { createBrowserViewRoute, type ViewBrowsers } from './browser-view.js';
import { FakeMcpSide } from './__fixtures__/fake-mcp-side.js';
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

/** Hears the next canned line (or result) per utterance, and "what's building?" once they run out. */
class FakeStt implements CallStt {
  calls = 0;
  readonly canned: (string | SttResult)[] = [];
  transcribe(): Promise<SttResult> {
    this.calls += 1;
    const next = this.canned.shift() ?? "what's building?";
    if (typeof next !== 'string') return Promise.resolve(next);
    return Promise.resolve({ kind: 'text', text: next, durationMs: 900, costUsd: 0.001, seconds: 0.9 });
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

/** Replies with {@link REPLY}, one delta per piece; `#wait` thinks until {@link release} (or an abort). */
class ScriptedAgent implements VoiceAgent {
  readonly kind = 'chief' as const;
  readonly heard: string[] = [];
  private releases: (() => void)[] = [];
  /** Lets every `#wait` turn that is thinking go on to answer. */
  release(): void {
    for (const go of this.releases.splice(0)) go();
  }
  get waiting(): number {
    return this.releases.length;
  }
  async *run(input: { text: string; signal: AbortSignal }): AsyncGenerator<AgentEvent> {
    this.heard.push(input.text);
    if (input.text.includes('#wait')) {
      await new Promise<void>((resolve) => {
        this.releases.push(resolve);
        input.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (input.signal.aborted) return;
    }
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

/** The call panel's page view socket (voice feedback US-008): JSON messages parsed, JPEG frames kept. */
class ViewClient {
  readonly json: Record<string, unknown>[] = [];
  readonly frames: Buffer[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.frames.push(data);
      else this.json.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    this.closed = new Promise((resolve) => {
      socket.on('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
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
  /** Opens the page view socket of a session's browser (voice feedback US-008); needs `browser`. */
  connectView(sessionId: string): Promise<ViewClient>;
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
/** `browser`: the session browsers, the "watch with me" card and the page view socket, as in app.ts. */
/** `providerTts`: the real `TtsService` against `ELEVENLABS_API_URL`/`OPENROUTER_API_URL` instead of {@link FakeTts}. */
async function world(
  env: Record<string, string> = {},
  opts: {
    chief?: (db: Database) => ChiefServices;
    sessionAgents?: (db: Database, config: Config) => SessionAgentRegistry;
    earcons?: CallEarcons;
    events?: VoiceEventBus;
    providerTts?: boolean;
    browser?: (db: Database) => { deps: NonNullable<VoiceServiceDeps['browser']>; browsers: ViewBrowsers };
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
  const browser = opts.browser?.(db);
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
    ...(browser === undefined ? {} : { browser: browser.deps }),
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
  if (browser !== undefined) gateway.register(createBrowserViewRoute(browser.browsers, config));
  const server = createServer((_req, res) => res.end());
  gateway.attach(server);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  worlds.push({ gateway, server, db });
  const origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const base = `${origin}/api/voice/stream`;

  const connect = async (query = ''): Promise<Client> => {
    const client = new Client(new WebSocket(`${base}${query}`, { headers: { cookie } }));
    await new Promise<void>((resolve, reject) => {
      client.socket.once('open', resolve);
      client.socket.once('error', reject);
    });
    return client;
  };
  const connectView = async (sessionId: string): Promise<ViewClient> => {
    const view = new ViewClient(new WebSocket(`${origin}/api/voice/browser/${sessionId}`, { headers: { cookie } }));
    await new Promise<void>((resolve, reject) => {
      view.socket.once('open', resolve);
      view.socket.once('error', reject);
    });
    return view;
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
    connectView,
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

describe('an operator who pauses while chief thinks', () => {
  const utterance = (client: Client): void => {
    client.socket.send(encodeFrame(FRAME_KIND_UTTERANCE, 0, Buffer.from('RIFF-not-really')));
  };

  it('keeps thinking through the start of speech and an utterance that transcribes to nothing', async () => {
    const w = await world();
    const { client } = await w.call('?focus=chief');
    w.stt.canned.push('#wait build me a feature', { kind: 'dropped', reason: 'hallucination', text: 'Thank you.', durationMs: 600, costUsd: 0.001, seconds: 0.6 });
    utterance(client);
    await waitFor(() => w.agents[0]?.waiting === 1);

    client.send({ type: 'speech.start' });
    utterance(client);
    await waitFor(() => w.stt.calls === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(client.messages('agent.done').length, 0);
    assert.equal(client.messages('tts.stop').length, 0);

    w.agents[0]?.release();
    assert.deepEqual(await client.until('agent.done'), { type: 'agent.done', turn: 1, interrupted: false });
    assert.deepEqual(w.agents[0]?.heard, ['#wait build me a feature']);
  });

  it('interrupts the thinking turn for real words, and answers an overtaken utterance together with the next', async () => {
    const w = await world();
    const { client, callId } = await w.call('?focus=chief');
    w.stt.canned.push('#wait maak een sessie', 'die de sessie op het scherm toont', 'en ook de PR');
    utterance(client);
    await waitFor(() => w.agents[0]?.waiting === 1);

    // Both arrive while the first turn winds down: the second overtakes the first in the queue.
    utterance(client);
    utterance(client);
    await client.until('agent.done', 2);
    assert.deepEqual(client.messages('agent.done')[0], { type: 'agent.done', turn: 1, interrupted: true });
    assert.deepEqual(w.agents[0]?.heard, ['#wait maak een sessie', 'die de sessie op het scherm toont en ook de PR']);
    const said = listVoiceTurns(w.db, callId).filter((t) => t.speaker === 'user').map((t) => t.text);
    assert.deepEqual(said, ['#wait maak een sessie', 'die de sessie op het scherm toont en ook de PR']);
  });

  it('still lets push-to-talk interrupt a thinking turn', async () => {
    const w = await world();
    const { client } = await w.call('?focus=chief');
    w.stt.canned.push('#wait think hard');
    utterance(client);
    await waitFor(() => w.agents[0]?.waiting === 1);
    client.send({ type: 'ptt', down: true });
    assert.deepEqual(await client.until('agent.done'), { type: 'agent.done', turn: 1, interrupted: true });
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

  it('keeps a login in a tool call out of the socket, the tool card and the database (voice feedback US-009)', async () => {
    const { w, client } = await sessionCall('redacted-login');
    client.send({ type: 'text', text: '#secret check the account page' });
    await client.until('agent.done', 2);

    const card = client.messages('tool').find((message) => message.status === 'ok');
    assert.equal(card?.name, 'Bash');
    assert.equal(card?.summary, 'Running curl -u [redacted]:[redacted] http://localhost:3000/api/me');
    const socket = JSON.stringify(client.received);
    const tables = (w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    const database = JSON.stringify(tables.map((table) => w.db.prepare(`SELECT * FROM "${table}"`).all()));
    assert.match(database, /Running curl -u \[redacted\]/, 'the card is stored');
    for (const secret of [SECRET_LOGIN.password, SECRET_LOGIN.username]) {
      assert.ok(!socket.includes(secret), `${secret} reached the socket`);
      assert.ok(!database.includes(secret), `${secret} reached the database`);
    }
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

  /** Sessions whose clone and container are in place. */
  const cloned = new Set<string>();

  /** A clone for the session to plan against, and a running container on the fake daemon. */
  const clone = (config: Config, session: { id: string; name: string }): void => {
    if (cloned.has(session.id)) return;
    cloned.add(session.id);
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
    daemon.addContainer({ id: `c-${session.id}`, name: `chief-web-${session.name}-${session.id}` });
  };

  after(async () => {
    await openrouter.close();
    await daemon.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * A call on the real chief over the seeded install, scripted through
   * {@link openrouter}, with the pending `onboarding-copy` session's agent
   * running as the fake `claude` on the fake daemon (any other session's too,
   * once `clone`d). `say` goes through STT as an utterance and waits for
   * `turns` turns to finish. `browser` adds the session browsers on the fake
   * daemon, the card and the page view socket.
   */
  const scriptedCall = async (
    opts: { env?: Record<string, string>; providerTts?: boolean; before?: (db: Database) => void; browser?: boolean } = {},
  ) => {
    openrouter.replies.length = 0;
    openrouter.requests.length = 0;
    openrouter.speech.length = 0;
    claude.onTurn = null;
    const events = new VoiceEventBus();
    let seeded: ChiefWorld | null = null;
    let registry: SessionAgentRegistry | null = null;
    let settings: Config | null = null;
    let voice: Voice | null = null;
    const agents = (): SessionAgentRegistry => registry ?? assert.fail('no session agent registry');
    const planning = (): PlanningStates =>
      new PlanningStates({ db: (seeded ?? assert.fail('chief was not seeded')).db, config: settings ?? assert.fail('no config'), registry: agents() });
    const w = await world(
      { DATA_DIR: dataDir, OPENROUTER_API_URL: openrouter.baseUrl, ...opts.env },
      {
        events,
        ...(opts.providerTts === true ? { providerTts: true } : {}),
        ...(opts.browser === true
          ? {
              browser: (db: Database) => {
                const docker = new DockerApi(daemon.socketPath);
                const container = (id: string): Promise<string> => Promise.resolve(`c-${id}`);
                const browsers = new BrowserService({ docker, container });
                return { deps: { docker, container, browsers, savedLogins: createBrowserSavedLogins(db), stopAll: () => browsers.stopAll() }, browsers };
              },
            }
          : {}),
        chief: (db) => {
          seeded = chiefWorld(db);
          // Like app.ts: chief reaches the registry and the voice service built after it.
          return {
            ...seeded.services,
            sessionAgents: { acquire: (id) => agents().acquire(id), isAlive: (id) => agents().isAlive(id) },
            planningStates: { planningState: (id) => planning().planningState(id), listPlanningSessions: () => planning().listPlanningSessions() },
            detachedTurns: {
              start: (id, message) => {
                (voice ?? assert.fail('no voice')).service.runDetachedTurn(id, message, { updated: true });
              },
            },
          };
        },
        sessionAgents: (db, loaded) => {
          settings = loaded;
          const id = (seeded ?? assert.fail('chief was not seeded')).ids['onboarding'] ?? '';
          clone(loaded, { id, name: 'onboarding-copy' });
          registry = new SessionAgentRegistry({
            config: loaded,
            db,
            docker: new DockerApi(daemon.socketPath),
            containers: {
              // Each session in its own container, named after it.
              start: (session) => Promise.resolve({ id: `c-${session.id}`, name: `chief-web-${session.name}-${session.id}`, running: true, state: 'running' as const }),
              remove: () => Promise.resolve(),
            },
            hold: { active: () => false, until: () => null },
          });
          return registry;
        },
      },
    );
    voice = w.voice;
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
    return {
      w,
      chief,
      events,
      client,
      callId,
      say,
      hangUp,
      agents,
      /** What the clone leaves behind: a checkout on the data volume and a container to run its agent in. */
      cloned: (sessionId: string, name: string): void => clone(settings ?? assert.fail('no config'), { id: sessionId, name }),
    };
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

  it('"create a session …" → created and opened on the first tool call, and the setup event spoken after a quiet moment', async () => {
    const s = await scriptedCall();
    openrouter.replies.push(
      toolReply([{ id: 'c1', name: 'create_session', args: '{"repository":"shop-api","name":"CSV export"}' }]),
      textReply(['Done. csv-export is being set up.']),
    );
    await s.say('create a session for the CSV export on shop-api');
    assert.deepEqual(s.chief.state.calls.map((c) => c.method), ['sessions.create']);
    const session = listSessions(s.w.db, { repositoryId: s.chief.ids['shop'] ?? '' }).find((row) => row.name === 'csv-export');
    assert.ok(session);
    assert.deepEqual(toolCards(s.client, 1), [['create_session', 'ok', 'Created session: csv-export']]);
    assert.ok(s.client.messages('ui').some((m) => m.action === 'navigate' && m.path === `/sessions/${session.id}`));
    assert.equal(spoken(s.client, 1), 'Done. csv-export is being set up.');

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
    assert.equal(spoken(s.client, 2), 'csv-export is cloned and ready to plan.');
    await s.hangUp();
  });

  it('"pause the nightly rector task" → paused on the first tool call and read back', async () => {
    const s = await scriptedCall();
    const task = (): boolean | undefined => getRecurringTaskByName(s.w.db, s.chief.ids['shop'] ?? '', 'nightly-rector')?.paused;
    assert.equal(task(), false);
    openrouter.replies.push(
      toolReply([{ id: 'p1', name: 'pause_recurring_task', args: '{"task":"nightly rector"}' }]),
      textReply(['nightly-rector is gepauzeerd; ', 'hij draait vannacht niet.']),
    );
    await s.say('pause the nightly rector task');
    assert.equal(task(), true);
    assert.deepEqual(toolCards(s.client, 1), [['pause_recurring_task', 'ok', 'Paused: nightly-rector']]);
    // Two model round trips: the tool call, then chief reads the outcome back.
    assert.equal(openrouter.requests.length, 2);
    assert.deepEqual(JSON.parse(lastModelInput()), { ok: true, name: 'nightly-rector', paused: true, nextRun: null });
    assert.equal(spoken(s.client, 1), 'nightly-rector is gepauzeerd; hij draait vannacht niet.');
    await s.hangUp();
  });

  it('"change PR 213: …" → the request is posted and a feedback run started on the first tool call', async () => {
    const s = await scriptedCall();
    const list = s.chief.state.pullRequests;
    const [shop] = list?.repositories ?? [];
    const template = shop?.pullRequests[0];
    assert.ok(list && shop && template);
    const csv = { ...template, number: 213, title: 'CSV import', url: 'https://github.com/acme/shop-api/pull/213', headRef: 'csv-import', sessionId: null };
    s.chief.state.pullRequests = { ...list, repositories: [{ ...shop, pullRequests: [...shop.pullRequests, csv] }] };
    openrouter.replies.push(
      toolReply([{ id: 'r1', name: 'request_pr_change', args: '{"repository":"shop-api","number":213,"instruction":"use league csv instead of fgetcsv"}' }]),
      textReply(['Posted, and a run is picking it up.']),
    );
    await s.say('change PR 213: use league csv instead of fgetcsv');
    assert.deepEqual(s.chief.state.calls.map((c) => c.method), ['pullRequests.feedback', 'github.postReview', 'prFeedback.start']);
    const posted = s.chief.state.calls[1]?.arg as { prNumber: number; body: string };
    assert.equal(posted.prNumber, 213);
    assert.match(posted.body, /use league csv instead of fgetcsv/);
    assert.deepEqual(s.chief.state.calls[2]?.arg, { repositoryId: s.chief.ids['shop'], prNumber: 213 });
    assert.deepEqual(toolCards(s.client, 1).map(([name, status]) => [name, status]), [['request_pr_change', 'ok']]);
    assert.equal(spoken(s.client, 1), 'Posted, and a run is picking it up.');
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

  it('a bare "ja" or "yes" is an ordinary utterance for chief and for a session agent', async () => {
    const s = await scriptedCall();
    openrouter.replies.push(textReply(['Waarmee kan ik helpen?']));
    await s.say('Ja.');
    assert.equal(openrouter.requests.length, 1, "chief's model was asked");
    assert.match(lastModelInput(), /Ja\./);
    assert.equal(spoken(s.client, 1), 'Waarmee kan ik helpen?');

    const sessionId = s.chief.ids['onboarding'] ?? '';
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    const before = sessionStdin(sessionId).length;
    const turn = s.client.messages('agent.done').at(-1)?.turn ?? 0;
    await s.say('yes');
    await waitFor(() => sessionStdin(sessionId).slice(before).some((text) => text.includes('yes')));
    const reply = s.client.messages('agent.delta').filter((d) => d.turn > turn);
    assert.ok(reply.length > 0 && reply.every((d) => d.agent === 'session'), 'the session agent answers');
    await s.hangUp();
  });

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

  /** A scripted call with the focus on the planning session onboarding-copy. */
  const onPlanningSession = async (language: 'en' | 'nl'): Promise<{ s: Awaited<ReturnType<typeof scriptedCall>>; sessionId: string }> => {
    const s = await scriptedCall({ before: (db) => setSetting(db, 'voice_language', language) });
    const sessionId = s.chief.ids['onboarding'] ?? '';
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je aan onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    return { s, sessionId };
  };
  const lastSaid = (s: { client: Client }): string => said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0);

  it('"bouw maar" to a planning session marks it ready, starts the build and chief takes the call (US-007)', async () => {
    const { s, sessionId } = await onPlanningSession('nl');
    await s.say('add a download button');
    const before = sessionStdin(sessionId).length;
    const requests = openrouter.requests.length;
    await s.say('Bouw maar.');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.equal(lastSaid(s), 'Oké, onboarding-copy staat klaar en wordt gebouwd. Ik ben er weer.');
    assert.deepEqual(s.chief.state.calls, [
      { method: 'sessions.markReady', arg: sessionId },
      { method: 'builds.start', arg: sessionId },
    ]);
    assert.equal(openrouter.requests.length, requests, 'a fixed line, not a model call');
    await flush();
    assert.deepEqual(sessionStdin(sessionId).slice(before), [], 'the intent never reaches the agent, and a ready session is not detached');
    await s.hangUp();
  });

  it('"build it" when every build slot is busy says the build is queued (US-007)', async () => {
    const { s, sessionId } = await onPlanningSession('en');
    s.chief.state.pool = {
      ...s.chief.state.pool,
      queued: 2,
      queue: [...s.chief.state.pool.queue, { kind: 'session', refId: sessionId, label: 'onboarding-copy', position: 2, queuedAt: '2026-09-25T12:00:00.000Z' }],
    };
    await s.say('Build it.');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.equal(lastSaid(s), 'Okay, onboarding-copy is marked ready and queued, every build slot is busy. Back with me.');
    await s.hangUp();
  });

  it('"build it" on a PRD that does not parse reads the first error and stays with the session (US-007)', async () => {
    const { s, sessionId } = await onPlanningSession('en');
    s.chief.state.prdErrors = [
      { line: 12, message: 'US-002 has no acceptance criteria' },
      { line: 30, message: 'US-004 has no title' },
    ];
    await s.say('start the build');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    assert.equal(lastSaid(s), 'The PRD does not parse yet: line 12: US-002 has no acceptance criteria.');
    assert.deepEqual(s.chief.state.calls.map((call) => call.method), ['sessions.markReady'], 'no build is started');
    await s.hangUp();
  });

  it('"build it" that the service refuses speaks its message and stays with the session (US-007)', async () => {
    const { s, sessionId } = await onPlanningSession('en');
    s.chief.state.failures.set('builds.start', Object.assign(new Error('Builds are on hold until 18:00.'), { status: 409, code: 'usage_hold' }));
    await s.say('build it');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
    assert.equal(lastSaid(s), 'Builds are on hold until 18:00.');
    await s.hangUp();
  });

  it('"build it" under chief focus is an ordinary utterance (US-007)', async () => {
    const s = await scriptedCall();
    openrouter.replies.push(textReply(['Which session should I build?']));
    await s.say('build it');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.equal(lastSaid(s), 'Which session should I build?');
    assert.deepEqual(s.chief.state.calls, []);
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

  /** A PRD of `stories` stories and these open questions, as the session agent would leave it. */
  const writePrd = (s: { w: World }, sessionId: string, stories: number, questions: readonly string[]): void => {
    const session = getSession(s.w.db, sessionId) ?? assert.fail('no session');
    const file = sessionPrdFile(s.w.config, session);
    const story = (n: number): string[] => [
      `### US-00${String(n)}: Story ${String(n)}`,
      '**Status:** todo',
      `**Priority:** ${String(n)}`,
      `**Description:** As a user, I want part ${String(n)}.`,
      '',
      '**Acceptance Criteria:**',
      '- [ ] It works',
      '',
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        `# PRD: ${session.name}`,
        '',
        '## Introduction',
        '',
        'Planned over voice.',
        '',
        '## User Stories',
        '',
        ...Array.from({ length: stories }, (_, i) => story(i + 1)).flat(),
        ...(questions.length === 0 ? [] : ['## Open Questions', '', ...questions.map((q) => `- ${q}`), '']),
      ].join('\n'),
    );
  };

  /** A promise the test settles later: a session agent that keeps working until `release()`. */
  const hold = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };

  const A_QUESTIONS = ['Download or Export?', 'Which file formats?', 'Who may download?', 'Keep old exports?'];

  it('two planning sessions: A drafts alone while B is planned, is announced, reminded of, and resumed (US-014)', async () => {
    const s = await scriptedCall({ before: (db) => setSetting(db, 'voice_language', 'en') });
    const a = s.chief.ids['onboarding'] ?? '';
    const detachA = detachPrompt(prdPathFor('onboarding-copy'));
    const draftingA = hold();
    let b = '';
    claude.onTurn = ({ containerId, text }) => {
      // A's detached turn: done only once B is being planned, with 3 stories and 4 questions.
      if (containerId === `c-${a}` && text === detachA) return draftingA.promise.then(() => writePrd(s, a, 3, A_QUESTIONS));
      // B's agent finishes its PRD during the operator's last answer.
      if (containerId === `c-${b}` && text.includes('invoices page')) writePrd(s, b, 2, []);
      return undefined;
    };

    // Brief A on chief-web, then hand the call back: A drafts alone.
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Handing you to onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    await s.say('add a download button');
    await s.say('back to chief');
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    await waitFor(() => sessionStdin(a).includes(detachA));
    assert.equal(s.agents().detachedState(a).running, true);

    // Chief creates B on shop-api and hands the call to it.
    openrouter.replies.push(
      toolReply([{ id: 'c1', name: 'create_session', args: '{"repository":"shop-api","name":"CSV export"}' }]),
      textReply(['Done. csv-export is being set up.']),
    );
    await s.say('create a session for the CSV export on shop-api');
    const created = listSessions(s.w.db, { repositoryId: s.chief.ids['shop'] ?? '' }).find((row) => row.name === 'csv-export');
    assert.ok(created);
    b = created.id;
    clone(s.w.config, created);
    openrouter.replies.push(
      toolReply([{ id: 'f2', name: 'focus_session', args: '{"session":"csv export"}' }]),
      textReply(['Handing you to csv-export.']),
    );
    await s.say("let's plan the csv export", 2);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId: b });
    await s.say('it needs one column per invoice line');
    assert.equal(s.agents().detachedState(a).running, true, 'A is still drafting while B is planned');

    // A finishes: toasted at once, spoken at the next quiet moment, with B still in focus.
    const announced = 'Your session onboarding-copy on chief-web has finished with 4 open questions.';
    draftingA.release();
    await waitFor(() => s.client.messages('ui').some((m) => m.action === 'toast' && m.text === announced));
    let done = s.client.messages('agent.done').length;
    const requests = openrouter.requests.length;
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);
    assert.equal(spoken(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), announced);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId: b });
    assert.equal(openrouter.requests.length, requests, 'a fixed line, not a model call');
    const viewA = s.client.messages('planning').at(-1)?.sessions.find((view) => view.sessionId === a);
    assert.deepEqual([viewA?.state, viewA?.stories, viewA?.openQuestions], ['waiting', 3, 4]);

    // B's agent finishes its PRD: A is the one waiting session, so the call
    // names it and moves there, and A's agent is sent its four questions.
    await s.say('the button goes on the invoices page');
    assert.equal(s.agents().detachedState(b).running, false);
    done = s.client.messages('agent.done').length;
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);
    assert.equal(
      spoken(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0),
      "onboarding-copy on chief-web is waiting with 4 open questions. I'm switching you over to onboarding-copy.",
    );
    assert.equal(openrouter.requests.length, requests, 'the switch is not a model call');
    await waitFor(() => sessionStdin(a).at(-1) === resumePrompt(A_QUESTIONS, { state: 'waiting' }));
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId: a });
    assert.equal(s.agents().detachedState(b).running, false, 'a done session is not sent off again');
    await s.hangUp();
  });

  it('with two other sessions waiting, the line names them and the focus stays (US-004)', async () => {
    const s = await scriptedCall({ before: (db) => setSetting(db, 'voice_language', 'nl') });
    const a = s.chief.ids['onboarding'] ?? '';
    for (const name of ['csv-export', 'search']) {
      const other = createSession(s.w.db, { repositoryId: s.chief.ids['shop'] ?? '', name, baseBranch: 'develop', prTargetBranch: 'main', status: 'pending' });
      upsertVoiceSessionAgent(s.w.db, { sessionId: other.id, claudeSessionId: `claude-${name}`, mode: 'plan' });
      writePrd(s, other.id, 1, ['Which columns?', 'Who may see it?']);
    }
    claude.onTurn = ({ containerId, text }) => {
      if (containerId === `c-${a}` && text.includes('invoices page')) writePrd(s, a, 2, []);
      return undefined;
    };
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Ik geef je onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    await s.say('the button goes on the invoices page');
    const done = s.client.messages('agent.done').length;
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);
    const line = spoken(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0);
    assert.match(line, /csv-export op shop-api wacht met 2 open vragen/);
    assert.match(line, /search op shop-api wacht met 2 open vragen/);
    assert.match(line, /vragen\.$/, 'no switch-over is announced');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId: a });
    await s.hangUp();
  });

  it('the switch-over sentence in both call languages (US-004)', () => {
    assert.equal(switchingOver('en', 'csv-export'), "I'm switching you over to csv-export.");
    assert.equal(switchingOver('nl', 'csv-export'), 'Ik verbind je door met csv-export.');
  });

  it('chief answers an open question of A while B is being planned, and the update is announced with one question fewer (US-014)', async () => {
    const s = await scriptedCall({ before: (db) => setSetting(db, 'voice_language', 'en') });
    const a = s.chief.ids['onboarding'] ?? '';
    const b = createSession(s.w.db, { repositoryId: s.chief.ids['shop'] ?? '', name: 'csv-export', baseBranch: 'develop', prTargetBranch: 'main', status: 'pending' });
    clone(s.w.config, b);
    const detachA = detachPrompt(prdPathFor('onboarding-copy'));
    const answerA = answerPrompt(prdPathFor('onboarding-copy'), [A_QUESTIONS[0] ?? ''], 'Export');
    const updating = hold();
    claude.onTurn = ({ containerId, text }) => {
      if (containerId !== `c-${a}`) return undefined;
      if (text === detachA) writePrd(s, a, 3, A_QUESTIONS);
      // Takes the answer in, until the test lets it finish: the first question is settled.
      if (text === answerA) return updating.promise.then(() => writePrd(s, a, 3, A_QUESTIONS.slice(1)));
      return undefined;
    };

    // A is briefed and drafts alone to a PRD with four questions; its announcement is heard.
    openrouter.replies.push(
      toolReply([{ id: 'f1', name: 'focus_session', args: '{"session":"onboarding copy"}' }]),
      textReply(['Handing you to onboarding-copy.']),
    );
    await s.say("let's plan the onboarding copy", 2);
    await s.say('add a download button');
    await s.say('back to chief');
    await waitFor(() => s.client.messages('ui').some((m) => m.action === 'toast' && m.text.includes('has finished with 4 open questions')));
    let done = s.client.messages('agent.done').length;
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);

    // B has the focus, then the operator steps back to chief for a word about A:
    // under a session focus every utterance goes to that session's agent.
    done = s.client.messages('agent.done').length;
    s.client.send({ type: 'focus', target: { sessionId: b.id } });
    await s.client.until('agent.done', done + 1);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId: b.id });
    await s.say('back to chief');
    openrouter.replies.push(
      toolReply([{ id: 'q1', name: 'answer_planning_question', args: '{"session":"onboarding copy","question":1,"answer":"Export"}' }]),
      textReply(['Passed it on to onboarding-copy.']),
    );
    await s.say('tell onboarding copy the button says Export');
    assert.deepEqual(toolCards(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), [
      ['answer_planning_question', 'ok', 'Passed the answer to onboarding-copy; it is working on it'],
    ]);
    await waitFor(() => sessionStdin(a).at(-1) === answerA);
    assert.equal(s.agents().detachedState(a).running, true);

    // Back on B while A works the answer in; A's update is spoken there, one question fewer.
    done = s.client.messages('agent.done').length;
    s.client.send({ type: 'focus', target: { sessionId: b.id } });
    await s.client.until('agent.done', done + 1);
    await waitFor(() => s.client.messages('state').at(-1)?.phase === 'listening');
    const updated = 'Your session onboarding-copy on chief-web updated its PRD; 3 open questions left.';
    updating.release();
    await waitFor(() => s.client.messages('ui').some((m) => m.action === 'toast' && m.text === updated));
    done = s.client.messages('agent.done').length;
    s.w.clock.advance(EVENT_QUIET_MS);
    await s.client.until('agent.done', done + 1);
    const turn = s.client.messages('agent.done').at(-1)?.turn ?? 0;
    assert.equal(said(s.client, turn), updated);
    assert.equal(spoken(s.client, turn), updated.replace('PRD', 'P R D'));
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId: b.id });
    await s.hangUp();
  });

  it('with three sessions drafting, focusing a fourth is refused with their names (US-014)', async () => {
    const s = await scriptedCall({ before: (db) => setSetting(db, 'voice_language', 'en') });
    const a = s.chief.ids['onboarding'] ?? '';
    const [c, d, e] = ['csv-export', 'pdf-invoices', 'dark-checkout'].map((name) => {
      const session = createSession(s.w.db, { repositoryId: s.chief.ids['shop'] ?? '', name, baseBranch: 'develop', prTargetBranch: 'main', status: 'pending' });
      clone(s.w.config, session);
      return session.id;
    });
    assert.ok(c !== undefined && d !== undefined && e !== undefined);
    const drafting = hold();
    claude.onTurn = ({ text }) => (text.startsWith('[detached]') ? drafting.promise : undefined);

    // Each session is briefed and left: it drafts alone, and none of them finishes.
    const focus = async (sessionId: string): Promise<void> => {
      const done = s.client.messages('agent.done').length;
      s.client.send({ type: 'focus', target: { sessionId } });
      await s.client.until('agent.done', done + 1);
      await waitFor(() => s.client.messages('state').at(-1)?.phase === 'listening');
    };
    for (const sessionId of [a, c, d]) {
      await focus(sessionId);
      assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId });
      await s.say('add a download button');
    }
    await s.say('back to chief');
    await waitFor(() => [a, c, d].every((id) => s.agents().detachedState(id).running));
    await waitFor(() => [a, c, d].every((id) => s.agents().aliveSessions().includes(id)));

    // The fourth cannot get an agent: the refusal is spoken and chief has the call again.
    await focus(e);
    assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });
    assert.equal(
      spoken(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0),
      'Three sessions are still drafting: onboarding-copy, csv-export and pdf-invoices. Wait for one to finish, or talk to one of them instead.',
    );
    assert.equal(s.agents().isAlive(e), false, 'no fourth agent was started');
    assert.ok([a, c, d].every((id) => s.agents().detachedState(id).running), 'the drafts go on');

    drafting.release();
    await Promise.all([a, c, d].map((id) => s.agents().detachedTurnEnded(id)));
    assert.deepEqual([a, c, d].map((id) => s.agents().detachedState(id).lastOutcome), ['ok', 'ok', 'ok']);
    await s.hangUp();
  });

  it('"I have feedback on shop-api about …" → created on the first tool call → cloned → handed over → the agent opens a browser → frames → Close browser (voice feedback US-013)', async () => {
    const FEEDBACK = 'the checkout total is wrong with a coupon';
    const LOGIN = { username: 'qa-ann@example.com', password: 'c0upon-hunter2!' };
    const URL_ = 'http://host.docker.internal:3000/checkout';
    // Every log line of the call (the logger writes to these two), to prove the password is in none of them.
    const logged: string[] = [];
    const record = (...args: unknown[]): void => {
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    const { log, error } = console;
    console.log = record;
    console.error = record;
    try {
      const s = await scriptedCall({ browser: true });
      const mcp = new FakeMcpSide(daemon, () => s.w.clock.now());
      const browser = new FakeBrowser(daemon);
      browser.replies.set('Page.getFrameTree', () => ({ result: { frameTree: { frame: { id: 'main', url: URL_ } } } }));

      // Chief's one tool call writes the session with the feedback, and its clone starts.
      openrouter.replies.push(
        toolReply([{ id: 'fb1', name: 'start_feedback_session', args: JSON.stringify({ repository: 'shop-api', feedback: FEEDBACK }) }]),
        textReply(['Done. I will hand you over once it is cloned.']),
      );
      await s.say(`I have feedback on shop-api about ${FEEDBACK}`);
      assert.deepEqual(s.chief.state.calls.map((c) => c.method), ['sessions.create']);
      const session = listSessions(s.w.db, { repositoryId: s.chief.ids['shop'] ?? '' }).find((row) => row.feedback === FEEDBACK);
      assert.ok(session, 'the session carries the feedback');
      assert.equal(session.name, 'feedback-checkout-total-is-wrong-with-coupon');
      assert.ok(s.client.messages('ui').some((m) => m.action === 'navigate' && m.path === `/sessions/${session.id}`));
      assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'chief' });

      // The clone finishes: chief says so after a quiet moment, then hands the call over by itself.
      s.cloned(session.id, session.name);
      const done = s.client.messages('agent.done').length;
      s.events.publish({ kind: 'session.setup', sessionId: session.id, name: session.name, ok: true, message: null });
      await waitFor(() => s.client.messages('ui').some((m) => m.action === 'toast' && m.text.includes(`${session.name} is cloned`)));
      openrouter.replies.push(textReply([`${session.name} is cloned. Handing you over.`]));
      s.w.clock.advance(EVENT_QUIET_MS);
      await s.client.until('agent.done', done + 2);
      assert.deepEqual(s.w.voice.service.activeCall?.focus, { kind: 'session', sessionId: session.id });
      const agentExec = (): string => claude.agentExecs().find((exec) => exec.containerId === `c-${session.id}`)?.id ?? '';
      assert.ok(claude.userTexts(agentExec()).some((text) => text.includes(FEEDBACK)), 'the session agent opens on the feedback');
      await waitFor(() => s.client.messages('state').at(-1)?.phase === 'listening');

      // The session agent calls open_browser_with_operator; the MCP server writes its request; the card appears.
      claude.onOpenBrowser = (containerId) => mcp.request(containerId);
      mcp.onAnswer = (_containerId, answer) =>
        claude.finishBrowserTool(answer['credentials'] === undefined ? `opened ${URL_}` : `opened ${URL_} and logged in`);
      const turns = s.client.messages('agent.done').length;
      s.w.stt.canned.push("#browser let's look at it together");
      s.client.socket.send(encodeFrame(FRAME_KIND_UTTERANCE, 0, Buffer.from('RIFF-not-really')));
      const card = await s.client.until('browser.ask');
      assert.equal(card.sessionId, session.id);
      assert.equal(card.hint, 'the checkout page');
      assert.ok(s.client.messages('tool').some((m) => m.status === 'running' && m.summary === 'Opening the browser'));
      assert.equal(s.client.messages('agent.done').length, turns, 'the turn waits for the operator');

      // The operator answers with a URL and a login: it reaches the container, and the turn goes on.
      s.client.send({ type: 'browser.answer', id: card.id, url: URL_, credentials: LOGIN });
      assert.deepEqual(await s.client.until('browser.resolved'), { type: 'browser.resolved', id: card.id, outcome: 'opened' });
      await waitFor(() => mcp.answers.length > 0);
      assert.deepEqual(mcp.answersFor(`c-${session.id}`), [{ id: card.id, cancelled: false, url: URL_, credentials: LOGIN }]);
      await s.client.until('agent.done', turns + 1);
      assert.equal(said(s.client, s.client.messages('agent.done').at(-1)?.turn ?? 0), 'The checkout page is open.');

      // The page view: the URL, then the frames Chromium paints.
      const view = await s.w.connectView(session.id);
      const relay = browser.relayExecs().find((exec) => exec.running && exec.containerId === `c-${session.id}`)?.id ?? '';
      await waitFor(() => browser.commands.some((c) => c.execId === relay && c.method === 'Page.startScreencast'));
      assert.deepEqual(view.json[0], { type: 'url', url: URL_ });
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      browser.emitEvent('Page.screencastFrame', { data: jpeg.toString('base64'), sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } });
      await waitFor(() => view.frames.length === 1);
      assert.deepEqual(view.frames[0], jpeg);

      // **Close browser**: the view closes and Chromium is stopped.
      view.send({ type: 'close' });
      await view.closed;
      const chromium = browser.chromiumExecs().find((exec) => exec.containerId === `c-${session.id}`);
      await waitFor(() => chromium?.running === false);
      assert.ok(browser.signals.includes('TERM'));
      await s.hangUp();

      const socket = JSON.stringify(s.client.received) + JSON.stringify(view.json);
      const voiceTurns = JSON.stringify(listVoiceTurns(s.w.db, s.callId));
      const tables = (s.w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
      const database = JSON.stringify(tables.map((table) => s.w.db.prepare(`SELECT * FROM "${table}"`).all()));
      assert.match(voiceTurns, /Opening the browser/, 'the tool card is stored');
      assert.ok(!socket.includes(LOGIN.password), 'the password reached a socket');
      assert.ok(!voiceTurns.includes(LOGIN.password), 'the password reached voice_turns');
      assert.ok(!database.includes(LOGIN.password), 'the password reached the database');
      assert.ok(!logged.join('\n').includes(LOGIN.password), 'the password reached the logs');
    } finally {
      console.log = log;
      console.error = error;
    }
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
