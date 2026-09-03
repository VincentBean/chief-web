import { lazy, Suspense, useCallback, useEffect, useState } from 'react';

import { closeTerminal, type Container, createTerminal, fetchContainers, fetchTerminals, type Terminal } from '../api.ts';
import { DESKTOP_QUERY, describeError, redirectIfUnauthorised, useMediaQuery } from '../data.tsx';
import { Icon } from '../Icon.tsx';
import { replaceSearch, useLocation } from '../router.tsx';
import { since } from '../schedule.ts';
import type { PaneStatus } from '../TerminalPane.tsx';
import { useToast } from '../toast.tsx';
import { Badge, EmptyState, Notice, PageHeader, Panel, Skeleton } from '../ui.tsx';

const TerminalPane = lazy(() => import('../TerminalPane.tsx').then((module) => ({ default: module.TerminalPane })));

/** Query parameter holding the attached terminal, so a reload rejoins it. */
const TERMINAL_PARAM = 'id';

const STATUS_LABEL: Record<PaneStatus, string> = {
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  closed: 'disconnected',
};

/**
 * Browser terminals: a real PTY in a running container, streamed over a
 * WebSocket. The server owns the process, so closing the tab only detaches a
 * viewer; the id in the URL is all a reload needs to rejoin.
 */
