import type { Config } from '../../config.js';
import {
  findPrRun,
  getQueuedBuild,
  getRepository,
  getSession,
  listRepositories,
  prRefId,
  type Repository,
} from '../../db/index.js';
import { isValidGithubSlug } from '../../lib/git-url.js';
import { createPullRequestReview, type PostedReview } from '../../lib/github-review.js';
import { forkRefusalMessage, VOICE_REQUEST_PREFIX } from '../../prfeedback/index.js';
import type { PullRequestListView, PullRequestView } from '../../pullrequests/index.js';
import { getGithubToken } from '../../settings/index.js';
import type { UiAction } from '../protocol.js';
import { serviceFailure } from './actions.js';
import {
  acting,
  type ChiefServices,
  type ChiefTool,
  missing,
  type PreparedAction,
  resolveName,
  stringArg,
  tool,
  type ToolResult,
  unresolved,
} from './tools.js';

/**
 * Chief's pull request tools (voice US-013): list the open pull requests, and
 * review one, address its feedback, stop that run, fix its merge conflicts or
 * pass on a change the operator asks for. Everything but the list is
 * built with `acting`, and every one of them drives the same service the Pull
 * requests page's buttons do.
 *
 * A pull request is named by repository (resolved like a session name) and
 * number. The number is an integer: turning "two thirteen" into 213 is the
 * model's job, not the tool's.
 */

/** How long `stop_pr_run` waits for the agent to stop before it answers "stopping". */
export const STOP_WAIT_MS = 2_000;

/** The most rows `list_pull_requests` hands the model. */
const MAX_ROWS = 30;

/** Posts the review behind a voice change request, as the configured token's user. */
export interface VoiceReviewGateway {
  postReview(repositoryId: string, prNumber: number, body: string): Promise<PostedReview>;
}

/** An error the tools turn into a spoken refusal, shaped like the services' own. */
export class VoiceReviewError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceReviewError';
  }
}

/** The production gateway: `createPullRequestReview` with the saved GitHub token. */
export class GithubVoiceReviews implements VoiceReviewGateway {
  constructor(
    private readonly config: Pick<Config, 'githubApiUrl'>,
    private readonly db: ChiefServices['db'],
  ) {}

  postReview(repositoryId: string, prNumber: number, body: string): Promise<PostedReview> {
    const repository = getRepository(this.db, repositoryId);
    if (repository === null) return Promise.reject(new VoiceReviewError(404, 'repository_not_found', 'No such repository.'));
    if (!isValidGithubSlug(repository.githubSlug)) {
      return Promise.reject(
        new VoiceReviewError(400, 'invalid_github_slug', `"${repository.githubSlug}" is not a GitHub owner/repo slug.`),
      );
    }
    const token = getGithubToken(this.db);
    if (token === null) {
      return Promise.reject(
        new VoiceReviewError(400, 'github_token_missing', 'No GitHub token is configured, so nothing can be posted.'),
      );
    }
    // Always `COMMENT` and never a line comment: `createPullRequestReview`
    // fixes the event, and the instruction is the whole of the body.
    return createPullRequestReview(token, this.config.githubApiUrl, repository.githubSlug, prNumber, { body, comments: [] });
  }
}

/** The body of the review a voice change request posts. */
export function voiceRequestBody(instruction: string): string {
  return `${VOICE_REQUEST_PREFIX}${instruction}`;
}

const PULL_REQUESTS_PAGE: readonly UiAction[] = [{ action: 'navigate', path: '/pull-requests' }];

const REPOSITORY_PARAM = { type: 'string', description: 'Repository id or spoken name' };
const NUMBER_PARAM = {
  type: 'integer',
  description: 'Pull request number as digits; turn spoken numbers ("two thirteen") into 213 yourself',
};
const PR_PARAMS = { repository: REPOSITORY_PARAM, number: NUMBER_PARAM };

