import { type Response, Router } from 'express';

import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { deriveGithubSlug, isValidGithubSlug, isValidGitUrl } from '../lib/git-url.js';
import { isValidSentrySlug } from '../lib/sentry-slug.js';
import {
  type CreateRepositoryRequest,
  createRepositoryWithKey,
  deleteRepositoryWithKey,
  getRepositoryView,
  listRepositoryViews,
  RepositoryError,
  testRepositoryConnection,
  type UpdateRepositoryRequest,
  updateRepositoryWithKey,
} from '../repositories/index.js';
import type { CommandRunner } from '../ssh/index.js';

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

const MAX_NAME_LENGTH = 100;
const MAX_BRANCH_LENGTH = 255;
const DEFAULT_BASE_BRANCH = 'main';

/**
 * Repository registration (US-005). Every response goes through
 * `RepositoryView`, which has no field that could carry a private key — the
 * key is written to the data volume and read back only by the orchestrator.
 */
export function createRepositoriesRouter(
  db: Database,
  config: Config,
  runCommand?: CommandRunner,
): Router {
  const router = Router();

  router.get('/repositories', (_req, res) => {
    res.status(200).json({ repositories: listRepositoryViews(db, config) });
  });

  router.get('/repositories/:id', (req, res) => {
    const repository = getRepositoryView(db, config, req.params.id);
    if (repository === null) {
      res.status(404).json({ error: 'repository_not_found', message: 'No such repository.' });
      return;
    }
    res.status(200).json(repository);
  });

  router.post('/repositories', (req, res) => {
    const parsed = parseCreate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }

    try {
      res.status(201).json(createRepositoryWithKey(db, config, parsed));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  router.put('/repositories/:id', (req, res) => {
    const parsed = parseUpdate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }

    try {
      res.status(200).json(updateRepositoryWithKey(db, config, req.params.id, parsed));
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  router.delete('/repositories/:id', (req, res) => {
    try {
      deleteRepositoryWithKey(db, config, req.params.id);
      res.status(204).end();
    } catch (cause) {
      respondWithFailure(res, cause);
    }
  });

  // A reachable-but-rejected remote is a *successful* request with `ok: false`,
  // so the UI can show git's stderr instead of a bare error banner.
  router.post('/repositories/:id/test-connection', (req, res) => {
    testRepositoryConnection(db, config, req.params.id, runCommand)
      .then((result) => {
        res.status(200).json(result);
      })
      .catch((cause: unknown) => {
        respondWithFailure(res, cause);
      });
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof RepositoryError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'repository_request_failed', message: String(cause) });
}

/** `null` when the body is a usable JSON object. */
function invalidBody(body: unknown): Invalid | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }
  return null;
}

/**
 * Like `optionalString`, but keeps the difference between "absent" and
 * "cleared": a field set to `null` or an empty string reads as `null`, which is
 * how the form unlinks a Sentry project.
 */
function clearableString(
  input: Record<string, unknown>,
  field: string,
  code: string,
): string | null | undefined | Invalid {
  if (!(field in input) || input[field] === undefined) return undefined;
  const raw = input[field];
  if (raw === null) return null;
  if (typeof raw !== 'string') return { error: code, message: `${field} must be a string.` };
  const value = raw.trim();
  return value === '' ? null : value;
}

/** `undefined` when the field is absent; an `Invalid` when it is the wrong shape. */
function optionalString(
  input: Record<string, unknown>,
  field: string,
  code: string,
): string | undefined | Invalid {
  if (!(field in input) || input[field] === undefined || input[field] === null) return undefined;
  const raw = input[field];
  if (typeof raw !== 'string') return { error: code, message: `${field} must be a string.` };
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function validateName(name: string): Invalid | null {
  if (name.length > MAX_NAME_LENGTH) {
    return {
      error: 'invalid_name',
      message: `The name must be at most ${MAX_NAME_LENGTH} characters.`,
    };
  }
  return null;
}

function validateSshUrl(url: string): Invalid | null {
  if (!isValidGitUrl(url)) {
    return {
      error: 'invalid_ssh_url',
      message: 'Expected a git remote such as git@github.com:owner/repo.git.',
    };
  }
  return null;
}

function validateSlug(slug: string): Invalid | null {
  if (!isValidGithubSlug(slug)) {
    return { error: 'invalid_github_slug', message: 'The slug must look like owner/repo.' };
  }
  return null;
}

/** Git forbids whitespace and a handful of metacharacters in ref names. */
function validateBranch(branch: string): Invalid | null {
  if (branch.length > MAX_BRANCH_LENGTH || /[\s~^:?*[\\]/.test(branch) || branch.startsWith('-')) {
    return { error: 'invalid_base_branch', message: 'That is not a valid git branch name.' };
  }
  return null;
}

function validateSentrySlug(slug: string, field: 'org' | 'project'): Invalid | null {
  if (!isValidSentrySlug(slug)) {
    return {
      error: `invalid_sentry_${field}`,
      message: `The Sentry ${field} slug must be lowercase letters, digits and hyphens, as it appears in the Sentry URL.`,
    };
  }
  return null;
}

/**
 * Reads the Sentry link out of a body. Both fields are optional and clearable;
 * whether the resulting *pair* makes sense is the domain layer's call, since an
 * edit only sees half of it.
 */
function parseSentryLink(
  input: Record<string, unknown>,
): { sentryOrg?: string | null; sentryProject?: string | null } | Invalid {
  const link: { sentryOrg?: string | null; sentryProject?: string | null } = {};

  const org = clearableString(input, 'sentryOrg', 'invalid_sentry_org');
  if (typeof org === 'object' && org !== null) return org;
  if (org !== undefined) {
    if (org !== null) {
      const bad = validateSentrySlug(org, 'org');
      if (bad) return bad;
    }
    link.sentryOrg = org;
  }

  const project = clearableString(input, 'sentryProject', 'invalid_sentry_project');
  if (typeof project === 'object' && project !== null) return project;
  if (project !== undefined) {
    if (project !== null) {
      const bad = validateSentrySlug(project, 'project');
      if (bad) return bad;
    }
    link.sentryProject = project;
  }

  return link;
}

function parseCreate(body: unknown): CreateRepositoryRequest | Invalid {
  const badBody = invalidBody(body);
  if (badBody) return badBody;
  const input = body as Record<string, unknown>;

  const name = optionalString(input, 'name', 'invalid_name');
  if (typeof name === 'object') return name;
  if (name === undefined) return { error: 'invalid_name', message: 'A name is required.' };
  const badName = validateName(name);
  if (badName) return badName;

  const sshUrl = optionalString(input, 'sshUrl', 'invalid_ssh_url');
  if (typeof sshUrl === 'object') return sshUrl;
  if (sshUrl === undefined) return { error: 'invalid_ssh_url', message: 'An SSH URL is required.' };
  const badUrl = validateSshUrl(sshUrl);
  if (badUrl) return badUrl;

  // Auto-derived from the URL unless the operator typed an override.
  const slugOverride = optionalString(input, 'githubSlug', 'invalid_github_slug');
  if (typeof slugOverride === 'object') return slugOverride;
  const githubSlug = slugOverride ?? deriveGithubSlug(sshUrl);
  if (githubSlug === null) {
    return {
      error: 'github_slug_required',
      message: 'The owner/repo slug could not be derived from that URL — enter it manually.',
    };
  }
  const badSlug = validateSlug(githubSlug);
  if (badSlug) return badSlug;

  const branch = optionalString(input, 'defaultBaseBranch', 'invalid_base_branch');
  if (typeof branch === 'object') return branch;
  const defaultBaseBranch = branch ?? DEFAULT_BASE_BRANCH;
  const badBranch = validateBranch(defaultBaseBranch);
  if (badBranch) return badBranch;

  const privateKey = optionalString(input, 'privateKey', 'invalid_private_key');
  if (typeof privateKey === 'object') return privateKey;

  const sentry = parseSentryLink(input);
  if ('error' in sentry) return sentry;

  return {
    name,
    sshUrl,
    githubSlug,
    defaultBaseBranch,
    ...sentry,
    // Omitted (not `undefined`) so `exactOptionalPropertyTypes` is satisfied
    // and the service can generate a keypair instead.
    ...(privateKey === undefined ? {} : { privateKey }),
  };
}

function parseUpdate(body: unknown): UpdateRepositoryRequest | Invalid {
  const badBody = invalidBody(body);
  if (badBody) return badBody;
  const input = body as Record<string, unknown>;

  const update: {
    name?: string;
    sshUrl?: string;
    githubSlug?: string;
    defaultBaseBranch?: string;
    privateKey?: string;
    sentryOrg?: string | null;
    sentryProject?: string | null;
  } = {};

  const name = optionalString(input, 'name', 'invalid_name');
  if (typeof name === 'object') return name;
  if (name !== undefined) {
    const bad = validateName(name);
    if (bad) return bad;
    update.name = name;
  }

  const sshUrl = optionalString(input, 'sshUrl', 'invalid_ssh_url');
  if (typeof sshUrl === 'object') return sshUrl;
  if (sshUrl !== undefined) {
    const bad = validateSshUrl(sshUrl);
    if (bad) return bad;
    update.sshUrl = sshUrl;
  }

  const githubSlug = optionalString(input, 'githubSlug', 'invalid_github_slug');
  if (typeof githubSlug === 'object') return githubSlug;
  if (githubSlug !== undefined) {
    const bad = validateSlug(githubSlug);
    if (bad) return bad;
    update.githubSlug = githubSlug;
  }

  const branch = optionalString(input, 'defaultBaseBranch', 'invalid_base_branch');
  if (typeof branch === 'object') return branch;
  if (branch !== undefined) {
    const bad = validateBranch(branch);
    if (bad) return bad;
    update.defaultBaseBranch = branch;
  }

  const privateKey = optionalString(input, 'privateKey', 'invalid_private_key');
  if (typeof privateKey === 'object') return privateKey;
  if (privateKey !== undefined) update.privateKey = privateKey;

  const sentry = parseSentryLink(input);
  if ('error' in sentry) return sentry;
  if (sentry.sentryOrg !== undefined) update.sentryOrg = sentry.sentryOrg;
  if (sentry.sentryProject !== undefined) update.sentryProject = sentry.sentryProject;

  return update;
}
