import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import { createVoiceCall, getVoiceCall, IN_MEMORY, openDatabase, setSetting, updateVoiceCall } from '../db/index.js';
import { readVoiceMonth } from '../routes/stats.js';
import { getVoiceScribeCreditsPerMin, setVoiceScribeCreditsPerMin } from '../settings/index.js';
import {
  type AgentEvent,
  type AgentInput,
  type CallClock,
  type CallTransport,
  type CallTts,
  type CallUsageSources,
  type VoiceAgent,
  VoiceCall,
} from './call.js';
import type { ServerMessage } from './protocol.js';
import { type ElevenLabsSubscription, fetchOpenRouterGenerationCost } from './providers.js';
import type { SpeakCallbacks, SpeakResult, TtsSink } from './tts/index.js';
import { OpenRouterTts } from './tts/openrouter.js';
import type { TtsProviderName, TtsSegment } from './tts/types.js';
import {
  CallUsage,
  GENERATION_LOOKUP_DELAY_MS,
  GENERATION_RETRY_MS,
  scribeCreditsPerMinute,
  SUBSCRIPTION_REFRESH_MS,
} from './usage.js';

function subscription(characterCount: number, characterLimit = 121_000): ElevenLabsSubscription {
  return {
    tier: 'creator',
    characterCount,
    characterLimit,
    remaining: characterLimit - characterCount,
    resetsAt: null,
  };
}

describe('CallUsage', () => {
  it('accumulates every counter and sums the OpenRouter dollars', () => {
    const usage = new CallUsage();
    usage.add({ sttSeconds: 2.5, sttCostUsd: 0.001 });
    usage.add({ chatCostUsd: 0.004 });
    usage.add({ elChars: 120 });
    usage.add({ elChars: 80, scribeSeconds: 12 });
    usage.add({ claudeTurns: 1 });
    usage.add({ claudeTurns: 1, ttsCostUsd: 0.002 });

    assert.deepEqual(usage.snapshot(), {
      elChars: 200,
      scribeSeconds: 12,
      sttSeconds: 2.5,
      sttCostUsd: 0.001,
      chatCostUsd: 0.004,
      ttsCostUsd: 0.002,
      claudeTurns: 2,
    });
    assert.ok(Math.abs(usage.orCostUsd - 0.007) < 1e-12);
    const row = usage.toCallUpdate();
    assert.equal(row.elChars, 200);
    assert.equal(row.scribeSeconds, 12);
    assert.equal(row.claudeTurns, 2);
    assert.ok(Math.abs((row.orCostUsd ?? 0) - 0.007) < 1e-12);
  });

  it('estimates the balance locally from the last authoritative read', () => {
    const usage = new CallUsage();
    usage.add({ elChars: 50 });
    assert.deepEqual(usage.report(), { elCreditsUsed: 50, orCostUsd: 0 });

    usage.noteSubscription(subscription(38_000));
    usage.add({ elChars: 200 });
    assert.deepEqual(usage.report(), { elCreditsUsed: 250, orCostUsd: 0, elCreditsRemaining: 82_800, elCreditsLimit: 121_000 });

    // The refresh already counts those 200: the estimate starts over from it.
    usage.noteSubscription(subscription(38_200));
    assert.equal(usage.report().elCreditsRemaining, 82_800);
    assert.equal(usage.firstSubscription?.characterCount, 38_000);
  });

  it('prices Scribe per minute from the balance delta beyond the voice', () => {
    // 2 minutes of Scribe moved the balance 1,200 beyond the voice's 300.
    assert.equal(scribeCreditsPerMinute(subscription(1_000), subscription(2_500), 300, 120), 600);
    assert.equal(scribeCreditsPerMinute(subscription(1_000), subscription(2_500), 300, 10), null, 'too little Scribe');
    assert.equal(scribeCreditsPerMinute(subscription(1_000), subscription(1_300), 300, 120), null, 'nothing beyond the voice');
    assert.equal(scribeCreditsPerMinute(subscription(90_000), subscription(100), 0, 120), null, 'the balance reset');
  });
});

