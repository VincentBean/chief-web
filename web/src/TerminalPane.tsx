import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

import { terminalSocketUrl } from './api.ts';

/** How the pane's own connection is doing, shown above the terminal. */
export type PaneStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

interface Props {
  /** Terminal id from the server; changing it re-attaches to another PTY. */
  readonly terminalId: string;
  readonly onStatus?: (status: PaneStatus) => void;
  readonly onExit?: (exitCode: number | null) => void;
}

/** Control frames the server sends as text; output arrives as binary frames. */
interface ServerMessage {
  type?: string;
  exitCode?: number | null;
  message?: string;
}

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

/**
 * An xterm.js view bound to a server-side PTY over a WebSocket.
 *
 * The server owns the terminal, so this component is disposable: unmounting it
 * (or closing the tab) only drops a listener, and mounting it again replays the
 * scrollback the server kept. That is why every `attached` message resets the
 * screen first — a reconnect re-sends the history, and drawing it twice would
 * show the same output stacked.
 */
export function TerminalPane({ terminalId, onStatus, onExit }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Callbacks are read through a ref so a parent re-render never tears down
  // and reconnects the socket.
  const handlers = useRef({ onStatus, onExit });
  handlers.current = { onStatus, onExit };

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, 'Cascadia Mono', monospace",
      fontSize: 13,
      // The browser keeps its own scrollback on top of the server's replay.
      scrollback: 5000,
      rightClickSelectsWord: true,
      theme: { background: '#010409', foreground: '#e6edf3', cursor: '#e6edf3' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();

    const encoder = new TextEncoder();
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | undefined;
    let disposed = false;

    const status = (next: PaneStatus): void => handlers.current.onStatus?.(next);

    const connect = (): void => {
      if (disposed) return;
      status(attempt === 0 ? 'connecting' : 'reconnecting');

      const ws = new WebSocket(terminalSocketUrl(terminalId));
      ws.binaryType = 'arraybuffer';
      socket = ws;

      ws.onopen = () => {
        attempt = 0;
        setError(null);
        status('connected');
        // The server sized the PTY from the create request; make sure it
        // matches what this browser is actually showing.
        sendResize(term.cols, term.rows);
      };

      ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data !== 'string') {
          term.write(new Uint8Array(event.data));
          return;
        }
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'attached') {
          // Everything that follows is the authoritative scrollback.
          term.reset();
        } else if (message.type === 'exit') {
          handlers.current.onExit?.(message.exitCode ?? null);
          term.write(
            `\r\n\u001b[33m[process exited${
              message.exitCode === null || message.exitCode === undefined
                ? ''
                : ` with code ${message.exitCode}`
            }]\u001b[0m\r\n`,
          );
        } else if (message.type === 'error') {
          setError(message.message ?? 'The server rejected a terminal message.');
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (disposed || socket !== ws) return;
        status('closed');
        if (event.code === 4404) {
          setError('This terminal is no longer available on the server.');
          return;
        }
        if (event.code === 4401) {
          window.location.replace('/login');
          return;
        }
        const delay = RECONNECT_DELAYS_MS[attempt];
        if (delay === undefined) {
          setError('Lost the connection to the terminal. Reload the page to try again.');
          return;
        }
        attempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    const sendResize = (cols: number, rows: number): void => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    };

    const onData = term.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    const onResize = term.onResize(({ cols, rows }) => sendResize(cols, rows));

    // Ctrl+Shift+C/V and the Insert variants: the terminal must not swallow
    // them, and the browser's own Ctrl+Shift+C opens devtools instead.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const copy =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyC') ||
        (event.ctrlKey && event.code === 'Insert');
      if (copy && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection());
        return false;
      }
      const paste =
        (event.ctrlKey && event.shiftKey && event.code === 'KeyV') ||
        (event.shiftKey && event.code === 'Insert');
      if (paste) {
        void navigator.clipboard
          .readText()
          .then((text) => term.paste(text))
          .catch(() => setError('The browser blocked reading the clipboard.'));
        return false;
      }
      return true;
    });

    // Fit on any layout change: a window resize, the sidebar wrapping, or the
    // pane being revealed. `fit()` triggers `onResize`, which tells the PTY.
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // The host is detached (or zero-sized) mid-teardown; nothing to do.
      }
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    window.addEventListener('resize', refit);

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      observer.disconnect();
      window.removeEventListener('resize', refit);
      onData.dispose();
      onResize.dispose();
      // Closing the socket detaches this viewer; the PTY keeps running.
      socket?.close();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="terminal">
      {error === null ? null : <p className="notice notice--error">{error}</p>}
      <div className="terminal__screen" ref={hostRef} />
    </div>
  );
}
