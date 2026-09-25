import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRecurringTaskByName, listRecurringTasks, type RecurringTask, recordRecurringTaskOccurrence } from '../../db/index.js';
import { MAX_RECURRING_TASK_NAME_LENGTH, RecurringTaskError } from '../../recurringtasks/index.js';
import { chiefWorld, testGate } from './__fixtures__/world.js';
import { firstSentence } from './recurring-tasks.js';
import { type ChiefTool, createChiefTools, type ToolContext, type ToolResult } from './tools.js';

type World = ReturnType<typeof chiefWorld>;

const ctxAt = (gate: ToolContext['confirmations'], turn: number): ToolContext => ({
  signal: new AbortController().signal,
  turn,
  focus: { kind: 'chief' },
  endCall: () => undefined,
  confirmations: gate,
});

/** Asks in turn 1, checks nothing changed, confirms in turn 2. */
async function roundTrip(
  name: string,
  args: Record<string, unknown>,
  w: World = chiefWorld(),
): Promise<{ w: World; prompt: string; ran: ToolResult }> {
  const { gate, sent } = testGate();
  const tools = createChiefTools(w.services);
  const before = JSON.stringify(listRecurringTasks(w.db));
  const asked = await (tools.get(name) as ChiefTool).handler(args, ctxAt(gate, 1));
  assert.equal(asked.ok, true, asked.summary);
  const confirm = sent.find((message) => message.type === 'confirm');
  assert.ok(confirm !== undefined && confirm.type === 'confirm', 'asks for confirmation');
  assert.deepEqual(w.state.calls, [], 'nothing runs before the operator answers');
  assert.equal(JSON.stringify(listRecurringTasks(w.db)), before, 'nothing is written before the operator answers');
  const ran = await (tools.get('confirm') as ChiefTool).handler({ confirmation_id: confirm.id }, ctxAt(gate, 2));
  return { w, prompt: confirm.prompt, ran };
}

/** Asks only: the result, and whether a confirmation was parked. */
async function ask(name: string, args: Record<string, unknown>, w: World = chiefWorld()): Promise<{ result: ToolResult; parked: boolean }> {
  const { gate, sent } = testGate();
  const result = await (createChiefTools(w.services).get(name) as ChiefTool).handler(args, ctxAt(gate, 1));
  return { result, parked: sent.some((message) => message.type === 'confirm') };
}

function task(w: World, name: string): RecurringTask {
  const row = listRecurringTasks(w.db).find((entry) => entry.name === name);
  assert.ok(row, `no task ${name}`);
  return row;
}

