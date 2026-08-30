import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  type BuildLogEvent,
  type BuildLogHistory,
  type BuildLogIteration,
  type BuildLogMessage,
  buildLogSocketUrl,
} from './api.ts';
import { localClock } from './schedule.ts';

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
 * undone a second later. "Pause" is the same switch, made explicit.
 */
export function BuildLog({ sessionId, building }: Props) {
  const [iterations, setIterations] = useState<BuildLogIteration[]>([]);
  const [meta, setMeta] = useState<Pick<BuildLogHistory, 'path' | 'truncated'> | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);

  const viewRef = useRef<HTMLDivElement>(null);
  // Read inside the scroll handler, which must not be re-created per render.
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
          // Everything that follows is the authoritative history; a reconnect
          // replays it, and keeping the old copy would show it twice.
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
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight <= STICK_THRESHOLD_PX;
    setFollowing(atBottom);
  }, []);

  const total = iterations.length;
  const empty = total === 0;

  return (
    <section className="card">
      <div className="card__header">
        <h2 className="card__title">
          Agent log{' '}
          <span className={LOG_BADGE[label(connection, building)]}>
            {label(connection, building)}
          </span>
        </h2>
        <div className="field__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              const view = viewRef.current;
              if (!following && view !== null) view.scrollTop = view.scrollHeight;
              setFollowing((current) => !current);
            }}
            disabled={empty}
          >
            {following ? 'Pause scrolling' : 'Resume scrolling'}
          </button>
        </div>
      </div>

      {error !== null && (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      )}

      {meta !== null && (
        <p className="field__hint">
          Everything the agents print is appended to <code className="mono">{meta.path}</code> in the
          workspace, so this is a view of a file rather than of a process.
          {meta.truncated && ' Older iterations have been dropped from this view; the file has them all.'}
        </p>
      )}

      <div className="log" ref={viewRef} onScroll={onScroll}>
        {empty ? (
          <p className="log__empty">
            {building
              ? 'Waiting for the first output of this iteration…'
              : 'No agent output yet. It appears here as soon as a build starts.'}
          </p>
        ) : (
          iterations.map((iteration, index) => (
            <section className="log__section" key={`${String(index)}-${iteration.startedAt}`}>
              <h3 className="log__heading">
                Iteration {iteration.iteration}
                {iteration.storyId === null ? '' : ` · ${iteration.storyId}`}
                <span className="log__meta">
                  {' '}
                  {localClock(iteration.startedAt)} ·{' '}
                  {iteration.endedAt === null
                    ? 'running'
                    : iteration.exitCode === null
                      ? 'ended without an exit code'
                      : `exit ${String(iteration.exitCode)}`}
                </span>
              </h3>
              <pre className="log__body">{iteration.text}</pre>
            </section>
          ))
        )}
      </div>
    </section>
  );
}

/** Applies one live event to the sections already on screen. */
function apply(current: BuildLogIteration[], message: BuildLogEvent): BuildLogIteration[] {
  if (message.type === 'begin') {
    return [
      ...current,
      {
        iteration: message.iteration,
        storyId: message.storyId,
        startedAt: message.startedAt,
        endedAt: null,
        exitCode: null,
        text: '',
      },
    ];
  }

  // `append` and `end` always belong to the newest section: the loop runs one
  // iteration at a time, and the server opens a section before writing to it.
  // There is one way to have none — a log file the server could not write, so
  // the replayed history was empty — and dropping the output would be worse
  // than showing it under a section with no header of its own.
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

/**
 * The log's own state, which is not the session's: `live` means bytes are
 * arriving, `idle` means the socket is up but the build has stopped. Both the
 * pill's text and its colour come from this one value, so they cannot drift.
 */
function label(connection: Connection, building: boolean): LogState {
  if (connection === 'live') return building ? 'live' : 'idle';
  // `closed` is the socket's word for it; `disconnected` is what an operator
  // reading a pill needs to see.
  return connection === 'closed' ? 'disconnected' : connection;
}

type LogState = 'live' | 'idle' | 'connecting' | 'reconnecting' | 'disconnected';

const LOG_BADGE: Record<LogState, string> = {
  live: 'badge badge--live',
  idle: 'badge badge--idle',
  connecting: 'badge badge--connecting',
  reconnecting: 'badge badge--reconnecting',
  disconnected: 'badge badge--disconnected',
};
