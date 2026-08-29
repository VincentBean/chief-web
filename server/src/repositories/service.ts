import type { Config } from '../config.js';
import {
  countSessionsForRepository,
  createRepository,
  type Database,
  deleteRepository,
  getRepository,
  listRepositories,
  type Repository,
  type RepositoryKeySource,
  updateRepository,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import {
  type ConnectionTestResult,
  type CommandRunner,
  deletePrivateKey,
  generateEd25519KeyPair,
  hasPrivateKey,
  type InspectedKey,
  inspectPrivateKey,
  readPrivateKey,
  SshKeyError,
  testGitConnection,
  writePrivateKey,
} from '../ssh/index.js';

/**
 * Repository domain layer (US-005): keeps the database row and the private key
 * file on the data volume in step, and decides what the API is allowed to say
 * about a key.
 */

/** A repository as the API returns it — never including the private key. */
export interface RepositoryView {
  readonly id: string;
  readonly name: string;
  readonly sshUrl: string;
  readonly githubSlug: string;
  readonly defaultBaseBranch: string;
  /** The deploy key line to paste into GitHub; `null` for imported PEM keys. */
  readonly publicKey: string | null;
  readonly keyFingerprint: string | null;
  readonly keySource: RepositoryKeySource | null;
  /** Whether a usable private key exists on the data volume. */
  readonly keyConfigured: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A failure with the HTTP status and error code the route should answer with. */
export class RepositoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RepositoryError';
  }
}

export interface CreateRepositoryRequest {
  readonly name: string;
  readonly sshUrl: string;
  readonly githubSlug: string;
  readonly defaultBaseBranch: string;
  /** An existing key to import; omitted means "generate an ed25519 keypair". */
  readonly privateKey?: string;
}

export interface UpdateRepositoryRequest {
  readonly name?: string;
  readonly sshUrl?: string;
  readonly githubSlug?: string;
  readonly defaultBaseBranch?: string;
  /** Replaces the stored key; omitted leaves the existing one alone. */
  readonly privateKey?: string;
}

interface KeyMaterial {
  readonly privateKey: string;
  readonly publicKey: string | null;
  readonly keyFingerprint: string | null;
  readonly keySource: RepositoryKeySource;
}

