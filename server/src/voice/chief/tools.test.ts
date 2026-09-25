import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BuildError } from '../../build/index.js';
import { RetryError } from '../../recovery/index.js';
import { SessionError } from '../../sessions/index.js';
import { chiefWorld, NOW, testGate } from './__fixtures__/world.js';
import { SLUG_MAX, slugify } from './actions.js';
import { parseStartTime, speakTime } from './time.js';
import {
  BUILD_LOG_SUMMARY_CHARS,
  type ChiefTool,
  createChiefTools,
  levenshtein,
  normalizeName,
  resolveName,
  summarizeLog,
  type ToolContext,
  type ToolResult,
} from './tools.js';

const ITEMS = [
  { id: 's-1', name: 'billing-export' },
  { id: 's-2', name: 'billing-exports' },
  { id: 's-3', name: 'onboarding_copy' },
  { id: 's-4', name: 'dark-mode' },
  { id: 's-5', name: 'sentry-fix-4821' },
];

function names(result: ReturnType<typeof resolveName>): string | readonly string[] {
  return result.kind === 'one' ? result.item.name : result.candidates;
}

describe('chief name resolution (voice US-008)', () => {
  it('normalizes both sides', () => {
    assert.equal(normalizeName('The Billing Export session'), 'billing-export');
    assert.equal(normalizeName('  onboarding_copy '), 'onboarding-copy');
    assert.equal(normalizeName('Session: dark mode'), 'session:-dark-mode');
    assert.equal(normalizeName('the-session'), '');
  });

  it('matches an id, then the exact name, then a prefix, then within two edits', () => {
    assert.equal(names(resolveName('s-4', ITEMS)), 'dark-mode');
    // Exact beats the longer name it is also a prefix of.
    assert.equal(names(resolveName('the billing export session', ITEMS)), 'billing-export');
    assert.equal(names(resolveName('Onboarding copy', ITEMS)), 'onboarding_copy');
    assert.equal(names(resolveName('dark', ITEMS)), 'dark-mode');
    assert.equal(names(resolveName('sentry fix', ITEMS)), 'sentry-fix-4821');
    assert.equal(names(resolveName('dark mood', ITEMS)), 'dark-mode');
    assert.equal(names(resolveName('onbording copi', ITEMS)), 'onboarding_copy');
  });

  it('returns the candidates when a step matches several, without guessing further', () => {
    const result = resolveName('billing', ITEMS);
    assert.equal(result.kind, 'many');
    assert.deepEqual(names(result), ['billing-export', 'billing-exports']);
  });

  it('returns the nearest names when nothing matches', () => {
    const result = resolveName('invoices', ITEMS);
    assert.equal(result.kind, 'none');
    assert.ok(Array.isArray(names(result)) && names(result).length > 0);
    assert.equal(resolveName('marketing site', ITEMS).kind, 'none');
  });

  it('computes edit distances', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('same', 'same'), 0);
  });
});

