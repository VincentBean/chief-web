import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../../config.js';
import { setSetting } from '../../db/index.js';
import type { AgentEvent } from '../call.js';
import { chiefWorld, NOW, testGate } from './__fixtures__/world.js';
import {
  errorReply,
  type ScriptedOpenRouter,
  startScriptedOpenRouter,
  textReply,
  toolReply,
} from './__fixtures__/scripted-openrouter.js';
import { tool } from './tools.js';
import { BRAIN_UNREACHABLE, CHIEF_MAX_TOKENS, CHIEF_TEMPERATURE, ChiefAgent, WINDOW_MESSAGES } from './agent.js';

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

function setup(env: Record<string, string> = {}): { agent: ChiefAgent; w: ReturnType<typeof chiefWorld>; hangUps: () => number } {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', OPENROUTER_API_URL: fake.baseUrl, ...env });
  const w = chiefWorld();
  setSetting(w.db, 'openrouter_api_key', 'sk-or-test');
  let hangUps = 0;
  const agent = new ChiefAgent({
    db: w.db,
    config,
    services: w.services,
    call: { focus: { kind: 'chief' }, hangUpAfterTurn: () => (hangUps += 1), confirmations: testGate().gate },
    operatorName: 'Vincent',
    now: () => NOW,
  });
  return { agent, w, hangUps: () => hangUps };
}

async function turn(agent: ChiefAgent, text: string, n = 1, signal = new AbortController().signal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run({ text, turn: n, signal })) events.push(event);
  return events;
}

function spoken(events: readonly AgentEvent[]): string {
  return events.map((event) => (event.type === 'delta' ? event.text : '')).join('');
}

type Message = { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string };
function messagesOf(request: Record<string, unknown> | undefined): Message[] {
  return (request?.['messages'] ?? []) as Message[];
}

