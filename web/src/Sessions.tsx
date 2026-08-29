import { type FormEvent, useEffect, useState } from 'react';

import {
  ApiError,
  createSession,
  featureBranchFor,
  fetchRepositories,
  fetchSessions,
  type PrTargetBranch,
  type Repository,
  retrySessionSetup,
  type Session,
  type SessionInput,
  type SessionSetup,
} from './api.ts';

type Notice = { kind: 'ok' | 'error'; text: string };

/** Session names become branch names and directories, so keep them to a slug. */
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : String(error);

/** A stored UTC instant, shown in the visitor's own timezone. */
function localTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Sessions (US-010): create one for a repository, then watch its clone.
 *
 * A failed clone is not an error banner and gone — it is stored on the session,
 * shown with git's own output, and retried from here.
 */
export function Sessions() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [repositories, setRepositories] = useState<Repository[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The last setup outcome per session, so git's output stays on screen. */
  const [setups, setSetups] = useState<Record<string, SessionSetup>>({});

  useEffect(() => {
    const controller = new AbortController();

    Promise.all([fetchSessions(controller.signal), fetchRepositories(controller.signal)])
      .then(([loadedSessions, loadedRepositories]) => {
        setSessions(loadedSessions);
        setRepositories(loadedRepositories);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          window.location.replace('/login');
          return;
        }
        setLoadError(describe(error));
      });

    return () => controller.abort();
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

  if (loadError !== null) {
    return (
      <main className="shell">
        <Header />
        <p className="notice notice--error" role="alert">
          Could not load sessions: {loadError}
        </p>
      </main>
    );
  }

  const usable = (repositories ?? []).filter((repository) => repository.keyConfigured);

  return (
    <main className="shell">
      <Header />
      <p className="tagline">
        A session owns one feature: its own container, its own clone of the repository, and its own{' '}
        <code className="mono">chief/&lt;name&gt;</code> branch, opened from the base branch you
        choose.
      </p>

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
            className="button"
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

      {sessions === null ? (
        <p className="tagline">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="tagline">No sessions yet.</p>
      ) : (
        <ul className="cards">
          {sessions.map((session) => (
            <li className="card" key={session.id}>
              <div className="card__header">
                <h2 className="card__title">
                  {session.name}{' '}
                  <span className={`badge badge--${session.status}`}>{session.status}</span>
                </h2>
                {session.status === 'pending' && !session.cloned && (
                  <div className="field__actions">
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={() => onRetry(session)}
                      disabled={busyId === session.id}
                    >
                      {busyId === session.id ? 'Setting up…' : 'Retry setup'}
                    </button>
                  </div>
                )}
              </div>

              <dl className="meta">
                <dt>Repository</dt>
                <dd>{session.repositoryName}</dd>
                <dt>Feature branch</dt>
                <dd className="mono">{session.featureBranch}</dd>
                <dt>Base branch</dt>
                <dd className="mono">{session.baseBranch}</dd>
                <dt>PR target</dt>
                <dd className="mono">{session.prTargetBranch}</dd>
                <dt>Workspace</dt>
                <dd>{session.cloned ? 'cloned into /workspace/repo' : 'not cloned yet'}</dd>
                {session.scheduledStartAt !== null && (
                  <>
                    <dt>Scheduled</dt>
                    <dd>{localTime(session.scheduledStartAt)}</dd>
                  </>
                )}
              </dl>

              {session.lastError !== null && (
                <p className="notice notice--error" role="status">
                  {session.lastError}
                </p>
              )}
              {setups[session.id]?.stderr !== undefined && setups[session.id]?.stderr !== '' && (
                <pre className="output">{setups[session.id]?.stderr}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
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
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Creating and cloning…' : 'Create session'}
        </button>
        <button type="button" className="button button--quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Header() {
  return (
    <header className="topbar">
      <h1>Sessions</h1>
      <a className="link" href="/">
        Back
      </a>
    </header>
  );
}
