import type { RequestHandler } from 'express';

import { logger } from '../lib/logger.js';
import type { ClaudeAccountStatusView, ClaudeService } from './service.js';

/**
 * The precondition every session depends on (US-008, FR-5): a session container
 * can only do anything useful once a Claude Code account is signed in, because
 * it runs the agent with that account's credentials. Creating one before that
 * would produce a container that fails at its first agent invocation, with an
 * error far from the cause.
 */

export const CLAUDE_NOT_AUTHENTICATED = 'claude_not_authenticated';

export const CLAUDE_NOT_AUTHENTICATED_MESSAGE =
  'No Claude Code account is signed in, so sessions cannot be created. ' +
  'Add an account in Settings → Claude Code and sign it in.';

/**
 * Blocks a request while **no** Claude account is signed in (multiple accounts
 * US-004); which account a launch runs on is decided later.
 *
 * The status is **409**, never 401: the frontend reads 401 as an expired
 * session cookie and redirects to the login page, which would hide the real
 * reason. A probe that could not run counts as signed out — chief-web fails
 * closed, and reports why.
 */
export function requireClaudeAuth(claude: ClaudeService): RequestHandler {
  return (_req, res, next) => {
    claude
      .statuses()
      .then((accounts) => {
        if (accounts.some((account) => account.authenticated)) {
          next();
          return;
        }
        const errors = probeErrors(accounts);
        res.status(409).json({
          error: CLAUDE_NOT_AUTHENTICATED,
          message:
            errors === ''
              ? CLAUDE_NOT_AUTHENTICATED_MESSAGE
              : `${CLAUDE_NOT_AUTHENTICATED_MESSAGE} (status check: ${errors})`,
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

function probeErrors(accounts: readonly ClaudeAccountStatusView[]): string {
  return accounts
    .filter((account) => account.error !== null)
    .map((account) => `${account.nickname ?? account.email ?? account.id}: ${account.error ?? ''}`)
    .join('; ');
}
