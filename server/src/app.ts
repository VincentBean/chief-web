import fs from 'node:fs';
import path from 'node:path';

import express, { type Express } from 'express';

import { type AuthService, requireApiAuth, requirePageAuth } from './auth/index.js';
import { type ClaudeService, createClaudeService, requireClaudeAuth } from './claude/index.js';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { createAuthRouter } from './routes/auth.js';
import { createClaudeRouter } from './routes/claude.js';
import { createHealthRouter } from './routes/health.js';
import { createRepositoriesRouter } from './routes/repositories.js';
import { createSettingsRouter } from './routes/settings.js';
import { createTerminalsRouter } from './routes/terminals.js';
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
  // Mounted ahead of the sessions router (US-010) so session creation is
  // blocked, with a reason, until Claude Code has been signed in once.
  api.post('/sessions', requireClaudeAuth(claude));
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