/** A positive whole number, or null. Digit strings pass; words do not. */
export function prNumberArg(args: Readonly<Record<string, unknown>>): number | null {
  const raw = args['number'];
  const value = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

interface Target {
  readonly repository: Repository;
  readonly number: number;
  /** The row off the pull request list, when the list has it. */
  readonly pull: PullRequestView | null;
}

/** The list, fetched when stale; the cached copy when GitHub cannot be asked. */
async function currentList(services: ChiefServices): Promise<PullRequestListView | null> {
  try {
    return await services.pullRequests.list();
  } catch {
    return services.pullRequests.cached();
  }
}

async function targetArg(services: ChiefServices, args: Readonly<Record<string, unknown>>): Promise<Target | ToolResult> {
  const query = stringArg(args, 'repository');
  if (query === null) return missing('repository');
  const number = prNumberArg(args);
  if (number === null) {
    return {
      ok: false,
      data: { error: 'invalid_number', number: args['number'] ?? null },
      summary: 'The pull request number must be a positive whole number',
    };
  }
  const resolution = resolveName(query, listRepositories(services.db));
  if (resolution.kind !== 'one') return unresolved('repository', query, resolution);
  const repository = resolution.item;
  const list = await currentList(services);
  const pull =
    list?.repositories.find((entry) => entry.repositoryId === repository.id)?.pullRequests.find((entry) => entry.number === number) ??
    null;
  return { repository, number, pull };
}

function isTarget(value: Target | ToolResult): value is Target {
  return !('summary' in value);
}

function label(target: { repository: string; number: number }): string {
  return `${target.repository} #${String(target.number)}`;
}

function forkRefusal(repository: Repository, number: number, headRef: string): ToolResult {
  const message = forkRefusalMessage(headRef, number, repository.name);
  return { ok: false, data: { error: 'pull_request_from_fork', message }, summary: message, ui: PULL_REQUESTS_PAGE };
}

async function guarded(fallback: string, run: () => ToolResult | PreparedAction | Promise<ToolResult | PreparedAction>): Promise<ToolResult | PreparedAction> {
  try {
    return await run();
  } catch (cause) {
    return serviceFailure(cause, fallback);
  }
}

async function guardedResult(fallback: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (cause) {
    return { ...serviceFailure(cause, fallback), ui: PULL_REQUESTS_PAGE };
  }
}

/** The resolved arguments every pull request action runs with. */
function stored(args: Readonly<Record<string, unknown>>): { repositoryId: string; repository: string; number: number } {
  return { repositoryId: args['repositoryId'] as string, repository: args['repository'] as string, number: args['number'] as number };
}

/**
 * An action on one pull request: `prepare` resolves the target (refusing a
 * fork when `refuseFork`); `execute` gets the resolved ids only.
 */
function prAction(
  services: ChiefServices,
  name: string,
  description: string,
  steps: {
    readonly refuseFork: boolean;
    readonly extra?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    prepare(target: Target, args: Readonly<Record<string, unknown>>): PreparedAction | ToolResult;
    execute(target: { repositoryId: string; repository: string; number: number }, args: Readonly<Record<string, unknown>>): Promise<ToolResult>;
  },
): ChiefTool {
  const verb = name.replace(/_/g, ' ');
  return acting(name, description, { ...PR_PARAMS, ...steps.extra }, ['repository', 'number', ...(steps.required ?? [])], {
    prepare: (args) =>
      guarded(`Could not ${verb}`, async () => {
        const target = await targetArg(services, args);
        if (!isTarget(target)) return target;
        if (steps.refuseFork && target.pull?.fromFork === true) return forkRefusal(target.repository, target.number, target.pull.headRef);
        return steps.prepare(target, args);
      }),
    execute: (args) => {
      const target = stored(args);
      return guardedResult(`Could not ${verb} on ${label(target)}`, () => steps.execute(target, args));
    },
  });
}

function prepared(target: Target, extra: Readonly<Record<string, unknown>> = {}): PreparedAction {
  return {
    args: { repositoryId: target.repository.id, repository: target.repository.name, number: target.number, ...extra },
  };
}

/** The pull request tools over `services`. */
export function pullRequestTools(services: ChiefServices): ChiefTool[] {
  const { db } = services;

  return [
    tool(
      'list_pull_requests',
      'Open pull requests chief-web knows about, with their runs and conflicts. Opens the pull requests page.',
      {
        state: { type: 'string', enum: ['open', 'all'], description: 'Only open pull requests are listed either way' },
        repository: REPOSITORY_PARAM,
      },
      [],
      async (args) => {
        const repoQuery = stringArg(args, 'repository');
        let repositoryId: string | null = null;
        if (repoQuery !== null) {
          const resolution = resolveName(repoQuery, listRepositories(db));
          if (resolution.kind !== 'one') return unresolved('repository', repoQuery, resolution);
          repositoryId = resolution.item.id;
        }
        const list = await currentList(services);
        if (list === null) {
          return {
            ok: false,
            data: { error: 'pull_requests_unavailable' },
            summary: 'The pull requests could not be read from GitHub',
            ui: PULL_REQUESTS_PAGE,
          };
        }
        const repositories = list.repositories.filter((entry) => repositoryId === null || entry.repositoryId === repositoryId);
        const rows = repositories.flatMap((repository) =>
          repository.pullRequests.map((pull) => {
            const run = services.prFeedback.find(repository.repositoryId, pull.number);
            const unresolvedCount =
              run === null ? null : run.threads.filter((thread) => thread.kind === 'thread' && !thread.resolved).length;
            return {
              repository: repository.repositoryName,
              number: pull.number,
              title: pull.title,
              head: pull.headRef,
              draft: pull.draft,
              fromFork: pull.fromFork,
              session: pull.sessionId === null ? null : (getSession(db, pull.sessionId)?.name ?? null),
              unresolvedComments: unresolvedCount,
              conflicted: services.prConflicts.conflicted(repository.repositoryId, pull.number),
            };
          }),
        );
        const errors = repositories
          .filter((repository) => repository.error !== null)
          .map((repository) => ({ repository: repository.repositoryName, error: repository.error }));
        return {
          ok: true,
          data: {
            pullRequests: rows.slice(0, MAX_ROWS),
            total: rows.length,
            fetchedAt: list.fetchedAt,
            ...(errors.length === 0 ? {} : { errors }),
          },
          summary: `${rows.length} open pull request${rows.length === 1 ? '' : 's'}`,
          ui: PULL_REQUESTS_PAGE,
        };
      },
    ),
    prAction(services, 'review_pull_request', 'Start a code review of a pull request; the findings are posted on GitHub.', {
      refuseFork: false,
      prepare: (target) => prepared(target),
      execute: async (target) => {
        const review = await services.prReviews.start(target.repositoryId, target.number);
        return {
          ok: true,
          data: { reviewId: review.id, status: review.status, queued: review.queued, queuePosition: review.queuePosition },
          summary: `Review: ${label(target)}${review.queued ? ' (queued)' : ''}`,
          ui: PULL_REQUESTS_PAGE,
        };
      },
    }),
    prAction(
      services,
      'address_pr_feedback',
      "Start a run that implements a pull request's unresolved review comments and answers them on GitHub.",
      {
        refuseFork: true,
        prepare: (target) => prepared(target),
        execute: async (target) => {
          const run = await services.prFeedback.start(target.repositoryId, target.number);
          return {
            ok: true,
            data: { runId: run.id, status: run.status, queued: run.queued, queuePosition: run.queuePosition },
            summary: `Address feedback: ${label(target)}${run.queued ? ' (queued)' : ''}`,
            ui: PULL_REQUESTS_PAGE,
          };
        },
      },
    ),
    prAction(services, 'stop_pr_run', 'Stop the feedback run that is active (running or queued) on a pull request.', {
      refuseFork: false,
      prepare: (target) => {
        const runId = activeRunId(services, target.repository.id, target.number);
        if (runId === null) return noActiveRun(target.repository.name, target.number);
        return prepared(target, { runId });
      },
      execute: async (target, args) => {
        const runId = args['runId'] as string;
        const stopping = services.prFeedback.stop(runId);
        const outcome = await Promise.race([
          stopping.then((run) => ({ kind: 'stopped' as const, run })),
          new Promise<{ kind: 'stopping' }>((resolve) => setTimeout(() => resolve({ kind: 'stopping' }), STOP_WAIT_MS).unref()),
        ]);
        if (outcome.kind === 'stopping') {
          stopping.catch(() => undefined);
          return { ok: true, data: { runId, stopping: true }, summary: `Stopping: ${label(target)}`, ui: PULL_REQUESTS_PAGE };
        }
        return {
          ok: true,
          data: { runId, status: outcome.run.status, lastError: outcome.run.lastError },
          summary: `Stopped: ${label(target)}`,
          ui: PULL_REQUESTS_PAGE,
        };
      },
    }),
    prAction(services, 'fix_pr_conflicts', "Check a pull request for merge conflicts now and, if it has any, start chief-web's conflict fix.", {
      refuseFork: true,
      prepare: (target) => prepared(target),
      execute: async (target) => {
        const result = await services.prConflicts.fixNow(target.repositoryId, target.number);
        if (!result.ok) {
          return { ok: false, data: { error: result.code, message: result.reason }, summary: result.reason, ui: PULL_REQUESTS_PAGE };
        }
        return {
          ok: true,
          data: { head: result.headBranch, base: result.baseBranch, started: true },
          summary: `Fix conflicts: ${label(target)}`,
          ui: PULL_REQUESTS_PAGE,
        };
      },
    }),
    prAction(
      services,
      'request_pr_change',
      'Ask for a change on a pull request: posts the instruction on GitHub as a review comment, then starts a run that ' +
        'implements it and replies there.',
      {
        refuseFork: true,
        extra: { instruction: { type: 'string', description: "The change, in the operator's words" } },
        required: ['instruction'],
        prepare: (target, args) => {
          const instruction = stringArg(args, 'instruction')?.trim() ?? null;
          if (instruction === null || instruction === '') return missing('instruction');
          return prepared(target, { instruction });
        },
        execute: async (target, args) => {
          const instruction = args['instruction'] as string;
          // Read fresh before anything is posted: a comment nobody can act on
          // is worse than none.
          const feedback = await services.pullRequests.feedback(target.repositoryId, target.number);
          const repository = getRepository(db, target.repositoryId);
          if (feedback.fromFork && repository !== null) return forkRefusal(repository, target.number, feedback.headRef);
          if (feedback.state !== 'OPEN') {
            const message = `Pull request #${String(target.number)} is ${feedback.state.toLowerCase()}, so there is nothing to change.`;
            return { ok: false, data: { error: 'pull_request_not_open', message }, summary: message, ui: PULL_REQUESTS_PAGE };
          }
          const posted = await services.github.postReview(target.repositoryId, target.number, voiceRequestBody(instruction));
          try {
            const run = await services.prFeedback.start(target.repositoryId, target.number);
            return {
              ok: true,
              data: { posted: posted.url, runId: run.id, status: run.status, queued: run.queued },
              summary: `Change requested: ${label(target)}${run.queued ? ' (queued)' : ''}`,
              ui: PULL_REQUESTS_PAGE,
            };
          } catch (cause) {
            // The request is on GitHub either way; say so, and why nothing picked it up.
            const failure = serviceFailure(cause, 'The run did not start');
            return {
              ok: false,
              data: { posted: posted.url, run: failure.data },
              summary: `Posted the request on ${label(target)}, but the run did not start: ${failure.summary}`,
              ui: PULL_REQUESTS_PAGE,
            };
          }
        },
      },
    ),
  ];
}

/** The feedback run that is running or waiting in the queue on a pull request. */
function activeRunId(services: ChiefServices, repositoryId: string, number: number): string | null {
  const run = findPrRun(services.db, repositoryId, number);
  if (run === null) return null;
  const queued = getQueuedBuild(services.db, 'pr-feedback', prRefId(repositoryId, number)) !== null;
  return run.status === 'running' || queued ? run.id : null;
}

function noActiveRun(repository: string, number: number): ToolResult {
  return {
    ok: false,
    data: { error: 'no_active_run' },
    summary: `No run is active on ${label({ repository, number })}`,
    ui: PULL_REQUESTS_PAGE,
  };
}
