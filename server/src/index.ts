import fs from 'node:fs/promises';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // The data volume is mounted empty on a fresh install; create the layout the
  // rest of the application expects (SQLite DB, SSH keys, session workspaces).
  await Promise.all(
    [config.dataDir, config.sshKeysDir, config.workspacesDir].map((dir) =>
      fs.mkdir(dir, { recursive: true }),
    ),
  );

  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    logger.info('chief-web server listening', {
      port: config.port,
      host: config.host,
      dataDir: config.dataDir,
      env: config.nodeEnv,
    });
  });

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    server.close((err) => {
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
