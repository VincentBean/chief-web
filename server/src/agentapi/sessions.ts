import type { Request, RequestHandler } from 'express';

import type { BuildService } from '../build/index.js';
import type { Config } from '../config.js';
import { buildQueuePosition, type Database, getQueuedBuild, getRepository, getSession } from '../db/index.js';
import { parsePrd, prdParses } from '../prd/index.js';
import { parseCreate, respondWithFailure } from '../routes/sessions.js';
import type { SessionService } from '../sessions/index.js';
import { type AgentStartResult, startAgentSession } from './start.js';

/** The longest PRD the agent API accepts, in characters. */
export const MAX_AGENT_PRD_LENGTH = 200_000;

/**
 * What creating a session through the agent API needs that the router does
 * not have when it is mounted: the session service is built after the agent
 * router in `createApp`, so it is read lazily, at request time.
 */
export interface AgentSessionDeps {
  readonly config: Pick<Config, 'publicUrl'>;
  readonly sessions: () => SessionService | null;
  /** Built after the agent router too; starting a session needs it (extend-api US-001). */
  readonly builds: () => BuildService | null;
}

/**
 * `POST /api/agent/sessions` (send-to-chief US-006): an ordinary session plus
 * a ready-written PRD.
 *
 * Everything that can be rejected is rejected before the session row exists —
 * the body, the repository and the PRD itself. The PRD then rides on the row
 * until a setup succeeds and writes it into the clone; the session is left
 * `pending` either way, so nothing builds until the operator marks it ready.
 */
export function createAgentSession(db: Database, deps: AgentSessionDeps): RequestHandler {
  return (req, res) => {
    const parsed = parseCreate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }
    const input = req.body as Record<string, unknown>;
    if (input.start !== undefined && typeof input.start !== 'boolean') {
      res.status(400).json({ error: 'invalid_start', message: 'start must be a boolean.' });
      return;
    }
    const start = input.start === true;

    const repository = getRepository(db, parsed.repositoryId);
    if (repository === null) {
      res.status(404).json({ error: 'repository_not_found', message: 'No such repository.' });
      return;
    }

    const prd = input.prd;
    if (typeof prd !== 'string' || prd.trim() === '') {
      res.status(400).json({ error: 'invalid_prd', message: 'prd must be a non-empty string.' });
      return;
    }
    if (prd.length > MAX_AGENT_PRD_LENGTH) {
      res.status(400).json({
        error: 'invalid_prd',
        message: `The PRD must be at most ${MAX_AGENT_PRD_LENGTH} characters.`,
      });
      return;
    }
    const document = parsePrd(prd);
    if (!prdParses(document)) {
      res.status(400).json({
        error: 'invalid_prd',
        errors: document.errors.map(({ line, message }) => ({ line, message })),
      });
      return;
    }

    const sessions = deps.sessions();
    if (sessions === null) {
      res
        .status(503)
        .json({ error: 'sessions_unavailable', message: 'The session service is not ready yet.' });
      return;
    }

    // Unlike the dashboard form, the agent is not shown the repository's
    // settings, so an omitted target follows its default base branch, and an
    // omitted code review is off rather than the global default.
    const targetGiven = input.prTargetBranch !== undefined && input.prTargetBranch !== null;
    sessions
      .create({
        repositoryId: parsed.repositoryId,
        name: parsed.name,
        prTargetBranch: targetGiven
          ? parsed.prTargetBranch
          : repository.defaultBaseBranch === 'develop'
            ? 'develop'
            : 'main',
        scheduledStartAt: parsed.scheduledStartAt ?? null,
        codeReview: parsed.codeReview ?? false,
        ...(parsed.baseBranch === undefined ? {} : { baseBranch: parsed.baseBranch }),
        ...(parsed.openPullRequest === undefined
          ? {}
          : { openPullRequest: parsed.openPullRequest }),
        ...(parsed.maxParallelStories === undefined
          ? {}
          : { maxParallelStories: parsed.maxParallelStories }),
        pendingPrd: prd,
      })
      .then(async ({ session, setup }) => {
        const prdWritten = setup.ok && getSession(db, session.id)?.pendingPrd === null;
        const started = start ? await startCreated(db, deps, session.id, setup.ok && prdWritten) : null;
        // A start moves the session on, so show it as it is now.
        const shown = started?.ok === true ? started.session : null;
        res.status(201).json({
          session: shown ?? {
            id: session.id,
            name: session.name,
            status: session.status,
            branch: session.featureBranch,
            scheduledStartAt: session.scheduledStartAt,
            maxParallelStories: session.maxParallelStories,
          },
          setup: { ok: setup.ok, message: setup.message },
          prdWritten,
          url: sessionUrl(deps.config, req, session.id),
          ...(started === null ? {} : { start: startView(started) }),
        });
      })
      .catch((cause: unknown) => respondWithFailure(res, cause));
  };
}

/**
 * The start half of a create with `start: true` (extend-api US-002). Only a
 * clone holding the PRD can build; otherwise the session stays pending for the
 * operator to fix and **Retry setup**.
 */
async function startCreated(
  db: Database,
  deps: AgentSessionDeps,
  id: string,
  setUp: boolean,
): Promise<AgentStartResult> {
  if (!setUp) {
    return {
      ok: false,
      status: 409,
      error: 'setup_failed',
      message: 'Setup did not finish, so the session stays pending. Fix the cause and use Retry setup in chief-web.',
    };
  }
  return startAgentSession(db, deps, id);
}

/** The `start` object of a create response: the outcome, never an HTTP status. */
function startView(result: AgentStartResult): Record<string, unknown> {
  return result.ok
    ? {
        ok: true,
        outcome: result.outcome,
        queued: result.queued,
        queuePosition: result.queuePosition,
        message: result.message,
      }
    : { ok: false, error: result.error, message: result.message };
}

/**
 * `GET /api/agent/sessions/:id` (send-to-chief US-007): enough for the agent
 * to tell the operator whether setup worked and where to review the session.
 * Fields are picked explicitly — no workspace paths, container ids, logs or
 * PRD content reach the token holder. `queued`/`queuePosition` are read the
 * way `BuildView` reads them (extend-api US-005).
 */
export function readAgentSession(db: Database, deps: Pick<AgentSessionDeps, 'config'>): RequestHandler {
  return (req, res) => {
    const id = String(req.params.id);
    const session = getSession(db, id);
    if (session === null) {
      res.status(404).json({ error: 'session_not_found', message: 'No such session.' });
      return;
    }
    res.json({
      session: {
        id: session.id,
        name: session.name,
        status: session.status,
        branch: session.featureBranch,
        setupError: session.lastError,
        scheduledStartAt: session.scheduledStartAt,
        pullRequestUrl: session.prUrl,
        maxParallelStories: session.maxParallelStories,
        queued: getQueuedBuild(db, 'session', session.id) !== null,
        queuePosition: buildQueuePosition(db, 'session', session.id),
      },
      url: sessionUrl(deps.config, req, session.id),
    });
  };
}

/** `<PUBLIC_URL>/sessions/<id>`, or the request's own origin when PUBLIC_URL is unset. */
export function sessionUrl(config: Pick<Config, 'publicUrl'>, req: Request, id: string): string {
  const origin =
    config.publicUrl !== '' ? config.publicUrl : `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  return `${origin}/sessions/${id}`;
}
