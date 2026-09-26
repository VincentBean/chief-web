import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import { getVoiceCall, IN_MEMORY, openDatabase, setSetting } from '../db/index.js';
import { type AgentEvent, type AgentInput, type CallClock, type CallTransport, type CallTts, type VoiceAgent, VoiceCall } from './call.js';
import { ChatPrefetch, sameUtterance } from './chief/speculation.js';
import type { ChatEvent } from './chief/openrouter-client.js';
import type { ServerMessage } from './protocol.js';
import type { SpeakCallbacks, SpeakResult } from './tts/index.js';
import type { TtsSegment } from './tts/types.js';

const clock: CallClock = {
  now: () => Date.parse('2026-09-25T10:00:00.000Z'),
  setTimeout: () => 0,
  clearTimeout: () => undefined,
};

class Tts implements CallTts {
  readonly providerName = 'elevenlabs' as const;
  readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
  open(): Promise<void> {
    return Promise.resolve();
  }
  speak(seg: TtsSegment, _signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult> {
    callbacks.onStart?.(this.format, 'elevenlabs');
    return Promise.resolve({ spoken: true, provider: 'elevenlabs', chars: seg.text.length });
  }
  cancelTurn(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Chief stand-in whose `speculate` hands out a marker and records its abort. */
class Agent implements VoiceAgent {
  readonly kind = 'chief' as const;
  readonly inputs: AgentInput[] = [];
  readonly speculations: { text: string; signal: AbortSignal; step: object }[] = [];
  speculate(text: string, signal: AbortSignal): object {
    const step = { text };
    this.speculations.push({ text, signal, step });
    return step;
  }
  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    this.inputs.push(input);
    await Promise.resolve();
    yield { type: 'delta', text: 'Nothing is building right now.' };
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check(), 'condition not reached');
}

async function setup(opts: { speculative?: boolean } = {}) {
  const db = openDatabase(IN_MEMORY);
  if (opts.speculative === true) setSetting(db, 'voice_speculative_chief', '1');
  const sent: ServerMessage[] = [];
  const agent = new Agent();
  const call = new VoiceCall('call-1', { kind: 'chief' }, {
    db,
    config: loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }),
    stt: { transcribe: () => Promise.reject(new Error('no server STT in Scribe mode')) },
    tts: () => new Tts(),
    agent: () => agent,
    clock,
  });
  const transport: CallTransport = { send: (m) => sent.push(m), sendAudio: () => undefined, close: () => undefined };
  call.attach(transport);
  await call.start('elevenlabs-realtime');
  const final = async (text: string): Promise<void> => {
    const done = sent.filter((m) => m.type === 'agent.done').length;
    call.handleMessage({ type: 'transcript.final', text });
    await until(() => sent.filter((m) => m.type === 'agent.done').length > done && call.state.activeTurn === null);
  };
  return { db, call, sent, agent, final };
}

describe('Scribe realtime mode on the call (voice US-022)', () => {
  it('records the seconds streamed to Scribe on the call row', async () => {
    const { db, call } = await setup();
    call.handleMessage({ type: 'scribe.usage', seconds: 2.5 });
    call.handleMessage({ type: 'scribe.usage', seconds: 1.25 });
    assert.equal(getVoiceCall(db, 'call-1')?.scribeSeconds, 3.75);
    assert.equal(getVoiceCall(db, 'call-1')?.sttSeconds, 0);
  });

  it('switches to OpenRouter STT on stt.fallback: WAV utterances are accepted and the row says so', async () => {
    const { db, call, sent } = await setup();
    assert.equal(call.mode, 'elevenlabs-realtime');
    call.handleMessage({ type: 'stt.fallback', reason: 'quota_exceeded' });
    assert.equal(call.mode, 'openrouter');
    assert.equal(getVoiceCall(db, 'call-1')?.sttProvider, 'openrouter');
    // An utterance frame is no longer refused as unexpected audio.
    const frame = Buffer.alloc(5);
    frame.writeUInt8(0x01, 0);
    call.handleFrame(frame, true);
    assert.ok(!sent.some((m) => m.type === 'error' && m.code === 'unexpected_audio'));
  });

  it('does not speculate unless voice_speculative_chief is on', async () => {
    const { call, agent, final } = await setup();
    call.handleMessage({ type: 'transcript.partial', text: 'what is building' });
    assert.equal(agent.speculations.length, 0);
    await final('What is building?');
    assert.equal(agent.inputs[0]?.prefetched, undefined);
  });

  it('hands the early start to the turn when the commit says the same words', async () => {
    const { call, agent, final } = await setup({ speculative: true });
    call.handleMessage({ type: 'transcript.partial', text: 'what is building' });
    call.handleMessage({ type: 'transcript.partial', text: 'what is building' });
    assert.equal(agent.speculations.length, 1);
    await final('What is building?');
    assert.equal(agent.inputs[0]?.prefetched, agent.speculations[0]?.step);
    assert.equal(agent.inputs[0]?.text, 'What is building?');
  });

  it('discards the early start when speech continues or the commit differs', async () => {
    const { call, agent, final } = await setup({ speculative: true });
    call.handleMessage({ type: 'transcript.partial', text: 'what is' });
    call.handleMessage({ type: 'speculation.cancel' });
    assert.equal(agent.speculations[0]?.signal.aborted, true);

    call.handleMessage({ type: 'transcript.partial', text: 'what is building' });
    // A newer stable partial replaces the older one.
    call.handleMessage({ type: 'transcript.partial', text: 'what is building in billing' });
    assert.equal(agent.speculations[1]?.signal.aborted, true);
    await final('What is building in billing export?');
    assert.equal(agent.speculations[2]?.signal.aborted, true);
    assert.equal(agent.inputs[0]?.prefetched, undefined);
  });

  it('never speculates in OpenRouter mode', async () => {
    const { call, agent } = await setup({ speculative: true });
    call.handleMessage({ type: 'stt.fallback', reason: 'auth_error' });
    call.handleMessage({ type: 'transcript.partial', text: 'what is building' });
    assert.equal(agent.speculations.length, 0);
  });
});

describe('ChatPrefetch (voice US-022)', () => {
  async function* scripted(events: ChatEvent[], gate: Promise<void>): AsyncGenerator<ChatEvent> {
    yield events[0] as ChatEvent;
    await gate;
    for (const event of events.slice(1)) yield event;
  }

  it('replays what arrived early, then the rest as it streams', async () => {
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const prefetch = new ChatPrefetch('hi', {}, scripted([{ type: 'delta', text: 'Hel' }, { type: 'delta', text: 'lo.' }], gate));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const seen: string[] = [];
    const reading = (async () => {
      for await (const event of prefetch.replay()) if (event.type === 'delta') seen.push(event.text);
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(seen, ['Hel']);
    open();
    await reading;
    assert.deepEqual(seen, ['Hel', 'lo.']);
  });

  it('rethrows the stream failure (an abort) on replay', async () => {
    async function* failing(): AsyncGenerator<ChatEvent> {
      yield* [];
      await Promise.resolve();
      throw new Error('speculation discarded');
    }
    const prefetch = new ChatPrefetch('hi', {}, failing());
    await assert.rejects(async () => {
      for await (const _ of prefetch.replay()) void _;
    }, /speculation discarded/);
  });

  it('compares a partial and its commit by words only', () => {
    assert.ok(sameUtterance('what is building', 'What is building?'));
    assert.ok(!sameUtterance('what is building', 'what is building in billing'));
  });
});
