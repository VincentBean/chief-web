import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import { IN_MEMORY, listVoiceTurns, openDatabase, setSetting } from '../db/index.js';
import {
  ACK_AFTER_MS,
  type AgentEvent,
  type AgentInput,
  type CallClock,
  type CallEarcons,
  type CallTransport,
  type CallTts,
  MUTED_LINE,
  NOTHING_TO_REPEAT,
  type VoiceAgent,
  VoiceCall,
} from './call.js';
import { EARCON_NAMES, EARCON_TEXTS, EarconCache, type EarconClip, type EarconVoice } from './earcons.js';
import type { ServerMessage } from './protocol.js';
import type { SttResult } from './stt/index.js';
import type { SpeakCallbacks, SpeakResult } from './tts/index.js';
import type { TtsSegment } from './tts/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-earcons-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

/** Audio is the segment's text as bytes, so a replay can be compared byte for byte. */
class Tts implements CallTts {
  readonly providerName = 'elevenlabs' as const;
  readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
  readonly spoken: string[] = [];
  open(): Promise<void> {
    return Promise.resolve();
  }
  speak(seg: TtsSegment, _signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult> {
    if (seg.text !== '') {
      this.spoken.push(seg.text);
      callbacks.onStart?.(this.format, 'elevenlabs');
      callbacks.onAudio(Buffer.from(seg.text));
    }
    return Promise.resolve({ spoken: true, provider: 'elevenlabs', chars: seg.text.length });
  }
  cancelTurn(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Replies after `gate` opens (immediately without one), after yielding `before`. */
class Agent implements VoiceAgent {
  readonly kind = 'chief' as const;
  readonly inputs: AgentInput[] = [];
  gate: Promise<void> | null = null;
  before: AgentEvent[] = [];
  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    this.inputs.push(input);
    for (const event of this.before) yield event;
    if (this.gate !== null) {
      await Promise.race([this.gate, new Promise((resolve) => input.signal.addEventListener('abort', resolve))]);
      if (input.signal.aborted) return;
    }
    yield { type: 'delta', text: 'Nothing is building right now, and the queue is empty. Shall I start one?' };
  }
}

function clipsFor(sampleRate = 24000): EarconClip[] {
  return (['nl', 'en'] as const).flatMap((language) =>
    EARCON_NAMES.map((name) => ({ name, language, sampleRate, pcm: Buffer.from(`${language}:${name}`) })),
  );
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check(), 'condition not reached');
}

function setup(opts: { earcons?: CallEarcons | null; stt?: () => Promise<SttResult>; language?: string } = {}) {
  const db = openDatabase(IN_MEMORY);
  if (opts.language !== undefined) setSetting(db, 'voice_language', opts.language);
  const sent: ServerMessage[] = [];
  const audio: { segmentId: number; bytes: Buffer }[] = [];
  const clock = new FakeClock();
  const agent = new Agent();
  const tts = new Tts();
  const earcons = opts.earcons === undefined ? { load: () => Promise.resolve(clipsFor()) } : opts.earcons;
  const call = new VoiceCall('call-1', { kind: 'chief' }, {
    db,
    config: loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }),
    stt: { transcribe: opts.stt ?? (() => Promise.resolve({ kind: 'text', text: "what's building?", durationMs: 900, costUsd: 0, seconds: 1 })) },
    tts: () => tts,
    agent: () => agent,
    clock,
    ...(earcons === null ? {} : { earcons }),
  });
  const transport: CallTransport = {
    send: (message) => sent.push(message),
    sendAudio: (segmentId, bytes) => audio.push({ segmentId, bytes }),
    close: () => undefined,
  };
  call.attach(transport);
  const of = <T extends ServerMessage['type']>(type: T) =>
    sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  const say = async (text: string): Promise<void> => {
    const done = of('agent.done').length;
    call.handleMessage({ type: 'text', text });
    await until(() => of('agent.done').length > done && call.state.activeTurn === null);
  };
  return { db, call, sent, audio, of, clock, agent, tts, say };
}

