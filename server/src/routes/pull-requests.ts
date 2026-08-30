import { type Response, Router } from 'express';

import { GithubApiError } from '../lib/github.js';
import { PrFeedbackError, type PrFeedbackService } from '../prfeedback/index.js';
import { PullRequestError, type PullRequestService } from '../pullrequests/index.js';

/**
 * Open pull requests, their review feedback, and the runs that answer it
 * (US-021).
 *
 * Reading is deliberately not behind the Claude guard: listing runs no agent,
 * and a page that refuses to render because Claude Code is signed out would
 * hide the very thing the operator came to look at. Starting a run *is*
 * guarded, in `app.ts`, alongside the other four routes that spawn an agent.
 */
export function createPullRequestsRouter(
  pullRequests: PullRequestService,
  prFeedback: PrFeedbackService,
): Router {
  const router = Router();

  router.get('/pull-requests', (req, res) => {
    // The page's Refresh button; without it a reload inside the cache window
    // costs GitHub nothing.
    const refresh = req.query['refresh'] === '1';
    pullRequests
      .list({ refresh })
      .then((view) => {
        // Each pull request carries whatever chief-web knows about running one
        // against it, so the list renders a row's state without a second call.
        res.status(200).json({
          ...view,
          repositories: view.repositories.map((repository) => ({
            ...repository,
            pullRequests: repository.pullRequests.map((pull) => ({
              ...pull,
              run: prFeedback.find(repository.repositoryId, pull.number),
            })),
          })),
        });
      })
      .catch((cause: unknown) => {
        respondWithFailure(res, cause);
      });
  });

  router.get('/pull-requests/:repositoryId/:number/feedback', (req, res) => {
    const number = parseNumber(req.params.number);
    if (number === null) {
      respondWithInvalidNumber(res);
      return;
    }

    pullRequests
      .feedback(req.params.repositoryId, number)
      .then((feedback) => {
        res.status(200).json(feedback);
      })
      .catch((cause: unknown) => {
        respondWithFailure(res, cause);
      });
  });

  /**
   * Starts a pass over the pull request's feedback.
   *
   * 200 rather than 201: the run row is usually adopted rather than created —
   * one row per pull request, reused across passes — the same reasoning the
   * `adopted` flag on an opened pull request encodes.
   */
  router.post('/pull-requests/:repositoryId/:number/run', (req, res) => {
    const number = parseNumber(req.params.number);
    if (number === null) {
      respondWithInvalidNumber(res);
      return;
    }

    prFeedback
      .start(req.params.repositoryId, number)
      .then((run) => {
        res.status(200).json(run);
      })
      .catch((cause: unknown) => {
        respondWithFailure(res, cause);
      });
  });

  router.get('/pull-requests/runs/:runId', (req, res) => {
    try {
      res.status(200).json(prFeedback.status(req.params.runId));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  /** Signals the agent; anything already committed and pushed is kept. */
  router.delete('/pull-requests/runs/:runId', (req, res) => {
    prFeedback
      .stop(req.params.runId)
      .then((run) => {
        res.status(200).json(run);
      })
      .catch((cause: unknown) => {
        respondWithFailure(res, cause);
      });
  });

  return router;
}

function parseNumber(raw: string): number | null {
  const number = Number.parseInt(raw, 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function respondWithInvalidNumber(res: Response): void {
  res.status(400).json({
    error: 'invalid_pull_request_number',
    message: 'The pull request number must be a positive whole number.',
  });
}

/**
 * Never 401: that is reserved for *our* expired session cookie, and the SPA
 * redirects to /login when it sees one. A GitHub 401 is a bad token, which is
 * a 400 the operator has to read.
 */
function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof PullRequestError || cause instanceof PrFeedbackError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  if (cause instanceof GithubApiError) {
    const status = cause.code === 'github_unreachable' ? 502 : 400;
    res.status(status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'pull_requests_request_failed', message: String(cause) });
}
