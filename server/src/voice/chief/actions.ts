import { listRepositories, listSessions, PR_TARGET_BRANCHES, type PrTargetBranch } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { getVoiceSettings } from '../../settings/index.js';
import type { UiAction } from '../protocol.js';
import { confirmable, type PreparedAction } from './confirm.js';
import { parseStartTime, speakTime } from './time.js';
import {
  type ChiefServices,
  type ChiefTool,
  isResult,
  missing,
  resolveName,
  SESSION_PARAM,
  sessionArg,
  sessionPath,
  stringArg,
  type ToolContext,
  type ToolResult,
  unresolved,
} from './tools.js';

/**
 * Chief's session actions (voice US-012): create a session, start and stop
 * its build, mark it ready or send it back to planning, schedule its start and
 * retry it. Every one of them is `confirmable`: `prepare` resolves the spoken
 * names, parses the time and words the prompt the operator answers; `execute`
 * calls the same services the dashboard's buttons do, with the stored ids.
 *
 * A service refusal (a 409, a 404, the usage-limit hold) is a result with the
 * service's own message for chief to say, never an exception.
 */

/** The longest slug `create_session` makes of a spoken name. */
export const SLUG_MAX = 40;

/** Filler words a spoken session name loses: "CSV export for invoices" → `csv-export-invoices`. */
const SLUG_STOPWORDS: ReadonlySet<string> = new Set(['a', 'an', 'the', 'for', 'of', 'and', 'de', 'het', 'een', 'voor', 'van', 'en']);

/** A spoken name as a session name: `[a-z0-9-_]`, at most {@link SLUG_MAX} characters, cut between words. */
export function slugify(raw: string): string {
  const words = raw
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .split('-')
    .filter((word) => word !== '');
  const kept = words.filter((word) => !SLUG_STOPWORDS.has(word));
  let slug = (kept.length === 0 ? words : kept).join('-');
  if (slug.length > SLUG_MAX) {
    const cut = slug.slice(0, SLUG_MAX + 1);
    const lastDash = cut.lastIndexOf('-');
    slug = lastDash > 0 ? cut.slice(0, lastDash) : slug.slice(0, SLUG_MAX);
  }
  return slug.replace(/^[-_]+|[-_]+$/g, '');
}

/** A thrown service error as a result chief can speak: the service's own message. */
export function serviceFailure(cause: unknown, fallback: string): ToolResult {
  if (cause instanceof Error) {
    const { status, code } = cause as Error & { status?: unknown; code?: unknown };
    if (typeof status === 'number' && typeof code === 'string') {
      return { ok: false, data: { error: code, status, message: cause.message }, summary: cause.message };
    }
    logger.warn('chief action failed', { error: cause.message });
    return { ok: false, data: { error: 'failed', message: cause.message }, summary: `${fallback}: ${cause.message}` };
  }
  return { ok: false, data: { error: 'failed', message: String(cause) }, summary: fallback };
}

/** `run`, with anything it throws turned into a failed result. */
async function guarded<T>(fallback: string, run: () => T | Promise<T>): Promise<T | ToolResult> {
  try {
    return await run();
  } catch (cause) {
    return serviceFailure(cause, fallback);
  }
}

function idArg(args: Readonly<Record<string, unknown>>): { id: string; name: string } {
  return { id: args['sessionId'] as string, name: args['name'] as string };
}

/** A confirmable action on one existing session. */
function sessionAction(
  services: ChiefServices,
  name: string,
  description: string,
  steps: {
    readonly extra?: Readonly<Record<string, unknown>>;
    prepare(session: { id: string; name: string }, args: Readonly<Record<string, unknown>>): PreparedAction | ToolResult;
    execute(target: { id: string; name: string }, args: Readonly<Record<string, unknown>>, ctx: ToolContext): Promise<ToolResult>;
  },
): ChiefTool {
  return confirmable(name, description, { session: SESSION_PARAM, ...steps.extra }, ['session'], {
    prepare: (args) =>
      guarded(`Could not ${name.replace(/_/g, ' ')}`, () => {
        const session = sessionArg(services, args);
        if (isResult(session)) return session;
        return steps.prepare({ id: session.id, name: session.name }, args);
      }),
    execute: (args, ctx) => {
      const target = idArg(args);
      return guarded(`Could not ${name.replace(/_/g, ' ')} ${target.name}`, () => steps.execute(target, args, ctx));
    },
  });
}

function prepared(prompt: string, args: Readonly<Record<string, unknown>>): PreparedAction {
  return { prompt, args };
}

