import fs from 'node:fs/promises';

import { createApp } from './app.js';
import { createAuthService } from './auth/index.js';
import { createBuildLogSocketRoute, createBuildLogStore } from './build/index.js';
import { loadConfig } from './config.js';
import {
  clearInterruptedPrConflictFixes,
  closeDatabase,
  type Database,
  openDatabase,
  updatePrRun,
} from './db/index.js';
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
    // A feedback run (US-021) is one pass driven from memory, so no container
    // of one can still be doing anything useful after a restart. There is
    // nothing to plan: they all go.
    await orchestrator.reconcilePrRuns();
    failRunsLeftBehind(db);
    clearConflictFixesLeftBehind(db);
  } catch (error) {
    // A daemon that cannot be reached is not evidence that anything is gone;
    // start anyway and let the next reconcile sort it out.
    logger.error('could not reconcile session containers', { error: String(error) });
  }

  // A build's output outlives the tab watching it — the file in the workspace
  // is the record — so the store is owned here and shared by the loop that
  // writes it and the gateway that streams it (US-016).
  const buildLogs = createBuildLogStore(config, db);

  // The orchestrator is shared with the API: the same client that reconciled
  // at startup is the one that spawns a container for a new session (US-010).
  const app = createApp(config, auth, db, { terminals, orchestrator, buildLogs });

  // Terminals (US-007) and build logs (US-016) register their routes here;
  // the gateway enforces the same session cookie on every handshake.
  const gateway = new WebSocketGateway(auth);
  gateway.register(createTerminalSocketRoute(terminals));
  gateway.register(createBuildLogSocketRoute(buildLogs));

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

/**
 * Marks every run this process did not survive as failed.
 *
 * A `running` row after a restart means the pass was cut off mid-flight. It is
 * safe to fail it: nothing was replied to unless the push had already landed,
 * and the retry plan re-runs only what is outstanding.
 */
function failRunsLeftBehind(db: Database): void {
  const abandoned = db
    .prepare("SELECT id FROM pr_runs WHERE status = 'running'")
    .all() as { id: string }[];
  for (const row of abandoned) {
    updatePrRun(db, row.id, {
      status: 'failed',
      failureStage: 'container_lost',
      lastError: 'The server restarted while this run was in flight.',
      finishedAt: new Date().toISOString(),
    });
  }
  if (abandoned.length > 0) {
    logger.info('failed pull request runs left by a previous process', {
      runs: abandoned.length,
    });
  }
}

/**
 * Winds back the conflict fixes this process did not survive (US-005).
 *
 * A fix run is driven entirely from memory, so a `running` row left by a dead
 * process is driving nothing — and unlike a `failed` one it never goes stale,
 * so it would hide its pull request from every future scan and hold a build
 * slot for as long as the row existed. Nothing reached `origin` unless the run
 * had already succeeded, so the row is simply dropped and the first scan after
 * boot looks at the pull request afresh.
 */
function clearConflictFixesLeftBehind(db: Database): void {
  const cleared = clearInterruptedPrConflictFixes(db);
  if (cleared > 0) {
    logger.info('wound back pull request conflict fixes left by a previous process', {
      fixes: cleared,
    });
  }
}
