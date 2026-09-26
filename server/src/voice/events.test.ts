import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import { listVoiceTurns, setSetting } from '../db/index.js';
import { type AgentEvent, type AgentInput, type CallClock, type CallTts, EVENT_QUIET_MS, type VoiceAgent, VoiceCall } from './call.js';
import { chiefWorld, NOW } from './chief/__fixtures__/world.js';
import { type ScriptedOpenRouter, startScriptedOpenRouter, textReply } from './chief/__fixtures__/scripted-openrouter.js';
import { ChiefAgent } from './chief/agent.js';
import { describeEvent, isAnnounced, type VoiceBusEvent, VoiceEventBus } from './events.js';
import type { AgentKind, CallFocus, ServerMessage } from './protocol.js';
import type { SpeakCallbacks, SpeakResult } from './tts/index.js';
import type { TtsSegment } from './tts/types.js';

/** Drives every timer the call schedules; nothing runs on the wall clock. */
class FakeClock implements CallClock {
  t = NOW.getTime();
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

class SilentTts implements CallTts {
  readonly providerName = 'elevenlabs' as const;
  readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
  open(): Promise<void> {
    return Promise.resolve();
  }
  speak(_seg: TtsSegment, _signal: AbortSignal, _callbacks: SpeakCallbacks): Promise<SpeakResult> {
    return Promise.resolve({ spoken: true, provider: 'elevenlabs', chars: 0 });
  }
  cancelTurn(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** An agent that records what it was handed; `hold()` keeps its next turn running until released. */
class RecordingAgent implements VoiceAgent {
  readonly inputs: string[] = [];
  private gate: Promise<void> | null = null;

  constructor(readonly kind: AgentKind) {}

  hold(): () => void {
    let release = (): void => undefined;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.gate = null;
      release();
    };
  }

  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    this.inputs.push(input.text);
    if (this.gate !== null) await this.gate;
    yield { type: 'delta', text: 'Noted.' };
  }
}

const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw' });

const setupDone: VoiceBusEvent = { kind: 'session.setup', sessionId: 's-billing', name: 'billing-export', ok: true, message: null };
const buildFailed: VoiceBusEvent = { kind: 'build.failed', sessionId: 's-csv', name: 'csv-export', message: 'The agent stalled on US-004.\nmore detail' };
const taskFired: VoiceBusEvent = { kind: 'task.fired', sessionId: 's-rector', task: 'nightly-rector', name: 'nightly-rector-20260925-0200' };
const hold: VoiceBusEvent = { kind: 'limits.hold', until: '2026-09-25T13:10:00.000Z' };

async function liveCall(focus: CallFocus = { kind: 'chief' }) {
  const w = chiefWorld();
  const clock = new FakeClock();
  const sent: ServerMessage[] = [];
  const chief = new RecordingAgent('chief');
  const session = new RecordingAgent('session');
  const call = new VoiceCall('call-1', focus, {
    db: w.db,
    config,
    stt: { transcribe: () => Promise.reject(new Error('no audio here')) },
    tts: () => new SilentTts(),
    agent: (f) => (f.kind === 'chief' ? chief : session),
    clock,
  });
  call.attach({ send: (message) => sent.push(message), sendAudio: () => undefined, close: () => undefined });
  await call.start('openrouter');

  const dones = (): number => sent.filter((m) => m.type === 'agent.done').length;
  /** Resolves once `count` turns have sent `agent.done`. */
  const settled = async (count: number): Promise<void> => {
    for (let i = 0; i < 2000; i++) {
      if (dones() >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('the turn never finished');
  };
  /** Lets queued microtasks and a started turn run without moving the clock. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const toasts = (): string[] => sent.flatMap((m) => (m.type === 'ui' && m.action === 'toast' ? [m.text] : []));
  return { w, call, clock, sent, chief, session, settled, flush, toasts, dones };
}

describe('VoiceEventBus (voice US-015)', () => {
  it('delivers to subscribers until they unsubscribe, and never throws into the publisher', () => {
    const bus = new VoiceEventBus();
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(event.kind));
    bus.subscribe(() => {
      throw new Error('listener bug');
    });
    assert.doesNotThrow(() => bus.publish(setupDone));
    off();
    bus.publish(hold);
    assert.deepEqual(seen, ['session.setup']);
  });

  it('describes each event in one line, in the voice time zone', () => {
    assert.equal(describeEvent(setupDone), 'billing-export is cloned and ready to plan.');
    assert.equal(describeEvent(buildFailed), 'The build of csv-export failed: The agent stalled on US-004.');
    assert.equal(describeEvent(hold, 'Europe/Amsterdam'), 'Claude hit its usage limit; builds resume at 15:10.');
    assert.equal(
      describeEvent({ kind: 'pr.opened', sessionId: 's', name: 'billing-export', number: 213, adopted: false }),
      'Pull request 213 is open for billing-export.',
    );
  });

  it('sorts kinds into important and all', () => {
    for (const kind of ['session.setup', 'build.finished', 'build.failed', 'pr.opened', 'pr.run_finished', 'pr.conflict_fixed', 'limits.hold'] as const) {
      assert.equal(isAnnounced(kind, 'important'), true, kind);
      assert.equal(isAnnounced(kind, 'none'), false, kind);
    }
    for (const kind of ['build.story_done', 'task.fired', 'build.waiting'] as const) {
      assert.equal(isAnnounced(kind, 'important'), false, kind);
      assert.equal(isAnnounced(kind, 'all'), true, kind);
    }
  });
});

describe('background events in a call (voice US-015)', () => {
  it('toasts at once and speaks through chief after 2 s of quiet, as an [event] turn', async () => {
    const t = await liveCall();
    t.call.postEvent(setupDone);
    assert.deepEqual(t.toasts(), ['billing-export is cloned and ready to plan.']);

    t.clock.advance(EVENT_QUIET_MS - 1);
    await t.flush();
    assert.deepEqual(t.chief.inputs, []);

    t.clock.advance(1);
    await t.settled(1);
    assert.deepEqual(t.chief.inputs, ['[event] billing-export is cloned and ready to plan.']);
    // Not the operator's words: no transcript echo, and the row is an event row.
    assert.equal(t.sent.some((m) => m.type === 'user.transcript'), false);
    const rows = listVoiceTurns(t.w.db, 'call-1');
    assert.deepEqual(rows.map((row) => [row.speaker, row.text]), [
      ['event', '[event] billing-export is cloned and ready to plan.'],
      ['chief', 'Noted.'],
    ]);
    assert.equal(t.call.state.queue.length, 0);
    await t.call.end('hangup');
  });

  it('queues while a turn is running and delivers at the next quiet moment', async () => {
    const t = await liveCall();
    const release = t.chief.hold();
    t.call.handleMessage({ type: 'text', text: "what's building?" });
    await t.flush();
    assert.equal(t.call.state.phase, 'thinking');

    t.call.postEvent(setupDone);
    assert.equal(t.toasts().length, 1, 'toasted even though it cannot be spoken yet');
    t.clock.advance(10_000);
    await t.flush();
    assert.deepEqual(t.chief.inputs, ["what's building?"]);
    assert.equal(t.call.state.queue.length, 1);

    release();
    await t.settled(1);
    assert.equal(t.call.state.phase, 'listening');
    // The quiet moment counts from the end of the reply, not from the event.
    t.clock.advance(EVENT_QUIET_MS - 1);
    await t.flush();
    assert.equal(t.chief.inputs.length, 1);
    t.clock.advance(1);
    await t.settled(2);
    assert.deepEqual(t.chief.inputs, ["what's building?", '[event] billing-export is cloned and ready to plan.']);
    await t.call.end('hangup');
  });

  it('waits while the operator is speaking, and restarts the quiet clock on any sign of speech', async () => {
    const t = await liveCall();
    t.call.postEvent(setupDone);
    t.clock.advance(1_500);
    t.call.handleMessage({ type: 'speech.start' });
    t.clock.advance(10_000);
    await t.flush();
    assert.deepEqual(t.chief.inputs, [], 'not while speech is open');

    t.call.handleMessage({ type: 'speech.cancel' });
    t.clock.advance(1_000);
    t.call.handleMessage({ type: 'playback.progress', segmentId: 99, playedMs: 200, done: false });
    t.clock.advance(EVENT_QUIET_MS - 1);
    await t.flush();
    assert.deepEqual(t.chief.inputs, []);

    t.clock.advance(1);
    await t.settled(1);
    assert.equal(t.chief.inputs.length, 1);
    await t.call.end('hangup');
  });

  it('combines several queued events into one turn', async () => {
    const t = await liveCall();
    t.call.postEvent(setupDone);
    t.clock.advance(500);
    t.call.postEvent(buildFailed);
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(1);
    assert.deepEqual(t.chief.inputs, [
      '[event] billing-export is cloned and ready to plan.\n[event] The build of csv-export failed: The agent stalled on US-004.',
    ]);
    assert.equal(t.dones(), 1);
    await t.call.end('hangup');
  });

  it('honours voice_event_verbosity, toasting either way', async () => {
    const t = await liveCall();

    // Default `important`: a fired task is toasted only; a failure is spoken.
    t.call.postEvent(taskFired);
    t.call.postEvent(buildFailed);
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(1);
    assert.deepEqual(t.chief.inputs, ['[event] The build of csv-export failed: The agent stalled on US-004.']);

    setSetting(t.w.db, 'voice_event_verbosity', 'all');
    t.call.postEvent(taskFired);
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(2);
    assert.equal(t.chief.inputs[1], '[event] Recurring task nightly-rector fired as nightly-rector-20260925-0200.');

    setSetting(t.w.db, 'voice_event_verbosity', 'none');
    t.call.postEvent(setupDone);
    t.clock.advance(EVENT_QUIET_MS * 5);
    await t.flush();
    assert.equal(t.chief.inputs.length, 2);
    assert.equal(t.call.state.queue.length, 0);

    assert.equal(t.toasts().length, 4);
    await t.call.end('hangup');
  });

  it('while a session agent has the focus, announces only that session, in chief, and keeps the focus', async () => {
    const focus: CallFocus = { kind: 'session', sessionId: 's-billing' };
    const t = await liveCall(focus);

    t.call.postEvent(buildFailed);
    t.call.postEvent(hold);
    t.call.postEvent(setupDone);
    assert.equal(t.toasts().length, 3, 'every event is still toasted');
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(1);

    assert.deepEqual(t.chief.inputs, ['[event] billing-export is cloned and ready to plan.']);
    assert.deepEqual(t.session.inputs, []);
    assert.deepEqual(t.call.focus, focus);
    const deltas = t.sent.filter((m) => m.type === 'agent.delta');
    assert.deepEqual(deltas.map((m) => m.agent), ['chief']);
    assert.equal(t.sent.some((m) => m.type === 'state' && m.focus.kind === 'chief'), false);
    await t.call.end('hangup');
  });

  it('drops a queued event that no longer concerns the focus when it is delivered', async () => {
    const t = await liveCall();
    t.call.postEvent(buildFailed);
    t.call.handleMessage({ type: 'focus', target: { sessionId: 's-billing' } });
    t.clock.advance(EVENT_QUIET_MS * 2);
    await t.flush();
    assert.deepEqual(t.chief.inputs, []);
    assert.equal(t.call.state.queue.length, 0);
    await t.call.end('hangup');
  });

  it('holds events for a dropped socket until it is back', async () => {
    const t = await liveCall();
    const transport = { send: (message: ServerMessage) => t.sent.push(message), sendAudio: () => undefined, close: () => undefined };
    t.call.attach(transport);
    t.call.detach(transport);
    t.call.postEvent(setupDone);
    t.clock.advance(EVENT_QUIET_MS * 2);
    await t.flush();
    assert.deepEqual(t.chief.inputs, []);

    t.call.attach(transport);
    t.call.resume();
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(1);
    assert.equal(t.chief.inputs.length, 1);
    await t.call.end('hangup');
  });
});

describe("events in chief's conversation (voice US-015)", () => {
  let fake: ScriptedOpenRouter;

  before(async () => {
    fake = await startScriptedOpenRouter();
  });

  after(async () => {
    await fake.close();
  });

  beforeEach(() => {
    fake.replies.length = 0;
    fake.requests.length = 0;
  });

  it("injects the events as one user message and speaks chief's one line", async () => {
    const chiefConfig = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', OPENROUTER_API_URL: fake.baseUrl });
    const w = chiefWorld();
    setSetting(w.db, 'openrouter_api_key', 'sk-or-test');
    const clock = new FakeClock();
    const sent: ServerMessage[] = [];
    const call = new VoiceCall('call-2', { kind: 'chief' }, {
      db: w.db,
      config: chiefConfig,
      stt: { transcribe: () => Promise.reject(new Error('no audio here')) },
      tts: () => new SilentTts(),
      agent: (_focus, owner) => new ChiefAgent({ db: w.db, config: chiefConfig, services: w.services, call: owner, now: () => NOW }),
      clock,
    });
    call.attach({ send: (message) => sent.push(message), sendAudio: () => undefined, close: () => undefined });
    await call.start('openrouter');

    fake.replies.push(textReply(['billing-export is ready, and csv-export failed.']));
    call.postEvent(setupDone);
    call.postEvent(buildFailed);
    clock.advance(EVENT_QUIET_MS);
    for (let i = 0; i < 2000 && !sent.some((m) => m.type === 'agent.done'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    assert.equal(fake.requests.length, 1);
    const messages = fake.requests[0]?.['messages'] as { role: string; content: unknown }[];
    assert.deepEqual(messages.at(-1), {
      role: 'user',
      content: '[event] billing-export is cloned and ready to plan.\n[event] The build of csv-export failed: The agent stalled on US-004.',
    });
    const spoken = sent.flatMap((m) => (m.type === 'agent.delta' ? [m.text] : [])).join('');
    assert.equal(spoken, 'billing-export is ready, and csv-export failed.');
    await call.end('hangup');
  });
});

describe('the handoff to a feedback session (voice feedback US-003)', () => {
  const focusOf = (sent: ServerMessage[]): (CallFocus | null)[] =>
    sent.flatMap((m) => (m.type === 'state' ? [m.focus] : []));

  it('announces the clone through chief, then hands the call to the session agent, which opens the conversation', async () => {
    const t = await liveCall();
    t.call.handOffWhenReady('s-billing');
    t.call.postEvent(setupDone);
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(2);
    assert.deepEqual(t.chief.inputs, ['[event] billing-export is cloned and ready to plan.']);
    assert.deepEqual(t.call.focus, { kind: 'session', sessionId: 's-billing' });
    // A greeting: no words of the operator's, so the agent opens on the session's feedback.
    assert.deepEqual(t.session.inputs, ['']);
    assert.ok(t.sent.some((m) => m.type === 'ui' && m.action === 'navigate' && m.path === '/sessions/s-billing'));
    await t.call.end('hangup');
  });

  it('hands over at once when the event is not announced', async () => {
    const t = await liveCall();
    setSetting(t.w.db, 'voice_event_verbosity', 'none');
    t.call.handOffWhenReady('s-billing');
    t.call.postEvent(setupDone);
    await t.settled(1);
    assert.deepEqual(t.chief.inputs, []);
    assert.deepEqual(t.call.focus, { kind: 'session', sessionId: 's-billing' });
    assert.deepEqual(t.session.inputs, ['']);
    await t.call.end('hangup');
  });

  it('hands nothing over when the setup failed, or for another session', async () => {
    const t = await liveCall();
    t.call.handOffWhenReady('s-billing');
    t.call.postEvent({ ...setupDone, sessionId: 's-other', name: 'other' });
    t.call.postEvent({ ...setupDone, ok: false, message: 'Permission denied (publickey).' });
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(1);
    // A later success of the same session no longer counts either.
    t.call.postEvent(setupDone);
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(2);
    await t.flush();
    assert.deepEqual(t.call.focus, { kind: 'chief' });
    assert.deepEqual(t.session.inputs, []);
    await t.call.end('hangup');
  });

  it('hands nothing over once the call has moved to another session', async () => {
    const t = await liveCall();
    t.call.handOffWhenReady('s-billing');
    t.call.switchFocus({ kind: 'session', sessionId: 's-csv' });
    await t.settled(1);
    t.call.switchFocus({ kind: 'chief' });
    t.call.postEvent(setupDone);
    t.clock.advance(EVENT_QUIET_MS);
    await t.settled(2);
    await t.flush();
    assert.deepEqual(t.call.focus, { kind: 'chief' });
    assert.deepEqual(focusOf(t.sent).filter((f) => f?.kind === 'session' && f.sessionId === 's-billing'), []);
    await t.call.end('hangup');
  });

  it('hands nothing over once the call has ended', async () => {
    const t = await liveCall();
    t.call.handOffWhenReady('s-billing');
    await t.call.end('hangup');
    t.call.postEvent(setupDone);
    t.call.handOffWhenReady('s-billing');
    await t.flush();
    assert.deepEqual(t.call.focus, { kind: 'chief' });
    assert.deepEqual(t.session.inputs, []);
  });
});
