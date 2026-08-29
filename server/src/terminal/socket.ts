import { logger } from '../lib/logger.js';
import type { WebSocketRoute } from '../ws/gateway.js';
import type { TerminalManager } from './manager.js';
import { parseClientMessage, type ServerMessage } from './protocol.js';

/** Upgrade path a browser tab attaches to; `:id` is the terminal id. */
export const TERMINAL_WS_PATH = '/api/terminals/:id/stream';

/** No terminal with that id (it was never created, or has been closed). */
export const WS_CLOSE_TERMINAL_NOT_FOUND = 4404;

/** The client stopped reading and the backlog grew past {@link MAX_BUFFERED_BYTES}. */
export const WS_CLOSE_TOO_SLOW = 4408;

/**
 * Ceiling on unacknowledged output per tab. Past this the connection is closed
 * rather than allowed to consume the server's memory: the scrollback is held
 * server-side, so reconnecting restores the view.
 */
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

/** Keeps idle connections alive through proxies that time out silent sockets. */
const HEARTBEAT_MS = 30_000;

/**
 * Bridges a browser WebSocket to a PTY held by the {@link TerminalManager}.
 *
 * Attaching is cheap and repeatable, which is the whole point: a page refresh
 * opens a new socket to the same terminal id, gets the scrollback replayed, and
 * carries on typing into the same shell. Nothing here can end the process —
 * only `DELETE /api/terminals/:id` does.
 */
export function createTerminalSocketRoute(terminals: TerminalManager): WebSocketRoute {
  return {
    path: TERMINAL_WS_PATH,
    handle(socket, _req, params) {
      const id = params['id'] ?? '';
      const terminal = terminals.get(id);
      if (terminal === undefined) {
        socket.close(WS_CLOSE_TERMINAL_NOT_FOUND, 'terminal_not_found');
        return;
      }

      const send = (message: ServerMessage): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };

      const replay = terminal.replay();
      send({ type: 'attached', terminal: terminal.toView(), replayBytes: replay.length });
      if (replay.length > 0) socket.send(replay, { binary: true });

      const detach = terminal.attach({
        onData: (chunk) => {
          if (socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
            logger.warn('terminal client too slow, disconnecting', { terminal: id });
            socket.close(WS_CLOSE_TOO_SLOW, 'client_too_slow');
            return;
          }
          socket.send(chunk, { binary: true });
        },
        onExit: (exitCode) => send({ type: 'exit', exitCode }),
      });

      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          terminal.write(data);
          return;
        }
        const message = parseClientMessage(data.toString('utf8'));
        if (message === null) {
          send({ type: 'error', message: 'Unsupported control message.' });
          return;
        }
        void terminal.resize({ cols: message.cols, rows: message.rows });
      });

      const heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, HEARTBEAT_MS);
      // Node would otherwise keep the process alive for an idle terminal.
      heartbeat.unref();

      const cleanup = (): void => {
        clearInterval(heartbeat);
        detach();
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      logger.debug('terminal client attached', { terminal: id });
    },
  };
}

/** Path a client connects to for terminal `id`. */
export function terminalSocketPath(id: string): string {
  return TERMINAL_WS_PATH.replace(':id', encodeURIComponent(id));
}
