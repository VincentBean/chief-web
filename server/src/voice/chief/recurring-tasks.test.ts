import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRecurringTaskByName, listRecurringTasks, type RecurringTask, recordRecurringTaskOccurrence } from '../../db/index.js';
import { MAX_RECURRING_TASK_NAME_LENGTH, RecurringTaskError } from '../../recurringtasks/index.js';
import { chiefWorld } from './__fixtures__/world.js';
import { firstSentence } from './recurring-tasks.js';
import { type ChiefTool, createChiefTools, type ToolContext, type ToolResult } from './tools.js';

type World = ReturnType<typeof chiefWorld>;

const ctx: ToolContext = {
  signal: new AbortController().signal,
  turn: 1,
  focus: { kind: 'chief' },
  endCall: () => undefined,
};

/** Calls a tool once: an acting tool resolves its target and acts in the same call. */
async function act(name: string, args: Record<string, unknown>, w: World = chiefWorld()): Promise<{ w: World; result: ToolResult }> {
  const result = await (createChiefTools(w.services).get(name) as ChiefTool).handler(args, ctx);
  return { w, result };
}

/** Calls a tool that must refuse in `prepare`: nothing is called and nothing is written. */
async function refused(name: string, args: Record<string, unknown>, w: World = chiefWorld()): Promise<ToolResult> {
  const before = JSON.stringify(listRecurringTasks(w.db));
  const calls = w.state.calls.length;
  const { result } = await act(name, args, w);
  assert.equal(result.ok, false, result.summary);
  assert.equal(w.state.calls.length, calls, 'no service call');
  assert.equal(JSON.stringify(listRecurringTasks(w.db)), before, 'nothing written');
  return result;
}

function task(w: World, name: string): RecurringTask {
  const row = listRecurringTasks(w.db).find((entry) => entry.name === name);
  assert.ok(row, `no task ${name}`);
  return row;
}

