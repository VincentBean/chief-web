import fs from 'node:fs';
import path from 'node:path';

import express, { type Express } from 'express';

import { type AuthService, requireApiAuth, requirePageAuth } from './auth/index.js';
import { type BuildService, createAgentRunner, createBuildService } from './build/index.js';
import { type ClaudeService, createClaudeService, requireClaudeAuth } from './claude/index.js';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { DockerApi } from './docker/index.js';
import { createSessionOrchestrator } from './orchestrator/index.js';
import { createPlanningService, type PlanningService } from './planning/index.js';
import { createAuthRouter } from './routes/auth.js';
import { createBuildRouter } from './routes/build.js';
import { createClaudeRouter } from './routes/claude.js';
import { createHealthRouter } from './routes/health.js';
import { createPlanningRouter } from './routes/planning.js';
import { createRepositoriesRouter } from './routes/repositories.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createSettingsRouter } from './routes/settings.js';
import { createTerminalsRouter } from './routes/terminals.js';
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
  api.use(createAuthRouter(auth));
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

  // The client is cheap to construct — nothing is dialled until the first
  // request — so one instance serves both the orchestrator and the setup
  // commands, and either can be replaced independently.
  const docker = new DockerApi(config.dockerSocket);
  const orchestrator = deps.orchestrator ?? createSessionOrchestrator(config, db, docker);
  const exec = deps.exec ?? docker;
  api.use(createSessionsRouter(createSessionService(config, db, orchestrator, exec)));
  api.use(
    createPlanningRouter(
      deps.planning ?? createPlanningService(config, db, terminals, orchestrator),
    ),
  );
  api.use(
    createBuildRouter(
      deps.builds ?? createBuildService(config, db, orchestrator, createAgentRunner(exec)),
    ),
  );

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
