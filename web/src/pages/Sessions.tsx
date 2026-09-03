import { useEffect, useRef, useState } from 'react';

import {
  deleteSession,
  failureStageLabel,
  leaveQueue,
  retrySession,
  retrySessionSetup,
  type Session,
  sessionPath,
} from '../api.ts';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { describeError, isActive, needsAttention, useAppData, useKeyChords } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { Link, navigate, replaceSearch, useLocation } from '../router.tsx';
import { since, startsIn } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { EmptyState, Kbd, PageHeader, Progress, Segmented, Skeleton, StatusBadge, StatusDot } from '../ui.tsx';

type Filter = 'all' | 'active' | 'attention' | 'planning' | 'ready' | 'finished';

const FILTERS: readonly { value: Filter; label: string; test: (s: Session) => boolean }[] = [
  { value: 'all', label: 'All', test: () => true },
  { value: 'active', label: 'Active', test: isActive },
  { value: 'attention', label: 'Needs you', test: needsAttention },
  { value: 'planning', label: 'Planning', test: (s) => s.status === 'pending' },
  { value: 'ready', label: 'Ready', test: (s) => s.status === 'ready' && s.queuePosition === null },
  { value: 'finished', label: 'Finished', test: (s) => s.status === 'finished' },
];

function isFilter(value: string | null): value is Filter {
  return FILTERS.some((filter) => filter.value === value);
}

/**
 * Every session, as a table. Filters live in the URL, so a bookmarked
 * `/sessions?filter=attention` is a to-do list and the sidebar's counts link
 * to exactly what they count.
 */