describe('chief recurring task tools (voice US-014)', () => {
  it('list_recurring_tasks: compact rows, and opens the page', async () => {
    const { result } = await act('list_recurring_tasks', {});
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
    const web = await act('list_recurring_tasks', { repository: 'chief web' });
    assert.deepEqual(
      (web.result.data as { recurringTasks: { name: string }[] }).recurringTasks.map((row) => row.name).sort(),
      ['monthly-audit', 'weekly-deps'],
    );
    const unknown = await act('list_recurring_tasks', { repository: 'billing' });
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
    const { result } = await act('get_recurring_task', { task: 'the weekly deps task' }, w);
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(result.ui, [{ action: 'navigate', path: `/recurring-tasks/${weekly.id}` }]);
    const data = result.data as { name: string; schedule: string; prompt: string; occurrences: { at: string; detail: string }[] };
    assert.equal(data.name, 'weekly-deps');
    assert.equal(data.schedule, 'At 03:00, only on Monday');
    assert.equal(data.prompt, 'Bump dependencies.');
    assert.equal(data.occurrences.length, 5);
  });

  it('get_recurring_task: an unknown or ambiguous name offers candidates', async () => {
    const none = await act('get_recurring_task', { task: 'backups' });
    assert.equal(none.result.ok, false);
    assert.equal((none.result.data as { error: string }).error, 'not_found');
    assert.match(none.result.summary, /No recurring task called "backups"/);
  });

  it('pause_recurring_task: resolves the spoken name and pauses through updateRecurringTaskFromRequest', async () => {
    const { w, result } = await act('pause_recurring_task', { task: 'nightly rector' });
    assert.equal(result.ok, true, result.summary);
    assert.equal(result.summary, 'Paused: nightly-rector');
    const row = task(w, 'nightly-rector');
    assert.deepEqual(result.ui, [{ action: 'navigate', path: `/recurring-tasks/${row.id}` }]);
    assert.equal(row.paused, true);
    assert.equal(row.nextRunAt, null);
  });

  it('pause_recurring_task: an already paused task is said, and nothing changes', async () => {
    const w = chiefWorld();
    await act('pause_recurring_task', { task: 'nightly-rector' }, w);
    const again = await refused('pause_recurring_task', { task: 'nightly-rector' }, w);
    assert.equal((again.data as { error: string }).error, 'already_paused');
    assert.equal(again.summary, 'nightly-rector is already paused');
  });

  it('pause_recurring_task: an unknown name is refused', async () => {
    const result = await refused('pause_recurring_task', { task: 'backups' });
    assert.equal((result.data as { error: string }).error, 'not_found');
  });

  it('resume_recurring_task: resumes a paused task; a running one is refused', async () => {
    const w = chiefWorld();
    await act('pause_recurring_task', { task: 'nightly-rector' }, w);
    const { result } = await act('resume_recurring_task', { task: 'nightly-rector' }, w);
    assert.equal(result.ok, true, result.summary);
    assert.equal(result.summary, 'Resumed: nightly-rector');
    const row = task(w, 'nightly-rector');
    assert.equal(row.paused, false);
    assert.notEqual(row.nextRunAt, null);
    const notPaused = await refused('resume_recurring_task', { task: 'weekly-deps' }, w);
    assert.equal((notPaused.data as { error: string }).error, 'not_paused');
  });

  it('run_recurring_task_now: fires one occurrence by id', async () => {
    const { w, result } = await act('run_recurring_task_now', { task: 'nightly rector' });
    assert.equal(result.ok, true, result.summary);
    const id = task(w, 'nightly-rector').id;
    assert.deepEqual(w.state.calls, [{ method: 'recurringTasks.fireNow', arg: id }]);
    assert.deepEqual(result.data, { name: 'nightly-rector', outcome: 'started', run: 'nightly-rector-20260925-0200' });
    assert.equal(result.summary, 'Running now: nightly-rector');
    assert.deepEqual(result.ui, [{ action: 'navigate', path: `/recurring-tasks/${id}` }]);
  });

  it('run_recurring_task_now: a paused task may be run by hand', async () => {
    const w = chiefWorld();
    await act('pause_recurring_task', { task: 'nightly-rector' }, w);
    w.state.calls.length = 0;
    const { result } = await act('run_recurring_task_now', { task: 'nightly-rector' }, w);
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(w.state.calls, [{ method: 'recurringTasks.fireNow', arg: task(w, 'nightly-rector').id }]);
  });

  it('run_recurring_task_now: a skip is spoken with its reason', async () => {
    const w = chiefWorld();
    w.state.firing = { outcome: 'skipped', detail: 'PR #212 from the previous run is still open.', sessionId: null };
    const { result } = await act('run_recurring_task_now', { task: 'nightly-rector' }, w);
    assert.equal(result.ok, false);
    assert.equal(result.summary, 'Skipped nightly-rector: PR #212 from the previous run is still open.');
    assert.equal((result.data as { error: string }).error, 'skipped');
  });

  it('run_recurring_task_now: a run still setting up returns at once, and a refusal is spoken', async () => {
    const w = chiefWorld();
    w.state.firing = 'pending';
    const { result } = await act('run_recurring_task_now', { task: 'nightly-rector' }, w);
    assert.equal(result.ok, true);
    assert.equal((result.data as { setup: string }).setup, 'running');

    const failing = chiefWorld();
    failing.state.failures.set('recurringTasks.fireNow', new RecurringTaskError(503, 'sessions_unavailable', 'The session service is not ready yet.'));
    const second = await act('run_recurring_task_now', { task: 'nightly-rector' }, failing);
    assert.equal(second.result.ok, false);
    assert.equal(second.result.summary, 'The session service is not ready yet.');
  });

  it('create_recurring_task: creates in the resolved repository and reads the schedule back in words', async () => {
    const { w, result } = await act('create_recurring_task', {
      repository: 'shop api',
      name: 'Weekly cleanup',
      schedule: '0 3 * * 1',
      prompt: 'Remove dead code. Then run the tests and fix what breaks.',
      pr_target: 'develop',
      code_review: true,
    });
    assert.equal(result.ok, true, result.summary);
    assert.equal(result.summary, 'Created recurring task: weekly-cleanup');
    const data = result.data as { name: string; repository: string; schedule: string };
    assert.equal(data.name, 'weekly-cleanup');
    assert.equal(data.repository, 'shop-api');
    assert.equal(data.schedule, 'At 03:00, only on Monday');
    const row = getRecurringTaskByName(w.db, w.ids['shop'] as string, 'weekly-cleanup');
    assert.ok(row);
    assert.equal(row.cronExpression, '0 3 * * 1');
    assert.equal(row.prompt, 'Remove dead code. Then run the tests and fix what breaks.');
    assert.equal(row.baseBranch, 'develop');
    assert.equal(row.prTarget, 'develop');
    assert.equal(row.runCodeReview, true);
    assert.equal(row.paused, false);
    assert.deepEqual(result.ui, [{ action: 'navigate', path: `/recurring-tasks/${row.id}` }]);
  });

  it('create_recurring_task: an invalid cron expression is refused and nothing is created', async () => {
    const result = await refused('create_recurring_task', {
      repository: 'shop-api',
      name: 'cleanup',
      schedule: 'every monday',
      prompt: 'Clean up.',
    });
    assert.equal((result.data as { error: string }).error, 'invalid_cron_expression');
    assert.match(result.summary, /^"every monday" is not a schedule I can use: /);
  });

  it('create_recurring_task: a name that is too long is refused with the reason', async () => {
    const long = 'a very long name that goes on and on about the nightly database maintenance';
    const result = await refused('create_recurring_task', { repository: 'shop-api', name: long, schedule: '0 3 * * *', prompt: 'x' });
    assert.equal((result.data as { error: string }).error, 'name_too_long');
    assert.match(result.summary, new RegExp(`at most ${String(MAX_RECURRING_TASK_NAME_LENGTH)}, because every run adds the date and time`));
  });

  it('create_recurring_task: a taken name is refused', async () => {
    const result = await refused('create_recurring_task', { repository: 'shop-api', name: 'nightly rector', schedule: '0 3 * * *', prompt: 'x' });
    assert.equal((result.data as { error: string }).error, 'task_name_taken');
  });

  it('update_recurring_task: changes only the fields that differ, and says which', async () => {
    const { w, result } = await act('update_recurring_task', {
      task: 'weekly deps',
      schedule: '30 4 * * 5',
      prompt: 'Bump dependencies.',
      pr_target: 'main',
      code_review: true,
    });
    assert.equal(result.ok, true, result.summary);
    const data = result.data as { name: string; changed: string; schedule: string };
    assert.equal(data.changed, 'run it at 04:30, only on Friday and turn code review on');
    assert.equal(data.schedule, 'At 04:30, only on Friday');
    const row = task(w, 'weekly-deps');
    assert.equal(row.cronExpression, '30 4 * * 5');
    assert.equal(row.runCodeReview, true);
    assert.equal(row.prompt, 'Bump dependencies.');
  });

  it('update_recurring_task: a rename, and the refusals', async () => {
    const renamed = await act('update_recurring_task', { task: 'monthly audit', name: 'Monthly security audit' });
    assert.equal(renamed.result.ok, true, renamed.result.summary);
    assert.equal((renamed.result.data as { changed: string }).changed, 'rename it to monthly-security-audit');
    assert.equal(task(renamed.w, 'monthly-security-audit').cronExpression, '0 3 1 * *');

    const nothing = await refused('update_recurring_task', { task: 'weekly-deps', schedule: '0 3 * * 1' });
    assert.equal((nothing.data as { error: string }).error, 'no_changes');

    const badCron = await refused('update_recurring_task', { task: 'weekly-deps', schedule: '61 * * * *' });
    assert.equal((badCron.data as { error: string }).error, 'invalid_cron_expression');

    const tooLong = await refused('update_recurring_task', { task: 'weekly-deps', name: 'x'.repeat(MAX_RECURRING_TASK_NAME_LENGTH + 1) });
    assert.equal((tooLong.data as { error: string }).error, 'name_too_long');
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
