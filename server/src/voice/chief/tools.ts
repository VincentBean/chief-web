import type { BuildLogHistory, BuildPoolView, BuildView } from '../../build/index.js';
import {
  countStories,
  type Database,
  failureStageLabel,
  getRepository,
  listRepositories,
  listSessions,
  SESSION_STATUSES,
  type Session,
  type SessionStatus,
} from '../../db/index.js';
import type { PullRequestListView } from '../../pullrequests/index.js';
import type { CallFocus, UiAction } from '../protocol.js';
import { type ConfirmationGate, confirmTool } from './confirm.js';
import type { ChatTool } from './openrouter-client.js';

/**
 * Chief's tools (plan §9.2): each one a JSON-schema `definition` the model
 * sees and a `handler` over the services chief-web already has. A result's
 * `data` goes back to the model as compact JSON (ids, names, statuses; never
 * full logs), its `summary` is the one-liner on the tool card, and `ui` is
 * what the operator's browser is told to do.
 *
 * Tools that act (create a session, start a build) are built with
 * `confirmable` from `confirm.ts`: their first call only asks, and the
 * `confirm` tool runs them in a later turn.
 */

/** The slices of chief-web's services the tools and the snapshot read. */
export interface ChiefServices {
  readonly db: Database;
  readonly builds: {
    pool(): BuildPoolView;
    status(sessionId: string): BuildView;
  };
  readonly buildLogs: { history(session: Session): BuildLogHistory };
  /** The pull request list as last fetched; never a GitHub call. */
  readonly pullRequests: { cached(): PullRequestListView | null };
  readonly hold: { until(): string | null };
}

/** What a handler knows about the call it runs in. */
export interface ToolContext {
  readonly signal: AbortSignal;
  readonly turn: number;
  readonly focus: CallFocus;
  /** Hangs up once the turn in progress (the goodbye) has been spoken. */
  endCall(): void;
  /** The call's one pending confirmation. */
  readonly confirmations: Pick<ConfirmationGate, 'request' | 'take'>;
}

export interface ToolResult {
  readonly ok: boolean;
  readonly data: unknown;
  readonly summary: string;
  readonly ui?: readonly UiAction[];
}

