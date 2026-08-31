import { type FormEvent, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  type ClaudeState,
  createSession,
  deleteSession,
  failureStageLabel,
  featureBranchFor,
  fetchClaudeState,
  fetchRepositories,
  fetchSessions,
  leaveQueue,
  logout,
  type PrTargetBranch,
  type Repository,
  retrySession,
  retrySessionSetup,
  type Session,
  type SessionInput,
  type SessionSetup,
  sessionPath,
} from './api.ts';
import { localTime, startsIn } from './schedule.ts';
import { SESSION_BADGE } from './status.ts';

type Notice = { kind: 'ok' | 'error'; text: string };

/** Session names become branch names and directories, so keep them to a slug. */
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * How often the list is re-read. Sessions are moved along by agents in other
 * processes, so the only way this page can show a status change is to keep
 * looking; US-015 asks for that to happen within five seconds.
 */
const POLL_MS = 3000;

/**
 * The filter's options, in the order a session moves through them. `waiting`
 * sits next to `building` because that is what it is: a build in progress that
 * is holding its slot until Claude's usage limit lifts (US-009), not an idle
 * session someone forgot about.
 */
const STATUSES: Session['status'][] = [
  'pending',
  'ready',
  'building',
  'waiting',
  'failed',
  'finished',
];

/** Filter values: a status, a repository id, or "everything". */
const ALL = 'all';

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : String(error);

/**
 * The dashboard (US-015): every session at a glance, and the home page.
 *
 * The list is polled rather than pushed. A session's state is changed by the
 * build loop, the planning terminal and the delivery step — all of them in
 * other processes, none of them able to reach this tab — and the whole list is
 * a handful of database rows plus a `stat` per session, so re-reading it every
 * three seconds is cheaper than a socket per browser would be.
 *
 * Creating a session lives here too, so the page an operator lands on is the
 * one they work from.
 */
