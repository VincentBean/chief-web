import type { RequestHandler } from 'express';

import { type Database, getSession } from '../db/index.js';
import { parseSchedule, respondWithFailure } from '../routes/sessions.js';
import { type AgentSessionDeps, sessionUrl } from './sessions.js';
import { agentSessionView } from './start.js';

/**
 * `PUT /api/agent/sessions/:id/schedule` (extend-api US-003): sets, changes or
 * clears (`null`) the scheduled start, with the app route's parser and the
 * same `SessionService.setSchedule()` behind it. It starts nothing itself, so
 * it is not behind the Claude guard.
 */
export function scheduleAgentSession(db: Database, deps: AgentSessionDeps): RequestHandler {
  return (req, res) => {
    const parsed = parseSchedule(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }
    const sessions = deps.sessions();
    if (sessions === null) {
      res
        .status(503)
        .json({ error: 'sessions_unavailable', message: 'The session service is not ready yet.' });
      return;
    }
    const id = String(req.params.id);
    try {
      sessions.setSchedule(id, parsed.scheduledStartAt);
    } catch (cause: unknown) {
      respondWithFailure(res, cause);
      return;
    }
    const session = getSession(db, id);
    if (session === null) {
      res.status(404).json({ error: 'session_not_found', message: 'No such session.' });
      return;
    }
    res.json({ session: agentSessionView(session), url: sessionUrl(deps.config, req, id) });
  };
}