describe('earcon cache (voice US-021)', () => {
  const voice: EarconVoice = { provider: 'elevenlabs', voiceId: 'voice-a', model: 'eleven_flash_v2_5' };

  const counting = () => {
    const rendered: string[] = [];
    return {
      rendered,
      render: (v: EarconVoice, text: string) => {
        rendered.push(`${v.voiceId}:${text}`);
        return Promise.resolve({ audio: Buffer.from(`${v.voiceId}:${text}`), format: { kind: 'pcm16', sampleRate: 24000 } as const });
      },
    };
  };

  it('renders every clip in both languages once per voice, then reads them from disk', async () => {
    const dir = path.join(tmp, 'reuse');
    const first = counting();
    const clips = await new EarconCache(dir, first.render).load(voice, new AbortController().signal);
    assert.equal(first.rendered.length, 10);
    assert.ok(first.rendered.includes('voice-a:Sorry, dat verstond ik niet.'));
    assert.ok(first.rendered.includes("voice-a:Sorry, I didn't catch that."));
    assert.equal(clips.length, 10);
    for (const name of EARCON_NAMES) {
      assert.ok(fs.existsSync(path.join(dir, 'voice-a', `${name}.nl.pcm`)), name);
      assert.ok(fs.existsSync(path.join(dir, 'voice-a', `${name}.en.pcm`)), name);
    }

    // A new cache (a restart) over the same directory: no provider call.
    const second = counting();
    const again = await new EarconCache(dir, second.render).load(voice, new AbortController().signal);
    assert.deepEqual(second.rendered, []);
    const oneSec = again.find((clip) => clip.name === 'one_sec' && clip.language === 'en');
    assert.equal(oneSec?.pcm.toString(), `voice-a:${EARCON_TEXTS.en.one_sec}`);
    assert.equal(oneSec.sampleRate, 24000);
  });

  it('renders again for another voice, or when the model behind the same voice changed', async () => {
    const dir = path.join(tmp, 'changes');
    const r = counting();
    const cache = new EarconCache(dir, r.render);
    await cache.load(voice, new AbortController().signal);
    await cache.load({ ...voice, voiceId: 'voice-b' }, new AbortController().signal);
    assert.equal(r.rendered.length, 20);
    assert.ok(fs.existsSync(path.join(dir, 'voice-b', 'okay.en.pcm')));
    await cache.load({ ...voice, model: 'eleven_turbo_v2_5' }, new AbortController().signal);
    assert.equal(r.rendered.length, 30);
    await cache.load({ ...voice, model: 'eleven_turbo_v2_5' }, new AbortController().signal);
    assert.equal(r.rendered.length, 30);
  });

  it('shares one render between concurrent loads and keeps the voice id inside the cache directory', async () => {
    const dir = path.join(tmp, 'shared');
    const r = counting();
    const cache = new EarconCache(dir, r.render);
    const odd = { ...voice, voiceId: '../../etc' };
    await Promise.all([cache.load(odd, new AbortController().signal), cache.load(odd, new AbortController().signal)]);
    assert.equal(r.rendered.length, 10);
    assert.ok(cache.voiceDir(odd).startsWith(`${dir}${path.sep}`));
  });

  it('leaves no manifest behind when a clip fails, so the next load renders again', async () => {
    const dir = path.join(tmp, 'failing');
    let fail = true;
    const cache = new EarconCache(dir, (_v, text) =>
      fail && text === 'One sec.'
        ? Promise.reject(new Error('socket closed'))
        : Promise.resolve({ audio: Buffer.from(text), format: { kind: 'pcm16', sampleRate: 24000 } as const }),
    );
    await assert.rejects(cache.load(voice, new AbortController().signal), /socket closed/);
    assert.equal(fs.existsSync(path.join(dir, 'voice-a', 'manifest.json')), false);
    fail = false;
    assert.equal((await cache.load(voice, new AbortController().signal)).length, 10);
  });
});

