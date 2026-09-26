import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import { IN_MEMORY, listVoiceTurns, openDatabase, setSetting } from '../db/index.js';
import type { PrdStatus } from '../prd/index.js';
import {
  type AgentEvent,
  type AgentInput,
  backWithMe,
  type CallClock,
  type CallPlanning,
  type CallTransport,
  type CallTts,
  EVENT_QUIET_MS,
  HANGUP_GOODBYE,
  SWITCH_OVER_TOOL,
  type VoiceAgent,
  VoiceCall,
} from './call.js';
import type { AgentKind, CallFocus, ServerMessage } from './protocol.js';
import type { PlanningState } from './session-agent/planning-state.js';
import { waitingSummary } from './speakable.js';
import type { SpeakCallbacks, SpeakResult } from './tts/index.js';
import type { TtsSegment } from './tts/types.js';

/** Timers that never fire: background events stay in the queue for the test to see. */
const clock: CallClock = { now: () => Date.parse('2026-09-25T10:00:00.000Z'), setTimeout: () => 0, clearTimeout: () => undefined };

class Tts implements CallTts {
  readonly providerName = 'openrouter' as const;
  readonly format = { kind: 'pcm16', sampleRate: 24000 } as const;
  readonly spoken: string[] = [];
  open(): Promise<void> {
    return Promise.resolve();
  }
  speak(seg: TtsSegment, _signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult> {
    if (seg.text !== '') {
      this.spoken.push(seg.text);
      callbacks.onStart?.(this.format, 'openrouter');
    }
    return Promise.resolve({ spoken: true, provider: 'openrouter', chars: seg.text.length });
  }
  cancelTurn(): void {}
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** Says `reply`; a session one can block until released, to be interrupted. */
class Agent implements VoiceAgent {
  readonly inputs: AgentInput[] = [];
  hold: Promise<void> | null = null;
  /** What `focus_session` does from inside chief's turn. */
  during: (() => void) | null = null;
  constructor(
    readonly kind: AgentKind,
    private readonly reply: string,
  ) {}
  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    this.inputs.push(input);
    yield { type: 'delta', text: this.reply };
    this.during?.();
    if (this.hold !== null) {
      await Promise.race([this.hold, new Promise((resolve) => input.signal.addEventListener('abort', resolve))]);
    }
  }
}

const prd = (over: Partial<PrdStatus>): PrdStatus => ({
  path: '.chief/prds/x/prd.md',
  exists: true,
  parses: false,
  storyCount: 0,
  openQuestions: 0,
  errors: [],
  updatedAt: null,
  bytes: 10,
  ...over,
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check(), 'condition not reached');
}

/** A planning session as `PlanningStates` reports it. */
const planningSession = (over: Partial<PlanningState> & Pick<PlanningState, 'sessionId' | 'sessionName'>): PlanningState => ({
  repositoryName: 'shop-api',
  state: 'waiting',
  openQuestions: [],
  stories: 0,
  updatedAt: '2026-09-25T10:00:00.000Z',
  ...over,
});
const questions = (n: number): string[] => Array.from({ length: n }, (_, i) => `Question ${String(i + 1)}?`);

/** A clock the test moves by hand, and runs the timers of. */
function manualClock() {
  let now = Date.parse('2026-09-25T10:00:00.000Z');
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: CallClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.fn();
    }
  };
  return { clock, advance };
}

function setup(focus: CallFocus = { kind: 'chief' }, options: { clock?: CallClock } = {}) {
  const db = openDatabase(IN_MEMORY);
  const sent: ServerMessage[] = [];
  let closed: number | null = null;
  const agents = new Map<string, Agent>();
  const planningPolls: string[] = [];
  const focused: string[] = [];
  const planning: CallPlanning & { onPoll: ((id: string) => void) | null } = {
    onPoll: null,
    status: (sessionId) => {
      planningPolls.push(sessionId);
      planning.onPoll?.(sessionId);
      return { sessionName: 'csv-export-invoices', prd: prd({}) };
    },
  };
  const tts = new Tts();
  /** What `PlanningStates` reports; tests edit it in place. */
  const states: PlanningState[] = [];
  const call = new VoiceCall('call-1', focus, {
    db,
    config: loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }),
    stt: { transcribe: () => Promise.reject(new Error('no audio here')) },
    tts: () => tts,
    agent: (target) => {
      const key = target.kind === 'chief' ? 'chief' : target.sessionId;
      const agent = target.kind === 'chief' ? new Agent('chief', 'Chief here.') : new Agent('session', 'What do you want to build?');
      agents.set(key, agent);
      return agent;
    },
    clock: options.clock ?? clock,
    planning,
    planningStates: {
      planningState: (sessionId) => states.find((state) => state.sessionId === sessionId) ?? null,
      listPlanningSessions: () => states,
    },
    onSessionFocused: (sessionId) => focused.push(sessionId),
  });
  const transport: CallTransport = {
    send: (message) => sent.push(message),
    sendAudio: () => undefined,
    close: (code) => {
      closed = code;
    },
  };
  call.attach(transport);
  const of = <T extends ServerMessage['type']>(type: T) =>
    sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  return { db, call, sent, of, agents, tts, planning, planningPolls, focused, states, closed: () => closed };
}

