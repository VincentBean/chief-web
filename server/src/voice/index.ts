import type { Router } from 'express';

import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import type { WebSocketRoute } from '../ws/gateway.js';
import { createVoiceRouter } from './routes.js';
import { VoiceService, type VoiceServiceDeps } from './service.js';
import { createVoiceSocketRoute } from './socket.js';

export { type AgentEvent, type CallClock, EVENT_QUIET_MS, type VoiceAgent, VoiceCall, type VoiceCallState } from './call.js';
export * from './events.js';
export * from './protocol.js';
export {
  EL_BALANCE_TTL_MS,
  effectiveSttMode,
  RESUME_WINDOW_MS,
  VoiceService,
  type VoiceServiceDeps,
  type VoiceStatus,
  voiceReadiness,
} from './service.js';
export { createVoiceSocketRoute, VOICE_WS_PATH } from './socket.js';

export interface Voice {
  /** The REST routes; mount behind `requireApiAuth`. */
  readonly router: Router;
  /** `/api/voice/stream`; register on the `WebSocketGateway`. */
  readonly socketRoute: WebSocketRoute;
  readonly service: VoiceService;
}

/** The voice feature (plan §4): its routes, its call socket and the service owning the call. */
export function createVoice(config: Config, db: Database, deps: VoiceServiceDeps = {}): Voice {
  const service = new VoiceService(config, db, deps);
  return {
    router: createVoiceRouter(db, config, service),
    socketRoute: createVoiceSocketRoute(service, config, db),
    service,
  };
}