/** The session actions over `services`. */
export function sessionActionTools(services: ChiefServices): ChiefTool[] {
  const { db } = services;
  const now = (): Date => services.now?.() ?? new Date();
  const open = (id: string): readonly UiAction[] => [{ action: 'navigate', path: sessionPath(id) }];

  return [
    confirmable(
      'create_session',
      'Create a session in a repository. The name is turned into a slug. Setup (the clone) continues after this returns; ' +
        'a setup failure is announced separately.',
      {
        repository: { type: 'string', description: 'Repository id or spoken name' },
        name: { type: 'string', description: 'What the session is about, e.g. "CSV export for invoices"' },
        base_branch: { type: 'string', description: "Defaults to the repository's base branch" },
        pr_target: { type: 'string', enum: [...PR_TARGET_BRANCHES], description: 'Branch the pull request targets; default main' },
        code_review: { type: 'boolean', description: 'Review the pull request automatically' },
      },
      ['repository', 'name'],
      {
        prepare: (args) =>
          guarded('Could not create the session', () => {
            const repoQuery = stringArg(args, 'repository');
            if (repoQuery === null) return missing('repository');
            const spoken = stringArg(args, 'name');
            if (spoken === null) return missing('name');
            const resolution = resolveName(repoQuery, listRepositories(db));
            if (resolution.kind !== 'one') return unresolved('repository', repoQuery, resolution);
            const repository = resolution.item;
            const slug = slugify(spoken);
            if (slug === '') {
              return { ok: false, data: { error: 'invalid_name', name: spoken }, summary: `"${spoken}" makes no usable session name` };
            }
            const target = stringArg(args, 'pr_target') ?? 'main';
            if (!(PR_TARGET_BRANCHES as readonly string[]).includes(target)) {
              return { ok: false, data: { error: 'invalid_pr_target', allowed: PR_TARGET_BRANCHES }, summary: `No PR target ${target}` };
            }
            if (listSessions(db, { repositoryId: repository.id }).some((session) => session.name === slug)) {
              return {
                ok: false,
                data: { error: 'session_name_taken', name: slug },
                summary: `"${repository.name}" already has a session named "${slug}"`,
              };
            }
            const baseBranch = stringArg(args, 'base_branch')?.trim() ?? repository.defaultBaseBranch;
            const codeReview = typeof args['code_review'] === 'boolean' ? args['code_review'] : null;
            const review = codeReview === null ? '' : codeReview ? ', with code review' : ', without code review';
            return prepared(`Create session ${slug} in ${repository.name}, from ${baseBranch} with a pull request into ${target}${review}?`, {
              repositoryId: repository.id,
              repository: repository.name,
              name: slug,
              baseBranch,
              prTargetBranch: target,
              codeReview,
            });
          }),
        execute: (args) =>
          guarded(`Could not create ${String(args['name'])}`, async () => {
            const repositoryId = args['repositoryId'] as string;
            const name = args['name'] as string;
            const codeReview = args['codeReview'];
            const creating = services.sessions.create({
              repositoryId,
              name,
              baseBranch: args['baseBranch'] as string,
              prTargetBranch: args['prTargetBranch'] as PrTargetBranch,
              ...(typeof codeReview === 'boolean' ? { codeReview } : {}),
            });
            // The row is written, or the request refused, before `create`
            // reaches the clone; one macrotask later a refusal has settled.
            // Setup carries on without us: its outcome is the `session.setup`
            // event's to report (US-015), so only a log line waits for it.
            const early = await Promise.race([
              creating.then(
                () => ({ kind: 'done' as const }),
                (cause: unknown) => ({ kind: 'refused' as const, cause }),
              ),
              new Promise<{ kind: 'pending' }>((resolve) => setImmediate(() => resolve({ kind: 'pending' }))),
            ]);
            if (early.kind === 'refused') return serviceFailure(early.cause, `Could not create ${name}`);
            creating.catch((cause: unknown) => logger.warn('session setup failed after chief created it', { name, error: String(cause) }));
            const session = listSessions(db, { repositoryId }).find((entry) => entry.name === name);
            if (session === undefined) {
              return { ok: false, data: { error: 'not_created', name }, summary: `Could not create ${name}` };
            }
            return {
              ok: true,
              data: { id: session.id, name: session.name, repository: args['repository'], status: session.status, setup: 'running' },
              summary: `Created session: ${session.name}`,
              ui: open(session.id),
            };
          }),
      },
    ),

    sessionAction(services, 'start_build', 'Start the build of a ready session (it queues when every slot is busy).', {
      prepare: (session) => prepared(`Start the build of ${session.name}?`, { sessionId: session.id, name: session.name }),
      execute: async (target) => {
        const build = await services.builds.start(target.id);
        return {
          ok: true,
          data: { id: target.id, name: target.name, status: build.status, queued: build.queued, queuePosition: build.queuePosition },
          summary: build.queued ? `Queued build: ${target.name} (#${String(build.queuePosition ?? 1)})` : `Started build: ${target.name}`,
          ui: open(target.id),
        };
      },
    }),

    sessionAction(services, 'stop_build', 'Stop a running build, or take a queued session out of the queue.', {
      prepare: (session) => {
        const queued = services.builds.status(session.id).queued;
        return prepared(queued ? `${session.name} is still queued. Remove from the queue?` : `Stop the build of ${session.name}?`, {
          sessionId: session.id,
          name: session.name,
          dequeue: queued,
        });
      },
      execute: async (target, args) => {
        const dequeue = args['dequeue'] === true;
        const build = dequeue ? services.builds.dequeue(target.id) : await services.builds.stop(target.id);
        return {
          ok: true,
          data: { id: target.id, name: target.name, status: build.status, removedFromQueue: dequeue },
          summary: dequeue ? `Removed from the queue: ${target.name}` : `Stopped build: ${target.name}`,
          ui: open(target.id),
        };
      },
    }),

    sessionAction(services, 'mark_ready', "Parse a pending session's PRD and make it buildable. Parse errors come back to read out.", {
      prepare: (session) => prepared(`Mark ${session.name} ready?`, { sessionId: session.id, name: session.name }),
      execute: async (target) => {
        const result = await services.sessions.markReady(target.id);
        const ui: readonly UiAction[] = [...open(target.id), { action: 'highlight', target: 'prd' }];
        if (!result.ok) {
          const errors = result.prd.errors.slice(0, 10).map((error) => ({ line: error.line, message: error.message }));
          return {
            ok: false,
            data: { error: 'prd_invalid', path: result.prd.path, errors, total: result.prd.errors.length },
            summary: `Not ready: ${target.name}, ${result.prd.errors.length === 1 ? '1 PRD problem' : `${String(result.prd.errors.length)} PRD problems`}`,
            ui,
          };
        }
        return {
          ok: true,
          data: { id: target.id, name: target.name, status: result.session.status, stories: result.stories.length, started: result.started },
          summary: `Marked ready: ${target.name}, ${String(result.stories.length)} stories`,
          ui,
        };
      },
    }),

    sessionAction(services, 'back_to_planning', 'Return a ready session to planning so its PRD can be edited.', {
      prepare: (session) => prepared(`Take ${session.name} back to planning?`, { sessionId: session.id, name: session.name }),
      execute: (target) => {
        const result = services.sessions.backToPlanning(target.id);
        return Promise.resolve({
          ok: true,
          data: { id: target.id, name: target.name, status: result.session.status },
          summary: `Back to planning: ${target.name}`,
          ui: open(target.id),
        });
      },
    }),

    sessionAction(
      services,
      'schedule_start',
      'Schedule when a pending or ready session starts building, or clear its schedule. ' +
        '`at` is ISO or the operator\'s words ("tonight at 2", "in 3 hours", "morgen om 9 uur"); ask again on ambiguous_time.',
      {
        extra: {
          at: { type: 'string', description: 'When to start, as said or ISO 8601' },
          clear: { type: 'boolean', description: 'true to remove the schedule' },
        },
        prepare: (session, args) => {
          const timeZone = getVoiceSettings(db).timezone;
          if (args['clear'] === true) {
            return prepared(`Clear the scheduled start of ${session.name}?`, { sessionId: session.id, name: session.name, at: null });
          }
          const at = stringArg(args, 'at');
          if (at === null) return missing('at');
          const parsed = parseStartTime(at, { now: now(), timeZone });
          if (!parsed.ok) return { ok: false, data: { reason: parsed.reason, message: parsed.message }, summary: parsed.message };
          const spoken = speakTime(new Date(parsed.at), timeZone);
          return prepared(`Schedule ${session.name} to start ${spoken}?`, { sessionId: session.id, name: session.name, at: parsed.at, spoken });
        },
        execute: (target, args) => {
          const at = typeof args['at'] === 'string' ? args['at'] : null;
          const view = services.sessions.setSchedule(target.id, at);
          return Promise.resolve({
            ok: true,
            data: { id: target.id, name: target.name, scheduledStartAt: view.scheduledStartAt },
            summary: at === null ? `Schedule cleared: ${target.name}` : `Scheduled: ${target.name}, ${String(args['spoken'])}`,
            ui: open(target.id),
          });
        },
      },
    ),

    sessionAction(services, 'retry', 'Retry a failed session from where it failed (the build, or the push and pull request).', {
      prepare: (session) => prepared(`Retry ${session.name}?`, { sessionId: session.id, name: session.name }),
      execute: async (target) => {
        const result = await services.retries.retry(target.id);
        return {
          ok: result.ok,
          data: { id: target.id, name: target.name, action: result.action, status: result.status, message: result.message },
          summary: result.ok ? `Retried: ${target.name}` : result.message,
          ui: open(target.id),
        };
      },
    }),
  ];
}