describe('chief read-only tools (voice US-008)', () => {
  const ctx = (onEnd: () => void = () => undefined): ToolContext => ({
    signal: new AbortController().signal,
    turn: 1,
    focus: { kind: 'chief' },
    endCall: onEnd,
    confirmations: testGate().gate,
  });

  async function call(name: string, args: Record<string, unknown> = {}, context = ctx()): Promise<{ result: ToolResult; w: ReturnType<typeof chiefWorld> }> {
    const w = chiefWorld();
    const tool = createChiefTools(w.services).get(name);
    assert.ok(tool, `no tool ${name}`);
    return { result: await tool.handler(args, context), w };
  }

  it('registers the read-only tools, the session actions and confirm with OpenAI-shaped definitions', () => {
    const w = chiefWorld();
    const tools = createChiefTools(w.services);
    assert.deepEqual([...tools.keys()].sort(), [
      'address_pr_feedback',
      'back_to_planning',
      'build_status',
      'confirm',
      'create_session',
      'end_call',
      'fix_pr_conflicts',
      'get_session',
      'list_pull_requests',
      'list_repositories',
      'list_sessions',
      'mark_ready',
      'overview',
      'request_pr_change',
      'retry',
      'review_pull_request',
      'schedule_start',
      'show',
      'start_build',
      'stop_build',
      'stop_pr_run',
    ]);
    for (const [name, tool] of tools) {
      assert.equal(tool.definition.type, 'function');
      assert.equal(tool.definition.function.name, name);
      assert.equal(tool.definition.function.parameters['type'], 'object');
    }
    assert.deepEqual(tools.get('get_session')?.definition.function.parameters['required'], ['session']);
  });

  it('list_sessions: active first, filtered by status or by a spoken repository name', async () => {
    const { result } = await call('list_sessions');
    assert.equal(result.ok, true);
    const data = result.data as { sessions: { name: string; repository: string; status: string; stories: string | null }[]; total: number };
    assert.equal(data.total, 7);
    const { id: _id, ...first } = data.sessions[0] as (typeof data.sessions)[number] & { id: string };
    assert.deepEqual(first, { name: 'billing-export', repository: 'shop-api', status: 'building', stories: '2/7' });
    assert.equal(data.sessions.at(-1)?.name, 'old-merged-thing');

    const web = await call('list_sessions', { repository: 'the chief web' });
    assert.deepEqual(
      (web.result.data as typeof data).sessions.map((s) => s.name),
      ['onboarding-copy', 'dark-mode', 'old-merged-thing'],
    );
    const failed = await call('list_sessions', { status: 'failed' });
    assert.deepEqual((failed.result.data as typeof data).sessions.map((s) => s.name), ['billing-exports']);

    const bad = await call('list_sessions', { repository: 'nope-nothing-like-it' });
    assert.equal(bad.result.ok, false);
    assert.deepEqual(Object.keys(bad.result.data as object).sort(), ['candidates', 'error']);
  });

  it('get_session: compact details, and candidates for an ambiguous name', async () => {
    const { result, w } = await call('get_session', { session: 'billing export' });
    assert.equal(result.ok, true);
    const data = result.data as Record<string, unknown>;
    assert.equal(data['id'], w.ids['billing']);
    assert.equal(data['repository'], 'shop-api');
    assert.equal(data['status'], 'building');
    assert.deepEqual(data['build'], { running: true, iteration: 3, currentStory: 'US-003', queuePosition: null });
    assert.equal((data['stories'] as unknown[]).length, 7);
    assert.deepEqual((data['stories'] as unknown[])[2], { id: 'US-003', title: 'CSV writer', status: 'in-progress' });
    assert.equal(result.summary, 'billing-export: building');

    const ambiguous = await call('get_session', { session: 'billing' });
    assert.equal(ambiguous.result.ok, false);
    assert.equal(ambiguous.result.summary, '"billing" matches several sessions');
    assert.equal((ambiguous.result.data as { error: string }).error, 'ambiguous');
    assert.deepEqual([...(ambiguous.result.data as { candidates: string[] }).candidates].sort(), ['billing-export', 'billing-exports']);

    const none = await call('get_session', { session: 'invoice-pdf' });
    assert.equal(none.result.ok, false);
    assert.equal((none.result.data as { error: string }).error, 'not_found');

    const missing = await call('get_session', {});
    assert.equal(missing.result.ok, false);
  });

  it('list_repositories', async () => {
    const { result } = await call('list_repositories');
    assert.deepEqual(
      (result.data as { repositories: { name: string; baseBranch: string }[] }).repositories.map((r) => [r.name, r.baseBranch]),
      [
        ['chief-web', 'main'],
        ['shop-api', 'develop'],
      ],
    );
    assert.equal(result.summary, '2 repositories');
  });

  it('overview: slots, queue, statuses and the hold, and opens the overview page', async () => {
    const { result } = await call('overview');
    const data = result.data as Record<string, unknown>;
    assert.deepEqual(data['slots'], { busy: 2, max: 3 });
    assert.deepEqual(data['queued'], [{ kind: 'session', name: 'dark-mode', position: 1 }]);
    assert.equal((data['sessions'] as Record<string, number>)['building'], 1);
    assert.equal(data['usageLimitHoldUntil'], null);
    assert.deepEqual(result.ui, [{ action: 'navigate', path: '/' }]);
  });

  it('build_status: the current story and a summary of the last 20 log lines, and opens the session', async () => {
    const { result, w } = await call('build_status', { session: 'billing-export' });
    assert.equal(result.ok, true);
    const data = result.data as { story: unknown; stories: string; log: { summary: string; iteration: number } };
    assert.deepEqual(data.story, { id: 'US-003', title: 'CSV writer' });
    assert.equal(data.stories, '2/7');
    assert.equal(data.log.iteration, 3);
    assert.ok(data.log.summary.length <= BUILD_LOG_SUMMARY_CHARS);
    assert.ok(data.log.summary.endsWith(`line 30: ${'x'.repeat(40)}`));
    assert.ok(!data.log.summary.includes('line 10:'), 'older lines are left out');
    assert.ok(JSON.stringify(result.data).length < 1200, 'no full logs in tool results');
    assert.deepEqual(result.ui, [{ action: 'navigate', path: `/sessions/${w.ids['billing']}` }]);

    const idle = await call('build_status', { session: 'dark mode' });
    assert.equal((idle.result.data as { log: unknown }).log, null);
    assert.equal((idle.result.data as { queuePosition: number }).queuePosition, 1);
  });

  it('summarizes a log to its last 20 non-empty lines and at most 600 characters', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `step ${i + 1}`);
    assert.equal(summarizeLog(`${lines.join('\n\n')}\n`), lines.slice(5).join(' | '));
    const long = summarizeLog(Array.from({ length: 20 }, () => 'y'.repeat(100)).join('\n'));
    assert.equal(long.length, BUILD_LOG_SUMMARY_CHARS);
    assert.ok(long.startsWith('…'));
  });

  it('show: navigates to a known page and refuses an unknown one', async () => {
    const { result } = await call('show', { page: 'pull-requests' });
    assert.deepEqual(result, { ok: true, data: { shown: 'pull-requests' }, summary: 'Opened pull-requests', ui: [{ action: 'navigate', path: '/pull-requests' }] });
    assert.deepEqual((await call('show', { page: 'overview' })).result.ui, [{ action: 'navigate', path: '/' }]);
    const bad = await call('show', { page: 'kitchen' });
    assert.equal(bad.result.ok, false);
    assert.equal(bad.result.ui, undefined);
  });

  it('end_call: asks the call to hang up after this turn', async () => {
    let ended = 0;
    const { result } = await call('end_call', {}, ctx(() => (ended += 1)));
    assert.equal(result.ok, true);
    assert.equal(ended, 1);
  });
});

