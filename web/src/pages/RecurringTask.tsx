import { useCallback, useEffect, useState } from 'react';

import {
  fetchRecurringTaskDetail,
  RECURRING_TASK_HISTORY_LIMIT,
  type RecurringTaskDetail,
  type RecurringTaskOccurrence,
  sessionPath,
} from '../api.ts';
import { DASHBOARD_POLL_MS, describeError, redirectIfUnauthorised } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link, recurringTaskIdFromPath, useLocation } from '../router.tsx';
import { localTime, nextRunIn } from '../schedule.ts';
import {
  Badge,
  EmptyState,
  Facts,
  Notice,
  PageHeader,
  Panel,
  RECURRING_OUTCOME_TONE,
  Skeleton,
  StatusBadge,
} from '../ui.tsx';

/**
 * One recurring task: what it is set to do, and what every occurrence of it so
 * far actually did (US-009).
 *
 * The history is the point of the page. A task that runs unattended every
 * night is only trustworthy if the nights it produced nothing, skipped itself
 * or failed to start are as visible as the nights it opened a pull request —
 * so every occurrence gets a row, including the skips, which have no session
 * to click through to at all.
 *
 * Only the newest `RECURRING_TASK_HISTORY_LIMIT` of them, though: a task that
 * fires every quarter of an hour has tens of thousands of rows within the year,
 * and this page re-reads its history every few seconds. The panel says so when
 * it is full, so a window of the history is never mistaken for all of it.
 *
 * Polled on the dashboard's cadence for the same reason the list is: a run
 * that is `running` when the page opens settles without anybody touching this
 * tab, and the next occurrence counts down while it is on screen.
 */
