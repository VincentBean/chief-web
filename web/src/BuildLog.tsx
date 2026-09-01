import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { type BuildLogEvent, type BuildLogHistory, type BuildLogIteration, type BuildLogMessage, buildLogSocketUrl } from './api.ts';
import { Icon } from './Icon.tsx';
import { localClock } from './schedule.ts';
import { Badge, Notice, Panel, type Tone } from './ui.tsx';

/** How the pane's own connection is doing, shown next to the title. */
type Connection = 'connecting' | 'live' | 'reconnecting' | 'closed';

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/** Distance from the bottom still counted as "at the bottom", in pixels. */
const STICK_THRESHOLD_PX = 40;

interface Props {
  readonly sessionId: string;
  /** True while the loop is running, which is when live output is expected. */
  readonly building: boolean;
}

/**
 * The live build log of a session (US-016).
 *
 * The server owns the log — it is a file in the workspace — so this component
 * is disposable in exactly the way `TerminalPane` is: attaching replays every
 * iteration written so far and then follows, so opening the page halfway
 * through a build, reloading it, or coming back the next day all show the same
 * thing. Closing the tab does not touch the loop.
 *
 * Following is sticky rather than forced: new output scrolls the view only
 * while the reader is at the bottom, so scrolling up to read something is not
 * undone a second later.
 */
export function BuildLog({ sessionId, building }: Props) {
  const [iterations, setIterations] = useState<BuildLogIteration[]>([]);
  const [meta, setMeta] = useState<Pick<BuildLogHistory, 'path' | 'truncated'> | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const viewRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      setConnection(attempt === 0 ? 'connecting' : 'reconnecting');
      const ws = new WebSocket(buildLogSocketUrl(sessionId));
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        setError(null);
        setConnection('live');
      };
      ws.onmessage = (event: MessageEvent<string>) => {
        const message = JSON.parse(event.data) as BuildLogMessage;
        if (message.type === 'attached') {
          setMeta({ path: message.history.path, truncated: message.history.truncated });
          setIterations(message.history.iterations);
          return;
        }
        setIterations((current) => apply(current, message));
      };
      ws.onclose = (event: CloseEvent) => {
        if (disposed || socket !== ws) return;
        setConnection('closed');
        if (event.code === 4401) {
          window.location.replace('/login');
          return;
        }
        if (event.code === 4404) {
          setError('This session is no longer available on the server.');
          return;
        }
        const delay = RECONNECT_DELAYS_MS[attempt];
        if (delay === undefined) {
          setError('Lost the connection to the build log. Reload the page to reconnect.');
          return;
        }
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [sessionId]);

  // Layout effect, not a plain one: scrolling after the browser has painted the
  // new lines is a visible jump.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view !== null && followingRef.current) view.scrollTop = view.scrollHeight;
  }, [iterations]);

  /** Scrolling up pauses; scrolling back to the bottom resumes. */
  const onScroll = useCallback((): void => {
    const view = viewRef.current;
    if (view === null) return;
    setFollowing(view.scrollHeight - view.scrollTop - view.clientHeight <= STICK_THRESHOLD_PX);
  }, []);

  const empty = iterations.length === 0;
  const state = label(connection, building);

  return (
    <Panel
      title="Agent log"
      icon="terminal"
      meta={
        <>
          <Badge tone={LOG_TONE[state]} pulse={state === 'live'}>
            {state}
          </Badge>
          {!empty && (
            <span className="panel__meta muted">
              {iterations.length} {iterations.length === 1 ? 'iteration' : 'iterations'}
            </span>
          )}
        </>
      }
      actions={
        <>
          <button
            type="button"
            className="button button--small button--quiet"
            onClick={() => {
              const view = viewRef.current;
              if (!following && view !== null) view.scrollTop = view.scrollHeight;
              setFollowing((current) => !current);
            }}
            disabled={empty}
            aria-pressed={following}
          >
            <Icon name={following ? 'pulse' : 'chevron-down'} />
            {following ? 'Following' : 'Jump to end'}
          </button>
          <button type="button" className="button button--small button--quiet" onClick={() => setExpanded((current) => !current)} disabled={empty} aria-pressed={expanded}>
            {expanded ? 'Shorter' : 'Taller'}
          </button>
        </>
      }
      className="panel--log"
    >
      {error !== null && <Notice kind="error">{error}</Notice>}

      <div className={`log${expanded ? ' log--tall' : ''}`} ref={viewRef} onScroll={onScroll}>
        {empty ? (
          <p className="log__empty">{building ? 'Waiting for the first output of this iteration…' : 'No agent output yet. It appears here as soon as a build starts.'}</p>
        ) : (
          iterations.map((iteration, index) => (
            <section className="log__section" key={`${String(index)}-${iteration.startedAt}`}>
              <h3 className="log__heading">
                <span className="log__iteration">#{iteration.iteration}</span>
                {iteration.storyId !== null && <span className="log__story">{iteration.storyId}</span>}
                <span className="log__meta">
                  {localClock(iteration.startedAt)} ·{' '}
                  {iteration.endedAt === null ? (
                    <span className="text-active">running</span>
                  ) : iteration.exitCode === null ? (
                    'ended without an exit code'
                  ) : iteration.exitCode === 0 ? (
                    <span className="text-done">exit 0</span>
                  ) : (
                    <span className="text-danger">exit {iteration.exitCode}</span>
                  )}
                </span>
              </h3>
              <pre className="log__body">{iteration.text}</pre>
            </section>
          ))
        )}
      </div>

      {meta !== null && (
        <p className="field__hint">
          A view of <code className="mono">{meta.path}</code> in the workspace, not of a process: it survives reloads and restarts.
          {meta.truncated && ' Older iterations were dropped from this view; the file has them all.'}
        </p>
      )}
    </Panel>
  );
}

/** Applies one live event to the sections already on screen. */
function apply(current: BuildLogIteration[], message: BuildLogEvent): BuildLogIteration[] {
  if (message.type === 'begin') {
    return [
      ...current,
      { iteration: message.iteration, storyId: message.storyId, startedAt: message.startedAt, endedAt: null, exitCode: null, text: '' },
    ];
  }
  const last = current[current.length - 1] ?? {
    iteration: 0,
    storyId: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    text: '',
  };
  const head = current.slice(0, -1);
  return message.type === 'append'
    ? [...head, { ...last, text: last.text + message.text }]
    : [...head, { ...last, endedAt: message.endedAt, exitCode: message.exitCode }];
}

type LogState = 'live' | 'idle' | 'connecting' | 'reconnecting' | 'disconnected';

function label(connection: Connection, building: boolean): LogState {
  if (connection === 'live') return building ? 'live' : 'idle';
  return connection === 'closed' ? 'disconnected' : connection;
}

const LOG_TONE: Record<LogState, Tone> = {
  live: 'active',
  idle: 'neutral',
  connecting: 'wait',
  reconnecting: 'wait',
  disconnected: 'danger',
};