/* ---------------------------------------------------------------- the call */

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
  get pending(): number {
    return this.timers.size;
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

/** Speaks on `provider`, reporting a generation id per OpenRouter segment like the real service. */
class Tts implements CallTts {
  readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
  private generations = 0;
  constructor(
    private readonly sink: TtsSink,
    readonly providerName: TtsProviderName,
  ) {}
  open(): Promise<void> {
    return Promise.resolve();
  }
  speak(seg: TtsSegment, _signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult> {
    if (seg.text !== '') {
      callbacks.onStart?.(this.format, this.providerName);
      callbacks.onAudio(Buffer.from(seg.text));
      const usage = { provider: this.providerName, segmentId: seg.segmentId, turn: seg.turn, chars: seg.text.length };
      this.sink.chars(this.providerName === 'openrouter' ? { ...usage, generationId: `gen-${String(++this.generations)}` } : usage);
    }
    return Promise.resolve({ spoken: true, provider: this.providerName, chars: seg.text.length });
  }
  cancelTurn(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class Agent implements VoiceAgent {
  readonly kind = 'chief' as const;
  events: AgentEvent[] = [{ type: 'delta', text: 'Nothing is building right now.' }];
  async *run(_input: AgentInput): AsyncGenerator<AgentEvent> {
    for (const event of this.events) yield await Promise.resolve(event);
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check(), 'condition not reached');
}

function setup(opts: { provider?: TtsProviderName; sources?: CallUsageSources } = {}) {
  const db = openDatabase(IN_MEMORY);
  const sent: ServerMessage[] = [];
  const clock = new FakeClock();
  const agent = new Agent();
  const reads: number[] = [];
  let count = 38_000;
  const sources: CallUsageSources = opts.sources ?? {
    subscription: () => {
      reads.push(clock.now());
      return Promise.resolve(subscription(count));
    },
    generationCost: () => Promise.resolve(null),
  };
  const call = new VoiceCall('call-1', { kind: 'chief' }, {
    db,
    config: loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }),
    stt: { transcribe: () => Promise.resolve({ kind: 'text', text: 'hi', durationMs: 900, costUsd: 0.001, seconds: 1 }) },
    tts: (sink) => new Tts(sink, opts.provider ?? 'elevenlabs'),
    agent: () => agent,
    clock,
    usage: sources,
  });
  const transport: CallTransport = { send: (message) => sent.push(message), sendAudio: () => undefined, close: () => undefined };
  call.attach(transport);
  const usages = () => sent.filter((m): m is Extract<ServerMessage, { type: 'usage' }> => m.type === 'usage');
  const say = async (text: string): Promise<void> => {
    const done = sent.filter((m) => m.type === 'agent.done').length;
    call.handleMessage({ type: 'text', text });
    await until(() => sent.filter((m) => m.type === 'agent.done').length > done && call.state.activeTurn === null);
  };
  return {
    db,
    call,
    clock,
    agent,
    reads,
    usages,
    say,
    setCount: (n: number) => {
      count = n;
    },
  };
}

describe('the call meter', () => {
  it('reads the balance at call start and every 5 minutes, estimating in between', async () => {
    const w = setup();
    await w.call.start('openrouter');
    await until(() => w.reads.length === 1 && w.usages().at(-1)?.elCreditsLimit !== undefined);
    assert.deepEqual(w.usages().at(-1), {
      type: 'usage',
      elCreditsUsed: 0,
      orCostUsd: 0,
      elCreditsRemaining: 83_000,
      elCreditsLimit: 121_000,
    });

    await w.say('what is building?');
    const text = 'Nothing is building right now.';
    // The local estimate: the last read, less the characters spoken since.
    assert.equal(w.usages().at(-1)?.elCreditsRemaining, 83_000 - text.length);

    w.clock.advance(SUBSCRIPTION_REFRESH_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(w.reads.length, 1, 'not before 5 minutes');

    // ElevenLabs counted more than we did (another app, a rounding): it wins.
    w.setCount(38_100);
    w.clock.advance(1);
    await until(() => w.reads.length === 2);
    await until(() => w.usages().at(-1)?.elCreditsRemaining === 82_900);

    w.clock.advance(SUBSCRIPTION_REFRESH_MS);
    await until(() => w.reads.length === 3);

    await w.call.end('hangup');
    w.clock.advance(SUBSCRIPTION_REFRESH_MS * 3);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(w.reads.length, 3, 'no reads after the call');
    w.db.close();
  });

  it('writes every source to voice_calls, Claude turns included', async () => {
    const w = setup();
    w.agent.events = [
      { type: 'delta', text: 'Done.' },
      { type: 'usage', costUsd: 0.004 },
      { type: 'usage', claudeTurns: 1 },
    ];
    await w.call.start('openrouter');
    await w.say('hello');
    w.call.handleMessage({ type: 'scribe.usage', seconds: 4.5 });
    await w.call.end('hangup');

    const row = getVoiceCall(w.db, 'call-1');
    assert.equal(row?.elChars, 'Done.'.length);
    assert.equal(row?.scribeSeconds, 4.5);
    assert.equal(row?.claudeTurns, 1);
    assert.ok(Math.abs((row?.orCostUsd ?? 0) - 0.004) < 1e-12);
    assert.ok(Math.abs((w.usages().at(-1)?.orCostUsd ?? 0) - 0.004) < 1e-12);
    w.db.close();
  });

  it('looks the backup voice cost up after the call, once more for a late generation', async () => {
    const asked: string[] = [];
    let ready = new Set(['gen-1']);
    const w = setup({
      provider: 'openrouter',
      sources: {
        subscription: () => Promise.resolve(null),
        generationCost: (id) => {
          asked.push(id);
          return Promise.resolve(ready.has(id) ? 0.01 : null);
        },
      },
    });
    w.agent.events = [{ type: 'delta', text: 'The first sentence of this reply is long enough to be its own segment. And here is a second one.' }];
    await w.call.start('openrouter');
    await w.say('hello');
    await w.call.end('hangup');
    assert.deepEqual(asked, [], 'nothing is looked up during the call');

    w.clock.advance(GENERATION_LOOKUP_DELAY_MS);
    await until(() => asked.length === 2);
    assert.deepEqual(asked.sort(), ['gen-1', 'gen-2']);
    ready = new Set(['gen-1', 'gen-2']);
    await until(() => w.clock.pending === 1);
    w.clock.advance(GENERATION_RETRY_MS);
    await w.call.settled();

    assert.deepEqual(asked.sort(), ['gen-1', 'gen-2', 'gen-2']);
    assert.ok(Math.abs((getVoiceCall(w.db, 'call-1')?.orCostUsd ?? 0) - 0.02) < 1e-12);
    w.db.close();
  });

  it('measures Scribe credits per minute from the balance after a Scribe call', async () => {
    const w = setup();
    await w.call.start('openrouter');
    await until(() => w.reads.length === 1);
    w.call.handleMessage({ type: 'scribe.usage', seconds: 60 });
    w.call.handleMessage({ type: 'scribe.usage', seconds: 60 });
    await w.call.end('hangup');
    w.setCount(38_000 + 1_000);
    w.clock.advance(GENERATION_LOOKUP_DELAY_MS);
    await w.call.settled();
    assert.equal(w.reads.length, 2);
    assert.equal(getVoiceScribeCreditsPerMin(w.db), 500);
    w.db.close();
  });
});

/* ---------------------------------------------------------- over the wire */

describe('OpenRouter generation lookup', () => {
  let server: http.Server;
  let baseUrl = '';
  const requests: { url: string; auth: string | undefined; method: string | undefined }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? '', auth: req.headers.authorization, method: req.method });
      if (req.url?.startsWith('/audio/speech') === true) {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Generation-Id': 'gen-abc' });
        res.end(Buffer.alloc(8));
        return;
      }
      if (req.url === '/generation?id=gen-abc') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'gen-abc', total_cost: 0.00042, model: 'google/tts' } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Generation not found', code: 404 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('reads the generation id off a speech response', async () => {
    const tts = new OpenRouterTts({ baseUrl, apiKey: 'or-key', model: 'google/tts', voice: 'Kore', sampleRate: 24000 });
    const result = await tts.speak({ segmentId: 1, turn: 1, text: 'Hallo.', last: true }, new AbortController().signal, () => undefined);
    assert.deepEqual(result, { chars: 6, generationId: 'gen-abc' });
  });

  it('answers the total cost, and null while OpenRouter has no stats yet', async () => {
    assert.equal(await fetchOpenRouterGenerationCost(baseUrl, 'or-key', 'gen-abc'), 0.00042);
    assert.equal(await fetchOpenRouterGenerationCost(baseUrl, 'or-key', 'gen-late'), null);
    const lookup = requests.find((r) => r.url === '/generation?id=gen-abc');
    assert.equal(lookup?.method, 'GET');
    assert.equal(lookup?.auth, 'Bearer or-key');
  });
});