/* ------------------------------------------------ session actions (US-012) */

describe('slugify (voice US-012)', () => {
  it('turns a spoken name into a session name', () => {
    assert.equal(slugify('CSV export for invoices'), 'csv-export-invoices');
    assert.equal(slugify('  Dark   mode!! '), 'dark-mode');
    assert.equal(slugify('Export van de facturen'), 'export-facturen');
    assert.equal(slugify('Crème brûlée page'), 'creme-brulee-page');
    assert.equal(slugify('keep_under_scores'), 'keep_under_scores');
    assert.equal(slugify('The'), 'the');
    assert.equal(slugify('?!'), '');
  });

  it('keeps to 40 characters, cut between words', () => {
    const slug = slugify('Rework the whole onboarding flow for new accountants and their clients');
    assert.ok(slug.length <= SLUG_MAX, slug);
    assert.equal(slug, 'rework-whole-onboarding-flow-new');
    assert.match(slug, /^[a-z0-9_-]+$/);
    assert.equal(slugify('x'.repeat(60)), 'x'.repeat(40));
  });
});

describe('spoken start times (voice US-012)', () => {
  // 14:02 on Friday 25 September in Amsterdam (UTC+2).
  const ctx = { now: NOW, timeZone: 'Europe/Amsterdam' };
  const at = (text: string, context = ctx): string => {
    const parsed = parseStartTime(text, context);
    assert.ok(parsed.ok, `${text}: ${parsed.ok ? '' : parsed.message}`);
    return parsed.at;
  };
  const reason = (text: string): string | null => {
    const parsed = parseStartTime(text, ctx);
    return parsed.ok ? null : parsed.reason;
  };

  it('reads ISO timestamps, with an offset as is and without one in the zone', () => {
    assert.equal(at('2026-09-26T02:00:00Z'), '2026-09-26T02:00:00.000Z');
    assert.equal(at('2026-09-26T02:00'), '2026-09-26T00:00:00.000Z');
    assert.equal(at('2026-09-26 02:00+01:00'), '2026-09-26T01:00:00.000Z');
    // After the clocks go back on 25 October Amsterdam is UTC+1.
    assert.equal(at('2026-10-26T09:00'), '2026-10-26T08:00:00.000Z');
  });

  it('reads relative phrases', () => {
    assert.equal(at('in 3 hours'), '2026-09-25T15:02:00.000Z');
    assert.equal(at('in an hour'), '2026-09-25T13:02:00.000Z');
    assert.equal(at('in 20 minutes'), '2026-09-25T12:22:00.000Z');
    assert.equal(at('over 2 uur'), '2026-09-25T14:02:00.000Z');
    assert.equal(at('over een half uur'), '2026-09-25T12:32:00.000Z');
  });

  it('reads days, day parts and clock times in the zone', () => {
    assert.equal(at('tonight at 2'), '2026-09-26T00:00:00.000Z');
    assert.equal(at('morgen om 9 uur'), '2026-09-26T07:00:00.000Z');
    assert.equal(at('tomorrow at 9pm'), '2026-09-26T19:00:00.000Z');
    assert.equal(at('vanavond om 8'), '2026-09-25T18:00:00.000Z');
    assert.equal(at("morgen 's avonds om 7"), '2026-09-26T17:00:00.000Z');
    assert.equal(at('morgen ’s avonds om 7'), '2026-09-26T17:00:00.000Z');
    assert.equal(at('half 3 vannacht'), '2026-09-26T00:30:00.000Z');
    assert.equal(at('14:30'), '2026-09-25T12:30:00.000Z');
    assert.equal(at('monday at 10 am'), '2026-09-28T08:00:00.000Z');
    assert.equal(at('tomorrow at 9am', { now: NOW, timeZone: 'America/New_York' }), '2026-09-26T13:00:00.000Z');
  });

  it('rejects what could mean two moments, or none, as ambiguous_time', () => {
    assert.equal(reason('tomorrow at 9'), 'ambiguous_time');
    assert.equal(reason('at 3'), 'ambiguous_time');
    assert.equal(reason('tomorrow'), 'ambiguous_time');
    assert.equal(reason('friday at 10'), 'ambiguous_time');
    assert.equal(reason('whenever'), 'ambiguous_time');
    assert.equal(reason(''), 'ambiguous_time');
    assert.equal(reason('2026-01-01T10:00'), 'past_time');
    assert.equal(reason('yesterday at 3pm'), 'past_time');
  });

  it('reads a time back in the zone', () => {
    assert.equal(speakTime(new Date('2026-09-26T00:00:00.000Z'), 'Europe/Amsterdam'), 'Saturday 26 September at 02:00');
  });
});

