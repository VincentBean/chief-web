import { lazy, Suspense, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  fetchPlanning,
  fetchSession,
  type Planning,
  type PrdStatus,
  type Session as SessionData,
  startPlanning,
  stopPlanning,
} from './api.ts';

type Notice = { kind: 'ok' | 'error'; text: string };

/** How often the PRD indicator and the terminal's state are re-read. */
const POLL_MS = 3000;

// xterm.js is the largest dependency in the bundle and only matters once
// planning actually starts, so it stays in its own chunk.
const TerminalPane = lazy(() =>
  import('./TerminalPane.tsx').then((module) => ({ default: module.TerminalPane })),
);

const describe = (error: unknown): string =>
  error instanceof ApiError ? error.message : String(error);

const localTime = (iso: string): string => new Date(iso).toLocaleString();

/** The session id is the last path segment: `/sessions/<id>`. */
export function sessionIdFromPath(pathname: string): string | null {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
  return match === null ? null : decodeURIComponent(match[1] ?? '');
}

/**
 * One session (US-011): its details, the state of its PRD, and the planning
 * terminal.
 *
 * While a session is `pending` this page is `chief new` in the browser — an
 * interactive `claude` inside the session's own container, preloaded with
 * chief's PRD-generation prompt. The server owns that process, so reloading the
 * page or closing the tab rejoins the same conversation instead of restarting
 * it, and the PRD indicator is polled from the workspace on the data volume.
 */
