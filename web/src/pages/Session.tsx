import { type FormEvent, lazy, Suspense, useEffect, useState } from 'react';

import {
  backToPlanning,
  type Build,
  clearUsageLimitHold,
  deleteSession,
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
  retrySessionSetup,
  type Session as SessionData,
  setSessionSchedule,
  startBuild,
  startPlanning,
  stopBuild,
  stopPlanning,
  type Story,
} from '../api.ts';
import { BuildLog } from '../BuildLog.tsx';
import { ConfirmDialog } from '../ConfirmDialog.tsx';
import { DESKTOP_QUERY, describeError, redirectIfUnauthorised, useAppData, useMediaQuery } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { navigate, sessionIdFromPath, useLocation } from '../router.tsx';
import { countdown, fromLocalParts, localTime, normaliseTime, startsIn, toLocalInputParts } from '../schedule.ts';
import { useToast } from '../toast.tsx';
import { Badge, Facts, Notice, PageHeader, Panel, Progress, Skeleton, STORY_TONE, StatusBadge } from '../ui.tsx';
import { DeletionWarning } from './Sessions.tsx';

/** How often the PRD indicator, the terminal's state and the build are re-read. */
const POLL_MS = 3000;

// xterm.js is the largest dependency in the bundle and only matters once
// planning actually starts, so it stays in its own chunk.
const TerminalPane = lazy(() =>
  import('../TerminalPane.tsx').then((module) => ({ default: module.TerminalPane })),
);

type Busy =
  | 'start'
  | 'stop'
  | 'ready'
  | 'planning'
  | 'build'
  | 'stop-build'
  | 'resume-hold'
  | 'leave-queue'
  | 'delivery'
  | 'retry'
  | 'setup'
  | 'schedule'
  | 'delete'
  | null;

/**
 * One session: where it is in its life, the one thing to do next, and the
 * detail behind it. The page is built around the stage the session is in —
 * planning shows the terminal, building shows the loop and its log — so the
 * operator never scrolls past cards for stages that are over or not yet due.
 */