describe('earcons in a call (voice US-021)', () => {
  it('lists the earcons of the call language in ready and sends their audio right after it', async () => {
    const t = setup({ language: 'en' });
    await t.call.start('openrouter');
    const ready = t.of('ready')[0];
    assert.ok(ready);
    assert.deepEqual(
      ready.earcons.map((e) => e.name),
      [...EARCON_NAMES],
    );
    assert.ok(ready.earcons.every((e) => e.sampleRate === 24000));
    for (const earcon of ready.earcons) {
      assert.equal(t.audio.find((a) => a.segmentId === earcon.segmentId)?.bytes.toString(), `en:${earcon.name}`);
      assert.ok(t.of('tts.end').some((m) => m.segmentId === earcon.segmentId));
    }
    assert.ok(t.sent.indexOf(ready) < t.sent.findIndex((m) => m.type === 'tts.end'));

    // A resumed socket gets them again.
    t.call.resume();
    assert.equal(t.of('ready').length, 2);
    assert.equal(t.audio.length, EARCON_NAMES.length * 2);
  });

  it('goes without earcons when they cannot be loaded', async () => {
    const t = setup({ earcons: { load: () => Promise.reject(new Error('no key')) } });
    await t.call.start('openrouter');
    assert.deepEqual(t.of('ready')[0]?.earcons, []);
  });

  it('plays an acknowledgement when no agent audio has started 700 ms after the operator stopped', async () => {
    const t = setup();
    await t.call.start('openrouter');
    let release = (): void => undefined;
    t.agent.gate = new Promise((resolve) => {
      release = resolve;
    });
    t.call.handleFrame(Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('RIFF')]), true);
    await until(() => t.agent.inputs.length === 1);

    t.clock.advance(ACK_AFTER_MS - 1);
    assert.deepEqual(t.of('earcon'), []);
    t.clock.advance(1);
    assert.deepEqual(t.of('earcon'), [{ type: 'earcon', name: 'mm_hm' }]);
    // Once per utterance.
    t.clock.advance(5_000);
    assert.equal(t.of('earcon').length, 1);

    release();
    await until(() => t.call.state.activeTurn === null);
    // The reply's audio came after the earcon.
    assert.ok(t.sent.findIndex((m) => m.type === 'earcon') < t.sent.findIndex((m) => m.type === 'tts.segment'));
  });

  it('plays nothing when the reply is heard within 700 ms, and rotates the acknowledgement', async () => {
    const t = setup();
    await t.call.start('openrouter');
    await t.say('hello');
    t.clock.advance(ACK_AFTER_MS * 2);
    assert.deepEqual(t.of('earcon'), []);

    t.agent.gate = new Promise(() => undefined);
    t.call.handleMessage({ type: 'text', text: 'first' });
    await until(() => t.agent.inputs.length === 2);
    t.clock.advance(ACK_AFTER_MS);
    t.call.handleMessage({ type: 'text', text: 'second' });
    await until(() => t.agent.inputs.length === 3);
    t.clock.advance(ACK_AFTER_MS);
    assert.deepEqual(
      t.of('earcon').map((m) => m.name),
      ['mm_hm', 'okay'],
    );
  });

  it('plays "one sec" when the agent says it is booting, instead of the acknowledgement', async () => {
    const t = setup();
    await t.call.start('openrouter');
    let release = (): void => undefined;
    t.agent.before = [{ type: 'earcon', name: 'one_sec' }];
    t.agent.gate = new Promise((resolve) => {
      release = resolve;
    });
    t.call.handleMessage({ type: 'text', text: 'hi' });
    await until(() => t.of('earcon').length === 1);
    t.clock.advance(ACK_AFTER_MS * 3);
    assert.deepEqual(t.of('earcon'), [{ type: 'earcon', name: 'one_sec' }]);
    release();
    await until(() => t.call.state.activeTurn === null);
  });

  it('says "sorry, I didn\'t catch that" when transcription fails and keeps listening', async () => {
    const t = setup({ stt: () => Promise.reject(new Error('timeout')) });
    await t.call.start('openrouter');
    t.call.handleFrame(Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('RIFF')]), true);
    await until(() => t.of('earcon').length === 1 && t.call.state.activeTurn === null);
    assert.deepEqual(t.of('earcon'), [{ type: 'earcon', name: 'sorry' }]);
    t.clock.advance(ACK_AFTER_MS);
    assert.equal(t.of('earcon').length, 1);
    assert.equal(t.of('state').at(-1)?.phase, 'listening');
    assert.equal(t.call.state.phase, 'listening');
    assert.equal(t.agent.inputs.length, 0);
    assert.equal(t.call.ended, false);
  });

  it('sends no earcon the call does not have', async () => {
    const t = setup({ earcons: null, stt: () => Promise.reject(new Error('timeout')) });
    await t.call.start('openrouter');
    t.call.handleFrame(Buffer.concat([Buffer.from([1, 0, 0, 0, 0]), Buffer.from('RIFF')]), true);
    await until(() => t.of('error').length === 1 && t.call.state.activeTurn === null);
    assert.deepEqual(t.of('earcon'), []);
  });
});

