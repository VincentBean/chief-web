import type { IncomingMessage } from 'node:http';

import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { WebSocketRoute } from '../ws/gateway.js';
import { WS_CLOSE_BAD_ORIGIN, WS_CLOSE_NOT_CONFIGURED } from './protocol.js';
import { type VoiceService, voiceReadiness } from './service.js';

export const VOICE_WS_PATH = '/api/voice/stream';

/**
 * The call socket (voice US-007; docs/voice-plan.md §6). Registered on the shared
 * `WebSocketGateway`, so the session cookie is checked before `handle` runs.
 * A voice socket is more sensitive than a log stream (docs/voice-plan.md §17), so it also
 * requires the browser's `Origin` to be `PUBLIC_URL` when that is set.
 */
export function createVoiceSocketRoute(service: VoiceService, config: Config, db: Database): WebSocketRoute {
  return {
    path: VOICE_WS_PATH,
    handle(socket, req) {
      if (!originAllowed(req, config.publicUrl)) {
        logger.warn('rejected voice socket from another origin', { origin: req.headers.origin });
        socket.close(WS_CLOSE_BAD_ORIGIN, 'bad_origin');
        return;
      }
      const readiness = voiceReadiness(db);
      if (!readiness.ok) {
        socket.close(WS_CLOSE_NOT_CONFIGURED, readiness.reason);
        return;
      }
      service.connect(socket, new URL(req.url ?? '/', 'http://localhost').searchParams);
    },
  };
}

/** Without `PUBLIC_URL` there is nothing to compare against. */
export function originAllowed(req: IncomingMessage, publicUrl: string): boolean {
  if (publicUrl === '') return true;
  const origin = req.headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(origin).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}
