import type { ContainerSpec } from '../docker/index.js';
import type { Session } from '../db/index.js';
import {
  RUNNER_WORKSPACE_DIR,
  runnerBinds,
  runnerEnvironment,
  type RunnerMounts,
} from '../runner/index.js';
import type { GitIdentity } from '../settings/index.js';

/**
 * How a session container is named and labelled (US-009).
 *
 * The session label is the single source of truth for "which container belongs
 * to which session": names are cosmetic (a session can be renamed) and the
 * `container_id` column can go stale across a crash, but the label travels with
 * the container and is queryable straight from the daemon — which is exactly
 * what reconciliation needs after a restart.
 */

/** Label carrying the session id; the value is the session's UUID. */
export const SESSION_LABEL = 'chief-web.session';
/** Label distinguishing session containers from helpers (login, probe). */
export const ROLE_LABEL = 'chief-web.role';
export const SESSION_ROLE = 'session';
/** Purely informational labels, so `docker ps` is readable. */
export const REPOSITORY_LABEL = 'chief-web.repository';
export const SESSION_NAME_LABEL = 'chief-web.session-name';

/** Label carrying the pull-request feedback run's id (US-021). */
export const PR_RUN_LABEL = 'chief-web.pr-run';
export const PR_FEEDBACK_ROLE = 'pr-feedback';
export const PR_NUMBER_LABEL = 'chief-web.pr-number';

type SessionIdentity = Pick<Session, 'id' | 'name' | 'repositoryId'>;

/**
 * `chief-web-<session name>-<first 8 of the id>`: readable in `docker ps` and
 * unique even when two repositories have a session with the same name.
 */
export function sessionContainerName(session: Pick<Session, 'id' | 'name'>): string {
  return `chief-web-${session.name}-${session.id.slice(0, 8)}`;
}

export function sessionLabels(session: SessionIdentity): Record<string, string> {
  return {
    [SESSION_LABEL]: session.id,
    [ROLE_LABEL]: SESSION_ROLE,
    [REPOSITORY_LABEL]: session.repositoryId,
    [SESSION_NAME_LABEL]: session.name,
  };
}

/** The session a container belongs to, or `null` when it is not one of ours. */
export function sessionIdOf(container: { labels: Readonly<Record<string, string>> }): string | null {
  const value = container.labels[SESSION_LABEL];
  return value === undefined || value === '' ? null : value;
}

/** Docker filter selecting every session container, or one session's. */
export function sessionLabelFilter(sessionId?: string): string {
  return sessionId === undefined ? SESSION_LABEL : `${SESSION_LABEL}=${sessionId}`;
}

/** Enough of a run to name and label its container. */
export interface PrRunIdentity {
  readonly id: string;
  readonly prNumber: number;
  readonly repositoryId: string;
}

/** `chief-web-pr-61-<first 8 of the run id>`: readable in `docker ps`. */
export function prRunContainerName(run: PrRunIdentity): string {
  return `chief-web-pr-${String(run.prNumber)}-${run.id.slice(0, 8)}`;
}

export function prRunLabels(run: PrRunIdentity): Record<string, string> {
  return {
    [PR_RUN_LABEL]: run.id,
    [ROLE_LABEL]: PR_FEEDBACK_ROLE,
    [REPOSITORY_LABEL]: run.repositoryId,
    [PR_NUMBER_LABEL]: String(run.prNumber),
  };
}

/**
 * Docker filter selecting every feedback-run container, or one run's.
 *
 * A separate label namespace from `chief-web.session` on purpose: session
 * reconciliation removes any container carrying the session label whose row is
 * gone, and a feedback run has no session row at all.
 */
export function prRunLabelFilter(runId?: string): string {
  return runId === undefined ? PR_RUN_LABEL : `${PR_RUN_LABEL}=${runId}`;
}

export interface PrRunContainerInput {
  readonly run: PrRunIdentity;
  readonly image: string;
  readonly identity: GitIdentity;
  readonly mounts: RunnerMounts;
}

/** The `POST /containers/create` body for a feedback run. */
export function prRunContainerSpec(input: PrRunContainerInput): ContainerSpec {
  const env = Object.entries(runnerEnvironment(input.identity)).map(
    ([key, value]) => `${key}=${value}`,
  );
  env.push(
    `CHIEF_PR_RUN_ID=${input.run.id}`,
    `CHIEF_PR_NUMBER=${String(input.run.prNumber)}`,
  );

  return {
    image: input.image,
    labels: prRunLabels(input.run),
    env,
    workingDir: RUNNER_WORKSPACE_DIR,
    binds: runnerBinds(input.mounts),
  };
}

export interface SessionContainerInput {
  readonly session: SessionIdentity;
  readonly image: string;
  /** Commit identity from the settings page (US-004). */
  readonly identity: GitIdentity;
  /** Host-side sources; see `HostPaths`. */
  readonly mounts: RunnerMounts;
}

/**
 * The `POST /containers/create` body for a session.
 *
 * No command is given: the image idles by design (`tail -f /dev/null`) and the
 * server `docker exec`s the agent, git and shell processes into it. No ports
 * are published — the container needs outbound network only.
 */
export function sessionContainerSpec(input: SessionContainerInput): ContainerSpec {
  const env = Object.entries(runnerEnvironment(input.identity)).map(
    ([key, value]) => `${key}=${value}`,
  );
  env.push(`CHIEF_SESSION_ID=${input.session.id}`, `CHIEF_SESSION_NAME=${input.session.name}`);

  return {
    image: input.image,
    labels: sessionLabels(input.session),
    env,
    workingDir: RUNNER_WORKSPACE_DIR,
    binds: runnerBinds(input.mounts),
  };
}
