import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../../config.js';
import { setSetting } from '../../db/index.js';
import { type AgentEvent, type CallClock, type CallTts, VoiceCall } from '../call.js';
import { matchConfirmIntent } from '../intents.js';
import { parseClientMessage, type ServerMessage } from '../protocol.js';
import type { SpeakCallbacks, SpeakResult } from '../tts/index.js';
import type { TtsSegment } from '../tts/types.js';
import { chiefWorld, NOW, testGate } from './__fixtures__/world.js';
import { type ScriptedOpenRouter, startScriptedOpenRouter, textReply, toolReply } from './__fixtures__/scripted-openrouter.js';
import { ChiefAgent } from './agent.js';
import { CONFIRMATION_TTL_MS, confirmable } from './confirm.js';
import { type ChiefTool, type ToolContext, withConfirmTool } from './tools.js';

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

/**
 * A confirmable tool standing in for US-012's actions: the server builds the
 * prompt and stored arguments from the model's, and `runs` records what the
 * confirmation actually executed, with how many model requests had been made.
 */
function startBuildTool(runs: { args: Readonly<Record<string, unknown>>; requestsSoFar: number }[]): ChiefTool {
  return confirmable('start_build', 'Start a build (needs confirmation).', { session: { type: 'string' } }, ['session'], {
    prepare: (args) => {
      const session = typeof args['session'] === 'string' ? args['session'].trim().toLowerCase().replace(/\s+/g, '-') : '';
      if (session === '') return { ok: false, data: { error: 'missing_argument' }, summary: 'Missing session' };
      return { prompt: `Start the build of ${session}?`, args: { sessionId: `id-${session}` } };
    },
    execute: (args) => {
      runs.push({ args, requestsSoFar: fake.requests.length });
      return { ok: true, data: { started: args['sessionId'] }, summary: `Started ${String(args['sessionId'])}` };
    },
  });
}

function ctxFor(gate: ToolContext['confirmations'], turn: number): ToolContext {
  return { signal: new AbortController().signal, turn, focus: { kind: 'chief' }, endCall: () => undefined, confirmations: gate };
}