describe('chief session actions (voice US-012)', () => {
  const ctxAt = (gate: ToolContext['confirmations'], turn: number): ToolContext => ({
    signal: new AbortController().signal,
    turn,
    focus: { kind: 'chief' },
    endCall: () => undefined,
    confirmations: gate,
  });

  /** Asks in turn 1, checks nothing ran, confirms in turn 2. */
  async function roundTrip(
    name: string,
    args: Record<string, unknown>,
    w = chiefWorld(),
  ): Promise<{ w: ReturnType<typeof chiefWorld>; prompt: string; asked: ToolResult; ran: ToolResult }> {
    const { gate, sent } = testGate();
    const tools = createChiefTools(w.services);
    const tool = tools.get(name);
    assert.ok(tool, `no tool ${name}`);
    const asked = await tool.handler(args, ctxAt(gate, 1));
    assert.equal(asked.ok, true, asked.summary);
    const confirm = sent.find((message) => message.type === 'confirm');
    assert.ok(confirm !== undefined && confirm.type === 'confirm');
    assert.deepEqual(w.state.calls, [], 'nothing runs before the operator answers');
    const early = await (tools.get('confirm') as ChiefTool).handler({ confirmation_id: confirm.id }, ctxAt(gate, 1));
    assert.equal(early.ok, false, 'not in the turn that asked');
    assert.deepEqual(w.state.calls, []);
    const ran = await (tools.get('confirm') as ChiefTool).handler({ confirmation_id: confirm.id }, ctxAt(gate, 2));
    return { w, prompt: confirm.prompt, asked, ran };
  }

  async function ask(name: string, args: Record<string, unknown>, w = chiefWorld()): Promise<{ result: ToolResult; parked: boolean }> {
    const { gate, sent } = testGate();
    const result = await (createChiefTools(w.services).get(name) as ChiefTool).handler(args, ctxAt(gate, 1));
    return { result, parked: sent.some((message) => message.type === 'confirm') };
  }

  it('create_session: slug and repository in the prompt, create with the mapped fields, returns while setup runs', async () => {
    const { w, prompt, ran } = await roundTrip('create_session', { repository: 'shop api', name: 'CSV export for invoices', code_review: true });
    assert.match(prompt, /csv-export-invoices/);
    assert.match(prompt, /shop-api/);
    assert.deepEqual(w.state.calls, [
      {
        method: 'sessions.create',
        arg: { repositoryId: w.ids['shop'], name: 'csv-export-invoices', baseBranch: 'develop', prTargetBranch: 'main', codeReview: true },
      },
    ]);
    // The fake's setup never finishes, so getting here is the "returns immediately".
    assert.equal(ran.ok, true, ran.summary);
    const id = (ran.data as { id: string }).id;
    assert.deepEqual(ran.ui, [{ action: 'navigate', path: `/sessions/${id}` }]);
    assert.equal(ran.summary, 'Created session: csv-export-invoices');
  });

  it('create_session: pr_target and base_branch pass through; code_review is left to the default when not said', async () => {
    const { w } = await roundTrip('create_session', { repository: 'chief-web', name: 'Dark mode toggle', pr_target: 'develop', base_branch: 'release' });
    assert.deepEqual(w.state.calls[0]?.arg, {
      repositoryId: w.ids['web'],
      name: 'dark-mode-toggle',
      baseBranch: 'release',
      prTargetBranch: 'develop',
    });
  });

  it("create_session: a service refusal comes back with the service's message", async () => {
    const w = chiefWorld();
    w.state.failures.set('sessions.create', new SessionError(400, 'repository_key_missing', '"shop-api" has no private key on the data volume.'));
    const { ran } = await roundTrip('create_session', { repository: 'shop-api', name: 'Invoices' }, w);
    assert.deepEqual(ran, {
      ok: false,
      data: { error: 'repository_key_missing', status: 400, message: '"shop-api" has no private key on the data volume.' },
      summary: '"shop-api" has no private key on the data volume.',
    });
  });

  it('create_session: an unknown repository, a bad target or a taken name is refused without asking', async () => {
    for (const args of [
      { repository: 'marketing', name: 'x' },
      { repository: 'shop-api', name: 'y', pr_target: 'staging' },
      { repository: 'shop-api', name: 'Billing export' },
      { repository: 'shop-api', name: '??' },
    ]) {
      const { result, parked } = await ask('create_session', args);
      assert.equal(result.ok, false, JSON.stringify(args));
      assert.equal(parked, false);
    }
  });

  it('start_build: starts the stored session, and a usage-limit hold is spoken, not thrown', async () => {
    const { w, prompt, ran } = await roundTrip('start_build', { session: 'onboarding copy' });
    assert.equal(prompt, 'Start the build of onboarding-copy?');
    assert.deepEqual(w.state.calls, [{ method: 'builds.start', arg: w.ids['onboarding'] }]);
    assert.equal(ran.summary, 'Started build: onboarding-copy');

    const held = chiefWorld();
    held.state.failures.set('builds.start', new BuildError(429, 'usage_limit_hold', 'Claude is on hold until 16:00; onboarding-copy is queued.'));
    const refused = await roundTrip('start_build', { session: 'onboarding copy' }, held);
    assert.equal(refused.ran.ok, false);
    assert.equal(refused.ran.summary, 'Claude is on hold until 16:00; onboarding-copy is queued.');
  });

  it('stop_build: stops a running build', async () => {
    const { w, prompt, ran } = await roundTrip('stop_build', { session: 'billing export' });
    assert.equal(prompt, 'Stop the build of billing-export?');
    assert.deepEqual(w.state.calls, [{ method: 'builds.stop', arg: w.ids['billing'] }]);
    assert.equal(ran.summary, 'Stopped build: billing-export');
  });

  it('stop_build: a queued session is dequeued instead, and the prompt says so', async () => {
    const { w, prompt, ran } = await roundTrip('stop_build', { session: 'dark mode' });
    assert.match(prompt, /remove from the queue/i);
    assert.deepEqual(w.state.calls, [{ method: 'builds.dequeue', arg: w.ids['dark'] }]);
    assert.equal(ran.summary, 'Removed from the queue: dark-mode');
  });

  it('mark_ready: highlights the PRD, and returns parse errors as data', async () => {
    const good = await roundTrip('mark_ready', { session: 'onboarding' });
    assert.equal(good.ran.ok, true);
    assert.deepEqual(good.w.state.calls, [{ method: 'sessions.markReady', arg: good.w.ids['onboarding'] }]);
    assert.ok(good.ran.ui?.some((action) => action.action === 'highlight' && action.target === 'prd'));

    const w = chiefWorld();
    w.state.prdErrors = [{ line: 12, message: 'Story US-002 has no acceptance criteria.' }];
    const bad = await roundTrip('mark_ready', { session: 'onboarding' }, w);
    assert.equal(bad.ran.ok, false);
    assert.deepEqual((bad.ran.data as { errors: unknown }).errors, [{ line: 12, message: 'Story US-002 has no acceptance criteria.' }]);
    assert.match(bad.ran.summary, /onboarding-copy/);
    assert.ok(bad.ran.ui?.some((action) => action.action === 'highlight' && action.target === 'prd'));
  });

  it('back_to_planning: returns a ready session to planning', async () => {
    const { w, ran } = await roundTrip('back_to_planning', { session: 'dark-mode' });
    assert.deepEqual(w.state.calls, [{ method: 'sessions.backToPlanning', arg: w.ids['dark'] }]);
    assert.equal(ran.summary, 'Back to planning: dark-mode');
  });

  it('schedule_start: parses the time in voice_timezone, reads it back, and sets it', async () => {
    const { w, prompt, ran } = await roundTrip('schedule_start', { session: 'dark mode', at: 'tonight at 2' });
    assert.equal(prompt, 'Schedule dark-mode to start Saturday 26 September at 02:00?');
    assert.deepEqual(w.state.calls, [{ method: 'sessions.setSchedule', arg: { id: w.ids['dark'], scheduledStartAt: '2026-09-26T00:00:00.000Z' } }]);
    assert.equal(ran.summary, 'Scheduled: dark-mode, Saturday 26 September at 02:00');
  });

  it('schedule_start: clear sets the schedule to null', async () => {
    const { w, prompt } = await roundTrip('schedule_start', { session: 'dark mode', clear: true });
    assert.equal(prompt, 'Clear the scheduled start of dark-mode?');
    assert.deepEqual(w.state.calls, [{ method: 'sessions.setSchedule', arg: { id: w.ids['dark'], scheduledStartAt: null } }]);
  });

  it('schedule_start: an ambiguous time asks again instead of parking anything', async () => {
    const { result, parked } = await ask('schedule_start', { session: 'dark mode', at: 'tomorrow at 9' });
    assert.equal(result.ok, false);
    assert.equal((result.data as { reason: string }).reason, 'ambiguous_time');
    assert.equal(parked, false);
    assert.equal((await ask('schedule_start', { session: 'dark mode' })).result.ok, false);
  });

  it('retry: retries the failed session; a 404 comes back as a result', async () => {
    const { w, ran } = await roundTrip('retry', { session: 'billing exports' });
    assert.deepEqual(w.state.calls, [{ method: 'retries.retry', arg: w.ids['exports'] }]);
    assert.equal(ran.ok, true);
    assert.equal(ran.summary, 'Retried: billing-exports');

    const gone = chiefWorld();
    gone.state.failures.set('retries.retry', new RetryError(404, 'session_not_found', 'This session no longer exists.'));
    const missingOne = await roundTrip('retry', { session: 'billing exports' }, gone);
    assert.deepEqual(missingOne.ran, {
      ok: false,
      data: { error: 'session_not_found', status: 404, message: 'This session no longer exists.' },
      summary: 'This session no longer exists.',
    });
  });

  it('an unknown or ambiguous session is refused before anything is parked', async () => {
    for (const name of ['start_build', 'stop_build', 'mark_ready', 'back_to_planning', 'retry']) {
      const { result, parked } = await ask(name, { session: 'billing' });
      assert.equal(result.ok, false, name);
      assert.equal((result.data as { error: string }).error, 'ambiguous');
      assert.equal(parked, false);
    }
  });

  it('a thrown non-service error is a failed result too', async () => {
    const w = chiefWorld();
    w.state.failures.set('builds.stop', new Error('docker went away'));
    const { ran } = await roundTrip('stop_build', { session: 'billing export' }, w);
    assert.equal(ran.ok, false);
    assert.match(ran.summary, /billing-export: docker went away/);
  });
});
