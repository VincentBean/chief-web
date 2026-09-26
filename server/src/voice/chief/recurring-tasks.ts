import { getRecurringTaskByName, getSession, latestRecurringTaskRunSession, listRepositories, PR_TARGET_BRANCHES, type PrTargetBranch } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import {
  createRecurringTaskFromRequest,
  type FireNowResult,
  getRecurringTaskDetailView,
  listRecurringTaskViews,
  MAX_RECURRING_TASK_NAME_LENGTH,
  previewCron,
  type RecurringTaskView,
  type UpdateRecurringTaskRequest,
  updateRecurringTaskFromRequest,
} from '../../recurringtasks/index.js';
import { getVoiceSettings } from '../../settings/index.js';
import type { UiAction } from '../protocol.js';
import { guarded, serviceFailure, slugify } from './actions.js';
import { confirmable, type PreparedAction } from './confirm.js';
import { formatLocal } from './snapshot.js';
import {
  type ChiefServices,
  type ChiefTool,
  missing,
  resolveName,
  stringArg,
  tool,
  type ToolResult,
  unresolved,
} from './tools.js';

/**
 * Chief's recurring task tools (voice US-014): list and read them, pause,
 * resume and run one by hand, create one and edit one. Deleting is not
 * exposed. Everything goes through the same domain layer the Recurring tasks
 * page uses (`recurringtasks/service.ts`), so a name that page refuses, or a
 * schedule the scheduler cannot fire, is refused here with the same words.
 *
 * The model turns the spoken schedule into a cron expression; `previewCron`
 * is the judge of it, and the confirmation reads it back in words.
 */

/** How many occurrences `get_recurring_task` returns. */
export const RECURRING_TASK_OCCURRENCES = 5;

const TASK_PARAM = { type: 'string', description: 'Recurring task id or spoken name' };
const SCHEDULE_PARAM = {
  type: 'string',
  description:
    'Five-field cron expression (minute hour day-of-month month day-of-week) in server time, made from what was said: ' +
    '"every Monday at three in the morning" → "0 3 * * 1"',
};
const FIELD_PARAMS = {
  prompt: { type: 'string', description: 'What every run should do, as the operator said it' },
  base_branch: { type: 'string', description: "Branch each run starts from; default the repository's base branch" },
  pr_target: { type: 'string', enum: [...PR_TARGET_BRANCHES], description: 'Branch the pull request targets; default main' },
  code_review: { type: 'boolean', description: 'Review each run’s pull request automatically' },
};

/** Words a spoken task name carries that the stored one does not: "the nightly rector task". */
const TASK_FILLER = /\b(recurring|task)\b/gi;

export function recurringTaskPath(id: string): string {
  return `/recurring-tasks/${encodeURIComponent(id)}`;
}