describe('confirmation gate (voice US-011)', () => {
  it('parks a request, tells the browser, and only hands it out in a later turn', () => {
    const { gate, sent } = testGate();
    const confirmation = gate.request({ tool: 'start_build', args: { sessionId: 's1' }, prompt: 'Start s1?' }, 3);

    assert.deepEqual(confirmation, {
      id: 'c1',
      tool: 'start_build',
      args: { sessionId: 's1' },
      prompt: 'Start s1?',
      createdAtTurn: 3,
      expiresAt: new Date(NOW.getTime() + CONFIRMATION_TTL_MS).toISOString(),
    });
    assert.deepEqual(sent, [{ type: 'confirm', id: 'c1', prompt: 'Start s1?', expiresAt: confirmation.expiresAt }]);

    assert.deepEqual(gate.take('c1', 3), { kind: 'await_user', why: 'same_turn' });
    assert.equal(gate.pending?.id, 'c1');
    assert.deepEqual(gate.take('c1', 4), { kind: 'ok', confirmation });
    assert.equal(gate.pending, null);
    assert.deepEqual(sent.at(-1), { type: 'confirm.resolved', id: 'c1', outcome: 'confirmed' });
    assert.deepEqual(gate.take('c1', 5), { kind: 'await_user', why: 'unknown' });
  });

  it('expires after 60 s on the call clock', () => {
    let now = NOW.getTime();
    const { gate, sent } = testGate(() => now);
    gate.request({ tool: 'start_build', args: {}, prompt: 'Start?' }, 1);

    now += CONFIRMATION_TTL_MS - 1;
    assert.equal(gate.pending?.id, 'c1');
    now += 1;
    assert.deepEqual(gate.take('c1', 2), { kind: 'await_user', why: 'expired' });
    assert.equal(gate.pending, null);
    assert.deepEqual(sent.at(-1), { type: 'confirm.resolved', id: 'c1', outcome: 'expired' });
  });

  it('keeps one pending confirmation: a new request kills the old id', () => {
    const { gate } = testGate();
    gate.request({ tool: 'start_build', args: { sessionId: 'a' }, prompt: 'Start a?' }, 1);
    gate.request({ tool: 'stop_build', args: { sessionId: 'b' }, prompt: 'Stop b?' }, 1);

    assert.deepEqual(gate.take('c1', 2), { kind: 'await_user', why: 'unknown' });
    const taken = gate.take('c2', 2);
    assert.equal(taken.kind === 'ok' ? taken.confirmation.tool : null, 'stop_build');
  });

  it('runs the stored arguments through `confirm`, never the model\'s', async () => {
    const runs: { args: Readonly<Record<string, unknown>>; requestsSoFar: number }[] = [];
    const tools = withConfirmTool([startBuildTool(runs)]);
    const { gate } = testGate();

    const asked = await tools.get('start_build')?.handler({ session: 'Billing Export' }, ctxFor(gate, 1));
    assert.deepEqual(asked, {
      ok: true,
      data: { needs_confirmation: true, confirmation_id: 'c1', say: 'Start the build of billing-export?' },
      summary: 'Waiting for confirmation: Start the build of billing-export?',
    });
    assert.equal(runs.length, 0);

    const confirm = tools.get('confirm');
    const same = await confirm?.handler({ confirmation_id: 'c1', session: 'something-else' }, ctxFor(gate, 1));
    assert.equal(same?.ok, false);
    assert.deepEqual(same?.data, { reason: 'await_user', why: 'same_turn' });
    assert.equal(runs.length, 0);

    const later = await confirm?.handler({ confirmation_id: 'c1', session: 'something-else' }, ctxFor(gate, 2));
    assert.equal(later?.ok, true);
    assert.deepEqual(runs.map((run) => run.args), [{ sessionId: 'id-billing-export' }]);
  });

  it('does not let the model confirm in the same turn it asked', async () => {
    const runs: { args: Readonly<Record<string, unknown>>; requestsSoFar: number }[] = [];
    const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', OPENROUTER_API_URL: fake.baseUrl });
    const w = chiefWorld();
    setSetting(w.db, 'openrouter_api_key', 'sk-or-test');
    const { gate } = testGate();
    const agent = new ChiefAgent({
      db: w.db,
      config,
      services: w.services,
      call: { focus: { kind: 'chief' }, hangUpAfterTurn: () => undefined, confirmations: gate },
      tools: withConfirmTool([startBuildTool(runs)]),
      now: () => NOW,
    });
    fake.replies.push(
      toolReply([{ id: 'call_1', name: 'start_build', args: '{"session":"billing export"}' }]),
      toolReply([{ id: 'call_2', name: 'confirm', args: '{"confirmation_id":"c1"}' }]),
      textReply(['Start the build of billing-export?']),
    );

    const events: AgentEvent[] = [];
    for await (const event of agent.run({ text: 'Start billing export and confirm it yourself', turn: 1, signal: new AbortController().signal })) {
      events.push(event);
    }

    assert.equal(runs.length, 0);
    assert.deepEqual(
      events.flatMap((event) => (event.type === 'tool' && event.status !== 'running' ? [[event.name, event.status]] : [])),
      [
        ['start_build', 'ok'],
        ['confirm', 'error'],
      ],
    );
    const answer = agent.history.find((message) => message.role === 'tool' && message.tool_call_id === 'call_2');
    assert.deepEqual(JSON.parse(answer?.role === 'tool' ? answer.content : '{}'), { ok: false, reason: 'await_user', why: 'same_turn' });
    assert.equal(gate.pending?.id, 'c1');
  });
});

describe('confirm intents (voice US-011)', () => {
  it('matches a bare yes or no as the whole utterance', () => {
    for (const text of ['yes', 'Yes.', 'Ja!', 'do it', 'Go.', 'klopt', 'Oké', 'ok', 'Ja, doe maar.']) {
      assert.equal(matchConfirmIntent(text), 'yes', text);
    }
    for (const text of ['no', 'Nee.', 'cancel', 'Laat maar', 'nee, laat maar', 'never mind']) {
      assert.equal(matchConfirmIntent(text), 'no', text);
    }
  });

  it('leaves sentences, and anything over eight words, to the agent', () => {
    for (const text of ['', 'yes but first tell me what is queued', 'go to the billing session', 'no idea', 'yes yes yes yes yes yes yes yes yes']) {
      assert.equal(matchConfirmIntent(text), null, text);
    }
  });

  it('parses the pill button message', () => {
    assert.deepEqual(parseClientMessage('{"type":"confirm.resolve","id":"c1","accept":true}'), { type: 'confirm.resolve', id: 'c1', accept: true });
    assert.equal(parseClientMessage('{"type":"confirm.resolve","id":"c1"}'), null);
    assert.equal(parseClientMessage('{"type":"confirm.resolve","id":"","accept":false}'), null);
  });
});

