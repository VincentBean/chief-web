import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react';

import {
  ApiError,
  backToPlanning,
  type Build,
  type FailureStage,
  failureStageLabel,
  fetchBuild,
  fetchPlanning,
  fetchSession,
  leaveQueue,
  markSessionReady,
  type Planning,
  type PrdParseError,
  type PrdStatus,
  retryDelivery,
  retrySession,
  type Session as SessionData,
  setSessionSchedule,
  startBuild,
  startPlanning,
  stopBuild,
  stopPlanning,
  type Story,
} from './api.ts';
import { BuildLog } from './BuildLog.tsx';
import { fromLocalInputValue, localTime, startsIn, toLocalInputValue } from './schedule.ts';
import { SESSION_BADGE, STORY_BADGE } from './status.ts';

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
  const [busy, setBusy] = useState<
    | 'start'
    | 'stop'
    | 'ready'
    | 'planning'
    | 'build'
    | 'stop-build'
    | 'leave-queue'
    | 'delivery'
    | 'retry'
    | 'schedule'
    | null
  >(null);
  const [build, setBuild] = useState<Build | null>(null);
  /** Why the last "Mark ready" was refused; cleared by the next attempt. */
  const [readyErrors, setReadyErrors] = useState<readonly PrdParseError[] | null>(null);
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
      Promise.all([
        fetchSession(id, controller.signal),
        fetchPlanning(id, controller.signal),
        fetchBuild(id, controller.signal),
      ])
        .then(([loadedSession, loadedPlanning, loadedBuild]) => {
          setSession(loadedSession);
          setPlanning(loadedPlanning);
          setBuild(loadedBuild);
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

  const onMarkReady = (): void => {
    // A schedule this session slept through is honoured the moment it becomes
    // ready, so the operator is told before it happens rather than after.
    if (session.scheduleMissed && !window.confirm(missedScheduleWarning(session))) return;
    setBusy('ready');
    setNotice(null);
    markSessionReady(id)
      .then((result) => {
        setSession(result.session);
        setBuild((current) => (current === null ? current : { ...current, stories: result.stories }));
        setReadyErrors(result.ok ? null : result.prd.errors);
        const synced = `Ready: ${String(result.stories.length)} ${result.stories.length === 1 ? 'story' : 'stories'} synced from ${result.prd.path}.`;
        setNotice(
          result.ok
            ? {
                kind: 'ok',
                text: result.started
                  ? result.session.queuePosition === null
                    ? `${synced} Its missed schedule was honoured, so the build has started.`
                    : `${synced} Its missed schedule was honoured, but every build slot is taken: ` +
                      `it is queued (#${String(result.session.queuePosition)}) and starts as soon ` +
                      'as one frees.'
                  : synced,
              }
            : {
                kind: 'error',
                text: `${result.prd.path} cannot be used yet, so this session stays pending.`,
              },
        );
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onSchedule = (at: string | null): void => {
    setBusy('schedule');
    setNotice(null);
    setSessionSchedule(id, at)
      .then((next) => {
        setSession(next);
        setNotice({
          kind: 'ok',
          text:
            next.scheduledStartAt === null
              ? 'Schedule cleared — this session only starts when you say so.'
              : `Scheduled for ${localTime(next.scheduledStartAt)} (${startsIn(next.scheduledStartAt)}).`,
        });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onBackToPlanning = (): void => {
    setBusy('planning');
    setNotice(null);
    backToPlanning(id)
      .then((result) => {
        setSession(result.session);
        setBuild((current) => (current === null ? current : { ...current, stories: result.stories }));
        setReadyErrors(null);
        setNotice({ kind: 'ok', text: 'Back to planning — edit the PRD and mark it ready again.' });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onStartBuild = (): void => {
    setBusy('build');
    setNotice(null);
    startBuild(id)
      .then((next) => {
        setBuild(next);
        setSession((current) => (current === null ? current : { ...current, status: next.status }));
        setNotice({
          kind: 'ok',
          text: next.queued
            ? `Queued (#${String(next.queuePosition ?? 1)}) — ${String(next.activeBuilds)} of ` +
              `${String(next.maxConcurrentBuilds)} build slots are in use. It starts on its own ` +
              'as soon as one frees.'
            : `Build started — up to ${String(next.maxIterations)} iterations, one story at a time.`,
        });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onStopBuild = (): void => {
    setBusy('stop-build');
    setNotice(null);
    stopBuild(id)
      .then((next) => {
        setBuild(next);
        setSession((current) => (current === null ? current : { ...current, status: next.status }));
        setNotice({ kind: 'ok', text: 'Build stopped. Everything already committed is kept.' });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onLeaveQueue = (): void => {
    setBusy('leave-queue');
    setNotice(null);
    leaveQueue(id)
      .then((next) => {
        setBuild(next);
        setSession((current) => (current === null ? current : { ...current, status: next.status }));
        setNotice({
          kind: 'ok',
          text: 'Left the build queue. Nothing was started, so nothing was lost.',
        });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  const onRetryDelivery = (): void => {
    setBusy('delivery');
    setNotice(null);
    retryDelivery(id)
      .then((result) => {
        setSession((current) =>
          current === null
            ? current
            : { ...current, status: result.status, prUrl: result.prUrl ?? current.prUrl },
        );
        setBuild((current) => (current === null ? current : { ...current, status: result.status }));
        setNotice({ kind: result.ok ? 'ok' : 'error', text: result.message });
      })
      .catch((error: unknown) => setNotice({ kind: 'error', text: describe(error) }))
      .finally(() => setBusy(null));
  };

  /**
   * "Retry" on a failed session (US-019). Which recovery that is — restarting
   * the loop, or re-running the push and the pull request — is the server's
   * decision, taken from the stage the session failed at, so there is one
   * button here rather than a guess.
   */
  const onRetry = (): void => {
    setBusy('retry');
    setNotice(null);
    retrySession(id)
      .then((result) => {
        setSession((current) =>
          current === null
            ? current
            : {
                ...current,
                status: result.status,
                prUrl: result.prUrl ?? current.prUrl,
                failureStage: result.ok ? null : current.failureStage,
              },
        );
        setBuild((current) =>
          result.build ?? (current === null ? current : { ...current, status: result.status }),
        );
        setNotice({ kind: result.ok ? 'ok' : 'error', text: result.message });
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

      {session.status === 'failed' && (
        <FailureCard
          error={session.lastError}
          stage={session.failureStage}
          stories={build?.stories ?? []}
          busy={busy}
          onRetry={onRetry}
        />
      )}

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">
            {session.name} <span className={SESSION_BADGE[session.status]}>{session.status}</span>
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
          {session.scheduledStartAt !== null && (
            <>
              <dt>Scheduled start</dt>
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
        </dl>
        {session.lastError !== null && session.status !== 'failed' && (
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

      <ScheduleCard session={session} busy={busy} onSave={onSchedule} />

      <PrdCard prd={planning.prd} />

      <ReadinessCard
        status={session.status}
        prd={planning.prd}
        stories={build?.stories ?? []}
        errors={readyErrors}
        busy={busy}
        onMarkReady={onMarkReady}
        onBackToPlanning={onBackToPlanning}
      />

      <BuildCard
        status={session.status}
        build={build}
        prUrl={session.prUrl}
        busy={busy}
        onStart={onStartBuild}
        onStop={onStopBuild}
        onLeaveQueue={onLeaveQueue}
        onRetry={onRetry}
        onRetryDelivery={onRetryDelivery}
      />

      {session.status !== 'pending' && (
        <BuildLog sessionId={id} building={session.status === 'building'} />
      )}

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
            <TerminalPane terminalId={attached} size="tall" />
          </Suspense>
        )}
      </section>
    </main>
  );
}

/**
 * What the operator confirms before a missed schedule is honoured: the build
 * does not wait for another button, it starts as this request returns.
 */
function missedScheduleWarning(session: SessionData): string {
  return [
    `"${session.name}" missed its scheduled start at ${localTime(session.scheduledStartAt ?? '')}, because it was still being planned.`,
    '',
    'Marking it ready now parses its PRD and starts the build immediately.',
    '',
    'Cancel, and clear the schedule first, if you would rather start it by hand.',
  ].join('\n');
}

/**
 * The scheduled start (US-017).
 *
 * A schedule is one-shot and lives on the session, not in a timer: the server
 * checks the database every half minute, so a stack that was down overnight
 * still starts the session the moment it comes back. It can be set, moved or
 * cleared for as long as the session has not started — after that there is
 * nothing left to schedule.
 */
function ScheduleCard({
  session,
  busy,
  onSave,
}: {
  session: SessionData;
  busy: string | null;
  onSave: (at: string | null) => void;
}) {
  const schedulable = session.status === 'pending' || session.status === 'ready';
  const [value, setValue] = useState(
    session.scheduledStartAt === null ? '' : toLocalInputValue(session.scheduledStartAt),
  );
  const [error, setError] = useState<string | null>(null);
  /** The stored value the field was last synced with, so a poll cannot fight typing. */
  const [known, setKnown] = useState(session.scheduledStartAt);

  if (known !== session.scheduledStartAt) {
    setKnown(session.scheduledStartAt);
    setValue(session.scheduledStartAt === null ? '' : toLocalInputValue(session.scheduledStartAt));
  }

  if (!schedulable && session.scheduledStartAt === null) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const at = fromLocalInputValue(value);
    if (value !== '' && at === null) {
      setError('That is not a valid date and time.');
      return;
    }
    setError(null);
    onSave(at);
  };

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">
          Schedule{' '}
          <span className={session.scheduleMissed ? 'badge badge--failed' : 'badge'}>
            {session.scheduledStartAt === null
              ? 'not scheduled'
              : session.scheduleMissed
                ? 'missed'
                : startsIn(session.scheduledStartAt)}
          </span>
        </h2>
      </div>

      {session.scheduleMissed && (
        <p className="notice notice--error" role="status">
          Missed schedule — mark ready to start. This session was still being planned at{' '}
          {localTime(session.scheduledStartAt ?? '')}, so nothing ran. Marking it ready starts the
          build immediately; clear the schedule first if you would rather not.
        </p>
      )}

      {schedulable ? (
        <form className="form" onSubmit={submit}>
          <section className="field">
            <label className="field__label" htmlFor="session-schedule">
              Start the build at
            </label>
            <p className="field__hint">
              Read in this browser&rsquo;s timezone and stored as UTC. The session has to be ready
              by then — a schedule that passes while it is still being planned is missed, and
              nothing runs. If every build slot is taken at that moment, the session takes a place
              in the build queue instead and starts as soon as one frees.
            </p>
            <input
              id="session-schedule"
              className="field__input"
              type="datetime-local"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </section>

          {error !== null && (
            <p className="notice notice--error" role="alert">
              {error}
            </p>
          )}

          <div className="field__actions">
            <button type="submit" className="button" disabled={busy !== null}>
              {busy === 'schedule' ? 'Saving…' : 'Save schedule'}
            </button>
            {session.scheduledStartAt !== null && (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => {
                  setValue('');
                  onSave(null);
                }}
                disabled={busy !== null}
              >
                Clear
              </button>
            )}
          </div>
        </form>
      ) : (
        <p className="field__hint">
          Scheduled for {localTime(session.scheduledStartAt ?? '')}. A schedule can only be changed
          while a session is pending or ready; this one is {session.status}.
        </p>
      )}
    </section>
  );
}

/**
 * Why a `failed` session failed, and the one button that recovers it (US-016,
 * US-019).
 *
 * The stored message is the only account of what happened — the loop writes the
 * retry count and the tail of the agent's own output into it — and it is
 * multi-line, so it gets a card of its own at the top of the page rather than a
 * line of body text further down that a reader has to go looking for. Next to
 * it is the stage: which step failed, and therefore where a retry resumes.
 */
function FailureCard({
  error,
  stage,
  stories,
  busy,
  onRetry,
}: {
  error: string | null;
  stage: FailureStage | null;
  stories: Story[];
  busy: string | null;
  onRetry: () => void;
}) {
  const outstanding = stories.filter((story) => story.status !== 'done').length;
  // The same reading the server makes: the delivery stages, plus a session
  // that failed before stages existed and has nothing left to build.
  const delivery =
    stage === 'push' ||
    stage === 'pull_request' ||
    (stage === null && stories.length > 0 && outstanding === 0);

  return (
    <section className="card card--failed" role="alert">
      <div className="card__header">
        <h2 className="card__title">
          This session failed <span className="badge badge--failed">failed</span>{' '}
          {stage !== null && (
            <span className="badge badge--failed">{failureStageLabel(stage)}</span>
          )}
        </h2>
        <div className="field__actions">
          <button type="button" className="button" onClick={onRetry} disabled={busy !== null}>
            {busy === 'retry' ? 'Retrying…' : delivery ? 'Retry push & PR' : 'Retry build'}
          </button>
        </div>
      </div>
      {error === null ? (
        <p className="field__hint">
          No reason was recorded. The agent log below is the next place to look.
        </p>
      ) : (
        <pre className="output output--wrap">{error}</pre>
      )}
      <p className="field__hint">
        {delivery
          ? 'Every story is committed, so nothing is rebuilt: the retry re-runs only the push and the pull request, and adopts an existing pull request for this branch rather than opening a second one.'
          : stage === 'container_lost'
            ? `The workspace is on the data volume, not in the container that was lost. The retry starts a fresh container on that same clone and resumes at the first story that is not done${outstanding === 0 ? '.' : ` (${String(outstanding)} left).`}`
            : `Nothing that was committed is lost. The retry resumes from the PRD: every story it already marked done is skipped${outstanding === 0 ? '.' : `, so ${String(outstanding)} are left to run.`}`}
      </p>
    </section>
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

/**
 * The gate between planning and building (US-012).
 *
 * "Mark ready" is the only way a session leaves `pending`, and it parses
 * `prd.md` first: nothing is built against a PRD chief-web cannot read. A
 * refusal lists exactly what was wrong and where, so the fix goes back into the
 * planning terminal; "Back to planning" reopens the same door.
 */
function ReadinessCard({
  status,
  prd,
  stories,
  errors,
  busy,
  onMarkReady,
  onBackToPlanning,
}: {
  status: SessionData['status'];
  prd: PrdStatus;
  stories: Story[];
  errors: readonly PrdParseError[] | null;
  busy: string | null;
  onMarkReady: () => void;
  onBackToPlanning: () => void;
}) {
  const pending = status === 'pending';
  const ready = status === 'ready';
  if (!pending && !ready) return null;

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">Stories</h2>
        <div className="field__actions">
          {pending && (
            <button type="button" className="button button--primary" onClick={onMarkReady} disabled={busy !== null}>
              {busy === 'ready' ? 'Checking the PRD…' : 'Mark ready'}
            </button>
          )}
          {ready && (
            <button
              type="button"
              className="button button--quiet"
              onClick={onBackToPlanning}
              disabled={busy !== null}
            >
              {busy === 'planning' ? 'Reopening…' : 'Back to planning'}
            </button>
          )}
        </div>
      </div>

      {pending && (
        <p className="field__hint">
          Marking this session ready parses {prd.path} and stores its stories. It only succeeds if
          the whole file is usable — nothing is built against a PRD chief-web cannot read.
        </p>
      )}

      {errors !== null && errors.length > 0 && (
        <ul className="cards">
          {errors.map((error) => (
            <li className="notice notice--error" key={`${String(error.line)}-${error.message}`}>
              {error.line > 0 ? `Line ${String(error.line)}: ` : ''}
              {error.message}
            </li>
          ))}
        </ul>
      )}

      {stories.length === 0 ? (
        ready && <p className="field__hint">This session has no stories.</p>
      ) : (
        <ul className="stories">
          {stories.map((story) => (
            <li className="story" key={story.storyId}>
              <span className="mono story__id">{story.storyId}</span>
              <span className="story__title">{story.title}</span>
              <span className="story__priority">priority {story.priority}</span>
              <span className={STORY_BADGE[story.status]}>{story.status}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The Ralph loop (US-013).
 *
 * A build is the session running itself: one headless `claude -p` per story,
 * in priority order, until every `**Status:**` in `prd.md` reads `done`. The
 * server owns the loop, so this card is a view of it — the numbers come from
 * the same poll as everything else, and closing the tab changes nothing.
 */
function BuildCard({
  status,
  build,
  prUrl,
  busy,
  onStart,
  onStop,
  onLeaveQueue,
  onRetry,
  onRetryDelivery,
}: {
  status: SessionData['status'];
  build: Build | null;
  prUrl: string | null;
  busy: string | null;
  onStart: () => void;
  onStop: () => void;
  onLeaveQueue: () => void;
  onRetry: () => void;
  onRetryDelivery: () => void;
}) {
  if (build === null || status === 'pending') return null;

  const building = status === 'building';
  const done = build.stories.filter((story) => story.status === 'done').length;
  const current = build.stories.find((story) => story.storyId === build.currentStoryId) ?? null;
  // Everything is committed, so the only thing left that can have failed is the
  // push or the pull request — and that is retried on its own (US-014).
  const complete = build.stories.length > 0 && done === build.stories.length;
  // A failed session is retried through the one endpoint that knows where to
  // resume (US-019); the stage says which of the two it will be. A *finished*
  // session with no pull request is the other case — nothing failed, the
  // operator closed the PR by hand — and that is still the delivery endpoint.
  const failed = status === 'failed';
  const retryIsDelivery =
    build.failureStage === 'push' ||
    build.failureStage === 'pull_request' ||
    (build.failureStage === null && complete);
  const canRetryDelivery = status === 'finished' && prUrl === null && complete;
  const canRetryBuild = failed && !retryIsDelivery;

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">
          Build <span className={SESSION_BADGE[status]}>{status}</span>{' '}
          {build.queued && (
            <span className="badge badge--queued">Queued (#{build.queuePosition ?? 1})</span>
          )}
        </h2>
        <div className="field__actions">
          {status === 'ready' && !build.queued && (
            <button
              type="button"
              className="button button--primary"
              onClick={onStart}
              disabled={busy !== null}
            >
              {busy === 'build' ? 'Starting…' : 'Start build'}
            </button>
          )}
          {failed && !build.queued && (
            <button type="button" className="button" onClick={onRetry} disabled={busy !== null}>
              {busy === 'retry'
                ? 'Retrying…'
                : retryIsDelivery
                  ? 'Retry push & PR'
                  : 'Retry build'}
            </button>
          )}
          {build.queued && (
            <button
              type="button"
              className="button button--quiet"
              onClick={onLeaveQueue}
              disabled={busy !== null}
            >
              {busy === 'leave-queue' ? 'Leaving…' : 'Leave queue'}
            </button>
          )}
          {building && (
            <button
              type="button"
              className="button button--quiet"
              onClick={onStop}
              disabled={busy !== null}
            >
              {busy === 'stop-build' ? 'Stopping…' : 'Stop build'}
            </button>
          )}
          {canRetryDelivery && (
            <button
              type="button"
              className="button"
              onClick={onRetryDelivery}
              disabled={busy !== null}
            >
              {busy === 'delivery' ? 'Retrying…' : 'Retry push & PR'}
            </button>
          )}
        </div>
      </div>

      <dl className="meta">
        <dt>Stories done</dt>
        <dd>
          {done}/{build.stories.length}
        </dd>
        {build.queued && (
          <>
            <dt>Queue</dt>
            <dd>
              #{build.queuePosition ?? 1} of the sessions waiting for a build slot
            </dd>
          </>
        )}
        <dt>Build slots</dt>
        <dd>
          {build.activeBuilds} of {build.maxConcurrentBuilds} in use
        </dd>
        {building && (
          <>
            <dt>Iteration</dt>
            <dd>
              {build.iteration} of at most {build.maxIterations}
              {build.attempts > 0 && ` (retry ${String(build.attempts)} of 2)`}
              <span className="story__priority">
                {' '}
                &middot; {Math.round(build.agentTimeoutMs / 60000)} min limit each
              </span>
            </dd>
            <dt>Current story</dt>
            <dd>
              {current === null ? (
                build.currentStoryId ?? 'starting…'
              ) : (
                <>
                  <span className="mono">{current.storyId}</span> {current.title}
                </>
              )}
            </dd>
          </>
        )}
      </dl>

      {prUrl !== null && (
        <p className="field__hint">
          <a className="link" href={prUrl} target="_blank" rel="noreferrer">
            View the pull request
          </a>{' '}
          — opened automatically when the last story was done.
        </p>
      )}

      {(canRetryDelivery || (failed && retryIsDelivery)) && (
        <p className="field__hint">
          Every story is done, so nothing has to be rebuilt. &ldquo;Retry push &amp; PR&rdquo;
          re-attempts only the push and the pull request; an existing pull request for this branch is
          adopted rather than duplicated.
        </p>
      )}

      {build.queued && (
        <p className="field__hint">
          Every build slot is taken, so this session is waiting its turn. It starts on its own the
          moment one frees — no container has been spawned for it yet, and &ldquo;Leave queue&rdquo;
          takes it back to ready with nothing lost. The cap lives on the{' '}
          <a className="link" href="/settings">
            settings page
          </a>
          .
        </p>
      )}

      {status === 'ready' && !build.queued && (
        <p className="field__hint">
          Starting the build runs one headless Claude per story, lowest priority number first. After
          each iteration chief-web re-reads {build.prd.path} and the git history — a story only
          counts as done when the file says so.
        </p>
      )}

      {canRetryBuild && (
        <p className="field__hint">
          {done} of {build.stories.length} stories are done and stay done. &ldquo;Retry build&rdquo;
          starts the loop again at the next story that is not
          {build.failureStage === 'container_lost' ? ', in a fresh container on the same workspace' : ''}
          .
        </p>
      )}

      {building && !build.running && (
        <p className="field__hint">
          This session is marked building but no loop is running here, which means the server was
          restarted. Stop the build to return it to ready.
        </p>
      )}

      {build.stories.length > 0 && (
        <ul className="stories">
          {build.stories.map((story) => (
            <li
              className={story.storyId === build.currentStoryId && building ? 'story story--current' : 'story'}
              key={story.storyId}
            >
              <span className="mono story__id">{story.storyId}</span>
              <span className="story__title">
                {story.title}
                {story.storyId === build.currentStoryId && building && (
                  <span className="story__now"> · running now</span>
                )}
              </span>
              <span className="mono story__priority">
                {story.commitSha === null ? '—' : story.commitSha.slice(0, 7)}
              </span>
              <span className={STORY_BADGE[story.status]}>{story.status}</span>
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
