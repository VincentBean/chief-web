import type { RequestHandler } from 'express';

import { logger } from '../lib/logger.js';
import type { ClaudeService } from './service.js';

/**
 * The precondition every session depends on (US-008, FR-5): a session container
 * can only do anything useful once Claude Code is signed in, because it runs
 * the agent with the credentials from the shared volume. Creating one before
 * that would produce a container that fails at its first agent invocation, with
 * an error far from the cause.
 */

export const CLAUDE_NOT_AUTHENTICATED = 'claude_not_authenticated';

export const CLAUDE_NOT_AUTHENTICATED_MESSAGE =
  'Claude Code is not authenticated, so sessions cannot be created. ' +
  'Open Settings → “Set up Claude” and sign in once; every session container shares that login.';

/**
 * Blocks a request while Claude is not signed in.
 *
 * The status is **409**, never 401: the frontend reads 401 as an expired
 * session cookie and redirects to the login page, which would hide the real
 * reason. A probe that could not run also blocks — chief-web fails closed, and
 * reports why.
 */
export function requireClaudeAuth(claude: ClaudeService): RequestHandler {
  return (_req, res, next) => {
    claude
      .status()
      .then((status) => {
        if (status.authenticated) {
          next();
          return;
        }
        res.status(409).json({
          error: CLAUDE_NOT_AUTHENTICATED,
          message:
            status.error === null
              ? CLAUDE_NOT_AUTHENTICATED_MESSAGE
              : `${CLAUDE_NOT_AUTHENTICATED_MESSAGE} (status check: ${status.error})`,
        });
      })
      .catch((cause: unknown) => {
        logger.error('claude auth check failed', { error: String(cause) });
        res.status(409).json({
          error: CLAUDE_NOT_AUTHENTICATED,
          message: `${CLAUDE_NOT_AUTHENTICATED_MESSAGE} (status check failed: ${String(cause)})`,
        });
      });
  };
}