/* ------------------------------------------------ a call with the real chief */

class Clock implements CallClock {
  t = NOW.getTime();
  now(): number {
    return this.t;
  }
  setTimeout(): unknown {
    return 0;
  }
  clearTimeout(): void {}
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

async function liveCall(): Promise<{
  call: VoiceCall;
  sent: ServerMessage[];
  runs: { args: Readonly<Record<string, unknown>>; requestsSoFar: number }[];
  clock: Clock;
  say(text: string): Promise<void>;
  click(id: string, accept: boolean): Promise<void>;
}> {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', OPENROUTER_API_URL: fake.baseUrl });
  const w = chiefWorld();
  setSetting(w.db, 'openrouter_api_key', 'sk-or-test');
  const runs: { args: Readonly<Record<string, unknown>>; requestsSoFar: number }[] = [];
  const sent: ServerMessage[] = [];
  const clock = new Clock();
  const tools = withConfirmTool([startBuildTool(runs)]);
  const call = new VoiceCall('call-1', { kind: 'chief' }, {
    db: w.db,
    config,
    stt: { transcribe: () => Promise.reject(new Error('no audio here')) },
    tts: () => new SilentTts(),
    agent: (_focus, owner) => new ChiefAgent({ db: w.db, config, services: w.services, call: owner, tools, now: () => NOW }),
    clock,
  });
  call.attach({ send: (message) => sent.push(message), sendAudio: () => undefined, close: () => undefined });
  await call.start('openrouter');

  /** Resolves once the next turn has sent `agent.done` (or a turn-less error). */
  const settle = async (before: number): Promise<void> => {
    for (let i = 0; i < 2000; i++) {
      if (sent.slice(before).some((m) => m.type === 'agent.done' || (m.type === 'error' && m.code === 'confirmation_gone'))) return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('the turn never finished');
  };
  return {
    call,
    sent,
    runs,
    clock,
    say: async (text) => {
      const before = sent.length;
      call.handleMessage({ type: 'text', text });
      await settle(before);
    },
    click: async (id, accept) => {
      const before = sent.length;
      call.handleMessage({ type: 'confirm.resolve', id, accept });
      await settle(before);
    },
  };
}

/** Turn 1: chief asks to start billing-export; returns the pill's id. */
async function askToStart(c: Awaited<ReturnType<typeof liveCall>>): Promise<string> {
  fake.replies.push(
    toolReply([{ id: 'call_1', name: 'start_build', args: '{"session":"billing export"}' }], 'Okay. '),
    textReply(['Zal ik de build van billing-export starten?']),
  );
  await c.say('Start billing export');
  const pill = c.sent.filter((m) => m.type === 'confirm').at(-1);
  assert.ok(pill?.type === 'confirm');
  // The pill shows the server's prompt, whatever language chief spoke it in.
  assert.equal(pill.prompt, 'Start the build of billing-export?');
  return pill.id;
}

function resolvedOutcomes(sent: readonly ServerMessage[]): string[] {
  return sent.flatMap((m) => (m.type === 'confirm.resolved' ? [m.outcome] : []));
}

describe('confirmations on a call (voice US-011)', () => {
  it('resolves a spoken "ja" without a model round trip, then lets chief say one line', async () => {
    const c = await liveCall();
    const id = await askToStart(c);
    assert.equal(c.runs.length, 0);
    assert.equal(c.call.state.pendingConfirmation?.id, id);
    const requestsBefore = fake.requests.length;

    fake.replies.push(textReply(['Gestart.']));
    await c.say('Ja.');

    assert.deepEqual(c.runs, [{ args: { sessionId: 'id-billing-export' }, requestsSoFar: requestsBefore }]);
    assert.equal(fake.requests.length, requestsBefore + 1);
    assert.equal(c.call.state.pendingConfirmation, null);
    assert.deepEqual(resolvedOutcomes(c.sent), ['confirmed']);
    const tool = c.sent.filter((m) => m.type === 'tool' && m.turn === 2 && m.status !== 'running');
    assert.deepEqual(tool.map((m) => (m.type === 'tool' ? [m.name, m.status, m.summary] : [])), [['start_build', 'ok', 'Started id-billing-export']]);
    // Chief hears the outcome as a tool result of `confirm` and speaks about it.
    const messages = (fake.requests.at(-1)?.['messages'] ?? []) as { role: string; content: string | null }[];
    assert.deepEqual(JSON.parse(messages.at(-1)?.content ?? '{}'), { ok: true, started: 'id-billing-export' });
    assert.ok(c.sent.some((m) => m.type === 'agent.delta' && m.turn === 2 && m.text === 'Gestart.'));
    await c.call.end('hangup');
  });

  it('cancels on a spoken "nee" and runs nothing', async () => {
    const c = await liveCall();
    await askToStart(c);
    fake.replies.push(textReply(['Oké, niet gedaan.']));
    await c.say('Nee, laat maar');

    assert.equal(c.runs.length, 0);
    assert.equal(c.call.state.pendingConfirmation, null);
    assert.deepEqual(resolvedOutcomes(c.sent), ['cancelled']);
    const messages = (fake.requests.at(-1)?.['messages'] ?? []) as { role: string; content: string | null }[];
    assert.deepEqual(JSON.parse(messages.at(-1)?.content ?? '{}'), {
      ok: true,
      cancelled: true,
      tool: 'start_build',
      prompt: 'Start the build of billing-export?',
    });
    await c.call.end('hangup');
  });

  it('resolves the pill buttons over the socket, bound to the clicked id', async () => {
    const c = await liveCall();
    const first = await askToStart(c);
    const second = await askToStart(c);
    assert.notEqual(first, second);

    await c.click(first, true);
    assert.equal(c.runs.length, 0, 'a replaced pill cannot answer the new one');
    assert.ok(c.sent.some((m) => m.type === 'error' && m.code === 'confirmation_gone'));
    assert.equal(c.call.state.pendingConfirmation?.id, second);

    fake.replies.push(textReply(['Started.']));
    await c.click(second, true);
    assert.deepEqual(
      c.runs.map((run) => run.args),
      [{ sessionId: 'id-billing-export' }],
    );

    const third = await askToStart(c);
    fake.replies.push(textReply(['Left it.']));
    await c.click(third, false);
    assert.equal(c.runs.length, 1);
    assert.equal(c.call.state.pendingConfirmation, null);
    await c.call.end('hangup');
  });

  it('lets an expired confirmation go to the model instead of running it', async () => {
    const c = await liveCall();
    await askToStart(c);
    c.clock.t += CONFIRMATION_TTL_MS;

    fake.replies.push(textReply(['That one timed out; shall I ask again?']));
    const requestsBefore = fake.requests.length;
    await c.say('yes');

    assert.equal(c.runs.length, 0);
    assert.equal(fake.requests.length, requestsBefore + 1);
    assert.deepEqual(resolvedOutcomes(c.sent), ['expired']);
    await c.call.end('hangup');
  });

  it('cancels on a focus switch, and "yes" is not a shortcut away from chief', async () => {
    const c = await liveCall();
    await askToStart(c);
    c.call.handleMessage({ type: 'focus', target: { sessionId: 'x' } });
    assert.equal(c.call.state.pendingConfirmation, null);
    assert.deepEqual(resolvedOutcomes(c.sent), ['cancelled']);

    // Chief still answers session focus until US-018; the "yes" goes to it as text.
    fake.replies.push(textReply(['Yes to what?']));
    await c.say('yes');
    assert.equal(c.runs.length, 0);
    const messages = (fake.requests.at(-1)?.['messages'] ?? []) as { role: string; content: string | null }[];
    assert.deepEqual(messages.at(-1), { role: 'user', content: 'yes' });
    await c.call.end('hangup');
  });

  it('cancels when the call ends (hang-up or takeover)', async () => {
    const c = await liveCall();
    await askToStart(c);
    await c.call.end('taken_over');
    assert.equal(c.call.state.pendingConfirmation, null);
    assert.deepEqual(resolvedOutcomes(c.sent), ['cancelled']);
  });
});
