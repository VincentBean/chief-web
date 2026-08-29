import fs from 'node:fs';
import path from 'node:path';

import express, { type Express } from 'express';

import { type AuthService, requireApiAuth, requirePageAuth } from './auth/index.js';
import type { Config } from './config.js';
import type { Database } from './db/index.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter } from './routes/health.js';
import { createSettingsRouter } from './routes/settings.js';

/**
 * Builds the Express application: the JSON API under `/api`, and the built
 * React frontend as static files with an SPA fallback for client-side routes.
 *
 * Everything is behind the shared password (US-003) except `GET /api/health`,
 * `POST /api/auth/login` and the `/login` page.
 */
export function createApp(config: Config, auth: AuthService, db: Database): Express {
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
