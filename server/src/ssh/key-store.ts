import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';

/**
 * Private keys live on the data volume, one file per repository, and never
 * leave the server: no API response, log line or UI ever contains one. Only the
 * orchestrator (US-009) reads them back, to hand them to a session container.
 */

/** Owner-only, as OpenSSH requires — it refuses group/world-readable keys. */
const PRIVATE_KEY_MODE = 0o600;
const KEYS_DIR_MODE = 0o700;

export function repositoryKeyPath(config: Config, repositoryId: string): string {
  return path.join(config.sshKeysDir, `${repositoryId}.key`);
}

/**
 * Writes the key with `0600`. `writeFile`'s mode is both masked by the process
 * umask and ignored for an existing file, so the mode is applied explicitly
 * afterwards; the file is created with the right mode from the start so it is
 * never briefly readable.
 */
export function writePrivateKey(config: Config, repositoryId: string, privateKey: string): string {
  fs.mkdirSync(config.sshKeysDir, { recursive: true, mode: KEYS_DIR_MODE });
  // `mkdir` does not change an existing directory's mode, and the boot-time
  // layout creation leaves it at the umask default.
  fs.chmodSync(config.sshKeysDir, KEYS_DIR_MODE);
  const file = repositoryKeyPath(config, repositoryId);
  const body = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`;
  fs.writeFileSync(file, body, { mode: PRIVATE_KEY_MODE });
  fs.chmodSync(file, PRIVATE_KEY_MODE);
  return file;
}

export function readPrivateKey(config: Config, repositoryId: string): string | null {
  try {
    return fs.readFileSync(repositoryKeyPath(config, repositoryId), 'utf8');
  } catch {
    return null;
  }
}

export function hasPrivateKey(config: Config, repositoryId: string): boolean {
  return fs.existsSync(repositoryKeyPath(config, repositoryId));
}

export function deletePrivateKey(config: Config, repositoryId: string): void {
  fs.rmSync(repositoryKeyPath(config, repositoryId), { force: true });
}