export function Session() {
  const { pathname } = useLocation();
  const id = sessionIdFromPath(pathname);
  const { refresh } = useAppData();
  const toast = useToast();
  const [session, setSession] = useState<SessionData | null>(null);
  const [planning, setPlanning] = useState<Planning | null>(null);
  const [build, setBuild] = useState<Build | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  /** Why the last "Mark ready" was refused; cleared by the next attempt. */
  const [readyErrors, setReadyErrors] = useState<readonly PrdParseError[] | null>(null);
  const [confirming, setConfirming] = useState<'delete' | 'resume' | 'ready-missed' | null>(null);
  const [setupStderr, setSetupStderr] = useState<string | null>(null);

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
          setLoadError(null);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (redirectIfUnauthorised(error)) return;
          setLoadError(describeError(error));
        });
    };
    load();
    // The PRD is written by an agent in another process, so the only way this
    // page can show it appearing is to keep looking.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [id]);

  if (loadError !== null) {
    return (
      <div className="page page--narrow">
        <PageHeader back={{ href: '/sessions', label: 'Sessions' }} title={session?.name ?? 'Session'} />
        <Notice kind="error">Could not load this session: {loadError}</Notice>
      </div>
    );
  }

  if (id === null || session === null || planning === null || build === null) {
    return (
      <div className="page">
        <PageHeader back={{ href: '/sessions', label: 'Sessions' }} title="Session" />
        <div className="panel">
          <div className="panel__body">
            <Skeleton lines={5} />
          </div>
        </div>
      </div>
    );
  }

  /** Runs an action, applies its result, and tells the operator how it went. */
  const run = (kind: NonNullable<Busy>, action: () => Promise<string | null>): void => {
    setBusy(kind);
    action()
      .then((message) => {
        if (message !== null) toast.ok(message);
        void refresh();
      })
      .catch((cause: unknown) => toast.error(describeError(cause)))
      .finally(() => setBusy(null));
  };

  const applyStatus = (status: SessionData['status'], prUrl?: string | null): void => {
    setSession((current) => (current === null ? current : { ...current, status, prUrl: prUrl ?? current.prUrl }));
    setBuild((current) => (current === null ? current : { ...current, status }));
  };

  const onStartPlanning = (context: string): void =>
    run('start', async () => {
      const next = await startPlanning(id, context);
      setPlanning(next);
      return next.mode === 'edit'
        ? `Planning resumed with chief’s edit prompt for ${next.prd.path}.`
        : `Planning started. Claude will write ${next.prd.path}.`;
    });

  const onStopPlanning = (): void =>
    run('stop', async () => {
      setPlanning(await stopPlanning(id));
      return null;
    });

  const onMarkReady = (): void =>
    run('ready', async () => {
      const result = await markSessionReady(id);
      setSession(result.session);
      setBuild((current) => (current === null ? current : { ...current, stories: result.stories }));
      setReadyErrors(result.ok ? null : result.prd.errors);
      if (!result.ok) throw new Error(`${result.prd.path} cannot be used yet; the problems are listed on the page.`);
      const synced = `Ready: ${String(result.stories.length)} ${result.stories.length === 1 ? 'story' : 'stories'} from ${result.prd.path}.`;
      if (!result.started) return synced;
      return result.session.queuePosition === null
        ? `${synced} Its missed schedule was honoured, so the build has started.`
        : `${synced} Its missed schedule was honoured; it is queued (#${String(result.session.queuePosition)}).`;
    });

  const onSchedule = (at: string | null): void =>
    run('schedule', async () => {
      const next = await setSessionSchedule(id, at);
      setSession(next);
      return next.scheduledStartAt === null
        ? 'Schedule cleared. This session starts when you say so.'
        : `Scheduled for ${localTime(next.scheduledStartAt)} (${startsIn(next.scheduledStartAt)}).`;
    });

  const onBackToPlanning = (): void =>
    run('planning', async () => {
      const result = await backToPlanning(id);
      setSession(result.session);
      setBuild((current) => (current === null ? current : { ...current, stories: result.stories }));
      setReadyErrors(null);
      return 'Back to planning. Edit the PRD and mark it ready again.';
    });

  const onStartBuild = (): void =>
    run('build', async () => {
      const next = await startBuild(id);
      setBuild(next);
      applyStatus(next.status);
      return next.queued
        ? `Queued (#${String(next.queuePosition ?? 1)}): ${String(next.activeBuilds)} of ${String(next.maxConcurrentBuilds)} build slots are in use.`
        : `Build started: up to ${String(next.maxIterations)} iterations, one story at a time.`;
    });

  const onStopBuild = (): void =>
    run('stop-build', async () => {
      const next = await stopBuild(id);
      setBuild(next);
      applyStatus(next.status);
      return 'Build stopped. Everything already committed is kept.';
    });

  const onResumeNow = (): void =>
    run('resume-hold', async () => {
      const { resumed } = await clearUsageLimitHold();
      return `Hold lifted. ${String(resumed)} ${resumed === 1 ? 'session is' : 'sessions are'} building again; the rest are queued.`;
    });

  const onLeaveQueue = (): void =>
    run('leave-queue', async () => {
      const next = await leaveQueue(id);
      setBuild(next);
      applyStatus(next.status);
      return 'Left the build queue. Nothing was started, so nothing was lost.';
    });

  const onRetryDelivery = (): void =>
    run('delivery', async () => {
      const result = await retryDelivery(id);
      applyStatus(result.status, result.prUrl);
      if (!result.ok) throw new Error(result.message);
      return result.message;
    });

  const onRetry = (): void =>
    run('retry', async () => {
      const result = await retrySession(id);
      setSession((current) =>
        current === null
          ? current
          : { ...current, status: result.status, prUrl: result.prUrl ?? current.prUrl, failureStage: result.ok ? null : current.failureStage },
      );
      setBuild((current) => result.build ?? (current === null ? current : { ...current, status: result.status }));
      if (!result.ok) throw new Error(result.message);
      return result.message;
    });

  const onRetrySetup = (): void =>
    run('setup', async () => {
      const result = await retrySessionSetup(id);
      setSession(result.session);
      setSetupStderr(result.setup.stderr === '' ? null : result.setup.stderr);
      if (!result.setup.ok) throw new Error(result.setup.message);
      return `${result.session.name} is cloned; planning can start.`;
    });

  const onDelete = (): void =>
    run('delete', async () => {
      await deleteSession(id);
      navigate('/sessions');
      return `Deleted ${session.name}. Nothing on the remote changed.`;
    });

  const status = session.status;
  const stories = build.stories;
  const done = stories.filter((story) => story.status === 'done').length;
  const complete = stories.length > 0 && done === stories.length;
  const retryIsDelivery =
    build.failureStage === 'push' || build.failureStage === 'pull_request' || (build.failureStage === null && complete);

  // The one primary action per state, and the secondary ones beside it.
  const actions = (
    <>
      {status === 'pending' && (
        <button
          type="button"
          className={planning.prd.parses ? 'button button--primary' : 'button'}
          onClick={() => (session.scheduleMissed ? setConfirming('ready-missed') : onMarkReady())}
          disabled={busy !== null || !planning.prd.parses}
          title={planning.prd.exists ? (planning.prd.parses ? 'Parse the PRD and make the session buildable' : 'The PRD does not parse yet') : 'No PRD has been written yet'}
        >
          <Icon name="check" />
          {busy === 'ready' ? 'Checking the PRD…' : 'Mark ready'}
        </button>
      )}
      {status === 'ready' && !build.queued && (
        <>
          <button type="button" className="button button--primary" onClick={onStartBuild} disabled={busy !== null}>
            <Icon name="play" />
            {busy === 'build' ? 'Starting…' : 'Start build'}
          </button>
          <button type="button" className="button" onClick={onBackToPlanning} disabled={busy !== null}>
            {busy === 'planning' ? 'Reopening…' : 'Back to planning'}
          </button>
        </>
      )}
      {build.queued && (
        <button type="button" className="button" onClick={onLeaveQueue} disabled={busy !== null}>
          {busy === 'leave-queue' ? 'Leaving…' : 'Leave queue'}
        </button>
      )}
      {status === 'waiting' && (
        <button type="button" className="button button--primary" onClick={() => setConfirming('resume')} disabled={busy !== null}>
          <Icon name="play" />
          {busy === 'resume-hold' ? 'Resuming…' : 'Resume now'}
        </button>
      )}
      {(status === 'building' || status === 'waiting') && (
        <button type="button" className="button" onClick={onStopBuild} disabled={busy !== null}>
          <Icon name="stop" />
          {busy === 'stop-build' ? 'Stopping…' : 'Stop build'}
        </button>
      )}
      {status === 'failed' && !build.queued && (
        <button type="button" className="button button--primary" onClick={onRetry} disabled={busy !== null}>
          <Icon name="sync" />
          {busy === 'retry' ? 'Retrying…' : retryIsDelivery ? 'Retry push & PR' : 'Retry build'}
        </button>
      )}
      {status === 'finished' && session.prUrl !== null && (
        <a className="button button--primary" href={session.prUrl} target="_blank" rel="noreferrer">
          <Icon name="git-pull-request" />
          Open pull request
          <Icon name="link-external" />
        </a>
      )}
      {status === 'finished' && session.prUrl === null && complete && (
        <button type="button" className="button button--primary" onClick={onRetryDelivery} disabled={busy !== null}>
          <Icon name="sync" />
          {busy === 'delivery' ? 'Retrying…' : 'Retry push & PR'}
        </button>
      )}
      <button
        type="button"
        className="button button--quiet button--danger button--icon"
        onClick={() => setConfirming('delete')}
        disabled={busy !== null}
        aria-label="Delete session"
        title="Delete session"
      >
        <Icon name="trash" />
      </button>
    </>
  );

  return (
    <div className="page">
      <PageHeader
        back={{ href: '/sessions', label: 'Sessions' }}
        eyebrow={
          <span className="crumbs">
            <Icon name="repo" />
            {session.repositoryName}
            <span className="crumbs__sep">/</span>
            <Icon name="git-branch" />
            <span className="mono">{session.featureBranch}</span>
            <span className="muted mono"> → {session.prTargetBranch}</span>
          </span>
        }
        title={
          <>
            {session.name} <StatusBadge session={session} />
            {build.queued && <Badge tone="wait">queued #{build.queuePosition ?? 1}</Badge>}
          </>
        }
        actions={actions}
      />

      <Stages session={session} build={build} prd={planning.prd} />

      {status === 'failed' && (
        <FailurePanel error={session.lastError} stage={session.failureStage} stories={stories} retryIsDelivery={retryIsDelivery} />
      )}
      {status === 'waiting' && <HoldPanel until={session.waitingUntil} />}
      {session.scheduleMissed && (
        <Notice kind="warn">
          <strong>Missed its scheduled start.</strong> The session was still being planned at{' '}
          {localTime(session.scheduledStartAt ?? '')}, so nothing ran. Marking it ready starts the build immediately; clear
          the schedule first if you would rather not.
        </Notice>
      )}
      {status === 'building' && !build.running && (
        <Notice kind="warn">
          This session is marked building but no loop is running here, which means the server was restarted. Stop the
          build to return it to ready, then start it again.
        </Notice>
      )}
      {session.lastError !== null && status !== 'failed' && status !== 'waiting' && <Notice kind="error">{session.lastError}</Notice>}
      {!session.cloned && (
        <Notice kind="error">
          <strong>The clone did not finish,</strong> so there is no workspace to plan in.{' '}
          <button type="button" className="link link--button" onClick={onRetrySetup} disabled={busy !== null}>
            {busy === 'setup' ? 'Retrying…' : 'Retry setup'}
          </button>
          {setupStderr !== null && <pre className="output">{setupStderr}</pre>}
        </Notice>
      )}

      <div className="grid grid--main-aside">
        <div className="stack">
          {status === 'pending' && (
            <PlanningPanel
              planning={planning}
              cloned={session.cloned}
              busy={busy}
              onStart={onStartPlanning}
              onStop={onStopPlanning}
            />
          )}
          {readyErrors !== null && readyErrors.length > 0 && <PrdErrors errors={readyErrors} title="Mark ready was refused" />}
          {status !== 'pending' && (
            <Panel
              title={status === 'building' ? 'Build' : 'Stories'}
              icon={status === 'building' ? 'pulse' : 'tasklist'}
              meta={<span className="panel__meta mono">{done}/{stories.length} done</span>}
            >
              {status === 'building' && (
                <div className="build-facts">
                  <div className="build-fact">
                    <span className="build-fact__label">Iteration</span>
                    <span className="build-fact__value">
                      {build.iteration}
                      <span className="muted"> / {build.maxIterations}</span>
                    </span>
                  </div>
                  <div className="build-fact">
                    <span className="build-fact__label">Attempt</span>
                    <span className="build-fact__value">{build.attempts + 1}<span className="muted"> / 3</span></span>
                  </div>
                  <div className="build-fact">
                    <span className="build-fact__label">Time limit</span>
                    <span className="build-fact__value">{Math.round(build.agentTimeoutMs / 60000)}<span className="muted"> min</span></span>
                  </div>
                  <div className="build-fact">
                    <span className="build-fact__label">Slots</span>
                    <span className="build-fact__value">{build.activeBuilds}<span className="muted"> / {build.maxConcurrentBuilds}</span></span>
                  </div>
                </div>
              )}
              {build.queued && (
                <p className="muted">
                  Every build slot is taken ({build.activeBuilds} of {build.maxConcurrentBuilds}), so this session is #{build.queuePosition ?? 1} in
                  the queue. It starts on its own when one frees; nothing has been spawned for it yet.
                </p>
              )}
              {status === 'ready' && !build.queued && (
                <p className="muted">
                  Starting the build runs one headless Claude per story, lowest priority first. A story counts as done only when{' '}
                  <code className="mono">{build.prd.path}</code> says so.
                </p>
              )}
              <Progress done={done} total={stories.length} tone={status === 'finished' ? 'final' : status === 'failed' ? 'danger' : 'active'} label="Stories done" />
              <StoryList stories={stories} currentStoryId={status === 'building' ? build.currentStoryId : null} />
            </Panel>
          )}
        </div>

        <aside className="stack">
          <Panel title="Details" icon="info">
            <Facts
              items={[
                { label: 'Repository', value: session.repositoryName },
                { label: 'Branch', value: session.featureBranch, mono: true },
                { label: 'Base', value: session.baseBranch, mono: true },
                { label: 'PR into', value: session.prTargetBranch, mono: true },
                { label: 'Workspace', value: session.cloned ? 'cloned' : 'not cloned' },
                ...(session.prUrl !== null
                  ? [{ label: 'Pull request', value: <a className="link" href={session.prUrl} target="_blank" rel="noreferrer">{session.prUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}</a> }]
                  : []),
                { label: 'Created', value: localTime(session.createdAt) },
                { label: 'Updated', value: localTime(session.updatedAt) },
              ]}
            />
          </Panel>

          <PrdPanel prd={planning.prd} />

          <SchedulePanel session={session} busy={busy} onSave={onSchedule} />
        </aside>
      </div>

      {status !== 'pending' && <BuildLog sessionId={id} building={status === 'building'} />}

      <ConfirmDialog
        open={confirming === 'delete'}
        title={`Delete ${session.name}?`}
        confirmLabel="Delete session"
        busyLabel="Deleting…"
        danger
        busy={busy === 'delete'}
        onConfirm={() => {
          setConfirming(null);
          onDelete();
        }}
        onCancel={() => setConfirming(null)}
      >
        <DeletionWarning session={session} />
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'resume'}
        title="Resume every held session?"
        confirmLabel="Resume all"
        busyLabel="Resuming…"
        busy={busy === 'resume-hold'}
        onConfirm={() => {
          setConfirming(null);
          onResumeNow();
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>
          <strong>This resumes every waiting session, not only this one.</strong> The usage limit is on the Claude
          account the whole server shares, so there is one hold; lifting it starts every held session, as many as the
          build-slot cap allows, with the rest going on the queue in the order they were held.
        </p>
        <p>
          If the limit has in fact not lifted, the first agent to ask is refused again and a fresh hour begins. Nothing is
          lost either way: a refused iteration commits nothing and costs no story.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === 'ready-missed'}
        title="Mark ready and start now?"
        confirmLabel="Mark ready and build"
        busyLabel="Checking…"
        busy={busy === 'ready'}
        onConfirm={() => {
          setConfirming(null);
          onMarkReady();
        }}
        onCancel={() => setConfirming(null)}
      >
        <p>
          This session missed its scheduled start at {localTime(session.scheduledStartAt ?? '')} because it was still
          being planned. Marking it ready parses the PRD and <strong>starts the build immediately</strong>.
        </p>
        <p>Cancel and clear the schedule first if you would rather start it by hand.</p>
      </ConfirmDialog>
    </div>
  );
}

