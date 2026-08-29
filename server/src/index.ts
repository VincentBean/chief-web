import fs from 'node:fs/promises';

import { createApp } from './app.js';
import { createAuthService } from './auth/index.js';
import { loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/index.js';
import { logger } from './lib/logger.js';
import { createSessionOrchestrator } from './orchestrator/index.js';
import { createTerminalManager, createTerminalSocketRoute } from './terminal/index.js';
import { WebSocketGateway } from './ws/gateway.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // The data volume is mounted empty on a fresh install; create the layout the
  // rest of the application expects (SQLite DB, SSH keys, session workspaces).
  await Promise.all(
    [config.dataDir, config.sshKeysDir, config.workspacesDir].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  // Opening the database also runs any pending migrations; it must happen
  // before the first request can touch application state.
  const db = openDatabase(config.databasePath);

  // Resolves the shared password: `CHIEF_WEB_PASSWORD` if set, otherwise the
  // hash in settings — generating and logging one on first boot.
  const auth = createAuthService(config, db);

  // Terminals outlive the browser tabs attached to them, so the registry is
  // owned here and shared by the REST routes and the WebSocket gateway.
  const terminals = createTerminalManager(config);

  // Session containers outlive the server process, so the daemon and the
  // database can disagree after a crash or a `docker compose down` mid-build.
  // Reconciling before the first request means nothing ever sees a session
  // pointing at a container that is no longer there.
  const orchestrator = createSessionOrchestrator(config, db);
  try {
    await orchestrator.reconcile();
  } catch (error) {
    // A daemon that cannot be reached is not evidence that anything is gone;
    // start anyway and let the next reconcile sort it out.
    logger.error('could not reconcile session containers', { error: String(error) });
  }

  // The orchestrator is shared with the API: the same client that reconciled
  // at startup is the one that spawns a container for a new session (US-010).
  const app = createApp(config, auth, db, { terminals, orchestrator });

  // Terminals (US-007) and log streams (US-013) register their routes here;
  // the gateway enforces the same session cookie on every handshake.
  const gateway = new WebSocketGateway(auth);
  gateway.register(createTerminalSocketRoute(terminals));

  const server = app.listen(config.port, config.host, () => {
    logger.info('chief-web server listening', {
      port: config.port,
      host: config.host,
      dataDir: config.dataDir,
      env: config.nodeEnv,
    });
  });
  gateway.attach(server);

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    terminals.closeAll();
    gateway.close();
    server.close((err) => {
      closeDatabase(db);
      if (err) {
        logger.error('error during shutdown', { error: String(err) });
        process.exitCode = 1;
      }
      process.exit();
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  logger.error('failed to start chief-web server', { error: String(error) });
  process.exitCode = 1;
});