export interface ChiefTool {
  readonly definition: ChatTool;
  handler(args: Readonly<Record<string, unknown>>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
  /** A confirmable tool's action, run by `confirm` with the stored arguments. */
  readonly execute?: (args: Readonly<Record<string, unknown>>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

/** How many rendered log lines `build_status` looks at, and how much of them it keeps. */
export const BUILD_LOG_LINES = 20;
export const BUILD_LOG_SUMMARY_CHARS = 600;

/** `show`'s pages and where each one lives in the web app. */
export const PAGES: Readonly<Record<string, string>> = {
  overview: '/',
  sessions: '/sessions',
  'pull-requests': '/pull-requests',
  'recurring-tasks': '/recurring-tasks',
  repositories: '/repositories',
  sentry: '/sentry',
  settings: '/settings',
};

/* ------------------------------------------------------- name resolution */

/** Both sides of a spoken-name comparison: "The Billing_Export session" → `billing-export`. */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .split('-')
    .filter((word) => word !== '' && word !== 'the' && word !== 'session')
    .join('-');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The largest edit distance a spoken name may be off by. */
export const FUZZY_DISTANCE = 2;
/** How many names a failed resolution offers back. */
const MAX_CANDIDATES = 5;

export type Resolution<T> =
  | { readonly kind: 'one'; readonly item: T }
  | { readonly kind: 'none' | 'many'; readonly candidates: readonly string[] };

/**
 * An id or a spoken name to one item: the id itself, then the exact
 * normalized name, then a name the query is a prefix of, then a name within
 * {@link FUZZY_DISTANCE} edits. The first step that finds anything decides;
 * more than one hit there is ambiguous rather than a reason to guess further.
 */
export function resolveName<T extends { readonly id: string; readonly name: string }>(
  query: string,
  items: readonly T[],
): Resolution<T> {
  const byId = items.find((item) => item.id === query.trim());
  if (byId !== undefined) return { kind: 'one', item: byId };
  const wanted = normalizeName(query);
  const named = items.map((item) => ({ item, key: normalizeName(item.name) }));
  if (wanted !== '') {
    const steps: ((key: string) => boolean)[] = [
      (key) => key === wanted,
      (key) => key.startsWith(wanted),
      (key) => levenshtein(key, wanted) <= FUZZY_DISTANCE,
    ];
    for (const matches of steps) {
      const hits = named.filter((entry) => matches(entry.key));
      if (hits.length === 1) return { kind: 'one', item: (hits[0] as (typeof named)[number]).item };
      if (hits.length > 1) return { kind: 'many', candidates: hits.slice(0, MAX_CANDIDATES).map((hit) => hit.item.name) };
    }
  }
  const nearest = [...named]
    .sort((a, b) => levenshtein(a.key, wanted) - levenshtein(b.key, wanted))
    .slice(0, MAX_CANDIDATES)
    .map((entry) => entry.item.name);
  return { kind: 'none', candidates: nearest };
}

function unresolved(what: 'session' | 'repository', query: string, resolution: Resolution<unknown>): ToolResult {
  const candidates = resolution.kind === 'one' ? [] : resolution.candidates;
  const summary =
    resolution.kind === 'many'
      ? `"${query}" matches several ${what === 'session' ? 'sessions' : 'repositories'}`
      : `No ${what} called "${query}"`;
  return { ok: false, data: { error: resolution.kind === 'many' ? 'ambiguous' : 'not_found', candidates }, summary };
}

function stringArg(args: Readonly<Record<string, unknown>>, name: string): string | null {
  const value = args[name];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function missing(name: string): ToolResult {
  return { ok: false, data: { error: 'missing_argument', argument: name }, summary: `Missing ${name}` };
}

/** Resolves the `session` argument, or the result that says why it could not be. */
function sessionArg(services: ChiefServices, args: Readonly<Record<string, unknown>>): Session | ToolResult {
  const query = stringArg(args, 'session');
  if (query === null) return missing('session');
  const resolution = resolveName(query, listSessions(services.db));
  return resolution.kind === 'one' ? resolution.item : unresolved('session', query, resolution);
}

function isResult(value: Session | ToolResult): value is ToolResult {
  return 'summary' in value;
}

/* --------------------------------------------------------------- helpers */

function repositoryName(db: Database, id: string, cache: Map<string, string>): string {
  let name = cache.get(id);
  if (name === undefined) {
    name = getRepository(db, id)?.name ?? id;
    cache.set(id, name);
  }
  return name;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The PR number off a pull request URL, for speaking it. */
export function prNumberOf(url: string | null): number | null {
  const match = url === null ? null : /\/pull\/(\d+)/.exec(url);
  return match === null ? null : Number(match[1]);
}

/**
 * The gist of a build log: its last {@link BUILD_LOG_LINES} non-empty lines,
 * whitespace collapsed, and at most {@link BUILD_LOG_SUMMARY_CHARS} characters
 * of their tail, since the latest line is what the operator is asking about.
 */
export function summarizeLog(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .slice(-BUILD_LOG_LINES);
  const joined = lines.join(' | ');
  return joined.length <= BUILD_LOG_SUMMARY_CHARS ? joined : `…${joined.slice(-(BUILD_LOG_SUMMARY_CHARS - 1))}`;
}

function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`;
}

/* ------------------------------------------------------------------ tools */

function tool(
  name: string,
  description: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
  handler: ChiefTool['handler'],
): ChiefTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, ...(required.length === 0 ? {} : { required }) },
      },
    },
    handler,
  };
}

const SESSION_PARAM = { type: 'string', description: 'Session id or spoken name' };

/** Chief's tools over `services`, keyed by name, `confirm` included. */
export function createChiefTools(services: ChiefServices): ReadonlyMap<string, ChiefTool> {
  const { db } = services;
  const tools: ChiefTool[] = [
    tool(
      'list_sessions',
      'List sessions, active first. Only needed when the STATE block is not enough, e.g. for older or filtered sessions.',
      {
        status: { type: 'string', enum: [...SESSION_STATUSES] },
        repository: { type: 'string', description: 'Repository id or spoken name' },
      },
      [],
      (args) => {
        const status = stringArg(args, 'status');
        if (status !== null && !(SESSION_STATUSES as readonly string[]).includes(status)) {
          return { ok: false, data: { error: 'unknown_status', statuses: SESSION_STATUSES }, summary: `Unknown status ${status}` };
        }
        const repoQuery = stringArg(args, 'repository');
        let repositoryId: string | undefined;
        if (repoQuery !== null) {
          const resolution = resolveName(repoQuery, listRepositories(db));
          if (resolution.kind !== 'one') return unresolved('repository', repoQuery, resolution);
          repositoryId = resolution.item.id;
        }
        const names = new Map<string, string>();
        const sessions = orderActiveFirst(
          listSessions(db, {
            ...(repositoryId === undefined ? {} : { repositoryId }),
            ...(status === null ? {} : { status: status as SessionStatus }),
          }),
        );
        const data = sessions.slice(0, 30).map((session) => {
          const stories = countStories(db, session.id);
          return {
            id: session.id,
            name: session.name,
            repository: repositoryName(db, session.repositoryId, names),
            status: session.status,
            stories: stories.total === 0 ? null : `${stories.done}/${stories.total}`,
          };
        });
        return {
          ok: true,
          data: { sessions: data, total: sessions.length },
          summary: `${sessions.length} session${sessions.length === 1 ? '' : 's'}`,
        };
      },
    ),
    tool(
      'get_session',
      'Details of one session: status, stories, build progress, PRD state, PR.',
      { session: SESSION_PARAM },
      ['session'],
      (args) => {
        const session = sessionArg(services, args);
        if (isResult(session)) return session;
        const build = services.builds.status(session.id);
        return {
          ok: true,
          data: {
            id: session.id,
            name: session.name,
            repository: getRepository(db, session.repositoryId)?.name ?? session.repositoryId,
            status: session.status,
            baseBranch: session.baseBranch,
            prTarget: session.prTargetBranch,
            pr: prNumberOf(session.prUrl),
            scheduledStartAt: session.scheduledStartAt,
            waitingUntil: session.waitingUntil,
            failedAt: session.failureStage === null ? null : failureStageLabel(session.failureStage),
            lastError: session.lastError === null ? null : clip(session.lastError, 200),
            build: {
              running: build.running,
              iteration: build.iteration,
              currentStory: build.currentStoryId,
              queuePosition: build.queuePosition,
            },
            stories: build.stories.map((story) => ({ id: story.storyId, title: story.title, status: story.status })),
            prd: {
              exists: build.prd.exists,
              parses: build.prd.parses,
              stories: build.prd.storyCount,
              errors: build.prd.errors.length,
            },
          },
          summary: `${session.name}: ${session.status}`,
        };
      },
    ),
    tool('list_repositories', 'Registered repositories.', {}, [], () => {
      const repositories = listRepositories(db);
      return {
        ok: true,
        data: {
          repositories: repositories.map((repository) => ({
            id: repository.id,
            name: repository.name,
            baseBranch: repository.defaultBaseBranch,
            slug: repository.githubSlug,
          })),
        },
        summary: `${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}`,
      };
    }),
    tool('overview', 'Dashboard numbers: running, queued, needs attention, usage-limit hold.', {}, [], () => {
      const pool = services.builds.pool();
      const byStatus: Partial<Record<SessionStatus, number>> = {};
      for (const session of listSessions(db)) byStatus[session.status] = (byStatus[session.status] ?? 0) + 1;
      const hold = services.hold.until();
      return {
        ok: true,
        data: {
          slots: { busy: pool.active, max: pool.max },
          running: pool.slots.map((slot) => ({ kind: slot.kind, name: slot.label })),
          queued: pool.queue.map((entry) => ({ kind: entry.kind, name: entry.label, position: entry.position })),
          sessions: byStatus,
          usageLimitHoldUntil: hold,
        },
        summary: `${pool.active}/${pool.max} slots busy, ${pool.queued} queued`,
        ui: [{ action: 'navigate', path: '/' }],
      };
    }),
    tool(
      'build_status',
      'Current story and a short summary of the latest build log.',
      { session: SESSION_PARAM },
      ['session'],
      (args) => {
        const session = sessionArg(services, args);
        if (isResult(session)) return session;
        const build = services.builds.status(session.id);
        const history = services.buildLogs.history(session);
        const last = history.iterations.at(-1);
        const story = build.stories.find((entry) => entry.storyId === build.currentStoryId) ?? null;
        const counts = { done: build.stories.filter((entry) => entry.status === 'done').length, total: build.stories.length };
        return {
          ok: true,
          data: {
            id: session.id,
            name: session.name,
            status: session.status,
            running: build.running,
            iteration: build.iteration,
            story: story === null ? null : { id: story.storyId, title: story.title },
            stories: `${counts.done}/${counts.total}`,
            queuePosition: build.queuePosition,
            lastError: session.lastError === null ? null : clip(session.lastError, 200),
            log:
              last === undefined
                ? null
                : {
                    iteration: last.iteration,
                    story: last.storyId,
                    ended: last.endedAt !== null,
                    exitCode: last.exitCode,
                    summary: summarizeLog(last.text),
                  },
          },
          summary: `${session.name}: ${session.status}, ${counts.done}/${counts.total} stories`,
          ui: [{ action: 'navigate', path: sessionPath(session.id) }],
        };
      },
    ),
    tool(
      'show',
      "Open a page in the operator's browser.",
      { page: { type: 'string', enum: Object.keys(PAGES) } },
      ['page'],
      (args) => {
        const page = stringArg(args, 'page');
        const path = page === null ? undefined : PAGES[page];
        if (path === undefined) {
          return { ok: false, data: { error: 'unknown_page', pages: Object.keys(PAGES) }, summary: `No page ${page ?? ''}`.trim() };
        }
        return { ok: true, data: { shown: page }, summary: `Opened ${page}`, ui: [{ action: 'navigate', path }] };
      },
    ),
    tool(
      'end_call',
      'End the call. Say goodbye in the same reply; the call hangs up once that is spoken.',
      {},
      [],
      (_args, ctx) => {
        ctx.endCall();
        return { ok: true, data: { ending: true }, summary: 'Ending the call' };
      },
    ),
  ];
  return withConfirmTool(tools);
}

/** `tools` keyed by name, plus the `confirm` tool that runs their confirmations. */
export function withConfirmTool(tools: readonly ChiefTool[]): ReadonlyMap<string, ChiefTool> {
  const map = new Map(tools.map((entry) => [entry.definition.function.name, entry]));
  const confirm = confirmTool(() => map);
  map.set(confirm.definition.function.name, confirm);
  return map;
}

/** Busy work first, then what waits on the operator, then what is over. */
const STATUS_ORDER: readonly SessionStatus[] = [
  'building',
  'waiting',
  'reviewing',
  'fixing',
  'pending',
  'ready',
  'failed',
  'pr-open',
  'finished',
  'merged',
];

/** Sessions sorted by {@link STATUS_ORDER}, keeping the list's own order within a status. */
export function orderActiveFirst(sessions: readonly Session[]): Session[] {
  const rank = (status: SessionStatus): number => {
    const index = STATUS_ORDER.indexOf(status);
    return index === -1 ? STATUS_ORDER.length : index;
  };
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => rank(a.session.status) - rank(b.session.status) || a.index - b.index)
    .map((entry) => entry.session);
}

/** Statuses that hold a build slot or are otherwise moving on their own. */
export const ACTIVE_STATUSES: ReadonlySet<SessionStatus> = new Set(['building', 'waiting', 'reviewing', 'fixing']);