describe('repeat and mute (voice US-021)', () => {
  it('replays the last reply from the call cache without a provider call', async () => {
    const t = setup();
    await t.call.start('openrouter');
    await t.say("what's building?");
    const first = t.of('tts.segment');
    const spoken = [...t.tts.spoken];
    assert.ok(first.length > 0);
    const firstAudio = first.map((s) => Buffer.concat(t.audio.filter((a) => a.segmentId === s.segmentId).map((a) => a.bytes)).toString());

    await t.say('Say that again.');
    assert.deepEqual(t.tts.spoken, spoken, 'no provider call');
    assert.equal(t.agent.inputs.length, 1, 'the agent was not asked');
    const replayed = t.of('tts.segment').slice(first.length);
    assert.deepEqual(
      replayed.map((s) => s.text),
      first.map((s) => s.text),
    );
    assert.ok(replayed.every((s) => s.turn === 2));
    assert.deepEqual(
      replayed.map((s) => Buffer.concat(t.audio.filter((a) => a.segmentId === s.segmentId).map((a) => a.bytes)).toString()),
      firstAudio,
    );
    assert.ok(t.of('agent.delta').some((d) => d.turn === 2 && d.text.startsWith('Nothing is building')));
    assert.deepEqual(t.of('agent.done').at(-1), { type: 'agent.done', turn: 2, interrupted: false });
    assert.equal(listVoiceTurns(t.db, 'call-1').filter((row) => row.speaker === 'chief').length, 2);

    // Dutch works too, and a repeat of a repeat is still the same reply.
    await t.say('Wat zei je?');
    assert.deepEqual(t.tts.spoken, spoken);
    assert.deepEqual(
      t.of('tts.segment').slice(first.length * 2).map((s) => s.text),
      first.map((s) => s.text),
    );
  });

  it('says so when there is nothing to repeat yet', async () => {
    const t = setup({ language: 'en' });
    await t.call.start('openrouter');
    await t.say('say that again');
    assert.deepEqual(t.tts.spoken, [NOTHING_TO_REPEAT['en']]);
  });

  it('mutes the voice for the rest of the call while the transcript streams, and unmutes', async () => {
    const t = setup({ language: 'en' });
    await t.call.start('openrouter');
    await t.say('mute');
    assert.equal(t.call.state.muted, true);
    assert.equal(t.of('state').at(-1)?.muted, true);
    assert.deepEqual(t.tts.spoken, [], 'the mute line is text only');
    assert.ok(t.of('agent.delta').some((d) => d.text === MUTED_LINE['en']));

    const segments = t.of('tts.segment').length;
    await t.say("what's building?");
    await t.say('and now?');
    assert.deepEqual(t.tts.spoken, []);
    assert.equal(t.of('tts.segment').length, segments);
    assert.equal(t.of('agent.delta').filter((d) => d.text.startsWith('Nothing is building')).length, 2);

    // Muted: no acknowledgements either.
    t.agent.gate = new Promise(() => undefined);
    t.call.handleMessage({ type: 'text', text: 'slow one' });
    await until(() => t.agent.inputs.length === 3);
    t.clock.advance(ACK_AFTER_MS);
    assert.deepEqual(t.of('earcon'), []);
    t.agent.gate = null;

    await t.say('Unmute.');
    assert.equal(t.call.state.muted, false);
    assert.equal(t.of('state').at(-1)?.muted, false);
    assert.equal(t.tts.spoken.length, 1);
    await t.say('one more');
    assert.ok(t.tts.spoken.length > 1);
  });

  it('mutes from the panel button (voice.mute) and "stil" in Dutch', async () => {
    const t = setup();
    await t.call.start('openrouter');
    t.call.handleMessage({ type: 'voice.mute', muted: true });
    assert.equal(t.of('state').at(-1)?.muted, true);
    await t.say('hello');
    assert.deepEqual(t.tts.spoken, []);
    t.call.handleMessage({ type: 'voice.mute', muted: false });
    await t.say('hello again');
    assert.ok(t.tts.spoken.length > 0);

    await t.say('Stil!');
    assert.equal(t.call.state.muted, true);
  });
});
