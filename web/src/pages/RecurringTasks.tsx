import { useCallback, useEffect, useState } from 'react';

import {
  deleteRecurringTask,
  type RecurringTask,
  fetchRecurringTasks,
  updateRecurringTask,
} from '../api.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { DASHBOARD_POLL_MS, describeError, redirectIfUnauthorised } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link } from '../router.tsx';
import { localTime, nextRunIn } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Notice, PageHeader, RECURRING_OUTCOME_TONE, Skeleton } from '../ui.tsx';

/**
 * Every recurring task, with the two things an operator wants from a list of
 * automations: when each one runs next, and how the last run ended (US-007).
 *
 * The list is polled on the dashboard's own cadence rather than a slower one
 * of its own. Everything on the page moves without this tab: the countdown
 * runs down, the scheduler fires a task and clears its `nextRunAt`, and the
 * settle step rewrites `lastOutcome` when a run ends. A hidden tab polls
 * nothing, and coming back re-reads at once.
 */

/** How much of a prompt fits under the name before it stops being a summary. */
const PROMPT_SUMMARY_LENGTH = 80;

export function RecurringTasks() {
  const toast = useToast();
  const [tasks, setTasks] = useState<RecurringTask[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RecurringTask | null>(null);

  const load = useCallback((abort?: AbortSignal): void => {
    fetchRecurringTasks(abort)
      .then((loaded) => {
        setTasks(loaded);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (abort?.aborted === true) return;
        if (redirectIfUnauthorised(error)) return;
        setLoadError(describeError(error));
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load(controller.signal);
    }, DASHBOARD_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') load(controller.signal);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const onTogglePaused = (task: RecurringTask): void => {
    setBusyId(task.id);
    updateRecurringTask(task.id, { paused: !task.paused })
      .then((saved) => {
        setTasks((current) =>
          (current ?? []).map((candidate) => (candidate.id === saved.id ? saved : candidate)),
        );
        toast.ok(
          saved.paused
            ? `Paused ${saved.name}. It will not run until you resume it.`
            : `Resumed ${saved.name}.`,
        );
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setBusyId(null));
  };

  const onDelete = (): void => {
    if (deleting === null) return;
    const task = deleting;
    setDeleting(null);
    setBusyId(task.id);
    deleteRecurringTask(task.id)
      .then(() => {
        setTasks((current) => (current ?? []).filter((candidate) => candidate.id !== task.id));
        toast.ok(`Deleted ${task.name}.`);
      })
      .catch((error: unknown) => toast.error(describeError(error)))
      .finally(() => setBusyId(null));
  };

  const paused = (tasks ?? []).filter((task) => task.paused).length;

  return (
    <div className="page">
      <PageHeader
        title="Recurring tasks"
        subtitle="A saved prompt on a schedule. Each run gets its own session, container and branch, and opens a pull request only when it produced commits."
        actions={
          <Link className="button button--primary" href="/recurring-tasks/new">
            <Icon name="plus" />
            New task
          </Link>
        }
      />

      {loadError !== null && <Notice kind="error">Could not read recurring tasks: {loadError}</Notice>}

      {tasks === null ? (
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={4} />
          </div>
        </div>
      ) : tasks.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No recurring tasks yet"
          action={
            <Link className="button button--primary" href="/recurring-tasks/new">
              <Icon name="plus" />
              New task
            </Link>
          }
        >
          A recurring task runs unattended: chief-web starts a session for it on every occurrence,
          builds the prompt as a one-story PRD, and leaves a pull request when there is something to
          review.
        </EmptyState>
      ) : (
        <div className="table-wrap table-wrap--cards panel">
          <table className="table table--cards">
            <thead>
              <tr>
                <th>Task</th>
                <th>Schedule</th>
                <th>Next run</th>
                <th>Last run</th>
                <th className="table__actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  busy={busyId === task.id}
                  onTogglePaused={() => onTogglePaused(task)}
                  onDelete={() => setDeleting(task)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tasks !== null && paused > 0 && (
        <p className="muted">
          {paused} of {tasks.length} {tasks.length === 1 ? 'task is' : 'tasks are'} paused and will
          not run.
        </p>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting === null ? '' : `Delete ${deleting.name}?`}
        confirmLabel="Delete task"
        danger
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
      >
        {deleting !== null && (
          <>
            <p>
              <strong>{deleting.name}</strong> stops running: no further occurrence is scheduled,
              and its run history is removed with it.
            </p>
            <p>
              The sessions its past runs created are left alone, together with their branches and
              pull requests. Pause it instead if you only want it to stop for a while.
            </p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}

function TaskRow({
  task,
  busy,
  onTogglePaused,
  onDelete,
}: {
  readonly task: RecurringTask;
  readonly busy: boolean;
  readonly onTogglePaused: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <tr>
      <td className="table__cell--lead">
        <div className="cell-stack">
          <span className="cell-stack__title">
            <strong>{task.name}</strong>
            {task.paused ? (
              <Badge tone="wait" title="Paused: no occurrence is scheduled">
                paused
              </Badge>
            ) : (
              task.runCodeReview && <Badge tone="review">reviewed</Badge>
            )}
          </span>
          <span className="cell-stack__meta" title={task.prompt}>
            {task.repositoryName} · {summarise(task.prompt)}
          </span>
        </div>
      </td>
      <td data-label="Schedule">
        <div className="cell-stack">
          <span>{task.scheduleDescription ?? 'unreadable schedule'}</span>
          <span className="cell-stack__meta mono">{task.cronExpression}</span>
        </div>
      </td>
      <td className="table__time" data-label="Next run">
        {task.paused ? (
          // A paused task has no next occurrence at all: the server clears
          // `nextRunAt` when it is paused, so there is nothing to count down to.
          <span className="muted">paused — resume to schedule it</span>
        ) : task.nextRunAt === null ? (
          <span className="muted">not scheduled</span>
        ) : (
          <div className="cell-stack">
            <span title={task.nextRunAt}>next run {nextRunIn(task.nextRunAt)}</span>
            <span className="cell-stack__meta">{localTime(task.nextRunAt)}</span>
          </div>
        )}
      </td>
      <td data-label="Last run">
        {task.lastOutcome === null ? (
          <span className="muted">never run</span>
        ) : (
          <Badge tone={RECURRING_OUTCOME_TONE[task.lastOutcome]} pulse={task.lastOutcome === 'started'}>
            {task.lastOutcomeLabel ?? task.lastOutcome}
          </Badge>
        )}
      </td>
      <td className="table__actions table__cell--foot">
        <div className="row__actions">
          <button type="button" className="button button--small" onClick={onTogglePaused} disabled={busy}>
            <Icon name={task.paused ? 'play' : 'pause'} />
            {busy ? 'Working…' : task.paused ? 'Resume' : 'Pause'}
          </button>
          <Link
            className="button button--small button--quiet button--icon"
            href={`/recurring-tasks/${encodeURIComponent(task.id)}/edit`}
            aria-label={`Edit ${task.name}`}
            title="Edit"
          >
            <Icon name="pencil" />
          </Link>
          <button
            type="button"
            className="button button--small button--quiet button--danger button--icon"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${task.name}`}
            title="Delete"
          >
            <Icon name="trash" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** The first line of a prompt, short enough to sit under the task's name. */
function summarise(prompt: string): string {
  const [first = ''] = prompt.split('\n');
  const line = first.trim();
  return line.length > PROMPT_SUMMARY_LENGTH ? `${line.slice(0, PROMPT_SUMMARY_LENGTH - 1)}…` : line;
}
