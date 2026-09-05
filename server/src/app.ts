import fs from 'node:fs';
import path from 'node:path';

import express, { type Express } from 'express';

import {
  type AuthService,
  createLoginRateLimiter,
  requireApiAuth,
  requirePageAuth,
} from './auth/index.js';
import {
  type BuildLogStore,
  type BuildService,
  createAgentRunner,
  createBuildLogStore,
  createBuildService,
} from './build/index.js';
import { type ClaudeService, createClaudeService, requireClaudeAuth } from './claude/index.js';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { createDeliveryService, type DeliveryService, ReviewStep } from './delivery/index.js';
import { DockerApi } from './docker/index.js';
import { UsageLimitHold } from './limits/index.js';
import { createSessionOrchestrator } from './orchestrator/index.js';
import { createPlanningService, type PlanningService } from './planning/index.js';
import { createRetryService } from './recovery/index.js';
import { createReviewService, GithubReviewPublisher } from './review/index.js';
import { createAuthRouter } from './routes/auth.js';
import { createBuildRouter } from './routes/build.js';
import { createClaudeRouter } from './routes/claude.js';
import { createDeliveryRouter } from './routes/delivery.js';
import { createHealthRouter } from './routes/health.js';
import { createLimitsRouter } from './routes/limits.js';
import { createPlanningRouter } from './routes/planning.js';
import {
  type ConflictScan,
  createPrConflictFixService,
  createPrConflictScan,
} from './prconflicts/index.js';
import { createPrSync, type PullRequestSync } from './prsync/index.js';
import { createPrFeedbackService, type PrFeedbackService } from './prfeedback/index.js';
import { createPrReviewService, type PrReviewService } from './prreview/index.js';
import { createPullRequestService, type PullRequestService } from './pullrequests/index.js';
import { createPullRequestsRouter } from './routes/pull-requests.js';
import { createRepositoriesRouter } from './routes/repositories.js';
import { createRetryRouter } from './routes/retry.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createSettingsRouter } from './routes/settings.js';
import { createStatsRouter } from './routes/stats.js';
import { createTerminalsRouter } from './routes/terminals.js';
import { createScheduler, type SessionScheduler } from './scheduler/index.js';
import {
  createSessionService,
  type SessionContainers,
  type SessionExecutor,
} from './sessions/index.js';
import type { CommandRunner } from './ssh/index.js';
import { createTerminalManager, type TerminalManager } from './terminal/index.js';

/** Injected collaborators that tests replace; all optional in production. */
export interface AppDependencies {
  /**
   * How `docker run` is executed for the repository connection test. Defaults
   * to spawning the real Docker CLI.
   */
  readonly runCommand?: CommandRunner;
  /**
   * Live browser terminals (US-007). Passed in by `index.ts` so the same
   * registry backs both the REST routes and the WebSocket gateway; tests point
   * it at a fake Docker daemon.
   */
  readonly terminals?: TerminalManager;
  /**
   * Claude Code authentication (US-008). Defaults to a service that probes the
   * shared credentials volume with a real container.
   */
  readonly claude?: ClaudeService;
  /**
   * Open pull requests and their review feedback (US-021). Defaults to a
   * service that talks to GitHub; tests pass one built on a stub gateway so
   * they never reach the network.
   */
  readonly pullRequests?: PullRequestService;
  /**
   * Runs that answer a pull request's review feedback (US-021). Defaults to a
   * service driving the shared orchestrator and build cap; tests pass one built
   * on stubs so they never reach Docker or GitHub.
   */
  readonly prFeedback?: PrFeedbackService;
  /**
   * Code reviews started by hand on an open pull request. Defaults to a
   * service driving the shared orchestrator, the session review's pass and the
   * build cap; tests pass one built on stubs.
   */
  readonly prReviews?: PrReviewService;
  /**
   * Session containers (US-009). `index.ts` passes the same orchestrator it
   * reconciles with at startup so both share one Docker client; tests pass a
   * stub and never touch a daemon.
   */
  readonly orchestrator?: SessionContainers;
  /**
   * How commands are run inside a session container (US-010). Defaults to the
   * Engine API client.
   */
  readonly exec?: SessionExecutor;
  /**
   * The planning terminal (US-011). Defaults to a service driving the shared
   * terminal manager and orchestrator; tests pass one built on stubs.
   */
  readonly planning?: PlanningService;
  /**
   * The Ralph loop (US-013). Defaults to a service that execs `claude -p` in
   * the session container; tests pass one built on a mocked agent runner.
   */
  readonly builds?: BuildService;
  /**
   * Where the build loop's output is written and watched from (US-016).
   * `index.ts` passes the same store the WebSocket gateway serves, so the file
   * on the data volume and the browser see one stream.
   */
  readonly buildLogs?: BuildLogStore;
  /**
   * Push and pull request (US-014). Defaults to a service that pushes from the
   * session container and calls the GitHub REST API with the stored PAT.
   */
  readonly delivery?: DeliveryService;
  /**
   * Scheduled starts (US-017). Defaults to a service polling the database; it
   * is started here, because a schedule has to be honoured whether or not
   * anyone opens the UI. Tests pass one they drive by hand.
   */
  readonly scheduler?: SessionScheduler;
  /**
   * The pull request sync (US-003). Defaults to a service polling GitHub for
   * what became of each `pr-open` session's pull request; tests pass one built
   * on a stub gateway so they never reach the network.
   */
  readonly prSync?: PullRequestSync;
  /**
   * The merge conflict scan (US-003). Defaults to a service polling GitHub for
   * the open `chief/` pull requests that have grown conflicts; tests pass one
   * built on a stub gateway so they never reach the network.
   */
  readonly prConflicts?: ConflictScan;
}