describe('Voice this month', () => {
  it('sums the calendar month: minutes, ElevenLabs credits with Scribe at its rate, OpenRouter dollars', () => {
    const db = openDatabase(IN_MEMORY);
    setSetting(db, 'voice_enabled', '1');
    createVoiceCall(db, { id: 'last-month', sttProvider: 'openrouter', ttsProvider: 'elevenlabs', startedAt: '2026-08-31T23:00:00.000Z' });
    updateVoiceCall(db, 'last-month', { endedAt: '2026-08-31T23:30:00.000Z', elChars: 9_999, orCostUsd: 9 });
    createVoiceCall(db, { id: 'done', sttProvider: 'elevenlabs-realtime', ttsProvider: 'elevenlabs', startedAt: '2026-09-10T10:00:00.000Z' });
    updateVoiceCall(db, 'done', { endedAt: '2026-09-10T10:12:00.000Z', elChars: 3_000, scribeSeconds: 120, orCostUsd: 0.1, claudeTurns: 4 });
    createVoiceCall(db, { id: 'open', sttProvider: 'openrouter', ttsProvider: 'openrouter', startedAt: '2026-09-25T09:57:00.000Z' });
    updateVoiceCall(db, 'open', { orCostUsd: 0.04 });

    const before = readVoiceMonth(db, new Date('2026-09-25T10:00:00.000Z'));
    assert.equal(before.calls, 2);
    assert.ok(Math.abs(before.minutes - 15) < 0.01, String(before.minutes));
    assert.equal(before.elCredits, 3_000, 'Scribe is not priced before it was measured');
    assert.ok(Math.abs(before.orCostUsd - 0.14) < 1e-9);
    assert.equal(before.enabled, true);
    assert.equal('claudeTurns' in before, false);

    setVoiceScribeCreditsPerMin(db, 250);
    assert.equal(readVoiceMonth(db, new Date('2026-09-25T10:00:00.000Z')).elCredits, 3_500);
    db.close();
  });
});
