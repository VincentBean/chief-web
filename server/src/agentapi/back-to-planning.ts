import type { RequestHandler } from 'express';

import { BuildError } from '../build/index.js';
import { type Database, getQueuedBuild, getSession } from '../db/index.js';
import { SessionError } from '../sessions/index.js';
import { type AgentSessionDeps, sessionUrl } from './sessions.js';
import { agentSessionView } from './start.js';

/** Statuses with a build under way: only chief-web's **Stop build** ends them. */
const RUNNING = new Set(['building', 'waiting', 'deciding']);

/**
 * `POST /api/agent/sessions/:id/back-to-planning` (extend-api US-004): undoes
 * a start that has not begun building. A `ready` session goes back to
 * `pending`, and if it was waiting for a build slot it leaves the queue first,
 * so it can never start after it went back to planning. A scheduled start is
 * left as it is; `PUT /schedule` clears it.
 */
export function backToPlanningAgentSession(db: Database, deps: AgentSessionDeps): RequestHandler {
  return (req, res) => {
    const id = String(req.params.id);
    const found = getSession(db, id);
    if (found === null) {
      res.status(404).json({ error: 'session_not_found', message: 'No such session.' });
      return;
    }
    const sessions = deps.sessions();
    const builds = deps.builds();
    if (sessions === null || builds === null) {
      res
        .status(503)
        .json({ error: 'sessions_unavailable', message: 'The session service is not ready yet.' });
      return;
    }
    if (found.status !== 'ready') {
      const hint = RUNNING.has(found.status)
        ? ' Its build has begun; use Stop build in chief-web to stop it (the agent API does not stop builds).'
        : '';
      res.status(409).json({
        error: 'session_not_ready',
        message: `Only a ready session can go back to planning; "${found.name}" is ${found.status}.${hint}`,
      });
      return;
    }

    try {
      if (getQueuedBuild(db, 'session', id) !== null) builds.dequeue(id);
      sessions.backToPlanning(id);
    } catch (cause: unknown) {
      if (cause instanceof SessionError || cause instanceof BuildError) {
        res.status(cause.status).json({ error: cause.code, message: cause.message });
        return;
      }
      res.status(500).json({ error: 'session_request_failed', message: String(cause) });
      return;
    }
    const session = getSession(db, id) ?? found;
    res.json({ session: agentSessionView(session), url: sessionUrl(deps.config, req, id) });
  };
}
