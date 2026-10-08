import type { Request, RequestHandler } from 'express';

import type { Config } from '../config.js';
import { type Database, getRepository, getSession } from '../db/index.js';
import { parsePrd, prdParses } from '../prd/index.js';
import { parseCreate, respondWithFailure } from '../routes/sessions.js';
import type { SessionService } from '../sessions/index.js';

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
        pendingPrd: prd,
      })
      .then(({ session, setup }) => {
        const prdWritten = setup.ok && getSession(db, session.id)?.pendingPrd === null;
        res.status(201).json({
          session: {
            id: session.id,
            name: session.name,
            status: session.status,
            branch: session.featureBranch,
            scheduledStartAt: session.scheduledStartAt,
          },
          setup: { ok: setup.ok, message: setup.message },
          prdWritten,
          url: sessionUrl(deps.config, req, session.id),
        });
      })
      .catch((cause: unknown) => respondWithFailure(res, cause));
  };
}

/** `<PUBLIC_URL>/sessions/<id>`, or the request's own origin when PUBLIC_URL is unset. */
export function sessionUrl(config: Pick<Config, 'publicUrl'>, req: Request, id: string): string {
  const origin =
    config.publicUrl !== '' ? config.publicUrl : `${req.protocol}://${req.get('host') ?? 'localhost'}`;
  return `${origin}/sessions/${id}`;
}