export function Dashboard() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [claude, setClaude] = useState<ClaudeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(ALL);
  const [repositoryFilter, setRepositoryFilter] = useState<string>(ALL);
  /** The last setup outcome per session, so git's output stays on screen. */
  const [setups, setSetups] = useState<Record<string, SessionSetup>>({});
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();

    const load = (): void => {
      Promise.all([
        fetchSessions(controller.signal),
        fetchRepositories(controller.signal),
      ])
        .then(([loadedSessions, loadedRepositories]) => {
          setSessions(loadedSessions);
          setRepositories(loadedRepositories);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof ApiError && error.status === 401) {
            window.location.replace('/login');
            return;
          }
          setLoadError(describe(error));
        });
    };

    load();
    pollRef.current = window.setInterval(load, POLL_MS);

    // Sessions need a signed-in Claude Code (US-008); saying so here beats
    // finding out when the first session refuses to be created. It is checked
    // once — a probe costs a container start, so it is not polled.
    fetchClaudeState({ signal: controller.signal })
      .then(setClaude)
      .catch(() => {
        // The settings page reports why; the dashboard stays quiet.
      });

    return () => {
      controller.abort();
      window.clearInterval(pollRef.current);
    };
  }, []);

  const reload = async (): Promise<void> => {
    setSessions(await fetchSessions());
  };

  const onCreate = (input: SessionInput): void => {
    setSaving(true);
    setNotice(null);
    createSession(input)
      .then(async (result) => {
        await reload();
        setAdding(false);
        setSetups((current) => ({ ...current, [result.session.id]: result.setup }));
        setNotice(
          result.setup.ok
            ? {
                kind: 'ok',
                text: `Created ${result.session.name} on ${result.session.featureBranch}.`,
              }
            : { kind: 'error', text: result.setup.message },
        );
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setSaving(false));
  };

  const onRetry = (session: Session): void => {
    setBusyId(session.id);
    setNotice(null);
    retrySessionSetup(session.id)
      .then(async (result) => {
        await reload();
        setSetups((current) => ({ ...current, [session.id]: result.setup }));
        setNotice(
          result.setup.ok
            ? { kind: 'ok', text: `${session.name} is ready on ${result.session.featureBranch}.` }
            : { kind: 'error', text: result.setup.message },
        );
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusyId(null));
  };

  /**
   * "Retry" on a failed session (US-019). The server picks the resumption
   * point from the stage it failed at, so the dashboard can offer the action
   * without knowing anything about what went wrong.
   */
  const onRetryFailed = (session: Session): void => {
    setBusyId(session.id);
    setNotice(null);
    retrySession(session.id)
      .then(async (result) => {
        await reload();
        setNotice({ kind: result.ok ? 'ok' : 'error', text: result.message });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusyId(null));
  };

  const onLeaveQueue = (session: Session): void => {
    setBusyId(session.id);
    setNotice(null);
    leaveQueue(session.id)
      .then(async () => {
        await reload();
        setNotice({
          kind: 'ok',
          text: `${session.name} left the build queue and is ready again.`,
        });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusyId(null));
  };

  const onDelete = (session: Session): void => {
    if (!window.confirm(deletionWarning(session))) return;
    setBusyId(session.id);
    setNotice(null);
    deleteSession(session.id)
      .then(async () => {
        await reload();
        setSetups(({ [session.id]: _removed, ...rest }) => rest);
        setNotice({ kind: 'ok', text: `Deleted ${session.name}. Nothing on the remote changed.` });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusyId(null));
  };

  const usable = (repositories ?? []).filter((repository) => repository.keyConfigured);
  // The server already answers most-recently-updated first, which is the
  // default order; filtering never reorders.
  const visible = (sessions ?? []).filter(
    (session) =>
      (status === ALL || session.status === status) &&
      (repositoryFilter === ALL || session.repositoryId === repositoryFilter),
  );

  return (
    <main className="shell">
      <header className="topbar">
        <h1>Sessions</h1>
        <nav className="topbar__nav">
          <a className="link" href="/pull-requests">
            Pull requests
          </a>
          <a className="link" href="/repositories">
            Repositories
          </a>
          <a className="link" href="/terminal">
            Terminal
          </a>
          <a className="link" href="/settings">
            Settings
          </a>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              logout().finally(() => window.location.replace('/login'));
            }}
          >
            Log out
          </button>
        </nav>
      </header>

      <p className="tagline">
        A session owns one feature: its own container, its own clone of the repository, and its own{' '}
        <code className="mono">chief/&lt;name&gt;</code> branch, opened from the base branch you
        choose.
      </p>

      {claude !== null && !claude.status.authenticated && (
        <p className="notice notice--error" role="alert">
          Claude Code is not authenticated, so sessions cannot be created. Open{' '}
          <a className="link" href="/settings">
            Settings
          </a>{' '}
          and use “Set up Claude”.
        </p>
      )}

      {loadError !== null && (
        <p className="notice notice--error" role="alert">
          Could not load sessions: {loadError}
        </p>
      )}

      {notice !== null && (
        <p className={`notice notice--${notice.kind}`} role="alert">
          {notice.text}
        </p>
      )}

      {adding ? (
        <SessionForm
          repositories={usable}
          existing={sessions ?? []}
          busy={saving}
          onSubmit={onCreate}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="field__actions field__actions--spaced">
          <button
            type="button"
            className="button button--primary"
            onClick={() => setAdding(true)}
            disabled={repositories === null || usable.length === 0}
          >
            New session
          </button>
          {repositories !== null && usable.length === 0 && (
            <span className="field__hint">
              Add a repository with an SSH key first on the{' '}
              <a className="link" href="/repositories">
                repositories page
              </a>
              .
            </span>
          )}
        </div>
      )}

      {sessions !== null && sessions.length > 0 && (
        <Filters
          repositories={repositories ?? []}
          sessions={sessions}
          status={status}
          repositoryId={repositoryFilter}
          onStatus={setStatus}
          onRepository={setRepositoryFilter}
        />
      )}

      {sessions === null ? (
        <p className="tagline">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="tagline">No sessions yet.</p>
      ) : visible.length === 0 ? (
        <p className="tagline">No session matches this filter.</p>
      ) : (
        <ul className="cards">
          {visible.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              busy={busyId === session.id}
              setup={setups[session.id]}
              onRetry={() => onRetry(session)}
              onRetryFailed={() => onRetryFailed(session)}
              onLeaveQueue={() => onLeaveQueue(session)}
              onDelete={() => onDelete(session)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * What the confirmation has to say before anything is removed: exactly what
 * goes, exactly what stays, and — for a running build — that the agent is
 * stopped first.
 */
function deletionWarning(session: Session): string {
  const lines = [
    `Delete the session "${session.name}"?`,
    '',
    'Its container and its workspace on this server are removed — the clone, the PRD and everything the agent has written that is not committed.',
    `The remote branch ${session.featureBranch}${session.prUrl === null ? '' : ' and its pull request'} are left untouched.`,
  ];
  if (session.status === 'building') {
    lines.push(
      '',
      'This session is building: the loop will be stopped and its agent process ended gracefully first, which can take a moment.',
    );
  }
  if (session.status === 'waiting') {
    lines.push(
      '',
      'This session is mid-build and waiting on Claude’s usage limit. Deleting it now is deleting a build in progress: it will not be resumed when the limit lifts.',
    );
  }
  return lines.join('\n');
}

interface FilterProps {
  repositories: Repository[];
  sessions: Session[];
  status: string;
  repositoryId: string;
  onStatus: (value: string) => void;
  onRepository: (value: string) => void;
}

/** Only repositories that actually have a session are worth offering. */
function Filters({
  repositories,
  sessions,
  status,
  repositoryId,
  onStatus,
  onRepository,
}: FilterProps) {
  const used = new Map<string, string>();
  for (const session of sessions) used.set(session.repositoryId, session.repositoryName);
  for (const repository of repositories) {
    if (used.has(repository.id)) used.set(repository.id, repository.name);
  }

  return (
    <div className="filters">
      <label className="filters__field" htmlFor="filter-status">
        <span className="field__label">Status</span>
        <select
          id="filter-status"
          className="field__input field__input--narrow"
          value={status}
          onChange={(event) => onStatus(event.target.value)}
        >
          <option value={ALL}>All statuses</option>
          {STATUSES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
      </label>

      <label className="filters__field" htmlFor="filter-repository">
        <span className="field__label">Repository</span>
        <select
          id="filter-repository"
          className="field__input field__input--narrow"
          value={repositoryId}
          onChange={(event) => onRepository(event.target.value)}
        >
          <option value={ALL}>All repositories</option>
          {[...used].map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <span className="field__hint">Most recently updated first.</span>
    </div>
  );
}

interface CardProps {
  session: Session;
  busy: boolean;
  setup: SessionSetup | undefined;
  onRetry: () => void;
  onRetryFailed: () => void;
  onLeaveQueue: () => void;
  onDelete: () => void;
}

function SessionCard({
  session,
  busy,
  setup,
  onRetry,
  onRetryFailed,
  onLeaveQueue,
  onDelete,
}: CardProps) {
  const deliveryFailure =
    session.failureStage === 'push' || session.failureStage === 'pull_request';
  return (
    <li className="card">
      <div className="card__header">
        <h2 className="card__title">
          <a className="link" href={sessionPath(session.id)}>
            {session.name}
          </a>{' '}
          <span className={SESSION_BADGE[session.status]}>{session.status}</span>{' '}
          {session.status === 'failed' && session.failureStage !== null && (
            <span className="badge badge--failed">{failureStageLabel(session.failureStage)}</span>
          )}{' '}
          {session.queuePosition !== null && (
            <span className="badge badge--queued">Queued (#{session.queuePosition})</span>
          )}
        </h2>
        <div className="field__actions">
          <a className="button button--quiet" href={sessionPath(session.id)}>
            {session.status === 'pending' ? 'Plan' : 'Open'}
          </a>
          {session.queuePosition !== null && (
            <button
              type="button"
              className="button button--quiet"
              onClick={onLeaveQueue}
              disabled={busy}
            >
              {busy ? 'Working…' : 'Leave queue'}
            </button>
          )}
          {session.status === 'pending' && !session.cloned && (
            <button
              type="button"
              className="button button--quiet"
              onClick={onRetry}
              disabled={busy}
            >
              {busy ? 'Working…' : 'Retry setup'}
            </button>
          )}
          {session.status === 'failed' && (
            <button
              type="button"
              className="button button--quiet"
              onClick={onRetryFailed}
              disabled={busy}
            >
              {busy ? 'Working…' : deliveryFailure ? 'Retry push & PR' : 'Retry build'}
            </button>
          )}
          <button
            type="button"
            className="button button--quiet button--danger"
            onClick={onDelete}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Delete'}
          </button>
        </div>
      </div>

      <dl className="meta">
        <dt>Repository</dt>
        <dd>{session.repositoryName}</dd>
        <dt>Stories</dt>
        <dd>
          {session.stories.total === 0
            ? 'no PRD parsed yet'
            : `${String(session.stories.done)}/${String(session.stories.total)} done`}
        </dd>
        <dt>Feature branch</dt>
        <dd className="mono">{session.featureBranch}</dd>
        <dt>Base branch</dt>
        <dd className="mono">{session.baseBranch}</dd>
        <dt>PR target</dt>
        <dd className="mono">{session.prTargetBranch}</dd>
        {session.queuePosition !== null && (
          <>
            <dt>Queue</dt>
            <dd>
              #{session.queuePosition} — starts on its own as soon as a build slot frees.
            </dd>
          </>
        )}
        {session.status === 'waiting' && session.waitingUntil !== null && (
          <>
            <dt>Resumes</dt>
            <dd>
              {localTime(session.waitingUntil)}
              <span className="story__priority">
                {' '}
                &middot; {startsIn(session.waitingUntil)}
              </span>
            </dd>
          </>
        )}
        {session.scheduledStartAt !== null && (
          <>
            <dt>Scheduled</dt>
            <dd>
              {localTime(session.scheduledStartAt)}
              <span className="story__priority">
                {' '}
                &middot;{' '}
                {session.scheduleMissed ? 'missed' : startsIn(session.scheduledStartAt)}
              </span>
            </dd>
          </>
        )}
        {session.prUrl !== null && (
          <>
            <dt>Pull request</dt>
            <dd>
              <a className="link" href={session.prUrl} target="_blank" rel="noreferrer">
                {session.prUrl}
              </a>
            </dd>
          </>
        )}
        <dt>Updated</dt>
        <dd>{localTime(session.updatedAt)}</dd>
      </dl>

      {session.scheduleMissed && (
        <p className="notice notice--error" role="status">
          Missed schedule — mark ready to start. This session was still being planned at{' '}
          {localTime(session.scheduledStartAt ?? '')}, so nothing ran.{' '}
          <a className="link" href={sessionPath(session.id)}>
            Open it
          </a>{' '}
          and mark it ready; the build then starts immediately.
        </p>
      )}
      {/* A held session is working, not broken: it holds its build slot and
          its story and carries on by itself, so the hold reads as a wait (amber)
          rather than as the failure (red) every other `lastError` is. */}
      {session.status === 'waiting' ? (
        <p className="notice notice--warn" role="status">
          Claude&rsquo;s usage limit was reached, so this build is paused rather than stopped. It
          keeps its build slot and carries on{' '}
          {session.waitingUntil === null ? 'as soon as the hold lifts' : startsIn(session.waitingUntil)}
          .{' '}
          <a className="link" href={sessionPath(session.id)}>
            Open it
          </a>{' '}
          to see the countdown, or to resume it now.
        </p>
      ) : (
        session.lastError !== null && (
          <p className="notice notice--error" role="status">
            {session.lastError}
          </p>
        )
      )}
      {setup?.stderr !== undefined && setup.stderr !== '' && (
        <pre className="output">{setup.stderr}</pre>
      )}
    </li>
  );
}

interface FormProps {
  repositories: Repository[];
  existing: Session[];
  busy: boolean;
  onSubmit: (input: SessionInput) => void;
  onCancel: () => void;
}

function SessionForm({ repositories, existing, busy, onSubmit, onCancel }: FormProps) {
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? '');
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState(repositories[0]?.defaultBaseBranch ?? 'main');
  const [prTargetBranch, setPrTargetBranch] = useState<PrTargetBranch>('main');
  /** `datetime-local` value: wall-clock time in the browser's own timezone. */
  const [scheduledStart, setScheduledStart] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onRepositoryChange = (id: string): void => {
    setRepositoryId(id);
    const repository = repositories.find((candidate) => candidate.id === id);
    // The base branch follows the repository until the user overrides it.
    if (repository !== undefined) setBaseBranch(repository.defaultBaseBranch);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);

    const trimmed = name.trim();
    if (repositoryId === '') {
      setError('Choose a repository.');
      return;
    }
    if (!SESSION_NAME_PATTERN.test(trimmed)) {
      setError('The session name may only contain letters, numbers, hyphens and underscores.');
      return;
    }
    if (
      existing.some(
        (session) => session.repositoryId === repositoryId && session.name === trimmed,
      )
    ) {
      setError('That repository already has a session with this name.');
      return;
    }

    const input: SessionInput = { repositoryId, name: trimmed, prTargetBranch };
    if (baseBranch.trim() !== '') input.baseBranch = baseBranch.trim();
    if (scheduledStart !== '') {
      // The picker is read in the visitor's timezone; the server stores UTC.
      const instant = new Date(scheduledStart);
      if (Number.isNaN(instant.getTime())) {
        setError('That scheduled start time is not a valid date.');
        return;
      }
      input.scheduledStartAt = instant.toISOString();
    }

    onSubmit(input);
  };

  return (
    <form className="form form--card" onSubmit={submit}>
      <h2 className="card__title">New session</h2>

      <section className="field">
        <label className="field__label" htmlFor="session-repository">
          Repository
        </label>
        <select
          id="session-repository"
          className="field__input"
          value={repositoryId}
          onChange={(event) => onRepositoryChange(event.target.value)}
        >
          {repositories.map((repository) => (
            <option key={repository.id} value={repository.id}>
              {repository.name} ({repository.githubSlug})
            </option>
          ))}
        </select>
      </section>

      <section className="field">
        <label className="field__label" htmlFor="session-name">
          Session name
        </label>
        <p className="field__hint">
          Letters, numbers, hyphens and underscores. The feature branch will be{' '}
          <code className="mono">{featureBranchFor(name.trim() === '' ? '<name>' : name.trim())}</code>
          .
        </p>
        <input
          id="session-name"
          className="field__input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="add-login"
          autoComplete="off"
          spellCheck={false}
        />
      </section>

      <section className="field">
        <label className="field__label" htmlFor="session-base-branch">
          Base branch
        </label>
        <p className="field__hint">The branch the feature branch is created from.</p>
        <input
          id="session-base-branch"
          className="field__input field__input--narrow"
          value={baseBranch}
          onChange={(event) => setBaseBranch(event.target.value)}
          placeholder="main"
          autoComplete="off"
          spellCheck={false}
        />
      </section>

      <section className="field">
        <label className="field__label" htmlFor="session-pr-target">
          PR target branch
        </label>
        <select
          id="session-pr-target"
          className="field__input field__input--narrow"
          value={prTargetBranch}
          onChange={(event) => setPrTargetBranch(event.target.value as PrTargetBranch)}
        >
          <option value="develop">develop</option>
          <option value="main">main</option>
        </select>
      </section>

      <section className="field">
        <label className="field__label" htmlFor="session-scheduled-start">
          Scheduled start (optional)
        </label>
        <p className="field__hint">
          Read in this browser&rsquo;s timezone and stored as UTC. Leave it empty to start the
          session by hand.
        </p>
        <input
          id="session-scheduled-start"
          className="field__input"
          type="datetime-local"
          value={scheduledStart}
          onChange={(event) => setScheduledStart(event.target.value)}
        />
      </section>

      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      <div className="field__actions">
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Creating and cloning…' : 'Create session'}
        </button>
        <button type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