const say = (call: VoiceCall, text: string): void => call.handleMessage({ type: 'text', text });

describe('focus, handoff and control intents (voice US-019)', () => {
  it('switches focus from the chip: state, navigate, persisted, and the session agent opens', async () => {
    const t = setup();
    await t.call.start('openrouter');
    t.call.handleMessage({ type: 'focus', target: { sessionId: 's1' } });
    await until(() => t.agents.get('s1')?.inputs.length === 1);
    await until(() => t.call.state.activeTurn === null);

    assert.deepEqual(t.call.focus, { kind: 'session', sessionId: 's1' });
    // The registry forgets the last detached outcome of a session the operator returns to.
    assert.deepEqual(t.focused, ['s1']);
    assert.ok(t.of('state').some((m) => m.focus.kind === 'session'));
    assert.ok(t.of('ui').some((m) => m.action === 'navigate' && m.path === '/sessions/s1'));
    // The opening: no words of the operator's, and no user transcript.
    assert.equal(t.agents.get('s1')?.inputs[0]?.text, '');
    assert.equal(t.of('user.transcript').length, 0);
    assert.ok(t.of('agent.delta').some((m) => m.agent === 'session' && m.text === 'What do you want to build?'));
    const rows = listVoiceTurns(t.db, 'call-1');
    assert.ok(rows.some((row) => row.speaker === 'event' && row.sessionId === 's1' && row.text === '[focus] csv-export-invoices'));
    assert.ok(rows.some((row) => row.speaker === 'session' && row.sessionId === 's1'));
    // The planning poller is read after the session turn.
    assert.ok(t.planningPolls.includes('s1'));
  });

  it('lets chief finish a focus_session turn, then the session agent opens', async () => {
    const t = setup();
    await t.call.start('openrouter');
    say(t.call, 'I want to plan something');
    await until(() => t.agents.get('chief')?.inputs.length === 1);
    await until(() => t.call.state.activeTurn === null);
    (t.agents.get('chief') as Agent).during = () => t.call.setFocus({ kind: 'session', sessionId: 's1' });
    say(t.call, 'let me plan csv export with its own agent');
    await until(() => t.agents.get('s1')?.inputs.length === 1);
    await until(() => t.call.state.activeTurn === null);
    const done = t.of('agent.done');
    assert.equal(done.length, 3);
    assert.ok(done.every((m) => !m.interrupted), "chief's line is not cut off");
    assert.equal(t.agents.get('s1')?.inputs[0]?.text, '');
    assert.ok(t.of('ui').some((m) => m.action === 'navigate' && m.path === '/sessions/s1'));
  });

  it('skips the greeting when the operator speaks right after the switch', async () => {
    const t = setup();
    await t.call.start('openrouter');
    say(t.call, 'hello there chief how are you');
    await until(() => t.agents.get('chief') !== undefined);
    await until(() => t.call.state.activeTurn === null);
    const chief = t.agents.get('chief') as Agent;
    chief.hold = new Promise(() => undefined);
    say(t.call, 'tell me a long story about the builds');
    await until(() => chief.inputs.length === 2);
    t.call.handleMessage({ type: 'focus', target: { sessionId: 's1' } });
    say(t.call, 'I want a csv export of invoices');
    await until(() => t.agents.get('s1')?.inputs.length === 1);
    await until(() => t.call.state.activeTurn === null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(t.agents.get('s1')?.inputs.map((input) => input.text), ['I want a csv export of invoices']);
    assert.equal(t.of('agent.done').length, 3);
  });

  it('aborts the turn in progress when the chip switches', async () => {
    const t = setup({ kind: 'session', sessionId: 's1' });
    await t.call.start('openrouter');
    say(t.call, 'let us plan a csv export of invoices');
    await until(() => t.agents.get('s1') !== undefined);
    const session = t.agents.get('s1') as Agent;
    session.hold = new Promise(() => undefined);
    // The first turn already ran; hold the next one open.
    say(t.call, 'and what about the date filter here');
    await until(() => session.inputs.length === 2);
    t.call.handleMessage({ type: 'focus', target: 'chief' });
    await until(() => t.call.focus.kind === 'chief' && t.call.state.activeTurn === null);
    assert.ok(t.of('agent.done').some((m) => m.interrupted));
  });

  it('comes back to chief on "terug naar chief" with the session PRD state', async () => {
    const t = setup({ kind: 'session', sessionId: 's1' });
    await t.call.start('openrouter');
    say(t.call, 'Terug naar chief.');
    await until(() => t.of('agent.done').length === 1);
    assert.deepEqual(t.call.focus, { kind: 'chief' });
    assert.equal(t.agents.size, 0, 'no agent is asked');
    const line = t.of('agent.delta')[0];
    assert.equal(line?.agent, 'chief');
    assert.equal(line?.text, 'Je bent weer bij mij. csv-export-invoices heeft een concept-PRD.');
    // Spoken through the pronunciation map (PRD → P R D).
    assert.deepEqual(t.tts.spoken, ['Je bent weer bij mij. csv-export-invoices heeft een concept-P R D.']);
  });

  it('phrases the PRD state for the way back', () => {
    const session = (status: Partial<PrdStatus>) => ({ sessionName: 'csv-export-invoices', prd: prd(status) });
    assert.equal(backWithMe('en', session({})), 'Back with me. csv-export-invoices has a draft PRD.');
    assert.equal(backWithMe('en', session({ exists: false })), 'Back with me. csv-export-invoices has no PRD yet.');
    assert.equal(
      backWithMe('en', session({ parses: true, storyCount: 6 })),
      'Back with me. csv-export-invoices has a PRD with 6 stories that parses cleanly.',
    );
    assert.equal(backWithMe('en', null), 'Back with me.');
  });

  it('hands "switch to <name>" to chief as a focus_session call, even from a session', async () => {
    const t = setup({ kind: 'session', sessionId: 's1' });
    await t.call.start('openrouter');
    say(t.call, 'Switch to billing export.');
    await until(() => t.agents.get('chief')?.inputs.length === 1);
    assert.deepEqual(t.agents.get('chief')?.inputs[0]?.invoke, { tool: 'focus_session', args: { session: 'billing export' } });
    assert.equal(t.agents.get('s1'), undefined);
    // Chief decides whether the switch happens; the call has not moved yet.
    assert.deepEqual(t.call.focus, { kind: 'session', sessionId: 's1' });
  });

  it('stops talking on "wacht" without a reply, and leaves long sentences to the agent', async () => {
    const t = setup();
    await t.call.start('openrouter');
    say(t.call, 'Wacht!');
    await until(() => t.of('agent.done').length === 1);
    assert.equal(t.agents.size, 0);
    assert.equal(t.of('agent.delta').length, 0);

    say(t.call, 'can you stop the build of billing export for me please');
    await until(() => t.agents.get('chief')?.inputs.length === 1);
  });

  it('says goodbye and hangs up on "ophangen"', async () => {
    const t = setup();
    await t.call.start('openrouter');
    say(t.call, 'Ophangen');
    await until(() => t.call.ended);
    assert.deepEqual(t.tts.spoken, [HANGUP_GOODBYE['nl']]);
    assert.equal(t.agents.size, 0);
    assert.equal(listVoiceTurns(t.db, 'call-1').find((row) => row.speaker === 'chief')?.text, HANGUP_GOODBYE['nl']);
  });

  it('highlights the PRD and queues chief\'s line when a voice turn made prd.md valid', async () => {
    const t = setup({ kind: 'session', sessionId: 's1' });
    await t.call.start('openrouter');
    // What the planning poller does when it sees the PRD turn valid.
    t.planning.onPoll = (sessionId) => {
      t.call.postEvent({ kind: 'prd.valid', sessionId, name: 'csv-export-invoices', stories: 6 });
    };
    say(t.call, 'write it down');
    await until(() => t.call.state.activeTurn === null && t.of('agent.done').length === 1);
    assert.ok(t.of('ui').some((m) => m.action === 'highlight' && m.target === 'prd'));
    // `prd.valid` is an `all` event, but one the call itself planned is spoken at the default verbosity.
    assert.deepEqual(
      t.call.state.queue.map((event) => event.text),
      ['The PRD for csv-export-invoices has 6 stories and parses cleanly.'],
    );
  });

  it('only toasts a prd.valid for a session this call has not talked to', async () => {
    const t = setup();
    await t.call.start('openrouter');
    t.call.postEvent({ kind: 'prd.valid', sessionId: 'other', name: 'other', stories: 2 });
    assert.equal(t.of('ui').filter((m) => m.action === 'highlight').length, 0);
    assert.equal(t.call.state.queue.length, 0);
  });
});

describe('reminding of the other planning sessions (US-009)', () => {
  const csv = (status: Partial<PrdStatus>) => ({ sessionName: 'csv-export', prd: prd(status) });
  const billing = { sessionName: 'billing-export', repositoryName: 'shop-api', state: 'waiting', openQuestions: 4 } as const;
  const search = { sessionName: 'search', repositoryName: 'webshop', state: 'done', openQuestions: 0 } as const;
  const importer = { sessionName: 'importer', repositoryName: 'erp', state: 'drafting', openQuestions: 0 } as const;

  it('says nothing more with no other planning session', () => {
    assert.equal(backWithMe('en', csv({ openQuestions: 2 }), []), 'Back with me. csv-export has a draft PRD with 2 open questions.');
    assert.equal(backWithMe('nl', csv({ openQuestions: 2 }), []), 'Je bent weer bij mij. csv-export heeft een concept-PRD met 2 open vragen.');
    assert.equal(backWithMe('en', csv({ openQuestions: 1 })), 'Back with me. csv-export has a draft PRD with 1 open question.');
    assert.equal(backWithMe('nl', csv({ openQuestions: 1 })), 'Je bent weer bij mij. csv-export heeft een concept-PRD met 1 open vraag.');
    assert.equal(
      backWithMe('en', csv({ parses: true, storyCount: 3, openQuestions: 2 })),
      'Back with me. csv-export has a PRD with 3 stories and 2 open questions.',
    );
    assert.equal(
      backWithMe('nl', csv({ parses: true, storyCount: 3, openQuestions: 2 })),
      'Je bent weer bij mij. De PRD van csv-export heeft 3 stories en 2 open vragen.',
    );
    assert.equal(waitingSummary('en', []), '');
  });

  it('names one other session', () => {
    assert.equal(
      backWithMe('en', csv({ openQuestions: 2 }), [billing]),
      'Back with me. csv-export has a draft PRD with 2 open questions. billing-export on shop-api is waiting with 4 open questions.',
    );
    assert.equal(
      backWithMe('nl', csv({ openQuestions: 2 }), [billing]),
      'Je bent weer bij mij. csv-export heeft een concept-PRD met 2 open vragen. billing-export op shop-api wacht met 4 open vragen.',
    );
    assert.equal(backWithMe('en', null, [search]), 'Back with me. search on webshop is done.');
    assert.equal(backWithMe('nl', null, [search]), 'Je bent weer bij mij. search op webshop is klaar.');
  });

  it('names two other sessions in one sentence', () => {
    assert.equal(
      backWithMe('en', csv({}), [billing, search]),
      'Back with me. csv-export has a draft PRD. billing-export on shop-api is waiting with 4 open questions, and search on webshop is done.',
    );
    assert.equal(
      backWithMe('nl', csv({}), [billing, search]),
      'Je bent weer bij mij. csv-export heeft een concept-PRD. billing-export op shop-api wacht met 4 open vragen en search op webshop is klaar.',
    );
  });

  it('mentions a drafting session only when nothing waits', () => {
    assert.equal(
      backWithMe('en', csv({}), [importer]),
      'Back with me. csv-export has a draft PRD. importer on erp is still drafting.',
    );
    assert.equal(
      backWithMe('nl', csv({}), [importer]),
      'Je bent weer bij mij. csv-export heeft een concept-PRD. importer op erp is nog aan het schrijven.',
    );
    assert.equal(
      backWithMe('en', csv({}), [importer, billing]),
      'Back with me. csv-export has a draft PRD. billing-export on shop-api is waiting with 4 open questions.',
    );
    assert.equal(
      backWithMe('nl', csv({}), [importer, billing]),
      'Je bent weer bij mij. csv-export heeft een concept-PRD. billing-export op shop-api wacht met 4 open vragen.',
    );
    assert.equal(
      waitingSummary('en', [importer, { ...importer, sessionName: 'reports', state: 'briefing' }]),
      'importer on erp and reports on erp are still drafting.',
    );
  });

  it('never speaks a count of 0, and names a failed session', () => {
    const quiet = { ...billing, openQuestions: 0 };
    const failed = { ...search, sessionName: 'sync', state: 'failed' } as const;
    assert.equal(waitingSummary('en', [quiet, failed]), 'billing-export on shop-api is waiting, and sync on webshop has failed.');
    assert.equal(waitingSummary('nl', [quiet, failed]), 'billing-export op shop-api wacht op je en sync op webshop is vastgelopen.');
    assert.equal(
      waitingSummary('en', [billing, search, failed]),
      'billing-export on shop-api is waiting with 4 open questions, search on webshop is done, and sync on webshop has failed.',
    );
  });

  it('names the other planning sessions on "back to chief", through the pronunciation map', async () => {
    const t = setup({ kind: 'session', sessionId: 's1' });
    t.states.push(
      planningSession({ sessionId: 's1', sessionName: 'csv-export-invoices' }),
      planningSession({ sessionId: 's2', sessionName: 'billing-export', openQuestions: questions(4) }),
    );
    await t.call.start('openrouter');
    say(t.call, 'Terug naar chief.');
    await until(() => t.of('agent.done').length === 1);
    assert.equal(
      t.of('agent.delta')[0]?.text,
      'Je bent weer bij mij. csv-export-invoices heeft een concept-PRD. billing-export op shop-api wacht met 4 open vragen.',
    );
    assert.deepEqual(t.tts.spoken, [
      'Je bent weer bij mij. csv-export-invoices heeft een concept-P R D. billing-export op shop-api wacht met 4 open vragen.',
    ]);
  });

  it('reminds of the others when the focused session is done, and a "yes" switches over', async () => {
    const { clock, advance } = manualClock();
    const t = setup({ kind: 'session', sessionId: 's1' }, { clock });
    setSetting(t.db, 'voice_language', 'en');
    t.states.push(
      planningSession({ sessionId: 's1', sessionName: 'csv-export', openQuestions: questions(1) }),
      planningSession({ sessionId: 's2', sessionName: 'billing-export', openQuestions: questions(4) }),
      planningSession({ sessionId: 's3', sessionName: 'search', repositoryName: 'webshop', state: 'done', stories: 3 }),
    );
    await t.call.start('openrouter');
    // The operator answers the last open question; the agent writes the PRD out.
    t.planning.onPoll = () => {
      (t.states[0] as { state: string }).state = 'done';
    };
    say(t.call, 'Only admins can export.');
    await until(() => t.call.state.activeTurn === null && t.of('agent.done').length === 1);
    const line =
      'billing-export on shop-api is waiting with 4 open questions, and search on webshop is done. Shall I switch you over?';
    assert.deepEqual(t.call.state.queue.map((event) => event.line), [line]);

    advance(EVENT_QUIET_MS);
    await until(() => t.of('agent.done').length === 2 && t.call.state.activeTurn === null);
    assert.equal(t.tts.spoken.at(-1), line);
    assert.equal(t.call.state.pendingConfirmation?.tool, SWITCH_OVER_TOOL);
    assert.ok(t.of('confirm').some((m) => m.prompt === 'Switch over to billing-export?'));

    say(t.call, 'yes');
    await until(() => t.call.focus.kind === 'session' && t.call.focus.sessionId === 's2');
    assert.equal(t.call.state.pendingConfirmation, null);
    // The yes went to no agent: the call answered it itself, and the new session opens.
    assert.equal(t.agents.get('s1')?.inputs.length, 1);
    await until(() => t.agents.get('s2')?.inputs.length === 1);
    assert.equal(t.agents.get('s2')?.inputs[0]?.text, '');
  });

  it('asks nothing with two sessions waiting, and says nothing for a session that was done already', async () => {
    const t = setup({ kind: 'session', sessionId: 's1' });
    setSetting(t.db, 'voice_language', 'en');
    t.states.push(
      planningSession({ sessionId: 's1', sessionName: 'csv-export', openQuestions: questions(1) }),
      planningSession({ sessionId: 's2', sessionName: 'billing-export', openQuestions: questions(4) }),
      planningSession({ sessionId: 's3', sessionName: 'search', repositoryName: 'webshop', openQuestions: questions(2) }),
    );
    await t.call.start('openrouter');
    t.planning.onPoll = () => {
      (t.states[0] as { state: string }).state = 'done';
    };
    say(t.call, 'Only admins can export.');
    await until(() => t.call.state.activeTurn === null && t.of('agent.done').length === 1);
    assert.deepEqual(t.call.state.queue.map((event) => event.line), [
      'billing-export on shop-api is waiting with 4 open questions, and search on webshop is waiting with 2 open questions.',
    ]);
    t.call.state.queue.length = 0;

    say(t.call, 'Anything else?');
    await until(() => t.call.state.activeTurn === null && t.of('agent.done').length === 2);
    assert.equal(t.call.state.queue.length, 0);
  });
});
