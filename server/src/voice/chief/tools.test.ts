import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BuildError } from '../../build/index.js';
import { createRepository, createSession, getSession, listSessions } from '../../db/index.js';
import { RetryError } from '../../recovery/index.js';
import { SessionError } from '../../sessions/index.js';
import type { PlanningState } from '../session-agent/planning-state.js';
import { answerPrompt } from '../session-agent/prompt.js';
import { prdPathFor } from '../../prd/index.js';
import { chiefWorld, NOW } from './__fixtures__/world.js';
import { feedbackSessionName, SLUG_MAX, slugify } from './actions.js';
import { parseStartTime, speakTime } from './time.js';
import {
  BUILD_LOG_SUMMARY_CHARS,
  type ChiefServices,
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
  });

  async function call(name: string, args: Record<string, unknown> = {}, context = ctx()): Promise<{ result: ToolResult; w: ReturnType<typeof chiefWorld> }> {
    const w = chiefWorld();
    const tool = createChiefTools(w.services).get(name);
    assert.ok(tool, `no tool ${name}`);
    return { result: await tool.handler(args, context), w };
  }

  it('registers the read-only tools and the session actions with OpenAI-shaped definitions', () => {
    const w = chiefWorld();
    const tools = createChiefTools(w.services);
    assert.deepEqual([...tools.keys()].sort(), [
      'address_pr_feedback',
      'answer_planning_question',
      'back_to_planning',
      'build_status',
      'create_recurring_task',
      'create_session',
      'end_call',
      'fix_pr_conflicts',
      'focus_session',
      'get_recurring_task',
      'get_session',
      'list_pull_requests',
      'list_recurring_tasks',
      'list_repositories',
      'list_sessions',
      'mark_ready',
      'overview',
      'pause_recurring_task',
      'request_pr_change',
      'resume_recurring_task',
      'retry',
      'review_pull_request',
      'run_recurring_task_now',
      'schedule_start',
      'show',
      'start_build',
      'start_feedback_session',
      'stop_build',
      'stop_pr_run',
      'update_recurring_task',
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
  const ctx: ToolContext = {
    signal: new AbortController().signal,
    turn: 1,
    focus: { kind: 'chief' },
    endCall: () => undefined,
  };

  /** One handler call: it resolves what was said and acts on it. */
  async function run(name: string, args: Record<string, unknown>, w = chiefWorld()): Promise<{ w: ReturnType<typeof chiefWorld>; ran: ToolResult }> {
    const tool = createChiefTools(w.services).get(name);
    assert.ok(tool, `no tool ${name}`);
    return { w, ran: await tool.handler(args, ctx) };
  }

  /** A call `prepare` refuses: the failed result, and no service touched. */
  async function refused(name: string, args: Record<string, unknown>, w = chiefWorld()): Promise<ToolResult> {
    const { ran } = await run(name, args, w);
    assert.equal(ran.ok, false, JSON.stringify(args).slice(0, 80));
    assert.deepEqual(w.state.calls, [], `${name} called no service`);
    return ran;
  }

  it('create_session: creates with the mapped fields and the slug, and returns while setup runs', async () => {
    const { w, ran } = await run('create_session', { repository: 'shop api', name: 'CSV export for invoices', code_review: true });
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
    const { w } = await run('create_session', { repository: 'chief-web', name: 'Dark mode toggle', pr_target: 'develop', base_branch: 'release' });
    assert.deepEqual(w.state.calls, [
      {
        method: 'sessions.create',
        arg: { repositoryId: w.ids['web'], name: 'dark-mode-toggle', baseBranch: 'release', prTargetBranch: 'develop' },
      },
    ]);
  });

  it("create_session: a service refusal comes back with the service's message", async () => {
    const w = chiefWorld();
    w.state.failures.set('sessions.create', new SessionError(400, 'repository_key_missing', '"shop-api" has no private key on the data volume.'));
    const { ran } = await run('create_session', { repository: 'shop-api', name: 'Invoices' }, w);
    assert.deepEqual(ran, {
      ok: false,
      data: { error: 'repository_key_missing', status: 400, message: '"shop-api" has no private key on the data volume.' },
      summary: '"shop-api" has no private key on the data volume.',
    });
  });

  it('create_session: an unknown repository, a bad target or a taken name is refused without creating anything', async () => {
    for (const args of [
      { repository: 'marketing', name: 'x' },
      { repository: 'shop-api', name: 'y', pr_target: 'staging' },
      { repository: 'shop-api', name: 'Billing export' },
      { repository: 'shop-api', name: '??' },
    ]) {
      await refused('create_session', args);
    }
  });

  const FEEDBACK = 'The checkout total is wrong with a coupon';

  it('start_feedback_session: schema', () => {
    const tool = createChiefTools(chiefWorld().services).get('start_feedback_session');
    assert.ok(tool);
    const parameters = tool.definition.function.parameters as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['feedback', 'name', 'repository', 'targetBranch']);
    assert.deepEqual(parameters.required, ['repository', 'feedback']);
  });

  it('start_feedback_session: creates the session with the feedback, navigates, and asks the call to hand over', async () => {
    const handOffs: string[] = [];
    const w = chiefWorld();
    const tools = createChiefTools({ ...w.services, sessionAgents: { acquire: () => Promise.resolve() } });
    const ran = await (tools.get('start_feedback_session') as ChiefTool).handler(
      { repository: 'shop api', feedback: `  ${FEEDBACK} ` },
      { ...ctx, handOffWhenReady: (id) => handOffs.push(id) },
    );

    assert.equal(ran.ok, true, ran.summary);
    assert.deepEqual(w.state.calls, [
      {
        method: 'sessions.create',
        arg: {
          repositoryId: w.ids['shop'],
          name: 'feedback-checkout-total-is-wrong-with-coupon',
          baseBranch: 'develop',
          prTargetBranch: 'main',
          feedback: FEEDBACK,
        },
      },
    ]);
    const id = (ran.data as { id: string }).id;
    assert.equal(getSession(w.db, id)?.feedback, FEEDBACK);
    assert.deepEqual(ran.ui, [{ action: 'navigate', path: `/sessions/${id}` }]);
    assert.equal(ran.summary, 'Created session: feedback-checkout-total-is-wrong-with-coupon');
    assert.deepEqual(handOffs, [id]);
  });

  it('start_feedback_session: no handoff is promised without session agents', async () => {
    const { ran } = await run('start_feedback_session', { repository: 'shop-api', feedback: FEEDBACK });
    assert.equal(ran.ok, true);
    assert.equal((ran.data as { handOffWhenReady: boolean }).handOffWhenReady, false);
  });

  it('start_feedback_session: an ambiguous repository asks which one, creating nothing', async () => {
    const w = chiefWorld();
    createRepository(w.db, { name: 'shop-web', sshUrl: 'git@github.com:acme/shop-web.git', githubSlug: 'acme/shop-web', defaultBaseBranch: 'main' });
    const result = await refused('start_feedback_session', { repository: 'shop', feedback: FEEDBACK }, w);
    assert.equal((result.data as { error: string }).error, 'ambiguous');
    assert.deepEqual([...(result.data as { candidates: string[] }).candidates].sort(), ['shop-api', 'shop-web']);
    assert.deepEqual(listSessions(w.db).filter((session) => session.feedback !== null), []);
  });

  it('start_feedback_session: the name is feedback-<slug>, made unique; a given name and targetBranch are used', async () => {
    assert.equal(feedbackSessionName(FEEDBACK), 'feedback-checkout-total-is-wrong-with-coupon');
    assert.equal(feedbackSessionName('?!'), 'feedback');
    const long = feedbackSessionName('the search results page shows duplicate products when filtering by colour and size');
    assert.ok(long.length <= 'feedback-'.length + SLUG_MAX, long);

    const w = chiefWorld();
    await run('start_feedback_session', { repository: 'shop-api', feedback: FEEDBACK }, w);
    w.state.calls.length = 0;
    const second = await run('start_feedback_session', { repository: 'shop-api', feedback: FEEDBACK }, w);
    assert.equal(second.ran.summary, 'Created session: feedback-checkout-total-is-wrong-with-coupon-2');

    const named = await run('start_feedback_session', { repository: 'chief-web', feedback: FEEDBACK, name: 'Coupon total', targetBranch: 'develop' });
    assert.deepEqual(named.w.state.calls, [
      {
        method: 'sessions.create',
        arg: { repositoryId: named.w.ids['web'], name: 'coupon-total', baseBranch: 'main', prTargetBranch: 'develop', feedback: FEEDBACK },
      },
    ]);

    for (const args of [
      { repository: 'shop-api', feedback: '   ' },
      { repository: 'shop-api', feedback: FEEDBACK, targetBranch: 'staging' },
      { repository: 'shop-api', feedback: FEEDBACK, name: 'Billing export' },
      { repository: 'shop-api', feedback: 'x'.repeat(4001) },
    ]) {
      await refused('start_feedback_session', args);
    }
  });

  it('start_build: starts the resolved session, and a usage-limit hold is spoken, not thrown', async () => {
    const { w, ran } = await run('start_build', { session: 'onboarding copy' });
    assert.deepEqual(w.state.calls, [{ method: 'builds.start', arg: w.ids['onboarding'] }]);
    assert.equal(ran.ok, true);
    assert.equal(ran.summary, 'Started build: onboarding-copy');

    const held = chiefWorld();
    held.state.failures.set('builds.start', new BuildError(429, 'usage_limit_hold', 'Claude is on hold until 16:00; onboarding-copy is queued.'));
    const refusal = await run('start_build', { session: 'onboarding copy' }, held);
    assert.equal(refusal.ran.ok, false);
    assert.equal(refusal.ran.summary, 'Claude is on hold until 16:00; onboarding-copy is queued.');
  });

  it('stop_build: stops a running build', async () => {
    const { w, ran } = await run('stop_build', { session: 'billing export' });
    assert.deepEqual(w.state.calls, [{ method: 'builds.stop', arg: w.ids['billing'] }]);
    assert.equal(ran.summary, 'Stopped build: billing-export');
  });

  it('stop_build: a queued session is dequeued instead', async () => {
    const { w, ran } = await run('stop_build', { session: 'dark mode' });
    assert.deepEqual(w.state.calls, [{ method: 'builds.dequeue', arg: w.ids['dark'] }]);
    assert.equal(ran.summary, 'Removed from the queue: dark-mode');
  });

  it('mark_ready: highlights the PRD, and returns parse errors as data', async () => {
    const good = await run('mark_ready', { session: 'onboarding' });
    assert.equal(good.ran.ok, true);
    assert.deepEqual(good.w.state.calls, [{ method: 'sessions.markReady', arg: good.w.ids['onboarding'] }]);
    assert.ok(good.ran.ui?.some((action) => action.action === 'highlight' && action.target === 'prd'));

    const w = chiefWorld();
    w.state.prdErrors = [{ line: 12, message: 'Story US-002 has no acceptance criteria.' }];
    const bad = await run('mark_ready', { session: 'onboarding' }, w);
    assert.equal(bad.ran.ok, false);
    assert.deepEqual((bad.ran.data as { errors: unknown }).errors, [{ line: 12, message: 'Story US-002 has no acceptance criteria.' }]);
    assert.match(bad.ran.summary, /onboarding-copy/);
    assert.ok(bad.ran.ui?.some((action) => action.action === 'highlight' && action.target === 'prd'));
  });

  it('back_to_planning: returns a ready session to planning', async () => {
    const { w, ran } = await run('back_to_planning', { session: 'dark-mode' });
    assert.deepEqual(w.state.calls, [{ method: 'sessions.backToPlanning', arg: w.ids['dark'] }]);
    assert.equal(ran.summary, 'Back to planning: dark-mode');
  });

  it('schedule_start: parses the time in voice_timezone and sets it', async () => {
    const { w, ran } = await run('schedule_start', { session: 'dark mode', at: 'tonight at 2' });
    assert.deepEqual(w.state.calls, [{ method: 'sessions.setSchedule', arg: { id: w.ids['dark'], scheduledStartAt: '2026-09-26T00:00:00.000Z' } }]);
    assert.equal(ran.summary, 'Scheduled: dark-mode, Saturday 26 September at 02:00');
  });

  it('schedule_start: clear sets the schedule to null', async () => {
    const { w } = await run('schedule_start', { session: 'dark mode', clear: true });
    assert.deepEqual(w.state.calls, [{ method: 'sessions.setSchedule', arg: { id: w.ids['dark'], scheduledStartAt: null } }]);
  });

  it('schedule_start: an ambiguous or missing time asks again without scheduling', async () => {
    const result = await refused('schedule_start', { session: 'dark mode', at: 'tomorrow at 9' });
    assert.equal((result.data as { reason: string }).reason, 'ambiguous_time');
    await refused('schedule_start', { session: 'dark mode' });
  });

  it('retry: retries the failed session; a 404 comes back as a result', async () => {
    const { w, ran } = await run('retry', { session: 'billing exports' });
    assert.deepEqual(w.state.calls, [{ method: 'retries.retry', arg: w.ids['exports'] }]);
    assert.equal(ran.ok, true);
    assert.equal(ran.summary, 'Retried: billing-exports');

    const gone = chiefWorld();
    gone.state.failures.set('retries.retry', new RetryError(404, 'session_not_found', 'This session no longer exists.'));
    const missingOne = await run('retry', { session: 'billing exports' }, gone);
    assert.deepEqual(missingOne.ran, {
      ok: false,
      data: { error: 'session_not_found', status: 404, message: 'This session no longer exists.' },
      summary: 'This session no longer exists.',
    });
  });

  it('an unknown or ambiguous session is refused before any service is called', async () => {
    for (const name of ['start_build', 'stop_build', 'mark_ready', 'back_to_planning', 'retry']) {
      const result = await refused(name, { session: 'billing' });
      assert.equal((result.data as { error: string }).error, 'ambiguous', name);
      await refused(name, { session: 'marketing site' });
    }
  });

  it('a thrown non-service error is a failed result too', async () => {
    const w = chiefWorld();
    w.state.failures.set('builds.stop', new Error('docker went away'));
    const { ran } = await run('stop_build', { session: 'billing export' }, w);
    assert.equal(ran.ok, false);
    assert.match(ran.summary, /billing-export: docker went away/);
  });
});

describe('chief tools on planning sessions (voice multi-planning US-010)', () => {
  const ctx = (): ToolContext => ({
    signal: new AbortController().signal,
    turn: 1,
    focus: { kind: 'chief' },
    endCall: () => undefined,
  });

  function world(): { w: ReturnType<typeof chiefWorld>; tools: ReturnType<typeof createChiefTools> } {
    const w = chiefWorld();
    const onboarding = w.ids['onboarding'] ?? '';
    const shopSession = createSession(w.db, {
      repositoryId: w.ids['shop'] ?? '',
      name: 'csv-import',
      baseBranch: 'develop',
      prTargetBranch: 'develop',
      status: 'pending',
    });
    const states: PlanningState[] = [
      {
        sessionId: shopSession.id,
        sessionName: 'csv-import',
        repositoryName: 'shop-api',
        state: 'drafting',
        openQuestions: [],
        stories: 0,
        updatedAt: '2026-09-25T12:01:00.000Z',
      },
      {
        sessionId: onboarding,
        sessionName: 'onboarding-copy',
        repositoryName: 'chief-web',
        state: 'waiting',
        openQuestions: ['Formal or informal tone?', 'Which screens?'],
        stories: 3,
        updatedAt: '2026-09-25T12:00:00.000Z',
      },
    ];
    const services: ChiefServices = {
      ...w.services,
      planningStates: {
        listPlanningSessions: () => states,
        planningState: (id) => states.find((state) => state.sessionId === id) ?? null,
      },
    };
    return { w, tools: createChiefTools(services) };
  }

  it('get_session: the planning state and the open questions themselves for a planning session only', async () => {
    const { tools } = world();
    const getSession = tools.get('get_session');
    assert.ok(getSession);
    const planning = await getSession.handler({ session: 'onboarding copy' }, ctx());
    assert.equal(planning.ok, true);
    assert.deepEqual((planning.data as Record<string, unknown>)['planning'], {
      state: 'waiting',
      openQuestions: ['Formal or informal tone?', 'Which screens?'],
    });

    const building = await getSession.handler({ session: 'billing export' }, ctx());
    assert.equal(building.ok, true);
    assert.equal('planning' in (building.data as object), false);
  });

  it('list_sessions: planning true lists only planning sessions, latest first, with their state', async () => {
    const { tools } = world();
    const list = tools.get('list_sessions');
    assert.ok(list);
    assert.deepEqual(Object.keys(list.definition.function.parameters['properties'] as object), [
      'status',
      'repository',
      'planning',
    ]);

    const all = await list.handler({ planning: true }, ctx());
    assert.equal(all.summary, '2 planning sessions');
    type Row = { name: string; repository: string; state: string; openQuestions: number; stories: number };
    const data = all.data as { sessions: Row[]; total: number };
    assert.equal(data.total, 2);
    assert.deepEqual(
      data.sessions.map(({ name, repository, state, openQuestions, stories }) => ({ name, repository, state, openQuestions, stories })),
      [
        { name: 'csv-import', repository: 'shop-api', state: 'drafting', openQuestions: 0, stories: 0 },
        { name: 'onboarding-copy', repository: 'chief-web', state: 'waiting', openQuestions: 2, stories: 3 },
      ],
    );

    const shop = await list.handler({ planning: true, repository: 'shop api' }, ctx());
    assert.deepEqual((shop.data as { sessions: Row[] }).sessions.map((s) => s.name), ['csv-import']);
    assert.equal(shop.summary, '1 planning session');

    const everything = await list.handler({}, ctx());
    assert.ok((everything.data as { total: number }).total > 2, 'without the flag every session is listed');
  });

  it('list_sessions: planning true without planning states lists none', async () => {
    const w = chiefWorld();
    const list = createChiefTools(w.services).get('list_sessions');
    assert.ok(list);
    const result = await list.handler({ planning: true }, ctx());
    assert.deepEqual(result.data, { sessions: [], total: 0 });
  });
});

describe('answer_planning_question (voice multi-planning US-012)', () => {
  const ctx = (): ToolContext => ({
    signal: new AbortController().signal,
    turn: 1,
    focus: { kind: 'chief' },
    endCall: () => undefined,
  });

  function world(): {
    w: ReturnType<typeof chiefWorld>;
    tool: ChiefTool;
    started: { sessionId: string; message: string }[];
    ids: Record<string, string>;
  } {
    const w = chiefWorld();
    const onboarding = w.ids['onboarding'] ?? '';
    const session = (name: string): string =>
      createSession(w.db, {
        repositoryId: w.ids['shop'] ?? '',
        name,
        baseBranch: 'develop',
        prTargetBranch: 'develop',
        status: 'pending',
      }).id;
    const drafting = session('csv-import');
    const done = session('csv-export');
    const state = (sessionId: string, sessionName: string, rest: Pick<PlanningState, 'state' | 'openQuestions'>): PlanningState => ({
      sessionId,
      sessionName,
      repositoryName: 'shop-api',
      stories: 3,
      updatedAt: '2026-09-25T12:00:00.000Z',
      ...rest,
    });
    const states: PlanningState[] = [
      state(onboarding, 'onboarding-copy', { state: 'waiting', openQuestions: ['Formal or informal tone?', 'Which screens?'] }),
      state(drafting, 'csv-import', { state: 'drafting', openQuestions: ['Old question?'] }),
      state(done, 'csv-export', { state: 'done', openQuestions: [] }),
    ];
    const started: { sessionId: string; message: string }[] = [];
    const tools = createChiefTools({
      ...w.services,
      planningStates: {
        listPlanningSessions: () => states,
        planningState: (id) => states.find((entry) => entry.sessionId === id) ?? null,
      },
      detachedTurns: { start: (sessionId, message) => started.push({ sessionId, message }) },
    });
    const tool = tools.get('answer_planning_question');
    assert.ok(tool);
    return { w, tool, started, ids: { onboarding, drafting, done } };
  }

  it('takes session, question and answer', () => {
    const { tool } = world();
    const parameters = tool.definition.function.parameters;
    assert.deepEqual(Object.keys(parameters['properties'] as object), ['session', 'question', 'answer']);
    assert.deepEqual(parameters['required'], ['session', 'answer']);
  });

  it('passes one answered question to a detached turn and returns at once', async () => {
    const { tool, started, ids } = world();
    const result = await tool.handler({ session: 'onboarding copy', question: 2, answer: 'Only the settings screen' }, ctx());
    assert.equal(result.ok, true);
    assert.equal(result.summary, 'Passed the answer to onboarding-copy; it is working on it');
    assert.deepEqual(result.data, {
      id: ids['onboarding'],
      name: 'onboarding-copy',
      questions: ['Which screens?'],
      answer: 'Only the settings screen',
    });
    assert.deepEqual(started, [
      {
        sessionId: ids['onboarding'],
        message: answerPrompt(prdPathFor('onboarding-copy'), ['Which screens?'], 'Only the settings screen'),
      },
    ]);
    assert.ok(started[0]?.message.startsWith('[detached] '));
    assert.ok(started[0]?.message.includes('"Which screens?"'));
    assert.ok(!started[0]?.message.includes('Formal or informal tone?'));
  });

  it('quotes every open question when no question is named', async () => {
    const { tool, started } = world();
    const result = await tool.handler({ session: 'onboarding copy', answer: 'Informal, and only settings' }, ctx());
    assert.equal(result.ok, true);
    assert.equal(started.length, 1);
    assert.ok(started[0]?.message.includes('1. "Formal or informal tone?"\n2. "Which screens?"'));
    assert.ok(started[0]?.message.includes('Answer: "Informal, and only settings"'));
  });

  it('refuses a session that is not planning, one that is drafting and one without open questions', async () => {
    const { tool, started } = world();
    const cases: [string, string, string][] = [
      ['billing export', 'not_planning', 'billing-export is not a planning session, so there is no question to answer'],
      ['csv import', 'drafting', 'csv-import is still drafting; give it the answer once it is done'],
      ['csv export', 'no_open_questions', 'csv-export has no open questions'],
    ];
    for (const [session, error, summary] of cases) {
      const result = await tool.handler({ session, answer: 'CSV only' }, ctx());
      assert.equal(result.ok, false, session);
      assert.deepEqual(result.data, { error });
      assert.equal(result.summary, summary);
    }
    const outOfRange = await tool.handler({ session: 'onboarding copy', question: 3, answer: 'CSV only' }, ctx());
    assert.equal(outOfRange.summary, 'onboarding-copy has 2 open questions; there is no question 3');
    assert.equal(started.length, 0, 'no refusal starts a turn');
    const asString = await tool.handler({ session: 'onboarding copy', question: '1', answer: 'Informal' }, ctx());
    assert.equal(asString.ok, true, 'a question number sent as a string still counts');
    assert.ok(started[0]?.message.includes('"Formal or informal tone?"'));
  });

  it('refuses during the usage-limit hold without starting a turn', async () => {
    const { w, started, ids } = world();
    const tool = createChiefTools({
      ...w.services,
      hold: { until: () => '2026-09-25T18:00:00.000Z' },
      planningStates: {
        listPlanningSessions: () => [],
        planningState: (id) => ({
          sessionId: id,
          sessionName: 'onboarding-copy',
          repositoryName: 'chief-web',
          state: 'waiting',
          openQuestions: ['Which screens?'],
          stories: 3,
          updatedAt: '2026-09-25T12:00:00.000Z',
        }),
      },
      detachedTurns: { start: (sessionId, message) => started.push({ sessionId, message }) },
    }).get('answer_planning_question');
    assert.ok(tool);
    const result = await tool.handler({ session: ids['onboarding'] ?? '', answer: 'Settings only' }, ctx());
    assert.deepEqual(result.data, { error: 'usage_limit_hold' });
    assert.deepEqual(started, []);
  });
});
