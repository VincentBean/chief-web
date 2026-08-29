import { useCallback, useEffect, useState } from 'react';

import {
  api,
  ApiError,
  closeTerminal,
  type Container,
  createTerminal,
  fetchContainers,
  fetchTerminals,
  type Terminal,
} from './api.ts';
import { type PaneStatus, TerminalPane } from './TerminalPane.tsx';

/** Query parameter holding the attached terminal, so a reload rejoins it. */
const TERMINAL_PARAM = 'id';

const STATUS_LABEL: Record<PaneStatus, string> = {
  connecting: 'connecting…',
  connected: 'connected',
  reconnecting: 'reconnecting…',
  closed: 'disconnected',
};

function currentTerminalId(): string | null {
  return new URLSearchParams(window.location.search).get(TERMINAL_PARAM);
}

/**
 * Puts the attached terminal in the URL. The server-side PTY outlives the tab,
 * so the id is the only thing a reload needs in order to pick the session back
 * up — no local storage, and the URL can be shared or bookmarked.
 */
function rememberTerminal(id: string | null): void {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete(TERMINAL_PARAM);
  else url.searchParams.set(TERMINAL_PARAM, id);
  window.history.replaceState(null, '', url);
}

export function Terminals() {
  const [containers, setContainers] = useState<Container[]>([]);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [selected, setSelected] = useState<string | null>(currentTerminalId());
  const [container, setContainer] = useState('');
  const [command, setCommand] = useState('');
  const [status, setStatus] = useState<PaneStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const [openTerminals, running] = await Promise.all([
      fetchTerminals(signal),
      fetchContainers(signal).catch((cause: unknown) => {
        // Docker being down must not hide the terminals that are already open.
        setError(describe(cause));
        return [] as Container[];
      }),
    ]);
    setTerminals(openTerminals);
    setContainers(running);
    setContainer((current) => (current === '' ? (running[0]?.id ?? '') : current));
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    refresh(controller.signal)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(describe(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    api('/api/auth/session', { signal: controller.signal }).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) window.location.replace('/login');
    });

    return () => controller.abort();
  }, [refresh]);

  const attach = (id: string | null): void => {
    setSelected(id);
    setStatus('connecting');
    rememberTerminal(id);
  };

  const onOpen = (): void => {
    setBusy(true);
    setError(null);
    const parts = command.trim() === '' ? undefined : command.trim().split(/\s+/);
    createTerminal({ container, ...(parts === undefined ? {} : { command: parts }) })
      .then((terminal) => {
        setTerminals((current) => [...current, terminal]);
        attach(terminal.id);
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  const onClose = (id: string): void => {
    setBusy(true);
    closeTerminal(id)
      .then(() => {
        setTerminals((current) => current.filter((terminal) => terminal.id !== id));
        if (selected === id) attach(null);
      })
      .catch((cause: unknown) => setError(describe(cause)))
      .finally(() => setBusy(false));
  };

  const active = terminals.find((terminal) => terminal.id === selected) ?? null;

  return (
    <main className="shell shell--wide">
      <header className="topbar">
        <h1>Terminal</h1>
        <a className="link" href="/">
          Back
        </a>
      </header>

      <p className="tagline">
        A real shell inside a container. The process runs on the server, so closing this tab or
        reloading the page leaves it running — reopen the same terminal to pick up where you left
        off.
      </p>

      {error === null ? null : <p className="notice notice--error">{error}</p>}

      <section className="form form--card">
        <div className="field">
          <label className="field__label" htmlFor="terminal-container">
            Container
          </label>
          <select
            id="terminal-container"
            className="field__input"
            value={container}
            onChange={(event) => setContainer(event.target.value)}
            disabled={containers.length === 0}
          >
            {containers.length === 0 ? <option value="">No running containers</option> : null}
            {containers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {item.image}
              </option>
            ))}
          </select>
          <p className="field__hint">
            Session containers appear here once a session is running. Any other running container
            works too.
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="terminal-command">
            Command (optional)
          </label>
          <input
            id="terminal-command"
            className="field__input"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="bash -l"
          />
          <p className="field__hint">Leave empty for a login shell.</p>
        </div>

        <div className="field__actions">
          <button
            type="button"
            className="button"
            onClick={onOpen}
            disabled={busy || container === ''}
          >
            Open terminal
          </button>
        </div>
      </section>

      {loading ? <p className="tagline">Loading…</p> : null}

      {terminals.length === 0 ? null : (
        <ul className="tabs">
          {terminals.map((terminal) => (
            <li key={terminal.id}>
              <button
                type="button"
                className={`tab${terminal.id === selected ? ' tab--active' : ''}`}
                onClick={() => attach(terminal.id)}
              >
                {terminal.containerName}
                <span className="tab__meta">
                  {terminal.status === 'running' ? 'running' : `exited ${terminal.exitCode ?? '?'}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected === null ? (
        <p className="tagline">
          {terminals.length === 0
            ? 'No terminals open yet.'
            : 'Select a terminal above to attach to it.'}
        </p>
      ) : (
        <section className="card">
          <div className="card__header">
            <h2 className="card__title mono">{active?.containerName ?? selected}</h2>
            <div className="field__actions">
              <span className={`health health--${status === 'connected' ? 'ok' : 'error'}`}>
                {STATUS_LABEL[status]}
              </span>
              <button
                type="button"
                className="button button--quiet button--danger"
                onClick={() => onClose(selected)}
                disabled={busy}
              >
                Close terminal
              </button>
            </div>
          </div>
          <TerminalPane
            terminalId={selected}
            onStatus={setStatus}
            onExit={(exitCode) => {
              setTerminals((current) =>
                current.map((terminal) =>
                  terminal.id === selected ? { ...terminal, status: 'exited', exitCode } : terminal,
                ),
              );
            }}
          />
          <p className="field__hint">
            Copy with Ctrl+Shift+C (or Ctrl+Insert), paste with Ctrl+Shift+V (or Ctrl+V). The
            terminal resizes with the window.
          </p>
        </section>
      )}
    </main>
  );
}

function describe(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : String(cause);
}
