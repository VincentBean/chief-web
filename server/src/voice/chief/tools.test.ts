import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chiefWorld } from './__fixtures__/world.js';
import {
  BUILD_LOG_SUMMARY_CHARS,
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

  it('registers the read-only tools with OpenAI-shaped definitions', () => {
    const w = chiefWorld();
    const tools = createChiefTools(w.services);
    assert.deepEqual([...tools.keys()].sort(), [
      'build_status',
      'end_call',
      'get_session',
      'list_repositories',
      'list_sessions',
      'overview',
      'show',
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
