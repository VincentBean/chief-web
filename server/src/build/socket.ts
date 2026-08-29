import { logger } from '../lib/logger.js';
import type { WebSocketRoute } from '../ws/gateway.js';
import type { BuildLogEvent, BuildLogHistory, BuildLogStore } from './log.js';

/** Upgrade path a session page attaches to; `:id` is the session id. */
export const BUILD_LOG_WS_PATH = '/api/sessions/:id/build/log';

/** No session with that id. */
export const WS_CLOSE_SESSION_NOT_FOUND = 4404;

/** The client stopped reading and the backlog grew past {@link MAX_BUFFERED_BYTES}. */
export const WS_CLOSE_TOO_SLOW = 4408;

/** Ceiling on unacknowledged log output per tab; the file holds the truth. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Keeps idle connections alive through proxies that time out silent sockets. */
const HEARTBEAT_MS = 30_000;

/** Server → client. Everything is JSON: a log line is text, not bytes. */
export type BuildLogMessage =
  | { readonly type: 'attached'; readonly history: BuildLogHistory }
  | BuildLogEvent;

/**
 * Streams a session's build log to a browser (US-016).
 *
 * Attaching replays the whole history first and then follows, so a tab opened
 * halfway through an iteration shows the same thing as one that watched from
 * the start, and one opened after the build ended shows the finished sections.
 * Nothing here can affect the loop: detaching drops a listener, and that is all.
 */
export function createBuildLogSocketRoute(logs: BuildLogStore): WebSocketRoute {
  return {
    path: BUILD_LOG_WS_PATH,
    handle(socket, _req, params) {
      const id = params['id'] ?? '';

      const send = (message: BuildLogMessage): void => {
        if (socket.readyState !== socket.OPEN) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
          logger.warn('build log client too slow, disconnecting', { session: id });
          socket.close(WS_CLOSE_TOO_SLOW, 'client_too_slow');
          return;
        }
        socket.send(JSON.stringify(message));
      };

      const attachment = logs.attach(id, (event) => send(event));
      if (attachment === null) {
        socket.close(WS_CLOSE_SESSION_NOT_FOUND, 'session_not_found');
        return;
      }
      send({ type: 'attached', history: attachment.history });

      const heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, HEARTBEAT_MS);
      // Node would otherwise keep the process alive for an idle watcher.
      heartbeat.unref();

      const cleanup = (): void => {
        clearInterval(heartbeat);
        attachment.detach();
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      logger.debug('build log client attached', { session: id });
    },
  };
}

/** Path a client connects to for session `id`. */
export function buildLogSocketPath(id: string): string {
  return BUILD_LOG_WS_PATH.replace(':id', encodeURIComponent(id));
}