/**
 * Builds the Express application: the JSON API under `/api`, and the built
 * React frontend as static files with an SPA fallback for client-side routes.
 *
 * Everything is behind the shared password (US-003) except `GET /api/health`,
 * `POST /api/auth/login` and the `/login` page.
 */
export function createApp(
  config: Config,
  auth: AuthService,
  db: Database,
  deps: AppDependencies = {},
): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  api.use(createHealthRouter());
  api.use(
    createAuthRouter(
      auth,
      createLoginRateLimiter({
        maxAttempts: config.loginAttemptLimit,
        windowMs: config.loginAttemptWindowMs,
      }),
    ),
  );
  // Guard for every API route added below (and for unknown ones, which must
  // not reveal whether they exist).
  api.use(requireApiAuth(auth));
  api.use(createSettingsRouter(db, config));
  api.use(createRepositoriesRouter(db, config, deps.runCommand));
  const terminals = deps.terminals ?? createTerminalManager(config);
  api.use(createTerminalsRouter(terminals));
  const claude = deps.claude ?? createClaudeService(config, terminals, deps.runCommand);
  api.use(createClaudeRouter(claude));

  // Mounted ahead of the sessions router so creating a session — and retrying
  // its setup, which spawns the same container — is blocked, with a reason,
  // until Claude Code has been signed in once (US-008).
  const guard = requireClaudeAuth(claude);
  api.post('/sessions', guard);
  api.post('/sessions/:id/setup', guard);
  // Planning *is* an interactive `claude`, so it is blocked by the same guard;
  // so is a build, which is a headless one.
  api.post('/sessions/:id/planning', guard);
  api.post('/sessions/:id/build', guard);
  // Answering review feedback is a headless `claude` too (US-021). Reading the
  // list and stopping a run are not guarded: being unable to stop something you
  // could not start is a trap.
  api.post('/pull-requests/:repositoryId/:number/run', guard);
  // So is reviewing one by hand.
  api.post('/pull-requests/:repositoryId/:number/review', guard);

  // The client is cheap to construct — nothing is dialled until the first
  // request — so one instance serves both the orchestrator and the setup
  // commands, and either can be replaced independently.
  const docker = new DockerApi(config.dockerSocket);
  // Kept separately from `orchestrator` because `SessionContainers` is the
  // narrow two-method view a test may stub, while starting a feedback-run
  // container needs the real thing. A test that stubs the orchestrator and
  // wants runs passes `deps.prFeedback` as well.
  const sessionOrchestrator = createSessionOrchestrator(config, db, docker);
  const orchestrator = deps.orchestrator ?? sessionOrchestrator;
  const exec = deps.exec ?? docker;
  const planning = deps.planning ?? createPlanningService(config, db, terminals, orchestrator);
  // Assigned further down: the review chains into this solver (US-011), and the
  // solver needs the build loop's slot cap, which in turn needs the delivery.
  // The thunk below is what breaks that circle — nothing reads it until a
  // review has actually posted findings, by which point all three exist.
  let prFeedback: PrFeedbackService | null = null;
  // What the build loop does with a finished session: push, open the pull
  // request, then review it when the session asked for one (US-009). It is both
  // the loop's completion hand-off and its own endpoint, so a delivery that
  // failed can be retried without rerunning a story.
  // The review pass is one object shared by the delivery's review step and the
  // reviews started by hand on the Pull requests page: same prompt, same model
  // setting, same findings file.
  const reviewer = createReviewService(config, db, orchestrator, createAgentRunner(exec));
  const delivery =
    deps.delivery ??
    createDeliveryService(
      config,
      db,
      orchestrator,
      exec,
      undefined,
      new ReviewStep(reviewer, new GithubReviewPublisher(config), () => prFeedback),
    );
  const buildLogs = deps.buildLogs ?? createBuildLogStore(config, db);
  const builds =
    deps.builds ??
    createBuildService(config, db, orchestrator, createAgentRunner(exec), delivery, buildLogs);
  // Scheduled starts (US-017). The schedules live in the database, so starting
  // it here — before the first request — is also the catch-up on everything
  // that came due while the stack was down.
  const scheduler = deps.scheduler ?? createScheduler(config, db, builds);
  scheduler.start();
  // The pull request sync (US-003), started for the same reason: a merge that
  // happens overnight has to be noticed whether or not anyone opens the UI,
  // and the first tick is the catch-up on everything that was merged while the
  // stack was down.
  // The orchestrator comes along so a merge can throw the session's container
  // away (US-005); merged work never needs one again.
  const prSync = deps.prSync ?? createPrSync(config, db, orchestrator);
  prSync.start();
  // The merge conflict scan (US-003), started here for the same reason: a base
  // branch that moves overnight has to be noticed whether or not anyone opens
  // the UI. It only decides which pull requests conflict; what is done about
  // one is the fix pipeline handed to it (US-005).
  // What the scan does about a conflict (US-005): its own container through
  // the same machinery a feedback run uses, one agent on the conflicted files,
  // and a merge commit chief-web makes and pushes itself. It shares the build
  // loop's slot cap, so a fix queues to the next scan rather than
  // oversubscribing the host.
  // Built whether or not the scan is the injected one: the pull requests page
  // reads its rows, and a fixer nobody starts a run on is inert.
  const prConflictFixes = createPrConflictFixService(
    config,
    db,
    sessionOrchestrator,
    exec,
    createAgentRunner(exec),
    builds,
  );
  const prConflicts = deps.prConflicts ?? createPrConflictScan(config, db, prConflictFixes);
  prConflicts.start();
  // Pull request feedback (US-021). It shares the build loop's slot cap rather
  // than its queue: a five-minute pass should not wait behind an hour of
  // stories, so a full server refuses the run instead of holding it.
  prFeedback =
    deps.prFeedback ??
    createPrFeedbackService(config, db, sessionOrchestrator, exec, createAgentRunner(exec), builds);
  // A code review started by hand on an open pull request: the same pass the
  // delivery runs, in a feedback-run container, handing its findings to the
  // solver above exactly as the delivery's review does.
  const prReviews =
    deps.prReviews ??
    createPrReviewService(
      config,
      db,
      sessionOrchestrator,
      exec,
      createAgentRunner(exec),
      reviewer,
      builds,
      () => prFeedback,
    );
  api.use(
    createPullRequestsRouter(
      deps.pullRequests ?? createPullRequestService(config, db),
      prFeedback,
      prReviews,
      prConflictFixes,
      // Refresh on the page re-runs the scan (US-003): the half-hour timer is
      // too wide to wait out when an operator is looking at a conflict.
      prConflicts,
    ),
  );
  // Deleting a session (US-015) has to unwind whatever is running in its
  // container first, so the session service is built last and given all three.
  api.use(
    createSessionsRouter(
      createSessionService(config, db, orchestrator, exec, { builds, planning, scheduler }),
    ),
  );
  api.use(createPlanningRouter(planning));
  api.use(createDeliveryRouter(delivery));
  api.use(createBuildRouter(builds));
  // Claude's usage-limit hold (US-002) and the "Resume now" that ends it early
  // (US-008). The hold is a row on the database, so a second instance reads the
  // same one the build loop and the scheduler arm.
  const hold = new UsageLimitHold(db);
  api.use(createLimitsRouter(hold, builds));
  // The overview page's numbers (US-022): aggregates over the database only.
  api.use(createStatsRouter(db, config, hold));
  // "Retry" on a failed session (US-019): one endpoint over both recoveries,
  // dispatching on the stage the session failed at.
  const retries = createRetryService(db, builds, delivery);
  // Only the half of it that runs an agent needs Claude Code. A session whose
  // *push* or *pull request* failed has nothing left to build, so blocking its
  // retry on credentials it does not use would strand finished work.
  api.post('/sessions/:id/retry', (req, res, next) => {
    let action: string;
    try {
      action = retries.plan(req.params.id).action;
    } catch {
      // Not retryable at all: let the router answer with the real reason.
      next();
      return;
    }
    if (action === 'build') guard(req, res, next);
    else next();
  });
  api.use(createRetryRouter(retries));

  app.use('/api', api);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  mountFrontend(app, config, auth);

  return app;
}

function mountFrontend(app: Express, config: Config, auth: AuthService): void {
  const indexHtml = path.join(config.webRoot, 'index.html');

  if (!fs.existsSync(indexHtml)) {
    // The frontend has not been built (e.g. `npm run dev -w server` alone).
    // Serve a hint instead of a confusing 404 so the UI URL still responds.
    app.use((_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send('chief-web frontend is not built. Run `npm run build -w web`.');
    });
    return;
  }

  // Static assets stay public: the login page is served from the same bundle,
  // so gating them would leave an unauthenticated visitor with a blank screen.
  app.use(express.static(config.webRoot, { index: false, maxAge: '1h' }));
  app.use(requirePageAuth(auth));
  app.use((_req, res) => {
    res.sendFile(indexHtml);
  });
}