export function Sessions() {
  const { sessions, repositories, error, refresh } = useAppData();
  const { search } = useLocation();
  const toast = useToast();
  const params = new URLSearchParams(search);
  const filter: Filter = isFilter(params.get('filter')) ? (params.get('filter') as Filter) : 'all';
  const repositoryFilter = params.get('repository') ?? '';
  const [query, setQuery] = useState(params.get('q') ?? '');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useKeyChords({
    n: () => navigate('/sessions/new'),
    '/': () => searchRef.current?.focus(),
  });

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(window.location.search);
    if (value === '' || (key === 'filter' && value === 'all')) next.delete(key);
    else next.set(key, value);
    replaceSearch(next);
  };

  // The search box writes to the URL a beat after typing stops.
  useEffect(() => {
    const timer = window.setTimeout(() => setParam('q', query.trim()), 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [query]);

  const act = (session: Session, label: string, action: () => Promise<string>): void => {
    setBusyId(session.id);
    action()
      .then(async (message) => {
        await refresh();
        toast.ok(message);
      })
      .catch((cause: unknown) => toast.error(`${label}: ${describeError(cause)}`))
      .finally(() => setBusyId(null));
  };

  const onRetry = (session: Session): void =>
    act(session, 'Retry', async () => {
      const result = await retrySession(session.id);
      if (!result.ok) throw new Error(result.message);
      return result.message;
    });

  const onRetrySetup = (session: Session): void =>
    act(session, 'Retry setup', async () => {
      const result = await retrySessionSetup(session.id);
      if (!result.setup.ok) throw new Error(result.setup.message);
      return `${session.name} is cloned and ready to plan.`;
    });

  const onLeaveQueue = (session: Session): void =>
    act(session, 'Leave queue', async () => {
      await leaveQueue(session.id);
      return `${session.name} left the build queue and is ready again.`;
    });

  const onDelete = (): void => {
    if (deleting === null) return;
    const session = deleting;
    setDeleting(null);
    act(session, 'Delete', async () => {
      await deleteSession(session.id);
      return `Deleted ${session.name}. Nothing on the remote changed.`;
    });
  };

  const all = sessions ?? [];
  const active = FILTERS.find((candidate) => candidate.value === filter) ?? FILTERS[0]!;
  const needle = query.trim().toLowerCase();
  const visible = all.filter(
    (session) =>
      active.test(session) &&
      (repositoryFilter === '' || session.repositoryId === repositoryFilter) &&
      (needle === '' ||
        session.name.toLowerCase().includes(needle) ||
        session.repositoryName.toLowerCase().includes(needle) ||
        session.featureBranch.toLowerCase().includes(needle)),
  );
  const usable = (repositories ?? []).filter((repository) => repository.keyConfigured);
  const used = new Map<string, string>();
  for (const session of all) used.set(session.repositoryId, session.repositoryName);

  return (
    <div className="page">
      <PageHeader
        title="Sessions"
        subtitle="One feature per session: its own container, clone and branch."
        actions={
          <Link
            className="button button--primary"
            href="/sessions/new"
            aria-disabled={repositories !== null && usable.length === 0}
            title="n"
          >
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

      {repositories !== null && usable.length === 0 && (
        <div className="notice notice--info">
          <Icon name="info" />
          <div className="notice__body">
            Sessions need a repository with a deploy key.{' '}
            <Link className="link" href="/repositories">
              Add one
            </Link>{' '}
            first.
          </div>
        </div>
      )}

      <div className="toolbar">
        <Segmented
          ariaLabel="Filter sessions"
          value={filter}
          onChange={(value) => setParam('filter', value)}
          options={FILTERS.map((candidate) => ({
            value: candidate.value,
            label: candidate.label,
            count: candidate.value === 'all' ? undefined : all.filter(candidate.test).length,
          }))}
        />
        <div className="toolbar__spacer" />
        {used.size > 1 && (
          <select
            className="field__input field__input--inline"
            value={repositoryFilter}
            onChange={(event) => setParam('repository', event.target.value)}
            aria-label="Repository"
          >
            <option value="">All repositories</option>
            {[...used].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <label className="search">
          <Icon name="search" />
          <input
            ref={searchRef}
            className="search__input"
            type="search"
            placeholder="Filter by name or branch"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter sessions by name"
          />
          <Kbd>/</Kbd>
        </label>
      </div>

      {sessions === null ? (
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={4} />
          </div>
        </div>
      ) : all.length === 0 ? (
        <EmptyState
          icon="rocket"
          title="No sessions yet"
          action={
            usable.length > 0 && (
              <Link className="button button--primary" href="/sessions/new">
                <Icon name="plus" />
                Create the first one
              </Link>
            )
          }
        >
          A session plans a PRD with Claude, then builds it one story at a time on its own branch and
          opens a pull request.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState icon="filter" title="Nothing matches">
          No session matches this filter.{' '}
          <button
            type="button"
            className="link link--button"
            onClick={() => {
              setQuery('');
              replaceSearch(new URLSearchParams());
            }}
          >
            Clear filters
          </button>
        </EmptyState>
      ) : (
        <div className="table-wrap table-wrap--cards panel">
          <table className="table table--sessions table--cards">
            <thead>
              <tr>
                <th className="table__status">
                  <span className="visually-hidden">Status</span>
                </th>
                <th>Session</th>
                <th>Stories</th>
                <th>Branch</th>
                <th>Updated</th>
                <th className="table__actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  busy={busyId === session.id}
                  onRetry={() => onRetry(session)}
                  onRetrySetup={() => onRetrySetup(session)}
                  onLeaveQueue={() => onLeaveQueue(session)}
                  onDelete={() => setDeleting(session)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={deleting === null ? '' : `Delete ${deleting.name}?`}
        confirmLabel="Delete session"
        danger
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
      >
        {deleting !== null && <DeletionWarning session={deleting} />}
      </ConfirmDialog>
    </div>
  );
}

function SessionRow({
  session,
  busy,
  onRetry,
  onRetrySetup,
  onLeaveQueue,
  onDelete,
}: {
  readonly session: Session;
  readonly busy: boolean;
  readonly onRetry: () => void;
  readonly onRetrySetup: () => void;
  readonly onLeaveQueue: () => void;
  readonly onDelete: () => void;
}) {
  const note = rowNote(session);
  return (
    <tr className={needsAttention(session) ? 'table__row--attention' : undefined}>
      <td className="table__status table__cell--desktop">
        <StatusDot status={session.status} />
      </td>
      <td className="table__cell--lead">
        <div className="cell-stack">
          <span className="cell-stack__title">
            <Link className="link link--strong" href={sessionPath(session.id)}>
              {session.name}
            </Link>
            <StatusBadge session={session} />
            {session.queuePosition !== null && <span className="badge badge--wait">queued #{session.queuePosition}</span>}
          </span>
          <span className="cell-stack__meta">
            {session.repositoryName}
            {note !== null && (
              <>
                {' · '}
                <span className={session.status === 'failed' || session.scheduleMissed ? 'text-danger' : undefined}>{note}</span>
              </>
            )}
          </span>
        </div>
      </td>
      <td className="table__progress" data-label="Stories">
        <Progress
          done={session.stories.done}
          total={session.stories.total}
          tone={session.status === 'finished' ? 'final' : session.status === 'failed' ? 'danger' : session.status === 'waiting' ? 'wait' : 'active'}
          compact
        />
      </td>
      <td className="mono table__branch" data-label="Branch" title={`${session.featureBranch} → ${session.prTargetBranch}`}>
        {session.featureBranch}
        <span className="muted"> → {session.prTargetBranch}</span>
      </td>
      <td className="table__time" data-label="Updated" title={session.updatedAt}>
        {since(session.updatedAt)}
      </td>
      <td className="table__actions table__cell--foot">
        <div className="row__actions">
          {session.prUrl !== null && (
            <a className="button button--small button--quiet" href={session.prUrl} target="_blank" rel="noreferrer" title="Open the pull request on GitHub">
              PR
              <Icon name="link-external" />
            </a>
          )}
          {session.status === 'failed' && (
            <button type="button" className="button button--small" onClick={onRetry} disabled={busy}>
              <Icon name="sync" />
              {busy ? 'Working…' : 'Retry'}
            </button>
          )}
          {session.status === 'pending' && !session.cloned && (
            <button type="button" className="button button--small" onClick={onRetrySetup} disabled={busy}>
              <Icon name="sync" />
              {busy ? 'Working…' : 'Retry setup'}
            </button>
          )}
          {session.queuePosition !== null && (
            <button type="button" className="button button--small button--quiet" onClick={onLeaveQueue} disabled={busy}>
              Leave queue
            </button>
          )}
          <Link className="button button--small button--quiet" href={sessionPath(session.id)}>
            {session.status === 'pending' ? 'Plan' : 'Open'}
            <Icon name="chevron-right" />
          </Link>
          <button
            type="button"
            className="button button--small button--quiet button--danger button--icon"
            onClick={onDelete}
            disabled={busy}
            aria-label={`Delete ${session.name}`}
            title="Delete"
          >
            <Icon name="trash" />
          </button>
        </div>
      </td>
    </tr>
  );
}

/** The one thing worth saying under the name, if anything. */
function rowNote(session: Session): string | null {
  if (session.status === 'failed') {
    return session.failureStage === null ? 'failed' : `failed at ${failureStageLabel(session.failureStage)}`;
  }
  if (session.status === 'waiting') {
    return session.waitingUntil === null ? 'held by usage limit' : `held · resumes ${startsIn(session.waitingUntil).replace('starts ', '')}`;
  }
  if (session.scheduleMissed) return 'missed its scheduled start';
  if (session.scheduledStartAt !== null) return startsIn(session.scheduledStartAt);
  if (session.status === 'pending' && !session.cloned) return 'clone did not finish';
  if (session.status === 'building') return 'building';
  return null;
}

/**
 * What the confirmation has to say before anything is removed: exactly what
 * goes, exactly what stays, and — for a running build — that the agent is
 * stopped first.
 */
export function DeletionWarning({ session }: { readonly session: Session }) {
  return (
    <>
      <p>
        Its container and its workspace on this server are removed: the clone, the PRD and everything
        the agent has written that is not committed.
      </p>
      <p>
        The remote branch <code className="mono">{session.featureBranch}</code>
        {session.prUrl === null ? '' : ' and its pull request'} are left untouched.
      </p>
      {session.status === 'building' && (
        <p>
          <strong>This session is building.</strong> The loop is stopped and its agent ended gracefully
          first, which can take a moment.
        </p>
      )}
      {session.status === 'waiting' && (
        <p>
          <strong>This session is mid-build,</strong> waiting on Claude’s usage limit. Deleting it is
          deleting a build in progress: it will not resume when the limit lifts.
        </p>
      )}
    </>
  );
}