/* --------------------------------------------------------------- stages */

type StageKey = 'plan' | 'ready' | 'build' | 'deliver';

/**
 * Where the session is, as four steps. A failed session marks the step it
 * failed at rather than adding a fifth, because "failed" is not a stage of
 * its own — it is a stage that did not finish.
 */
function Stages({ session, build, prd }: { readonly session: SessionData; readonly build: Build; readonly prd: PrdStatus }) {
  const status = session.status;
  const failedAt: StageKey | null =
    status !== 'failed'
      ? null
      : session.failureStage === 'push' || session.failureStage === 'pull_request'
        ? 'deliver'
        : 'build';
  const current: StageKey =
    status === 'pending' ? 'plan' : status === 'ready' ? 'ready' : status === 'finished' ? 'deliver' : (failedAt ?? 'build');
  const order: StageKey[] = ['plan', 'ready', 'build', 'deliver'];
  const index = order.indexOf(current);
  const done = build.stories.filter((s) => s.status === 'done').length;

  const detail: Record<StageKey, string> = {
    plan: !prd.exists ? 'no PRD yet' : prd.parses ? `${String(prd.storyCount)} ${prd.storyCount === 1 ? 'story' : 'stories'}` : 'PRD does not parse',
    ready: build.queued ? `queued #${String(build.queuePosition ?? 1)}` : session.scheduledStartAt !== null && status === 'ready' ? startsIn(session.scheduledStartAt) : '',
    build:
      status === 'building'
        ? `story ${String(done + 1)} of ${String(build.stories.length)}`
        : status === 'waiting'
          ? 'on hold'
          : build.stories.length > 0
            ? `${String(done)}/${String(build.stories.length)} done`
            : '',
    deliver: session.prUrl !== null ? 'pull request open' : status === 'finished' ? 'no pull request' : '',
  };
  const labels: Record<StageKey, string> = { plan: 'Plan', ready: 'Ready', build: 'Build', deliver: 'Pull request' };

  return (
    <ol className="stages" aria-label="Progress">
      {order.map((stage, i) => {
        const state = failedAt === stage ? 'failed' : i < index || (stage === 'deliver' && status === 'finished') ? 'done' : i === index ? 'current' : 'todo';
        return (
          <li className={`stage stage--${state}`} key={stage} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="stage__marker">
              {state === 'done' ? <Icon name="check" /> : state === 'failed' ? <Icon name="x" /> : i + 1}
            </span>
            <span className="stage__text">
              <span className="stage__label">{labels[stage]}</span>
              {detail[stage] !== '' && <span className="stage__detail">{detail[stage]}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------- planning */

function PlanningPanel({
  planning,
  cloned,
  busy,
  onStart,
  onStop,
}: {
  readonly planning: Planning;
  readonly cloned: boolean;
  readonly busy: Busy;
  readonly onStart: (context: string) => void;
  readonly onStop: () => void;
}) {
  const [context, setContext] = useState('');
  /** Kept apart from `planning.terminalId` so the pane survives an exit. */
  const [attached, setAttached] = useState<string | null>(planning.terminalId);
  const [closed, setClosed] = useState<string | null>(null);

  // A terminal the server still knows about (a reload, or another tab) is
  // attached to straight away; one the operator closed here is not.
  useEffect(() => {
    if (planning.terminalId !== null && planning.terminalId !== closed) setAttached(planning.terminalId);
    if (planning.terminalId === null && !planning.running) setAttached((current) => (current === closed ? null : current));
  }, [planning.terminalId, planning.running, closed]);

  const resume = planning.nextMode === 'edit' || planning.terminalId !== null;
  // Below `lg` the pane is not rendered at all: mounting it would open a
  // WebSocket onto a PTY nothing on screen could show or type into.
  const desktop = useMediaQuery(DESKTOP_QUERY);

  return (
    <Panel
      title="Planning"
      icon="terminal"
      meta={
        <Badge tone={planning.running ? 'active' : 'neutral'} pulse={planning.running}>
          {planning.running ? 'running' : planning.terminalId === null ? 'not started' : 'exited'}
        </Badge>
      }
      actions={
        <>
          {!planning.running && (
            <button
              type="button"
              className={attached === null ? 'button button--primary' : 'button'}
              onClick={() => onStart(context.trim())}
              disabled={busy !== null || !cloned}
            >
              <Icon name="play" />
              {busy === 'start' ? 'Starting…' : resume ? 'Resume planning' : 'Start planning'}
            </button>
          )}
          {planning.terminalId !== null && (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => {
                setClosed(attached);
                setAttached(null);
                onStop();
              }}
              disabled={busy !== null}
            >
              {busy === 'stop' ? 'Closing…' : 'Close terminal'}
            </button>
          )}
        </>
      }
    >
      {attached === null && planning.nextMode === 'create' && (
        <div className="field">
          <label className="field__label" htmlFor="planning-context">
            What do you want to build?
          </label>
          <textarea
            id="planning-context"
            className="field__input"
            rows={3}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            placeholder="A login screen with email and password, rate limited…"
          />
          <p className="field__hint">
            Optional. Passed to Claude as the starting context; it interviews you before writing the PRD either way.
          </p>
        </div>
      )}

      {attached === null && planning.terminalId === null && planning.nextMode === 'edit' && (
        <p className="muted">
          A PRD exists. Resuming starts Claude with chief’s edit prompt in <code className="mono">{planning.cwd}</code>, so the
          existing file is changed rather than rewritten.
        </p>
      )}

      {planning.terminalId !== null && !planning.running && (
        <p className="muted">
          The planning process has exited{planning.exitCode === null ? '' : ` with code ${String(planning.exitCode)}`}.{' '}
          {planning.prd.exists ? 'Resume to edit the PRD it wrote, or mark the session ready.' : 'No PRD was written; resuming starts the questions again.'}
        </p>
      )}

      {attached !== null &&
        (desktop ? (
          <Suspense fallback={<Skeleton lines={6} />}>
            <TerminalPane terminalId={attached} size="tall" />
          </Suspense>
        ) : (
          <Notice kind="info">
            <strong>Terminal access is available on desktop.</strong> Planning is an interactive Claude conversation, which
            needs a keyboard and a screen this narrow cannot give it. The session keeps running on the server; everything
            else on this page — stages, stories, the agent log and the PRD — works here.
          </Notice>
        ))}

      {attached === null && planning.terminalId === null && (
        <p className="field__hint">
          An interactive Claude in this session’s own container, started with chief’s PRD prompt in{' '}
          <code className="mono">{planning.cwd}</code>. The conversation lives on the server, so reloading this page rejoins
          it.
        </p>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ PRD */

function PrdPanel({ prd }: { readonly prd: PrdStatus }) {
  const state = !prd.exists ? 'missing' : prd.parses ? 'ok' : 'broken';
  return (
    <Panel
      title="PRD"
      icon="file"
      meta={
        <Badge tone={state === 'ok' ? 'ready' : state === 'broken' ? 'danger' : 'neutral'}>
          {state === 'missing' ? 'not written' : state === 'ok' ? 'parses' : 'does not parse'}
        </Badge>
      }
    >
      <Facts
        items={[
          { label: 'File', value: prd.path, mono: true },
          ...(prd.exists
            ? [
                { label: 'Stories', value: prd.storyCount },
                { label: 'Written', value: prd.updatedAt === null ? 'unknown' : localTime(prd.updatedAt) },
              ]
            : []),
        ]}
      />
      {!prd.exists && <p className="field__hint">Claude writes it during planning; this updates on its own as soon as the file appears.</p>}
      {prd.exists && !prd.parses && <PrdErrors errors={prd.errors} />}
    </Panel>
  );
}

function PrdErrors({ errors, title }: { readonly errors: readonly PrdParseError[]; readonly title?: string }) {
  return (
    <div className="prd-errors" role="alert">
      {title !== undefined && <p className="prd-errors__title">{title}</p>}
      <ul className="prd-errors__list">
        {errors.map((error) => (
          <li key={`${String(error.line)}-${error.message}`}>
            {error.line > 0 && <span className="mono muted">line {error.line} · </span>}
            {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- stories */

function StoryList({ stories, currentStoryId }: { readonly stories: readonly Story[]; readonly currentStoryId: string | null }) {
  if (stories.length === 0) return <p className="muted">No stories parsed yet.</p>;
  return (
    <ol className="stories">
      {stories.map((story) => {
        const current = story.storyId === currentStoryId;
        return (
          <li className={`story${current ? ' story--current' : ''} story--${STORY_TONE[story.status]}`} key={story.storyId}>
            <span className="story__marker">
              {story.status === 'done' ? <Icon name="check" /> : current ? <span className="dot dot--active dot--pulse" /> : <span className="dot dot--neutral" />}
            </span>
            <span className="story__id mono">{story.storyId}</span>
            <span className="story__title">
              {story.title}
              {current && <span className="story__now"> · running now</span>}
            </span>
            <span className="story__aside mono">
              {story.commitSha === null ? <span className="muted">P{story.priority}</span> : story.commitSha.slice(0, 7)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------- failure */

function FailurePanel({
  error,
  stage,
  stories,
  retryIsDelivery,
}: {
  readonly error: string | null;
  readonly stage: FailureStage | null;
  readonly stories: readonly Story[];
  readonly retryIsDelivery: boolean;
}) {
  const outstanding = stories.filter((story) => story.status !== 'done').length;
  return (
    <Panel
      title={stage === null ? 'This session failed' : `Failed at ${failureStageLabel(stage)}`}
      icon="x-circle"
      tone="danger"
    >
      {error === null ? (
        <p className="muted">No reason was recorded. The agent log below is the next place to look.</p>
      ) : (
        <pre className="output output--wrap">{error}</pre>
      )}
      <p className="field__hint">
        {retryIsDelivery
          ? 'Every story is committed, so nothing is rebuilt: the retry re-runs only the push and the pull request, and adopts an existing pull request for this branch rather than opening a second one.'
          : stage === 'container_lost'
            ? `The workspace is on the data volume, not in the container that was lost. The retry starts a fresh container on the same clone and resumes at the first story that is not done${outstanding === 0 ? '.' : ` (${String(outstanding)} left).`}`
            : `Nothing committed is lost. The retry resumes from the PRD: every story already marked done is skipped${outstanding === 0 ? '.' : `, so ${String(outstanding)} ${outstanding === 1 ? 'is' : 'are'} left to run.`}`}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ hold */

function HoldPanel({ until }: { readonly until: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  // Its own timer rather than the page's poll: this is the one number on the
  // page whose whole job is to keep moving.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  const due = until !== null && new Date(until).getTime() <= now;
  return (
    <Panel
      title="Paused on Claude’s usage limit"
      icon="clock"
      tone="warn"
      meta={until !== null && !due && <span className="panel__meta mono hold-clock">{countdown(until, now)}</span>}
    >
      <p>
        {until === null
          ? 'This session is held until Claude will take work again. It keeps its build slot and starts itself when the hold lifts; nothing has been lost.'
          : due
            ? 'The hold has expired: this session goes back to building at the next check, within a minute. Everything it had committed is still committed.'
            : `The build is paused, not stuck. It carries on by itself at ${localTime(until)}, on the same story, in the same container, with everything already committed.`}
      </p>
      <p className="field__hint">
        The wait is an hour from the refusal, because the refusal does not say how much of the rolling window is left. If you
        know the limit has lifted, “Resume now” puts every held session back to work. “Stop build” returns this one to
        ready and keeps every commit.
      </p>
    </Panel>
  );
}

/* -------------------------------------------------------------- schedule */

function SchedulePanel({
  session,
  busy,
  onSave,
}: {
  readonly session: SessionData;
  readonly busy: Busy;
  readonly onSave: (at: string | null) => void;
}) {
  const schedulable = session.status === 'pending' || session.status === 'ready';
  const stored = (at: string | null): { day: string; time: string } => (at === null ? { day: '', time: '' } : toLocalInputParts(at));
  const [value, setValue] = useState(stored(session.scheduledStartAt));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The stored value the field was last synced with, so a poll cannot fight typing. */
  const [known, setKnown] = useState(session.scheduledStartAt);
  if (known !== session.scheduledStartAt) {
    setKnown(session.scheduledStartAt);
    setValue(stored(session.scheduledStartAt));
  }

  if (!schedulable && session.scheduledStartAt === null) return null;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const at = fromLocalParts(value.day, value.time);
    if (at === null) {
      setError(value.day === '' ? 'Pick a day as well as a time.' : 'Write the time as HH:mm on a 24-hour clock, such as 07:30.');
      return;
    }
    setError(null);
    setEditing(false);
    onSave(at);
  };

  const scheduled = session.scheduledStartAt;
  return (
    <Panel
      title="Schedule"
      icon="calendar"
      meta={
        scheduled !== null && (
          <Badge tone={session.scheduleMissed ? 'danger' : 'wait'}>{session.scheduleMissed ? 'missed' : startsIn(scheduled)}</Badge>
        )
      }
      actions={
        schedulable &&
        !editing && (
          <button type="button" className="button button--small button--quiet" onClick={() => setEditing(true)} disabled={busy !== null}>
            <Icon name="pencil" />
            {scheduled === null ? 'Set' : 'Change'}
          </button>
        )
      }
    >
      {!editing && (
        <p className={scheduled === null ? 'muted' : undefined}>
          {scheduled === null
            ? 'Starts when you press “Start build”.'
            : `Builds at ${localTime(scheduled)}.${schedulable ? '' : ` The schedule cannot change once a session is ${session.status}.`}`}
        </p>
      )}
      {editing && (
        <form className="form form--tight" onSubmit={submit}>
          <div className="field__pair">
            <input
              className="field__input"
              type="date"
              value={value.day}
              onChange={(event) => setValue({ ...value, day: event.target.value })}
              aria-label="Day the build starts"
              autoFocus
            />
            <input
              className="field__input field__input--narrow"
              type="text"
              inputMode="numeric"
              placeholder="HH:mm"
              maxLength={5}
              value={value.time}
              onChange={(event) => setValue({ ...value, time: event.target.value })}
              onBlur={() => {
                const tidy = normaliseTime(value.time);
                if (tidy !== null) setValue({ ...value, time: tidy });
              }}
              aria-label="Time the build starts, 24-hour clock"
              aria-invalid={value.time !== '' && normaliseTime(value.time) === null}
            />
          </div>
          <p className="field__hint">
            Your timezone, 24-hour clock. The session has to be ready by then; a schedule that passes while it is still being
            planned is missed. If every build slot is taken, it queues.
          </p>
          {error !== null && <Notice kind="error">{error}</Notice>}
          <div className="field__actions">
            <button type="submit" className="button button--small button--primary" disabled={busy !== null}>
              {busy === 'schedule' ? 'Saving…' : 'Save'}
            </button>
            {scheduled !== null && (
              <button
                type="button"
                className="button button--small button--quiet"
                onClick={() => {
                  setEditing(false);
                  setValue({ day: '', time: '' });
                  onSave(null);
                }}
                disabled={busy !== null}
              >
                Clear schedule
              </button>
            )}
            <button type="button" className="button button--small button--quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}