export function RecurringTask() {
  const { pathname } = useLocation();
  const id = recurringTaskIdFromPath(pathname);
  const [task, setTask] = useState<RecurringTaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    (abort?: AbortSignal): void => {
      if (id === null) return;
      fetchRecurringTaskDetail(id, abort)
        .then((loaded) => {
          setTask(loaded);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          if (abort?.aborted === true) return;
          if (redirectIfUnauthorised(error)) return;
          setLoadError(describeError(error));
        });
    },
    [id],
  );

  useEffect(() => {
    if (id === null) {
      setLoadError('That is not a recurring task URL.');
      return;
    }
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
  }, [id, load]);

  if (loadError !== null && task === null) {
    return (
      <div className="page">
        <PageHeader title="Recurring task" back={{ href: '/recurring-tasks', label: 'Recurring tasks' }} />
        <Notice kind="error">Could not read this recurring task: {loadError}</Notice>
      </div>
    );
  }

  if (task === null) {
    return (
      <div className="page">
        <PageHeader title="Recurring task" back={{ href: '/recurring-tasks', label: 'Recurring tasks' }} />
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={5} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        back={{ href: '/recurring-tasks', label: 'Recurring tasks' }}
        eyebrow={task.repositoryName}
        title={
          <>
            {task.name}
            {task.paused && (
              <>
                {' '}
                <Badge tone="wait" title="Paused: no occurrence is scheduled">
                  paused
                </Badge>
              </>
            )}
          </>
        }
        subtitle={task.scheduleDescription ?? 'unreadable schedule'}
        actions={
          <Link
            className="button button--primary"
            href={`/recurring-tasks/${encodeURIComponent(task.id)}/edit`}
          >
            <Icon name="pencil" />
            Edit
          </Link>
        }
      />

      {loadError !== null && <Notice kind="warn">Could not refresh: {loadError}</Notice>}

      <div className="grid grid--main-aside">
        <Panel
          title="Run history"
          icon="history"
          meta={
            <span className="panel__meta">
              {task.occurrences.length < RECURRING_TASK_HISTORY_LIMIT
                ? task.occurrences.length
                : `newest ${String(RECURRING_TASK_HISTORY_LIMIT)}`}
            </span>
          }
        >
          {task.occurrences.length === 0 ? (
            <EmptyState icon="clock" title="No runs yet">
              {task.paused
                ? 'This task is paused, so no occurrence is scheduled. Resume it to give it a next run.'
                : task.nextRunAt === null
                  ? 'No occurrence is scheduled.'
                  : `The first run is due ${nextRunIn(task.nextRunAt)}.`}
            </EmptyState>
          ) : (
            <div className="table-wrap table-wrap--cards">
              <table className="table table--cards">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Outcome</th>
                    <th>Run</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {task.occurrences.map((occurrence) => (
                    <OccurrenceRow key={occurrence.id} occurrence={occurrence} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="stack">
          <Panel title="Definition" icon="list" className="panel--aside">
            <Facts
              items={[
                { label: 'Repository', value: task.repositoryName },
                { label: 'Schedule', value: task.cronExpression, mono: true },
                {
                  label: 'Next run',
                  value: task.paused ? (
                    <span className="muted">paused — resume to schedule it</span>
                  ) : task.nextRunAt === null ? (
                    <span className="muted">not scheduled</span>
                  ) : (
                    <span title={task.nextRunAt}>
                      {nextRunIn(task.nextRunAt)} · {localTime(task.nextRunAt)}
                    </span>
                  ),
                },
                { label: 'Base branch', value: task.baseBranch, mono: true },
                { label: 'Pull request into', value: task.prTarget, mono: true },
                { label: 'Code review', value: task.runCodeReview ? 'on every run' : 'off' },
                { label: 'Created', value: localTime(task.createdAt) },
              ]}
            />
          </Panel>

          <Panel title="Prompt" icon="comment" className="panel--aside">
            <pre className="output output--wrap">{task.prompt}</pre>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function OccurrenceRow({ occurrence }: { readonly occurrence: RecurringTaskOccurrence }) {
  const { session } = occurrence;
  // `pr-opened` stores the pull request's URL as its detail, so the link is
  // read from the run when there is one and from the detail when the session
  // has since been deleted. Either way it is not repeated as prose below.
  const prUrl =
    occurrence.outcome === 'pr-opened'
      ? (session?.prUrl ?? (isHttpUrl(occurrence.detail) ? occurrence.detail : null))
      : null;
  const detail = occurrence.detail === prUrl ? null : occurrence.detail;

  return (
    <tr>
      <td className="table__time" data-label="When">
        <span title={occurrence.occurredAt}>{localTime(occurrence.occurredAt)}</span>
      </td>
      <td data-label="Outcome">
        {prUrl === null ? (
          <Badge
            tone={RECURRING_OUTCOME_TONE[occurrence.outcome]}
            pulse={occurrence.outcome === 'started'}
          >
            {occurrence.outcomeLabel}
          </Badge>
        ) : (
          <a
            className="badge-link"
            href={prUrl}
            target="_blank"
            rel="noreferrer"
            title="Open the pull request on GitHub"
          >
            <Badge tone={RECURRING_OUTCOME_TONE[occurrence.outcome]}>
              {occurrence.outcomeLabel}
              <Icon name="link-external" />
            </Badge>
          </a>
        )}
      </td>
      <td data-label="Run">
        {session === null ? (
          // A skip and a failure to fire never made a session, and a run whose
          // session was deleted has none left; the occurrence still counts.
          <span className="muted">no session</span>
        ) : (
          <div className="cell-stack">
            <Link className="link link--strong" href={sessionPath(session.id)}>
              {session.name}
            </Link>
            <span className="cell-stack__meta">
              <StatusBadge session={session} />
            </span>
          </div>
        )}
      </td>
      <td data-label="Detail">
        {detail === null || detail === '' ? (
          <span className="muted">—</span>
        ) : (
          <span className="text-muted">{detail}</span>
        )}
      </td>
    </tr>
  );
}

/** Whether a stored detail is something a browser can be sent to. */
function isHttpUrl(value: string | null): value is string {
  return value !== null && /^https?:\/\//i.test(value);
}