export function Terminals() {
  const { search } = useLocation();
  const toast = useToast();
  const selected = new URLSearchParams(search).get(TERMINAL_PARAM);
  const [containers, setContainers] = useState<Container[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [status, setStatus] = useState<PaneStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [command, setCommand] = useState('');
  // A PTY needs a keyboard and a screen wider than a phone, so below `lg`
  // nothing here is rendered — not the manager, and not a fetch to fill it.
  const desktop = useMediaQuery(DESKTOP_QUERY);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const [openTerminals, running] = await Promise.all([
      fetchTerminals(signal),
      fetchContainers(signal).catch((cause: unknown) => {
        // Docker being down must not hide the terminals that are already open.
        setError(describeError(cause));
        return [] as Container[];
      }),
    ]);
    setTerminals(openTerminals);
    setContainers(running);
  }, []);

  useEffect(() => {
    if (!desktop) return;
    const controller = new AbortController();
    refresh(controller.signal)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (redirectIfUnauthorised(cause)) return;
        setError(describeError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [desktop, refresh]);

  const attach = (id: string | null): void => {
    setStatus('connecting');
    const params = new URLSearchParams(window.location.search);
    if (id === null) params.delete(TERMINAL_PARAM);
    else params.set(TERMINAL_PARAM, id);
    replaceSearch(params);
  };

  const onOpen = (container: Container): void => {
    setBusy(container.id);
    setError(null);
    const parts = command.trim() === '' ? undefined : command.trim().split(/\s+/);
    createTerminal({ container: container.id, ...(parts === undefined ? {} : { command: parts }) })
      .then((terminal) => {
        setTerminals((current) => [...current, terminal]);
        attach(terminal.id);
      })
      .catch((cause: unknown) => toast.error(describeError(cause)))
      .finally(() => setBusy(null));
  };

  const onClose = (id: string): void => {
    setBusy(id);
    closeTerminal(id)
      .then(() => {
        setTerminals((current) => current.filter((terminal) => terminal.id !== id));
        if (selected === id) attach(null);
      })
      .catch((cause: unknown) => toast.error(describeError(cause)))
      .finally(() => setBusy(null));
  };

  const active = terminals.find((terminal) => terminal.id === selected) ?? null;

  if (!desktop) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Terminals" subtitle="A shell inside a running container." />
        <EmptyState icon="terminal" title="Terminals need a desktop">
          A container shell is an interactive terminal: it wants a keyboard, copy and paste, and a screen wider than this one.
          Open this page on a desktop to attach. Terminals you have already opened keep running on the server, so they are
          waiting there when you do.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="page page--full">
      <PageHeader
        title="Terminals"
        subtitle="A shell inside a running container. The process lives on the server, so a reload rejoins it."
      />

      {error !== null && <Notice kind="error">{error}</Notice>}

      <div className="grid grid--aside-main terminals">
        <aside className="stack">
          <Panel title="Containers" icon="package" meta={<span className="panel__meta muted">{containers.length}</span>}>
            {loading ? (
              <Skeleton lines={3} />
            ) : containers.length === 0 ? (
              <p className="muted">No running containers. Session containers appear here once a session is running.</p>
            ) : (
              <>
                <ul className="rows rows--tight">
                  {containers.map((container) => (
                    <li className="row" key={container.id}>
                      <div className="row__main">
                        <span className="row__title mono">{container.name}</span>
                        <span className="row__meta">{container.image}</span>
                      </div>
                      <button
                        type="button"
                        className="button button--small"
                        onClick={() => onOpen(container)}
                        disabled={busy !== null}
                        title={command.trim() === '' ? 'Open a login shell' : `Run ${command.trim()}`}
                      >
                        <Icon name="terminal" />
                        {busy === container.id ? 'Opening…' : 'Shell'}
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="field">
                  <label className="field__label" htmlFor="terminal-command">
                    Command
                  </label>
                  <input
                    id="terminal-command"
                    className="field__input mono"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder="bash -l"
                    spellCheck={false}
                  />
                  <p className="field__hint">Leave empty for a login shell.</p>
                </div>
              </>
            )}
          </Panel>

          <Panel title="Open terminals" icon="terminal" meta={<span className="panel__meta muted">{terminals.length}</span>}>
            {terminals.length === 0 ? (
              <p className="muted">None yet. Open a shell in a container above.</p>
            ) : (
              <ul className="rows rows--tight">
                {terminals.map((terminal) => (
                  <li className={`row row--selectable${terminal.id === selected ? ' row--selected' : ''}`} key={terminal.id}>
                    <button type="button" className="row__button" onClick={() => attach(terminal.id)} aria-current={terminal.id === selected ? 'true' : undefined}>
                      <span className="dot dot--done" style={terminal.status === 'running' ? undefined : { opacity: 0.35 }} />
                      <span className="row__main">
                        <span className="row__title mono">{terminal.containerName}</span>
                        <span className="row__meta">
                          {terminal.status === 'running' ? 'running' : `exited ${String(terminal.exitCode ?? '?')}`} · {terminal.command.join(' ') || 'shell'} ·{' '}
                          {since(terminal.lastActivityAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="button button--small button--quiet button--danger button--icon"
                      onClick={() => onClose(terminal.id)}
                      disabled={busy !== null}
                      aria-label={`Close terminal in ${terminal.containerName}`}
                      title="Close terminal"
                    >
                      <Icon name="x" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>

        <div className="stack">
          {selected === null ? (
            <EmptyState icon="terminal" title={terminals.length === 0 ? 'No terminal open' : 'Pick a terminal'}>
              {terminals.length === 0
                ? 'Open a shell in a container to start. Copy with Ctrl+Shift+C, paste with Ctrl+Shift+V.'
                : 'Select an open terminal on the left to attach to it.'}
            </EmptyState>
          ) : (
            <Panel
              title={<span className="mono">{active?.containerName ?? selected}</span>}
              icon="terminal"
              meta={
                <Badge tone={status === 'connected' ? 'done' : status === 'closed' ? 'danger' : 'wait'} pulse={status === 'connecting' || status === 'reconnecting'}>
                  {STATUS_LABEL[status]}
                </Badge>
              }
              actions={
                <button type="button" className="button button--small button--quiet button--danger" onClick={() => onClose(selected)} disabled={busy !== null}>
                  <Icon name="x" />
                  Close terminal
                </button>
              }
              className="panel--terminal"
            >
              <Suspense fallback={<Skeleton lines={6} />}>
                <TerminalPane
                  terminalId={selected}
                  size="tall"
                  onStatus={setStatus}
                  onExit={(exitCode) => {
                    setTerminals((current) =>
                      current.map((terminal) => (terminal.id === selected ? { ...terminal, status: 'exited', exitCode } : terminal)),
                    );
                  }}
                />
              </Suspense>
              <p className="field__hint">Copy with Ctrl+Shift+C (or Ctrl+Insert), paste with Ctrl+Shift+V (or Ctrl+V). The terminal resizes with the window.</p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