export function toRepositoryView(config: Config, repository: Repository): RepositoryView {
  return {
    id: repository.id,
    name: repository.name,
    sshUrl: repository.sshUrl,
    githubSlug: repository.githubSlug,
    defaultBaseBranch: repository.defaultBaseBranch,
    publicKey: repository.publicKey,
    keyFingerprint: repository.keyFingerprint,
    keySource: repository.keySource,
    keyConfigured: hasPrivateKey(config, repository.id),
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

export function listRepositoryViews(db: Database, config: Config): RepositoryView[] {
  return listRepositories(db).map((repository) => toRepositoryView(config, repository));
}

export function getRepositoryView(db: Database, config: Config, id: string): RepositoryView | null {
  const repository = getRepository(db, id);
  return repository === null ? null : toRepositoryView(config, repository);
}

/** Turns a key problem into the 400 the route should answer with. */
function inspect(privateKey: string): InspectedKey {
  try {
    return inspectPrivateKey(privateKey);
  } catch (cause) {
    if (cause instanceof SshKeyError) throw new RepositoryError(400, cause.code, cause.message);
    throw cause;
  }
}

function keyMaterialFor(name: string, privateKey: string | undefined): KeyMaterial {
  if (privateKey === undefined) {
    // The comment shows up in GitHub's deploy key list, so name the repository.
    const generated = generateEd25519KeyPair(`chief-web:${name.replace(/\s+/g, '-')}`);
    return {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
      keyFingerprint: generated.fingerprint,
      keySource: 'generated',
    };
  }

  const inspected = inspect(privateKey);
  return {
    privateKey,
    publicKey: inspected.publicKey,
    keyFingerprint: inspected.fingerprint,
    keySource: 'imported',
  };
}

function isUniqueNameViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: repositories\.name/.test(error.message);
}

export function createRepositoryWithKey(
  db: Database,
  config: Config,
  request: CreateRepositoryRequest,
): RepositoryView {
  const key = keyMaterialFor(request.name, request.privateKey);

  let repository: Repository;
  try {
    repository = createRepository(db, {
      name: request.name,
      sshUrl: request.sshUrl,
      githubSlug: request.githubSlug,
      defaultBaseBranch: request.defaultBaseBranch,
      publicKey: key.publicKey,
      keyFingerprint: key.keyFingerprint,
      keySource: key.keySource,
    });
  } catch (cause) {
    if (isUniqueNameViolation(cause)) {
      throw new RepositoryError(
        409,
        'repository_name_taken',
        `A repository named "${request.name}" already exists.`,
      );
    }
    throw cause;
  }

  // The row is useless without its key, so a failed write rolls the row back
  // rather than leaving a repository that can never clone.
  try {
    writePrivateKey(config, repository.id, key.privateKey);
  } catch (cause) {
    deleteRepository(db, repository.id);
    throw new RepositoryError(
      500,
      'key_write_failed',
      `The private key could not be written to the data volume: ${String(cause)}`,
    );
  }

  logger.info('registered repository', {
    repositoryId: repository.id,
    name: repository.name,
    keySource: key.keySource,
    fingerprint: key.keyFingerprint,
  });

  return toRepositoryView(config, repository);
}

export function updateRepositoryWithKey(
  db: Database,
  config: Config,
  id: string,
  request: UpdateRepositoryRequest,
): RepositoryView {
  const existing = getRepository(db, id);
  if (existing === null) {
    throw new RepositoryError(404, 'repository_not_found', 'This repository no longer exists.');
  }

  const patch: {
    name?: string;
    sshUrl?: string;
    githubSlug?: string;
    defaultBaseBranch?: string;
    publicKey?: string | null;
    keyFingerprint?: string | null;
    keySource?: RepositoryKeySource;
  } = {};
  if (request.name !== undefined) patch.name = request.name;
  if (request.sshUrl !== undefined) patch.sshUrl = request.sshUrl;
  if (request.githubSlug !== undefined) patch.githubSlug = request.githubSlug;
  if (request.defaultBaseBranch !== undefined) patch.defaultBaseBranch = request.defaultBaseBranch;

  if (request.privateKey !== undefined) {
    const inspected = inspect(request.privateKey);
    writePrivateKey(config, id, request.privateKey);
    patch.publicKey = inspected.publicKey;
    patch.keyFingerprint = inspected.fingerprint;
    patch.keySource = 'imported';
  }

  let updated: Repository | null;
  try {
    updated = updateRepository(db, id, patch);
  } catch (cause) {
    if (isUniqueNameViolation(cause)) {
      throw new RepositoryError(
        409,
        'repository_name_taken',
        `A repository named "${request.name ?? existing.name}" already exists.`,
      );
    }
    throw cause;
  }

  if (updated === null) {
    throw new RepositoryError(404, 'repository_not_found', 'This repository no longer exists.');
  }
  return toRepositoryView(config, updated);
}

/**
 * Deletes a repository and its key. Blocked while sessions reference it — the
 * foreign key is `ON DELETE RESTRICT`, but the count gives a message that says
 * how many sessions are in the way.
 */
export function deleteRepositoryWithKey(db: Database, config: Config, id: string): void {
  const existing = getRepository(db, id);
  if (existing === null) {
    throw new RepositoryError(404, 'repository_not_found', 'This repository no longer exists.');
  }

  const sessions = countSessionsForRepository(db, id);
  if (sessions > 0) {
    throw new RepositoryError(
      409,
      'repository_in_use',
      `"${existing.name}" still has ${sessions} session${sessions === 1 ? '' : 's'}. Delete ${
        sessions === 1 ? 'it' : 'them'
      } first, then delete the repository.`,
    );
  }

  deleteRepository(db, id);
  deletePrivateKey(config, id);
  logger.info('deleted repository', { repositoryId: id, name: existing.name });
}

/**
 * Runs `git ls-remote` in a short-lived runner container using the repository's
 * own key. `run` is injectable so tests do not need a Docker daemon.
 */
export async function testRepositoryConnection(
  db: Database,
  config: Config,
  id: string,
  run?: CommandRunner,
): Promise<ConnectionTestResult> {
  const repository = getRepository(db, id);
  if (repository === null) {
    throw new RepositoryError(404, 'repository_not_found', 'This repository no longer exists.');
  }

  const privateKey = readPrivateKey(config, id);
  if (privateKey === null) {
    throw new RepositoryError(
      400,
      'repository_key_missing',
      'This repository has no private key on the data volume. Edit it and paste a key, or re-create it.',
    );
  }

  return testGitConnection(config, { sshUrl: repository.sshUrl, privateKey }, run);
}