describe('chief recurring task tools (voice US-014)', () => {
  it('list_recurring_tasks: compact rows, and opens the page', async () => {
    const { result } = await ask('list_recurring_tasks', {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.ui, [{ action: 'navigate', path: '/recurring-tasks' }]);
    const data = result.data as { recurringTasks: Record<string, unknown>[]; total: number };
    assert.equal(data.total, 3);
    const weekly = data.recurringTasks.find((row) => row['name'] === 'weekly-deps');
    assert.deepEqual(weekly, {
      name: 'weekly-deps',
      repository: 'chief-web',
      schedule: 'At 03:00, only on Monday',
      paused: false,
      nextRun: '2026-09-28 03:00',
      lastOutcome: 'failed',
    });
    assert.equal(result.summary, '3 recurring tasks');
  });

  it('list_recurring_tasks: filters by a spoken repository name', async () => {
    const web = await ask('list_recurring_tasks', { repository: 'chief web' });
    assert.deepEqual(
      (web.result.data as { recurringTasks: { name: string }[] }).recurringTasks.map((row) => row.name).sort(),
      ['monthly-audit', 'weekly-deps'],
    );
    const unknown = await ask('list_recurring_tasks', { repository: 'billing' });
    assert.equal(unknown.result.ok, false);
    assert.equal((unknown.result.data as { error: string }).error, 'not_found');
  });

  it('get_recurring_task: the detail view with the last five occurrences, resolved like a session name', async () => {
    const w = chiefWorld();
    const weekly = task(w, 'weekly-deps');
    for (let i = 0; i < 7; i++) {
      recordRecurringTaskOccurrence(w.db, {
        recurringTaskId: weekly.id,
        occurredAt: `2026-09-${String(10 + i)}T01:00:00.000Z`,
        outcome: 'skipped',
        detail: `skip ${String(i)}`,
      });
    }
    const { result } = await ask('get_recurring_task', { task: 'the weekly deps task' }, w);
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(result.ui, [{ action: 'navigate', path: `/recurring-tasks/${weekly.id}` }]);
    const data = result.data as { name: string; schedule: string; prompt: string; occurrences: { at: string; detail: string }[] };
    assert.equal(data.name, 'weekly-deps');
    assert.equal(data.schedule, 'At 03:00, only on Monday');
    assert.equal(data.prompt, 'Bump dependencies.');
    assert.equal(data.occurrences.length, 5);
  });

  it('get_recurring_task: an unknown or ambiguous name offers candidates', async () => {
    const none = await ask('get_recurring_task', { task: 'backups' });
    assert.equal(none.result.ok, false);
    assert.equal((none.result.data as { error: string }).error, 'not_found');
    assert.match(none.result.summary, /No recurring task called "backups"/);
  });

  it('pause_recurring_task: confirms, then pauses through updateRecurringTaskFromRequest', async () => {
    const { w, prompt, ran } = await roundTrip('pause_recurring_task', { task: 'nightly rector' });
    assert.equal(prompt, 'Pause the recurring task nightly-rector?');
    assert.equal(ran.ok, true, ran.summary);
    assert.equal(ran.summary, 'Paused: nightly-rector');
    const row = task(w, 'nightly-rector');
    assert.equal(row.paused, true);
    assert.equal(row.nextRunAt, null);
  });

  it('pause_recurring_task: an already paused task is said, not confirmed', async () => {
    const w = chiefWorld();
    await roundTrip('pause_recurring_task', { task: 'nightly-rector' }, w);
    const again = await ask('pause_recurring_task', { task: 'nightly-rector' }, w);
    assert.equal(again.result.ok, false);
    assert.equal(again.parked, false);
    assert.equal(again.result.summary, 'nightly-rector is already paused');
  });

  it('resume_recurring_task: confirms with the schedule, then resumes', async () => {
    const w = chiefWorld();
    await roundTrip('pause_recurring_task', { task: 'nightly-rector' }, w);
    const { prompt, ran } = await roundTrip('resume_recurring_task', { task: 'nightly-rector' }, w);
    assert.equal(prompt, 'Resume the recurring task nightly-rector, at 02:00?');
    assert.equal(ran.ok, true, ran.summary);
    const row = task(w, 'nightly-rector');
    assert.equal(row.paused, false);
    assert.notEqual(row.nextRunAt, null);
    const notPaused = await ask('resume_recurring_task', { task: 'weekly-deps' }, w);
    assert.equal(notPaused.result.ok, false);
    assert.equal(notPaused.parked, false);
  });

  it('run_recurring_task_now: confirms, then fires one occurrence', async () => {
    const { w, prompt, ran } = await roundTrip('run_recurring_task_now', { task: 'nightly rector' });
    assert.equal(prompt, 'Run nightly-rector now?');
    assert.equal(ran.ok, true, ran.summary);
    const id = task(w, 'nightly-rector').id;
    assert.deepEqual(w.state.calls, [{ method: 'recurringTasks.fireNow', arg: id }]);
    assert.deepEqual(ran.data, { name: 'nightly-rector', outcome: 'started', run: 'nightly-rector-20260925-0200' });
    assert.equal(ran.summary, 'Running now: nightly-rector');
    assert.deepEqual(ran.ui, [{ action: 'navigate', path: `/recurring-tasks/${id}` }]);
  });

  it('run_recurring_task_now: a paused task may be run by hand, and the prompt says so', async () => {
    const w = chiefWorld();
    await roundTrip('pause_recurring_task', { task: 'nightly-rector' }, w);
    w.state.calls.length = 0;
    const { prompt, ran } = await roundTrip('run_recurring_task_now', { task: 'nightly-rector' }, w);
    assert.equal(prompt, 'Run nightly-rector now, even though it is paused?');
    assert.equal(ran.ok, true, ran.summary);
  });

  it('run_recurring_task_now: a skip is spoken with its reason', async () => {
    const w = chiefWorld();
    w.state.firing = { outcome: 'skipped', detail: 'PR #212 from the previous run is still open.', sessionId: null };
    const { ran } = await roundTrip('run_recurring_task_now', { task: 'nightly-rector' }, w);
    assert.equal(ran.ok, false);
    assert.equal(ran.summary, 'Skipped nightly-rector: PR #212 from the previous run is still open.');
    assert.equal((ran.data as { error: string }).error, 'skipped');
  });

  it('run_recurring_task_now: a run still setting up returns at once, and a refusal is spoken', async () => {
    const w = chiefWorld();
    w.state.firing = 'pending';
    const { ran } = await roundTrip('run_recurring_task_now', { task: 'nightly-rector' }, w);
    assert.equal(ran.ok, true);
    assert.equal((ran.data as { setup: string }).setup, 'running');

    const refused = chiefWorld();
    refused.state.failures.set('recurringTasks.fireNow', new RecurringTaskError(503, 'sessions_unavailable', 'The session service is not ready yet.'));
    const second = await roundTrip('run_recurring_task_now', { task: 'nightly-rector' }, refused);
    assert.equal(second.ran.ok, false);
    assert.equal(second.ran.summary, 'The session service is not ready yet.');
  });

  it('create_recurring_task: reads back name, schedule in words and the first sentence, then creates', async () => {
    const { w, prompt, ran } = await roundTrip('create_recurring_task', {
      repository: 'shop api',
      name: 'Weekly cleanup',
      schedule: '0 3 * * 1',
      prompt: 'Remove dead code. Then run the tests and fix what breaks.',
      pr_target: 'develop',
      code_review: true,
    });
    assert.equal(prompt, 'Create recurring task weekly-cleanup in shop-api, at 03:00, only on Monday, with the prompt "Remove dead code"?');
    assert.equal(ran.ok, true, ran.summary);
    assert.equal(ran.summary, 'Created recurring task: weekly-cleanup');
    const row = getRecurringTaskByName(w.db, w.ids['shop'] as string, 'weekly-cleanup');
    assert.ok(row);
    assert.equal(row.cronExpression, '0 3 * * 1');
    assert.equal(row.prompt, 'Remove dead code. Then run the tests and fix what breaks.');
    assert.equal(row.baseBranch, 'develop');
    assert.equal(row.prTarget, 'develop');
    assert.equal(row.runCodeReview, true);
    assert.equal(row.paused, false);
    assert.deepEqual(ran.ui, [{ action: 'navigate', path: `/recurring-tasks/${row.id}` }]);
  });

  it('create_recurring_task: an invalid cron expression is refused before asking', async () => {
    const { result, parked } = await ask('create_recurring_task', {
      repository: 'shop-api',
      name: 'cleanup',
      schedule: 'every monday',
      prompt: 'Clean up.',
    });
    assert.equal(result.ok, false);
    assert.equal(parked, false);
    assert.equal((result.data as { error: string }).error, 'invalid_cron_expression');
    assert.match(result.summary, /^"every monday" is not a schedule I can use: /);
  });

  it('create_recurring_task: a name that is too long is refused with the reason', async () => {
    const long = 'a very long name that goes on and on about the nightly database maintenance';
    const { result, parked } = await ask('create_recurring_task', { repository: 'shop-api', name: long, schedule: '0 3 * * *', prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal(parked, false);
    assert.equal((result.data as { error: string }).error, 'name_too_long');
    assert.match(result.summary, new RegExp(`at most ${String(MAX_RECURRING_TASK_NAME_LENGTH)}, because every run adds the date and time`));
  });

  it('create_recurring_task: a taken name is refused', async () => {
    const { result } = await ask('create_recurring_task', { repository: 'shop-api', name: 'nightly rector', schedule: '0 3 * * *', prompt: 'x' });
    assert.equal(result.ok, false);
    assert.equal((result.data as { error: string }).error, 'task_name_taken');
  });

  it('update_recurring_task: reads back only the fields that change', async () => {
    const { w, prompt, ran } = await roundTrip('update_recurring_task', {
      task: 'weekly deps',
      schedule: '30 4 * * 5',
      prompt: 'Bump dependencies.',
      pr_target: 'main',
      code_review: true,
    });
    assert.equal(prompt, 'For weekly-deps: run it at 04:30, only on Friday and turn code review on?');
    assert.equal(ran.ok, true, ran.summary);
    const row = task(w, 'weekly-deps');
    assert.equal(row.cronExpression, '30 4 * * 5');
    assert.equal(row.runCodeReview, true);
    assert.equal(row.prompt, 'Bump dependencies.');
  });

  it('update_recurring_task: a rename, and the refusals', async () => {
    const renamed = await roundTrip('update_recurring_task', { task: 'monthly audit', name: 'Monthly security audit' });
    assert.equal(renamed.prompt, 'For monthly-audit: rename it to monthly-security-audit?');
    assert.equal(renamed.ran.ok, true, renamed.ran.summary);
    assert.equal(task(renamed.w, 'monthly-security-audit').cronExpression, '0 3 1 * *');

    const nothing = await ask('update_recurring_task', { task: 'weekly-deps', schedule: '0 3 * * 1' });
    assert.equal(nothing.result.ok, false);
    assert.equal((nothing.result.data as { error: string }).error, 'no_changes');

    const badCron = await ask('update_recurring_task', { task: 'weekly-deps', schedule: '61 * * * *' });
    assert.equal(badCron.parked, false);
    assert.equal((badCron.result.data as { error: string }).error, 'invalid_cron_expression');

    const tooLong = await ask('update_recurring_task', { task: 'weekly-deps', name: 'x'.repeat(MAX_RECURRING_TASK_NAME_LENGTH + 1) });
    assert.equal((tooLong.result.data as { error: string }).error, 'name_too_long');
  });

  it('does not expose deleting a recurring task', () => {
    const names = [...createChiefTools(chiefWorld().services).keys()];
    assert.deepEqual(names.filter((name) => name.includes('delete') || name.includes('remove')), []);
  });

  it('firstSentence: the first sentence, without its full stop', () => {
    assert.equal(firstSentence('Run rector.  Then fix it.'), 'Run rector');
    assert.equal(firstSentence('Update v1.2 deps now'), 'Update v1.2 deps now');
    assert.equal(firstSentence('x'.repeat(200)).length, 160);
  });
});
