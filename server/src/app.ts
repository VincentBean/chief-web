import fs from 'node:fs';
import path from 'node:path';

import express, { type Express } from 'express';

import type { Config } from './config.js';
import { createHealthRouter } from './routes/health.js';

/**
 * Builds the Express application: the JSON API under `/api`, and the built
 * React frontend as static files with an SPA fallback for client-side routes.
 */
export function createApp(config: Config): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const api = express.Router();
  api.use(createHealthRouter());
  app.use('/api', api);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  mountFrontend(app, config);

  return app;
}

function mountFrontend(app: Express, config: Config): void {
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

  app.use(express.static(config.webRoot, { index: false, maxAge: '1h' }));
  app.use((_req, res) => {
    res.sendFile(indexHtml);
  });
}