describe('chief agent loop (voice US-008)', () => {
  it('answers "what\'s building?" from the STATE block with zero tool calls', async () => {
    const { agent } = setup();
    fake.replies.push(textReply(['billing-export is building, ', 'story 3 of 7. ', 'sentry-fix-4821 waits for the usage limit.'], 0.0021));

    const events = await turn(agent, "What's building?");

    assert.equal(fake.requests.length, 1);
    assert.deepEqual(
      events.filter((event) => event.type === 'tool'),
      [],
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['delta', 'delta', 'delta', 'usage'],
    );
    assert.equal(spoken(events), 'billing-export is building, story 3 of 7. sentry-fix-4821 waits for the usage limit.');
    assert.deepEqual(events.at(-1), { type: 'usage', costUsd: 0.0021 });

    const request = fake.requests[0] ?? {};
    assert.equal(request['temperature'], CHIEF_TEMPERATURE);
    assert.equal(request['max_tokens'], CHIEF_MAX_TOKENS);
    assert.equal(request['stream'], true);
    const system = messagesOf(request)[0];
    assert.equal(system?.role, 'system');
    assert.match(system?.content ?? '', /with the operator, Vincent\./);
    assert.match(system?.content ?? '', /Speak Dutch unless the operator switches language/);
    assert.match(system?.content ?? '', /\nSTATE\nNOW 2026-09-25 14:02 Europe\/Amsterdam\n/);
    assert.match(system?.content ?? '', /^- billing-export \[shop-api\] building story 3\/7 \(US-003 "CSV writer"\)/m);
    assert.deepEqual(messagesOf(request).slice(1), [{ role: 'user', content: "What's building?" }]);
    assert.deepEqual(
      ((request['tools'] ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name).sort(),
      [
        'address_pr_feedback', 'back_to_planning', 'build_status', 'confirm', 'create_recurring_task', 'create_session', 'end_call',
        'fix_pr_conflicts', 'focus_session', 'get_recurring_task', 'get_session', 'list_pull_requests', 'list_recurring_tasks', 'list_repositories',
        'list_sessions', 'mark_ready', 'overview', 'pause_recurring_task', 'request_pr_change', 'resume_recurring_task', 'retry',
        'review_pull_request', 'run_recurring_task_now', 'schedule_start', 'show', 'start_build', 'stop_build', 'stop_pr_run',
        'update_recurring_task',
      ],
    );
    assert.deepEqual(agent.history.at(-1), {
      role: 'assistant',
      content: 'billing-export is building, story 3 of 7. sentry-fix-4821 waits for the usage limit.',
    });
  });

  it('speaks text before a tool, runs it (running → ok), navigates, and answers with the result', async () => {
    const { agent, w } = setup();
    fake.replies.push(
      toolReply([{ id: 'call_1', name: 'build_status', args: '{"session":"the billing export"}' }], 'Even kijken. ', 0.001),
      textReply(['Het draait story drie.'], 0.002),
    );

    const events = await turn(agent, 'Hoe gaat billing export?');

    assert.deepEqual(
      events.map((event) => (event.type === 'tool' ? `tool:${event.status}` : event.type)),
      ['delta', 'usage', 'tool:running', 'tool:ok', 'ui', 'delta', 'usage'],
    );
    const tools = events.filter((event) => event.type === 'tool');
    assert.deepEqual(tools[0], { type: 'tool', id: 'call_1', name: 'build_status', status: 'running', summary: '' });
    assert.deepEqual(tools[1], { type: 'tool', id: 'call_1', name: 'build_status', status: 'ok', summary: 'billing-export: building, 2/7 stories' });
    assert.deepEqual(
      events.find((event) => event.type === 'ui'),
      { type: 'ui', ui: { action: 'navigate', path: `/sessions/${w.ids['billing']}` } },
    );

    assert.equal(fake.requests.length, 2);
    const second = messagesOf(fake.requests[1]);
    assert.deepEqual(second.slice(1, 3), [
      { role: 'user', content: 'Hoe gaat billing export?' },
      {
        role: 'assistant',
        content: 'Even kijken. ',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'build_status', arguments: '{"session":"the billing export"}' } }],
      },
    ]);
    const result = second[3];
    assert.equal(result?.role, 'tool');
    assert.equal(result?.tool_call_id, 'call_1');
    const data = JSON.parse(result?.content ?? '') as { ok: boolean; name: string; log: { summary: string } };
    assert.equal(data.ok, true);
    assert.equal(data.name, 'billing-export');
    assert.ok(data.log.summary.length <= 600);
  });

  it('reports a bad tool call as an error and lets the model go on', async () => {
    const { agent } = setup();
    fake.replies.push(
      toolReply([
        { id: 'c1', name: 'get_session', args: '{"session": ' },
        { id: 'c2', name: 'delete_everything', args: '{}' },
        { id: 'c3', name: 'get_session', args: '{"session":"billing"}' },
      ]),
      textReply(['Welke billing bedoel je?']),
    );
    const events = await turn(agent, 'Hoe staat billing ervoor?');
    assert.deepEqual(
      events.flatMap((event) => (event.type === 'tool' ? [`${event.name}:${event.status}`] : [])),
      ['get_session:running', 'get_session:error', 'delete_everything:running', 'delete_everything:error', 'get_session:running', 'get_session:error'],
    );
    const answers = messagesOf(fake.requests[1]).filter((message) => message.role === 'tool');
    assert.deepEqual(
      answers.map((answer) => (JSON.parse(answer.content ?? '') as { error: string }).error),
      ['bad_arguments', 'unknown_tool', 'ambiguous'],
    );
    assert.deepEqual((JSON.parse(answers[2]?.content ?? '') as { candidates: string[] }).candidates.sort(), ['billing-export', 'billing-exports']);
    assert.equal(spoken(events), 'Welke billing bedoel je?');
  });

  it(`stops after VOICE_CHIEF_MAX_TOOL_HOPS model steps`, async () => {
    const { agent } = setup({ VOICE_CHIEF_MAX_TOOL_HOPS: '2' });
    fake.replies.push(
      toolReply([{ id: 'a', name: 'overview', args: '{}' }]),
      toolReply([{ id: 'b', name: 'overview', args: '{}' }]),
      toolReply([{ id: 'c', name: 'overview', args: '{}' }]),
    );
    await turn(agent, 'Keep checking.');
    assert.equal(fake.requests.length, 2);
    assert.equal(fake.replies.length, 1);
    // Every tool call in the history has its answer.
    const calls = agent.history.flatMap((message) => (message.role === 'assistant' ? (message.tool_calls ?? []).map((call) => call.id) : []));
    const answered = agent.history.flatMap((message) => (message.role === 'tool' ? [message.tool_call_id] : []));
    assert.deepEqual(answered, calls);
  });

  it('says it cannot reach its brain once the retry is spent, and the next turn works', async () => {
    const { agent, w } = setup();
    fake.replies.push(errorReply(503), errorReply(503));
    const failed = await turn(agent, 'Hallo?');
    assert.equal(fake.requests.length, 2, 'one retry, then give up');
    assert.equal(spoken(failed), BRAIN_UNREACHABLE['nl']);

    fake.replies.push(textReply(['Ik ben er weer.']));
    const next = await turn(agent, 'Hallo?', 2);
    assert.equal(spoken(next), 'Ik ben er weer.');

    setSetting(w.db, 'voice_language', 'en');
    fake.replies.push(errorReply(500), errorReply(500));
    const english = await turn(agent, 'Hello?', 3);
    assert.equal(spoken(english), "I can't reach my brain right now.");
  });

  it('asks the call to hang up after the turn on end_call', async () => {
    const { agent, hangUps } = setup();
    fake.replies.push(toolReply([{ id: 'bye', name: 'end_call', args: '{}' }], 'Tot later! '), textReply(['']));
    const events = await turn(agent, 'Dat was het, doei.');
    assert.equal(hangUps(), 1);
    assert.equal(spoken(events), 'Tot later! ');
  });

  it(`keeps a ${WINDOW_MESSAGES}-message window and folds older turns into one system line off the hot path`, async () => {
    const { agent } = setup();
    const turns = WINDOW_MESSAGES / 2 + 1;
    for (let i = 1; i <= turns; i++) {
      fake.replies.push(textReply([`Answer ${i}.`]));
      await turn(agent, `Question ${i}?`, i);
    }
    // The last turn's request saw no more than the window.
    const last = messagesOf(fake.requests[turns - 1]);
    assert.ok(last.length - 1 <= WINDOW_MESSAGES, `sent ${last.length - 1} messages`);
    assert.equal(last[1]?.role, 'user', 'the window starts at a user message');

    // The summary request is the one after that turn, without tools.
    fake.replies.push(textReply(['The operator asked question 1 and chief gave answer 1.'], 0.0005));
    await agent.idle();
    const summaryRequest = fake.requests[turns] ?? {};
    assert.equal(summaryRequest['tools'], undefined);
    assert.match(messagesOf(summaryRequest)[1]?.content ?? '', /Operator: Question 1\?\nChief: Answer 1\./);
    assert.equal(agent.earlierSummary, 'The operator asked question 1 and chief gave answer 1.');
    assert.equal(agent.history[0]?.content, 'Question 2?');

    fake.replies.push(textReply(['Answer next.']));
    const next = await turn(agent, 'Next?', turns + 1);
    const request = messagesOf(fake.requests.at(-1));
    assert.deepEqual(request[1], { role: 'system', content: 'Earlier in this call: The operator asked question 1 and chief gave answer 1.' });
    // The summary's cost is reported with the next turn.
    assert.deepEqual(next[0], { type: 'usage', costUsd: 0.0005 });
    // That turn folds the next oldest one; the earlier summary goes along.
    fake.replies.push(textReply(['Questions 1 and 2 were asked.']));
    await agent.idle();
    assert.match(messagesOf(fake.requests.at(-1))[1]?.content ?? '', /^Summary so far: The operator asked question 1/);
    assert.equal(agent.earlierSummary, 'Questions 1 and 2 were asked.');
  });

  it('keeps the history valid when the turn is interrupted during a tool call', async () => {
    const { agent } = setup();
    fake.replies.push(toolReply([{ id: 'x1', name: 'overview', args: '{}' }], 'Even kijken. '));
    const controller = new AbortController();
    for await (const event of agent.run({ text: 'Overzicht?', turn: 1, signal: controller.signal })) {
      if (event.type === 'tool') {
        controller.abort(new Error('barge-in'));
        break;
      }
    }
    assert.deepEqual(agent.history.slice(-2), [
      {
        role: 'assistant',
        content: 'Even kijken. ',
        tool_calls: [{ id: 'x1', type: 'function', function: { name: 'overview', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'x1', content: '{"ok":false,"error":"interrupted"}' },
    ]);
  });
  it('lets a tool that is already running finish through a barge-in and keeps its result (US-020)', async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', OPENROUTER_API_URL: fake.baseUrl });
    const w = chiefWorld();
    setSetting(w.db, 'openrouter_api_key', 'sk-or-test');
    let release = (): void => {};
    let handlerSignal: AbortSignal | null = null;
    const slow = tool('start_build', 'Starts a build', {}, [], async (_args, ctx) => {
      handlerSignal = ctx.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, data: { started: true }, summary: 'Build started' };
    });
    const agent = new ChiefAgent({
      db: w.db,
      config,
      services: w.services,
      call: { focus: { kind: 'chief' }, hangUpAfterTurn: () => undefined, confirmations: testGate().gate },
      tools: new Map([['start_build', slow]]),
      now: () => NOW,
    });
    fake.replies.push(toolReply([{ id: 'b1', name: 'start_build', args: '{}' }], 'Starting it. '));
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    // The call's loop: past the abort it only takes a finished tool's card.
    for await (const event of agent.run({ text: 'Start the build', turn: 1, signal: controller.signal })) {
      events.push(event);
      if (event.type === 'tool' && event.status === 'running') {
        controller.abort(new Error('barge-in'));
        setImmediate(() => release());
      } else if (controller.signal.aborted) {
        break;
      }
    }
    assert.equal((handlerSignal as AbortSignal | null)?.aborted, false);
    assert.deepEqual(events.at(-1), { type: 'tool', id: 'b1', name: 'start_build', status: 'ok', summary: 'Build started' });
    assert.deepEqual(agent.history.at(-1), { role: 'tool', tool_call_id: 'b1', content: '{"ok":true,"started":true}' });
    assert.equal(fake.requests.length, 1);
  });

  it('prefixes the next message with what the operator heard before cutting chief off (US-020)', async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: 'pw', OPENROUTER_API_URL: fake.baseUrl });
    const w = chiefWorld();
    setSetting(w.db, 'openrouter_api_key', 'sk-or-test');
    const agent = new ChiefAgent({
      db: w.db,
      config,
      services: w.services,
      call: { focus: { kind: 'chief' }, hangUpAfterTurn: () => undefined, confirmations: testGate().gate, spokenSoFar: () => 'Two builds are running, one' },
      now: () => NOW,
    });
    fake.replies.push(textReply(['Two builds are running, one for billing ', 'and one for the export.']));
    const controller = new AbortController();
    for await (const event of agent.run({ text: 'Status?', turn: 1, signal: controller.signal })) {
      if (event.type === 'delta') {
        controller.abort(new Error('barge-in'));
        break;
      }
    }
    fake.replies.push(textReply(['Okay.']));
    await turn(agent, 'Just the export', 2);
    const sent = messagesOf(fake.requests.at(-1));
    assert.equal(sent.at(-1)?.content, '[You were interrupted after saying: "Two builds are running, one"] Just the export');
    // Only once: the turn after that is plain again.
    fake.replies.push(textReply(['Sure.']));
    await turn(agent, 'Thanks', 3);
    assert.equal(messagesOf(fake.requests.at(-1)).at(-1)?.content, 'Thanks');
  });
});
