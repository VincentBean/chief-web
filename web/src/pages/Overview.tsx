import { useState } from 'react';

import {
  failureStageLabel,
  retrySession,
  type Session,
  sessionPath,
  type Stats,
} from '../api.ts';
import { describeError, isActive, isEnded, needsAttention, useAppData } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link } from '../router.tsx';
import { localTime, since, startsIn } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import {
  Badge,
  Bars,
  EmptyState,
  Figure,
  Meter,
  PageHeader,
  Panel,
  Progress,
  Skeleton,
  StatusBadge,
  StatusDot,
} from '../ui.tsx';

/**
 * The home page: what needs the operator, what is running, and what the
 * server has shipped lately. Every number comes from the shared poll, so the
 * page is never more than a few seconds behind the loop.
 */
export function Overview() {
  const { sessions, repositories, stats, claude, error, refresh } = useAppData();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);

  const onRetry = (session: Session): void => {
    setBusyId(session.id);
    retrySession(session.id)
      .then(async (result) => {
        await refresh();
        toast.push(result.ok ? 'ok' : 'error', result.message);
      })
      .catch((cause: unknown) => toast.error(describeError(cause)))
      .finally(() => setBusyId(null));
  };

  const all = sessions ?? [];
  const attention = all.filter(needsAttention);
  const running = all.filter(isActive).sort((a, b) => {
    const rank = (s: Session): number => (s.status === 'building' ? 0 : s.status === 'waiting' ? 1 : 2);
    return rank(a) - rank(b) || (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
  });
  const upcoming = all
    .filter((s) => s.scheduledStartAt !== null && !s.scheduleMissed && (s.status === 'pending' || s.status === 'ready'))
    .sort((a, b) => (a.scheduledStartAt ?? '').localeCompare(b.scheduledStartAt ?? ''));
  // Every session whose build is over, including the delivered ones: what
  // this panel answers is "what shipped lately", not "what has no PR".
  const finished = all
    .filter(isEnded)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);

  const setup = {
    claude: claude?.status.authenticated === true,
    repository: (repositories ?? []).some((r) => r.keyConfigured),
    session: all.length > 0,
  };
  const needsSetup = claude !== null && repositories !== null && !(setup.claude && setup.repository && setup.session);

  return (
    <div className="page">
      <PageHeader
        title="Overview"
        subtitle={
          stats === null
            ? 'Reading the server…'
            : `${String(stats.builds.active)} of ${String(stats.builds.max)} build slots in use` +
              (stats.builds.queued > 0 ? ` · ${String(stats.builds.queued)} queued` : '') +
              ` · ${String(all.length)} ${all.length === 1 ? 'session' : 'sessions'}`
        }
        actions={
          <Link className="button button--primary" href="/sessions/new">
            <Icon name="plus" />
            New session
          </Link>
        }
      />

      {error !== null && (
        <div className="notice notice--error" role="alert">
          <Icon name="x-circle" />
          <div className="notice__body">Could not read sessions: {error}</div>
        </div>
      )}

      {needsSetup && <SetupChecklist {...setup} />}

      {attention.length > 0 && (
        <Panel
          title="Needs you"
          icon="alert"
          tone="danger"
          meta={<Badge tone="danger">{attention.length}</Badge>}
        >
          <ul className="rows">
            {attention.map((session) => (
              <li className="row" key={session.id}>
                <StatusDot status={session.status} />
                <div className="row__main">
                  <Link className="row__title" href={sessionPath(session.id)}>
                    {session.name}
                  </Link>
                  <span className="row__meta">
                    {session.repositoryName} · {attentionReason(session)}
                  </span>
                </div>
                <div className="row__actions">
                  {session.status === 'failed' && (
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() => onRetry(session)}
                      disabled={busyId === session.id}
                    >
                      <Icon name="sync" />
                      {busyId === session.id ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                  <Link className="button button--small button--quiet" href={sessionPath(session.id)}>
                    Open
                    <Icon name="chevron-right" />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid grid--main-aside">
        <Panel
          title="Right now"
          icon="pulse"
          meta={
            stats !== null && (
              <span className="panel__meta">
                <Meter value={stats.builds.active} max={stats.builds.max} label="Build slots" />
                <span className="mono">
                  {stats.builds.active}/{stats.builds.max}
                </span>
              </span>
            )
          }
          actions={
            <Link className="link" href="/sessions?filter=active">
              All active
            </Link>
          }
        >
          {sessions === null ? (
            <Skeleton lines={3} />
          ) : running.length === 0 ? (
            <EmptyState icon="zap" title="Nothing is building">
              {all.some((s) => s.status === 'ready')
                ? 'A ready session is waiting for you to start it.'
                : 'Plan a PRD in a session and start the build; it appears here while it runs.'}
            </EmptyState>
          ) : (
            <ul className="rows">
              {running.map((session) => (
                <li className="row" key={session.id}>
                  <StatusDot status={session.status} />
                  <div className="row__main">
                    <Link className="row__title" href={sessionPath(session.id)}>
                      {session.name}
                    </Link>
                    <span className="row__meta">
                      {session.repositoryName}
                      {session.queuePosition !== null && ` · queued #${String(session.queuePosition)}`}
                      {session.status === 'waiting' &&
                        session.waitingUntil !== null &&
                        ` · resumes ${startsIn(session.waitingUntil).replace('starts ', '')}`}
                    </span>
                  </div>
                  <div className="row__progress">
                    <Progress
                      done={session.stories.done}
                      total={session.stories.total}
                      tone={session.status === 'waiting' ? 'wait' : 'active'}
                      compact
                    />
                  </div>
                  <StatusBadge session={session} />
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Up next" icon="calendar">
          {sessions === null ? (
            <Skeleton lines={2} />
          ) : upcoming.length === 0 ? (
            <p className="muted">No scheduled starts. Set one on a session to build it while you are away.</p>
          ) : (
            <ul className="rows rows--tight">
              {upcoming.slice(0, 5).map((session) => (
                <li className="row" key={session.id}>
                  <div className="row__main">
                    <Link className="row__title" href={sessionPath(session.id)}>
                      {session.name}
                    </Link>
                    <span className="row__meta">
                      {localTime(session.scheduledStartAt ?? '')} · {startsIn(session.scheduledStartAt ?? '')}
                    </span>
                  </div>
                  <StatusBadge session={session} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Activity stats={stats} />

      <div className="grid grid--halves">
        <Panel title="Repositories" icon="repo" actions={<Link className="link" href="/repositories">Manage</Link>}>
          {stats === null ? (
            <Skeleton lines={3} />
          ) : stats.repositories.length === 0 ? (
            <EmptyState icon="repo" title="No repositories yet" action={<Link className="button" href="/repositories">Add a repository</Link>} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="num">Sessions</th>
                    <th className="num">Active</th>
                    <th>Stories</th>
                    <th className="num">Shipped</th>
                    <th className="num">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.repositories.map((repo) => (
                    <tr key={repo.repositoryId}>
                      <td>
                        <Link className="link link--strong" href={`/sessions?repository=${encodeURIComponent(repo.repositoryId)}`}>
                          {repo.name}
                        </Link>
                      </td>
                      <td className="num">{repo.sessions}</td>
                      <td className="num">{repo.active === 0 ? <span className="muted">—</span> : repo.active}</td>
                      <td>
                        <Progress done={repo.storiesDone} total={repo.storiesTotal} tone="done" compact />
                      </td>
                      <td className="num">{repo.finished}</td>
                      <td className="num">{repo.failed === 0 ? <span className="muted">—</span> : <span className="text-danger">{repo.failed}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Recently finished" icon="check-circle" actions={<Link className="link" href="/sessions?filter=finished">All finished</Link>}>
          {sessions === null ? (
            <Skeleton lines={3} />
          ) : finished.length === 0 ? (
            <p className="muted">Nothing has finished yet. A finished session has every story committed and, unless delivery was skipped, a pull request.</p>
          ) : (
            <ul className="rows rows--tight">
              {finished.map((session) => (
                <li className="row" key={session.id}>
                  <StatusDot status={session.status} />
                  <div className="row__main">
                    <Link className="row__title" href={sessionPath(session.id)}>
                      {session.name}
                    </Link>
                    <span className="row__meta">
                      {session.repositoryName} · {session.stories.done} {session.stories.done === 1 ? 'story' : 'stories'} · {since(session.updatedAt)}
                    </span>
                  </div>
                  {session.prUrl !== null && (
                    <a className="button button--small button--quiet" href={session.prUrl} target="_blank" rel="noreferrer">
                      PR
                      <Icon name="link-external" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function attentionReason(session: Session): string {
  if (session.status === 'failed') {
    return session.failureStage === null ? 'failed' : `failed at ${failureStageLabel(session.failureStage)}`;
  }
  if (session.status === 'waiting') {
    return session.waitingUntil === null
      ? 'held by Claude’s usage limit'
      : `held by Claude’s usage limit · resumes ${startsIn(session.waitingUntil).replace('starts ', '')}`;
  }
  if (session.scheduleMissed) return 'missed its scheduled start — mark it ready to build now';
  return '';
}

/** The last two weeks, as numbers and bars. */
function Activity({ stats }: { readonly stats: Stats | null }) {
  if (stats === null) {
    return (
      <div className="figures">
        <Skeleton lines={2} />
      </div>
    );
  }
  const days = stats.activity;
  const labels = days.map((d) => d.day);
  const sum = (pick: (day: Stats['activity'][number]) => number): number =>
    days.reduce((total, day) => total + pick(day), 0);
  const storiesFortnight = sum((d) => d.storiesDone);
  const finishedFortnight = sum((d) => d.sessionsFinished);
  const createdFortnight = sum((d) => d.sessionsCreated);
  // A session that ended counts as finished however it ended; `pr-open` and
  // `merged` are where delivered sessions live now, so leaving them out would
  // read as a collapsing finish rate rather than as a renamed state.
  const ended = stats.sessions.byStatus.finished + stats.sessions.byStatus['pr-open'] + stats.sessions.byStatus.merged;
  const outcomes = ended + stats.sessions.byStatus.failed;
  const successRate = outcomes === 0 ? null : Math.round((ended / outcomes) * 100);

  return (
    <div className="figures">
      <Figure
        label="stories shipped, 14 days"
        value={storiesFortnight}
        hint={<Bars values={days.map((d) => d.storiesDone)} labels={labels} ariaLabel="Stories done per day" />}
        tone="done"
      />
      <Figure
        label="sessions finished, 14 days"
        value={finishedFortnight}
        hint={<Bars values={days.map((d) => d.sessionsFinished)} labels={labels} ariaLabel="Sessions finished per day" />}
        tone="final"
      />
      <Figure
        label="sessions started, 14 days"
        value={createdFortnight}
        hint={<Bars values={days.map((d) => d.sessionsCreated)} labels={labels} ariaLabel="Sessions created per day" />}
        tone="active"
      />
      <Figure
        label="finish rate, all time"
        value={successRate === null ? '—' : `${String(successRate)}%`}
        hint={
          <span className="figure__note">
            {ended} finished · {stats.sessions.byStatus.failed} failed ·{' '}
            {stats.pullRequestsOpened} {stats.pullRequestsOpened === 1 ? 'PR' : 'PRs'} opened
          </span>
        }
        tone={successRate !== null && successRate < 50 ? 'danger' : undefined}
      />
    </div>
  );
}

function SetupChecklist({ claude, repository, session }: { readonly claude: boolean; readonly repository: boolean; readonly session: boolean }) {
  const steps = [
    {
      done: claude,
      title: 'Sign Claude Code in',
      body: 'A one-time browser login; the credentials are shared by every session.',
      href: '/settings#claude',
      action: 'Open settings',
    },
    {
      done: repository,
      title: 'Add a repository with a deploy key',
      body: 'chief-web generates the key; paste the public half into GitHub with write access.',
      href: '/repositories',
      action: 'Add repository',
    },
    {
      done: session,
      title: 'Create your first session',
      body: 'Plan a PRD with Claude in the browser, mark it ready, and start the build.',
      href: '/sessions/new',
      action: 'New session',
    },
  ];
  const remaining = steps.filter((step) => !step.done).length;
  return (
    <Panel title="Get set up" icon="tasklist" meta={<Badge tone="wait">{remaining} to go</Badge>}>
      <ol className="steps">
        {steps.map((step, index) => (
          <li className={`step${step.done ? ' step--done' : ''}`} key={step.title}>
            <span className="step__marker">{step.done ? <Icon name="check" /> : index + 1}</span>
            <div className="step__main">
              <span className="step__title">{step.title}</span>
              <span className="step__body">{step.body}</span>
            </div>
            {!step.done && (
              <Link className="button button--small" href={step.href}>
                {step.action}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