export function Session() {
  const id = sessionIdFromPath(window.location.pathname);
  const [session, setSession] = useState<SessionData | null>(null);
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [context, setContext] = useState('');
  /** Kept apart from `planning.terminalId` so the pane survives an exit. */
  const [attached, setAttached] = useState<string | null>(null);
  /** Terminal the operator closed, so a poll in flight cannot re-attach it. */
  const closedRef = useRef<string | null>(null);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (id === null) {
      setLoadError('That is not a session URL.');
      return;
    }
    const controller = new AbortController();

    const load = (): void => {
      Promise.all([fetchSession(id, controller.signal), fetchPlanning(id, controller.signal)])
        .then(([loadedSession, loadedPlanning]) => {
          setSession(loadedSession);
          setPlanning(loadedPlanning);
          // A terminal the server still knows about (a reload, or another tab)
          // is attached to straight away.
          setAttached((current) =>
            current ??
            (loadedPlanning.terminalId === closedRef.current ? null : loadedPlanning.terminalId),
          );
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
    // The PRD is written by an agent in another process, so the only way this
    // page can show it appearing is to keep looking.
    pollRef.current = window.setInterval(load, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(pollRef.current);
    };
  }, [id]);

  if (loadError !== null) {
    return (
      <main className="shell">
        <Header name={session?.name ?? 'Session'} />
        <p className="notice notice--error" role="alert">
          Could not load this session: {loadError}
        </p>
      </main>
    );
  }

  if (id === null || session === null || planning === null) {
    return (
      <main className="shell">
        <Header name="Session" />
        <p className="tagline">Loading…</p>
      </main>
    );
  }

  const onStart = (): void => {
    setBusy('start');
    setNotice(null);
    startPlanning(id, context.trim())
      .then((next) => {
        closedRef.current = null;
        setPlanning(next);
        setAttached(next.terminalId);
        setNotice({
          kind: 'ok',
          text:
            next.mode === 'edit'
              ? `Resumed planning — Claude was started with chief's edit prompt for ${next.prd.path}.`
              : `Planning started — Claude will write ${next.prd.path}.`,
        });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onStop = (): void => {
    setBusy('stop');
    setNotice(null);
    stopPlanning(id)
      .then((next) => {
        closedRef.current = attached;
        setPlanning(next);
        setAttached(null);
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const resume = planning.nextMode === 'edit' || planning.terminalId !== null;
  const startLabel = resume ? 'Resume planning' : 'Start planning';

  return (
    <main className="shell">
      <Header name={session.name} />

      <p className="tagline">
        Plan the feature here: an interactive Claude in this session&rsquo;s own container, started
        with chief&rsquo;s PRD prompt in <code className="mono">{planning.cwd}</code>. The
        conversation lives on the server, so reloading this page rejoins it.
      </p>

      {notice !== null && (
        <p className={`notice notice--${notice.kind}`} role="alert">
          {notice.text}
        </p>
      )}

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">
            {session.name} <span className={`badge badge--${session.status}`}>{session.status}</span>
          </h2>
        </div>
        <dl className="meta">
          <dt>Repository</dt>
          <dd>{session.repositoryName}</dd>
          <dt>Feature branch</dt>
          <dd className="mono">{session.featureBranch}</dd>
          <dt>Base branch</dt>
          <dd className="mono">{session.baseBranch}</dd>
          <dt>Workspace</dt>
          <dd>{session.cloned ? 'cloned into /workspace/repo' : 'not cloned yet'}</dd>
        </dl>
        {session.lastError !== null && (
          <p className="notice notice--error" role="status">
            {session.lastError}
          </p>
        )}
        {!session.cloned && (
          <p className="field__hint">
            Planning needs the clone.{' '}
            <a className="link" href="/sessions">
              Retry setup
            </a>{' '}
            first.
          </p>
        )}
      </section>

      <PrdCard prd={planning.prd} />

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">
            Planning <span className={planning.running ? 'badge badge--ready' : 'badge'}>
              {planning.running ? 'running' : planning.terminalId === null ? 'not started' : 'exited'}
            </span>
          </h2>
          <div className="field__actions">
            {!planning.running && (
              <button
                type="button"
                className="button"
                onClick={onStart}
                disabled={busy !== null || !session.cloned || session.status !== 'pending'}
              >
                {busy === 'start' ? 'Starting…' : startLabel}
              </button>
            )}
            {planning.terminalId !== null && (
              <button
                type="button"
                className="button button--quiet"
                onClick={onStop}
                disabled={busy !== null}
              >
                {busy === 'stop' ? 'Closing…' : 'Close terminal'}
              </button>
            )}
          </div>
        </div>

        {session.status !== 'pending' && (
          <p className="field__hint">
            Planning is only available while a session is pending; this one is {session.status}.
          </p>
        )}

        {planning.terminalId === null && planning.nextMode === 'create' && (
          <section className="field">
            <label className="field__label" htmlFor="planning-context">
              What do you want to build? (optional)
            </label>
            <p className="field__hint">
              Passed to Claude as the starting context. Leave it empty and it will ask you instead —
              either way it interviews you before writing the PRD.
            </p>
            <textarea
              id="planning-context"
              className="field__input"
              rows={4}
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder="A login screen with email + password, rate limited…"
            />
          </section>
        )}

        {planning.terminalId !== null && !planning.running && (
          <p className="field__hint">
            The planning process has exited
            {planning.exitCode === null ? '' : ` with code ${String(planning.exitCode)}`}.{' '}
            {planning.prd.exists
              ? 'Resuming starts Claude again with chief’s edit prompt, so the existing PRD is changed rather than rewritten.'
              : 'No PRD was written; resuming starts the questions again.'}
          </p>
        )}

        {attached !== null && (
          <Suspense fallback={<p className="tagline">Loading terminal…</p>}>
            <TerminalPane terminalId={attached} />
          </Suspense>
        )}
      </section>
    </main>
  );
}

/** Live indicator: does `prd.md` exist, and can chief-web read it? */
function PrdCard({ prd }: { prd: PrdStatus }) {
  const state = !prd.exists ? 'missing' : prd.parses ? 'ok' : 'broken';
  const badge = state === 'ok' ? 'badge badge--ready' : state === 'broken' ? 'badge badge--failed' : 'badge';

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">
          PRD <span className={badge}>
            {state === 'missing' ? 'not written yet' : state === 'ok' ? 'parses' : 'does not parse'}
          </span>
        </h2>
      </div>
      <dl className="meta">
        <dt>File</dt>
        <dd className="mono">{prd.path}</dd>
        {prd.exists && (
          <>
            <dt>Stories</dt>
            <dd>{prd.storyCount}</dd>
            <dt>Last written</dt>
            <dd>{prd.updatedAt === null ? 'unknown' : localTime(prd.updatedAt)}</dd>
          </>
        )}
      </dl>
      {!prd.exists && (
        <p className="field__hint">
          Claude writes it during planning; this indicator updates on its own as soon as the file
          appears.
        </p>
      )}
      {prd.exists && !prd.parses && (
        <ul className="cards">
          {prd.errors.map((error) => (
            <li className="notice notice--error" key={`${String(error.line)}-${error.message}`}>
              {error.line > 0 ? `Line ${String(error.line)}: ` : ''}
              {error.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Header({ name }: { name: string }) {
  return (
    <header className="topbar">
      <h1>{name}</h1>
      <a className="link" href="/sessions">
        Back to sessions
      </a>
    </header>
  );
}
