import { BuildError, type BuildService } from '../build/index.js';
import { type Database, getSession, nowIso, type Session } from '../db/index.js';
import { SessionError, type SessionService } from '../sessions/index.js';

/** How a start through the agent API ended up. */
export type AgentStartOutcome = 'started' | 'queued' | 'scheduled';

/** The fields of a session the token holder is shown after a start. */
export interface AgentStartSession {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly branch: string;
  readonly scheduledStartAt: string | null;
}

export interface AgentStartSuccess {
  readonly ok: true;
  readonly session: AgentStartSession;
  readonly outcome: AgentStartOutcome;
  readonly queued: boolean;
  readonly queuePosition: number | null;
  readonly message: string;
}

export interface AgentStartFailure {
  readonly ok: false;
  /** The HTTP status a route answers with. */
  readonly status: number;
  readonly error: string;
  readonly message: string;
  /** The PRD's parse errors, with `error: 'invalid_prd'`. */
  readonly errors?: readonly { line: number; message: string }[];
}

export type AgentStartResult = AgentStartSuccess | AgentStartFailure;

/** What starting needs; both services are built after the agent router, so read lazily. */
export interface AgentStartDeps {
  readonly sessions: () => SessionService | null;
  readonly builds: () => BuildService | null;
}

/**
 * "Mark ready" then "Start build" in one step (extend-api US-001), shared by
 * `POST /api/agent/sessions/:id/start` and a create with `start: true`.
 *
 * Never throws and never touches a response: every failure comes back as a
 * status and an error code, so each caller decides how to report it.
 */
export async function startAgentSession(
  db: Database,
  deps: AgentStartDeps,
  id: string,
): Promise<AgentStartResult> {
  const found = getSession(db, id);
  if (found === null) {
    return { ok: false, status: 404, error: 'session_not_found', message: 'No such session.' };
  }
  const sessions = deps.sessions();
  const builds = deps.builds();
  if (sessions === null || builds === null) {
    return {
      ok: false,
      status: 503,
      error: 'sessions_unavailable',
      message: 'The session service is not ready yet.',
    };
  }
  if (found.status !== 'pending' && found.status !== 'ready') {
    return {
      ok: false,
      status: 409,
      error: 'session_not_startable',
      message: `Only a pending or ready session can be started; "${found.name}" is ${found.status}.`,
    };
  }

  try {
    if (found.status === 'pending') {
      const ready = await sessions.markReady(id);
      if (!ready.ok) {
        return {
          ok: false,
          status: 400,
          error: 'invalid_prd',
          message: 'The PRD does not parse, so the session stays pending.',
          errors: ready.prd.errors.map(({ line, message }) => ({ line, message })),
        };
      }
      // A schedule that already passed was honoured by Mark ready itself.
      if (ready.started) return fromBuild(db, builds, found);
    }

    const session = getSession(db, id) ?? found;
    if (session.scheduledStartAt !== null && session.scheduledStartAt > nowIso()) {
      return {
        ok: true,
        session: view(session),
        outcome: 'scheduled',
        queued: false,
        queuePosition: null,
        message: `"${session.name}" is ready and starts at ${session.scheduledStartAt}.`,
      };
    }

    await builds.start(id);
    return fromBuild(db, builds, found);
  } catch (cause: unknown) {
    // The hold has already put the session on the queue; it is not a refusal.
    if (cause instanceof BuildError && cause.code === 'usage_limit_hold') {
      const current = getSession(db, id) ?? found;
      return {
        ok: true,
        session: view(current),
        outcome: 'queued',
        queued: true,
        queuePosition: builds.status(id).queuePosition,
        message: cause.message,
      };
    }
    if (cause instanceof SessionError || cause instanceof BuildError) {
      return { ok: false, status: cause.status, error: cause.code, message: cause.message };
    }
    return { ok: false, status: 500, error: 'session_request_failed', message: String(cause) };
  }
}

/** The outcome of a build start, read back from the build service. */
function fromBuild(db: Database, builds: BuildService, found: Session): AgentStartSuccess {
  const build = builds.status(found.id);
  const shown = view(getSession(db, found.id) ?? found);
  return build.queued
    ? {
        ok: true,
        session: shown,
        outcome: 'queued',
        queued: true,
        queuePosition: build.queuePosition,
        message: `"${shown.name}" is waiting for a build slot (#${String(build.queuePosition ?? '?')} in the queue).`,
      }
    : {
        ok: true,
        session: shown,
        outcome: 'started',
        queued: false,
        queuePosition: null,
        message: `"${shown.name}" is building.`,
      };
}

function view(session: Session): AgentStartSession {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    branch: session.featureBranch,
    scheduledStartAt: session.scheduledStartAt,
  };
}