/** The first sentence of a prompt, flattened and at most 160 characters, without its closing punctuation. */
export function firstSentence(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  const sentence = (/^.*?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat).replace(/[.!?]+$/, '');
  return sentence.length <= 160 ? sentence : `${sentence.slice(0, 159)}…`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Resolves the `task` argument like a session name, or the result that says why it could not be. */
function taskArg(services: ChiefServices, args: Readonly<Record<string, unknown>>): RecurringTaskView | ToolResult {
  const query = stringArg(args, 'task');
  if (query === null) return missing('task');
  const tasks = listRecurringTaskViews(services.db);
  const trimmed = query.replace(TASK_FILLER, ' ').trim();
  const resolution = resolveName(trimmed === '' ? query : trimmed, tasks);
  return resolution.kind === 'one' ? resolution.item : unresolved('recurring task', query, resolution);
}

function isTask(value: RecurringTaskView | ToolResult): value is RecurringTaskView {
  return !('summary' in value);
}

/** A spoken name as a task name, or the spoken reason it cannot be one. */
function taskName(spoken: string): string | ToolResult {
  const name = slugify(spoken, Number.POSITIVE_INFINITY);
  if (name === '') return { ok: false, data: { error: 'invalid_name', name: spoken }, summary: `"${spoken}" makes no usable task name` };
  if (name.length > MAX_RECURRING_TASK_NAME_LENGTH) {
    const summary =
      `"${name}" is ${String(name.length)} characters, and a recurring task name can have at most ${String(MAX_RECURRING_TASK_NAME_LENGTH)}, ` +
      'because every run adds the date and time to it. Please pick a shorter name.';
    return { ok: false, data: { error: 'name_too_long', name, length: name.length, max: MAX_RECURRING_TASK_NAME_LENGTH }, summary };
  }
  return name;
}

/** The schedule in words, or the result that says why the expression is refused. */
function scheduleArg(schedule: string, now: Date): { cron: string; words: string; nextRunAt: string | null } | ToolResult {
  const preview = previewCron(schedule.trim(), now);
  if (!preview.valid || preview.description === null) {
    const message = preview.message ?? 'That is not a schedule.';
    return {
      ok: false,
      data: { error: 'invalid_cron_expression', schedule, message },
      summary: `"${schedule}" is not a schedule I can use: ${message}`,
    };
  }
  return { cron: preview.expression, words: preview.description, nextRunAt: preview.nextRunAt };
}

function prTargetArg(args: Readonly<Record<string, unknown>>): PrTargetBranch | null | ToolResult {
  const target = stringArg(args, 'pr_target');
  if (target === null) return null;
  if (!(PR_TARGET_BRANCHES as readonly string[]).includes(target)) {
    return { ok: false, data: { error: 'invalid_pr_target', allowed: PR_TARGET_BRANCHES }, summary: `No PR target ${target}` };
  }
  return target as PrTargetBranch;
}

function prepared(prompt: string, args: Readonly<Record<string, unknown>>): PreparedAction {
  return { prompt, args };
}

/** The recurring task tools over `services`. */
export function recurringTaskTools(services: ChiefServices): ChiefTool[] {
  const { db } = services;
  const now = (): Date => services.now?.() ?? new Date();
  const timeZone = (): string => getVoiceSettings(db).timezone;
  const local = (iso: string | null): string | null => (iso === null ? null : formatLocal(new Date(iso), timeZone()));
  const open = (id: string): readonly UiAction[] => [{ action: 'navigate', path: recurringTaskPath(id) }];

  /** A confirmable action on one existing task: resolved in `prepare`, run by id. */
  const taskAction = (
    name: string,
    description: string,
    extra: Readonly<Record<string, unknown>>,
    steps: {
      prepare(task: RecurringTaskView, args: Readonly<Record<string, unknown>>): PreparedAction | ToolResult;
      execute(target: { id: string; name: string }, args: Readonly<Record<string, unknown>>): ToolResult | Promise<ToolResult>;
    },
  ): ChiefTool =>
    confirmable(name, description, { task: TASK_PARAM, ...extra }, ['task'], {
      prepare: (args) =>
        guarded(`Could not ${name.replace(/_/g, ' ')}`, () => {
          const task = taskArg(services, args);
          return isTask(task) ? steps.prepare(task, args) : task;
        }),
      execute: (args) => {
        const target = { id: args['taskId'] as string, name: args['name'] as string };
        return guarded(`Could not ${name.replace(/_/g, ' ')} ${target.name}`, () => steps.execute(target, args));
      },
    });

  const setPaused = (paused: boolean) => (target: { id: string; name: string }): ToolResult => {
    const view = updateRecurringTaskFromRequest(db, target.id, { paused });
    return {
      ok: true,
      data: { name: view.name, paused: view.paused, nextRun: local(view.nextRunAt) },
      summary: `${paused ? 'Paused' : 'Resumed'}: ${view.name}`,
      ui: open(view.id),
    };
  };

  return [
    tool(
      'list_recurring_tasks',
      'List recurring tasks: schedule in words, paused, next run, last outcome.',
      { repository: { type: 'string', description: 'Repository id or spoken name' } },
      [],
      (args) => {
        const repoQuery = stringArg(args, 'repository');
        let repositoryId: string | undefined;
        if (repoQuery !== null) {
          const resolution = resolveName(repoQuery, listRepositories(db));
          if (resolution.kind !== 'one') return unresolved('repository', repoQuery, resolution);
          repositoryId = resolution.item.id;
        }
        const tasks = listRecurringTaskViews(db, repositoryId);
        return {
          ok: true,
          data: {
            recurringTasks: tasks.map((task) => ({
              name: task.name,
              repository: task.repositoryName,
              schedule: task.scheduleDescription ?? task.cronExpression,
              paused: task.paused,
              nextRun: local(task.nextRunAt),
              lastOutcome: task.lastOutcomeLabel,
            })),
            total: tasks.length,
          },
          summary: `${String(tasks.length)} recurring task${tasks.length === 1 ? '' : 's'}`,
          ui: [{ action: 'navigate', path: '/recurring-tasks' }],
        };
      },
    ),

    tool('get_recurring_task', 'One recurring task: schedule, settings, prompt and its last five runs.', { task: TASK_PARAM }, ['task'], (args) => {
      const found = taskArg(services, args);
      if (!isTask(found)) return found;
      const detail = getRecurringTaskDetailView(db, found.id);
      if (detail === null) return { ok: false, data: { error: 'recurring_task_not_found' }, summary: `No recurring task ${found.name}` };
      return {
        ok: true,
        data: {
          name: detail.name,
          repository: detail.repositoryName,
          schedule: detail.scheduleDescription ?? detail.cronExpression,
          cron: detail.cronExpression,
          paused: detail.paused,
          nextRun: local(detail.nextRunAt),
          baseBranch: detail.baseBranch,
          prTarget: detail.prTarget,
          codeReview: detail.runCodeReview,
          prompt: detail.prompt.length <= 300 ? detail.prompt : `${detail.prompt.slice(0, 299)}…`,
          lastOutcome: detail.lastOutcomeLabel,
          occurrences: detail.occurrences.slice(0, RECURRING_TASK_OCCURRENCES).map((occurrence) => ({
            at: local(occurrence.occurredAt),
            outcome: occurrence.outcomeLabel,
            detail: occurrence.detail === null ? null : occurrence.detail.slice(0, 160),
            run: occurrence.session?.name ?? null,
          })),
        },
        summary: `${detail.name}: ${detail.paused ? 'paused' : (detail.scheduleDescription ?? detail.cronExpression)}`,
        ui: open(detail.id),
      };
    }),

    taskAction('pause_recurring_task', 'Pause a recurring task: it stops firing until resumed.', {}, {
      prepare: (task) =>
        task.paused
          ? { ok: false, data: { error: 'already_paused', name: task.name }, summary: `${task.name} is already paused` }
          : prepared(`Pause the recurring task ${task.name}?`, { taskId: task.id, name: task.name }),
      execute: setPaused(true),
    }),

    taskAction('resume_recurring_task', 'Resume a paused recurring task; its schedule is counted from now.', {}, {
      prepare: (task) =>
        task.paused
          ? prepared(`Resume the recurring task ${task.name}, ${lowerFirst(task.scheduleDescription ?? task.cronExpression)}?`, { taskId: task.id, name: task.name })
          : { ok: false, data: { error: 'not_paused', name: task.name }, summary: `${task.name} is not paused` },
      execute: setPaused(false),
    }),

    taskAction(
      'run_recurring_task_now',
      'Run one occurrence of a recurring task now, outside its schedule (paused tasks too). It is skipped, like a scheduled one, ' +
        'while the previous run is still going or its pull request is still open.',
      {},
      {
        prepare: (task) =>
          prepared(`Run ${task.name} now${task.paused ? ', even though it is paused' : ''}?`, { taskId: task.id, name: task.name }),
        execute: async (target) => {
          const firing = services.recurringTasks.fireNow(target.id);
          // A skip or a refused session settles within a few microtasks; a
          // run that got as far as the clone carries on without the call.
          const early = await Promise.race([
            firing.then(
              (result) => ({ kind: 'done' as const, result }),
              (cause: unknown) => ({ kind: 'refused' as const, cause }),
            ),
            new Promise<{ kind: 'pending' }>((resolve) => setImmediate(() => resolve({ kind: 'pending' }))),
          ]);
          if (early.kind === 'refused') return serviceFailure(early.cause, `Could not run ${target.name}`);
          if (early.kind === 'pending') {
            firing.catch((cause: unknown) => logger.warn('recurring task run by chief failed', { task: target.id, error: String(cause) }));
            const run = latestRecurringTaskRunSession(db, target.id);
            return {
              ok: true,
              data: { name: target.name, firing: true, run: run?.name ?? null, setup: 'running' },
              summary: `Running now: ${target.name}`,
              ui: open(target.id),
            };
          }
          return fired(target, early.result);
        },
      },
    ),

    confirmable(
      'create_recurring_task',
      'Create a recurring task in a repository. Turn the spoken schedule into a cron expression; the confirmation reads it back in words.',
      {
        repository: { type: 'string', description: 'Repository id or spoken name' },
        name: { type: 'string', description: 'Task name; turned into a slug' },
        schedule: SCHEDULE_PARAM,
        ...FIELD_PARAMS,
      },
      ['repository', 'name', 'schedule', 'prompt'],
      {
        prepare: (args) =>
          guarded('Could not create the recurring task', () => {
            const repoQuery = stringArg(args, 'repository');
            if (repoQuery === null) return missing('repository');
            const spoken = stringArg(args, 'name');
            if (spoken === null) return missing('name');
            const schedule = stringArg(args, 'schedule');
            if (schedule === null) return missing('schedule');
            const prompt = stringArg(args, 'prompt');
            if (prompt === null) return missing('prompt');
            const resolution = resolveName(repoQuery, listRepositories(db));
            if (resolution.kind !== 'one') return unresolved('repository', repoQuery, resolution);
            const repository = resolution.item;
            const name = taskName(spoken);
            if (typeof name !== 'string') return name;
            if (getRecurringTaskByName(db, repository.id, name) !== null) {
              return { ok: false, data: { error: 'task_name_taken', name }, summary: `${repository.name} already has a recurring task named ${name}` };
            }
            const cron = scheduleArg(schedule, now());
            if ('ok' in cron) return cron;
            const prTarget = prTargetArg(args);
            if (prTarget !== null && typeof prTarget === 'object') return prTarget;
            const baseBranch = stringArg(args, 'base_branch')?.trim() ?? null;
            const codeReview = typeof args['code_review'] === 'boolean' ? args['code_review'] : null;
            return prepared(`Create recurring task ${name} in ${repository.name}, ${lowerFirst(cron.words)}, with the prompt "${firstSentence(prompt)}"?`, {
              repositoryId: repository.id,
              name,
              cronExpression: cron.cron,
              prompt: prompt.trim(),
              baseBranch,
              prTarget,
              codeReview,
            });
          }),
        execute: (args) =>
          guarded(`Could not create ${String(args['name'])}`, () => {
            const { baseBranch, prTarget, codeReview } = args;
            const view = createRecurringTaskFromRequest(db, {
              repositoryId: args['repositoryId'] as string,
              name: args['name'] as string,
              prompt: args['prompt'] as string,
              cronExpression: args['cronExpression'] as string,
              ...(typeof baseBranch === 'string' ? { baseBranch } : {}),
              ...(typeof prTarget === 'string' ? { prTarget: prTarget as PrTargetBranch } : {}),
              ...(typeof codeReview === 'boolean' ? { runCodeReview: codeReview } : {}),
            });
            return {
              ok: true,
              data: { name: view.name, repository: view.repositoryName, schedule: view.scheduleDescription, nextRun: local(view.nextRunAt) },
              summary: `Created recurring task: ${view.name}`,
              ui: open(view.id),
            };
          }),
      },
    ),

    taskAction(
      'update_recurring_task',
      'Change a recurring task. Pass only what changes; a new schedule is a cron expression made from what was said.',
      { name: { type: 'string', description: 'New task name' }, schedule: SCHEDULE_PARAM, ...FIELD_PARAMS },
      {
        prepare: (task, args) => {
          const changes: { -readonly [K in keyof UpdateRecurringTaskRequest]: UpdateRecurringTaskRequest[K] } = {};
          const said: string[] = [];
          const spoken = stringArg(args, 'name');
          if (spoken !== null) {
            const name = taskName(spoken);
            if (typeof name !== 'string') return name;
            if (name !== task.name) {
              const taken = getRecurringTaskByName(db, task.repositoryId, name);
              if (taken !== null) return { ok: false, data: { error: 'task_name_taken', name }, summary: `${task.repositoryName} already has a recurring task named ${name}` };
              changes.name = name;
              said.push(`rename it to ${name}`);
            }
          }
          const schedule = stringArg(args, 'schedule');
          if (schedule !== null) {
            const cron = scheduleArg(schedule, now());
            if ('ok' in cron) return cron;
            if (cron.cron !== task.cronExpression) {
              changes.cronExpression = cron.cron;
              said.push(`run it ${lowerFirst(cron.words)}`);
            }
          }
          const prompt = stringArg(args, 'prompt');
          if (prompt !== null && prompt.trim() !== task.prompt) {
            changes.prompt = prompt.trim();
            said.push(`change the prompt to "${firstSentence(prompt)}"`);
          }
          const baseBranch = stringArg(args, 'base_branch')?.trim() ?? null;
          if (baseBranch !== null && baseBranch !== task.baseBranch) {
            changes.baseBranch = baseBranch;
            said.push(`start from ${baseBranch}`);
          }
          const prTarget = prTargetArg(args);
          if (prTarget !== null && typeof prTarget === 'object') return prTarget;
          if (prTarget !== null && prTarget !== task.prTarget) {
            changes.prTarget = prTarget;
            said.push(`open the pull request into ${prTarget}`);
          }
          const codeReview = args['code_review'];
          if (typeof codeReview === 'boolean' && codeReview !== task.runCodeReview) {
            changes.runCodeReview = codeReview;
            said.push(codeReview ? 'turn code review on' : 'turn code review off');
          }
          if (said.length === 0) {
            return { ok: false, data: { error: 'no_changes', name: task.name }, summary: `Nothing to change on ${task.name}` };
          }
          const list = said.length === 1 ? (said[0] as string) : `${said.slice(0, -1).join(', ')} and ${said.at(-1) as string}`;
          return prepared(`For ${task.name}: ${list}?`, { taskId: task.id, name: task.name, changes });
        },
        execute: (target, args) => {
          const view = updateRecurringTaskFromRequest(db, target.id, args['changes'] as UpdateRecurringTaskRequest);
          return {
            ok: true,
            data: { name: view.name, schedule: view.scheduleDescription, paused: view.paused, nextRun: local(view.nextRunAt) },
            summary: `Updated recurring task: ${view.name}`,
            ui: open(view.id),
          };
        },
      },
    ),
  ];

  function fired(target: { id: string; name: string }, result: FireNowResult): ToolResult {
    const occurrence = result.occurrence;
    const sessionId = occurrence?.sessionId ?? null;
    const run = sessionId === null ? null : (getSession(db, sessionId)?.name ?? null);
    if (result.fired) {
      return {
        ok: true,
        data: { name: target.name, outcome: occurrence?.outcome ?? 'started', run },
        summary: `Running now: ${target.name}`,
        ui: open(target.id),
      };
    }
    const reason = occurrence?.detail ?? 'It did not start.';
    return {
      ok: false,
      data: { error: occurrence?.outcome ?? 'not_started', name: target.name, reason, run },
      summary: occurrence?.outcome === 'skipped' ? `Skipped ${target.name}: ${reason}` : `Could not run ${target.name}: ${reason}`,
      ui: open(target.id),
    };
  }
}
