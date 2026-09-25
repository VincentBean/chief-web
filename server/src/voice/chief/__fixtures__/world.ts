import type { BuildLogHistory, BuildPoolView, BuildView } from '../../../build/index.js';
import {
  createPrReview,
  createRecurringTask,
  createRepository,
  createSession,
  type Database,
  getSession,
  IN_MEMORY,
  listStories,
  openDatabase,
  recordRecurringTaskOccurrence,
  type RecurringTaskOutcome,
  type Session,
  syncStories,
  updatePrReview,
  updateSession,
} from '../../../db/index.js';
import type { PullRequestFeedback } from '../../../lib/github-review.js';
import type { FixNowResult } from '../../../prconflicts/index.js';
import type { PrdParseError } from '../../../prd/index.js';
import type { PrRunView } from '../../../prfeedback/index.js';
import type { PrReviewView } from '../../../prreview/index.js';
import type { PullRequestListView } from '../../../pullrequests/index.js';
import type { RetryResult } from '../../../recovery/index.js';
import type { ReadyResult, SessionSetupView, SessionView } from '../../../sessions/index.js';
import type { ServerMessage } from '../../protocol.js';
import { ConfirmationGate } from '../confirm.js';
import type { ChiefServices } from '../tools.js';

/**
 * A seeded install for chief's tests (voice US-008): the state of docs/voice-plan.md §9.3's
 * example, over an in-memory database, with in-memory stand-ins for the
 * services that would otherwise need Docker or GitHub.
 */

/** 14:02 in Amsterdam. */
export const NOW = new Date('2026-09-25T12:02:00.000Z');

export interface ChiefWorld {
  readonly db: Database;
  readonly services: ChiefServices;
  readonly ids: Readonly<Record<string, string>>;
  /** Mutable, so a test can put the build pool or the hold in another state. */
  readonly state: {
    pool: BuildPoolView;
    hold: string | null;
    pullRequests: PullRequestListView | null;
    logText: string;
    /** Every action a tool took, in order: `sessions.create`, `builds.start`, … with its argument. */
    calls: { method: string; arg: unknown }[];
    /** An error an action method throws instead of acting, keyed like `calls[].method`. */
    failures: Map<string, Error>;
    /** The parse errors `markReady` refuses with; none means the PRD parses. */
    prdErrors: PrdParseError[];
    /** Feedback runs `prFeedback.find` knows, keyed `repositoryId#number`. */
    prRuns: Map<string, PrRunView>;
    /** What the conflict scan last said, keyed `repositoryId#number`. */
    conflicts: Map<string, boolean>;
    /** What `prConflicts.fixNow` answers. */
    fixNow: FixNowResult;
    /** How `pullRequests.feedback` reads every pull request. */
    feedback: Partial<PullRequestFeedback>;
    /** What `recurringTasks.fireNow` records; `pending` never settles, like a run still cloning. */
    firing: { outcome: RecurringTaskOutcome; detail: string | null; sessionId: string | null } | 'pending';
  };
}

export function chiefWorld(db: Database = openDatabase(IN_MEMORY)): ChiefWorld {
  const shop = createRepository(db, {
    name: 'shop-api',
    sshUrl: 'git@github.com:acme/shop-api.git',
    githubSlug: 'acme/shop-api',
    defaultBaseBranch: 'develop',
  });
  const web = createRepository(db, {
    name: 'chief-web',
    sshUrl: 'git@github.com:acme/chief-web.git',
    githubSlug: 'acme/chief-web',
    defaultBaseBranch: 'main',
  });
  const session = (repositoryId: string, name: string, status: Session['status']): Session =>
    createSession(db, { repositoryId, name, baseBranch: 'develop', prTargetBranch: 'develop', status });

  const billing = session(shop.id, 'billing-export', 'building');
  syncStories(
    db,
    billing.id,
    ['Schema', 'Query', 'CSV writer', 'Download route', 'Filters', 'Docs', 'Cleanup'].map((title, i) => ({
      storyId: `US-00${i + 1}`,
      title,
      priority: i + 1,
      status: i < 2 ? 'done' : i === 2 ? 'in-progress' : 'todo',
    })),
  );
  const sentry = session(shop.id, 'sentry-fix-4821', 'waiting');
  updateSession(db, sentry.id, { waitingUntil: '2026-09-25T13:10:00.000Z' });
  const onboarding = session(web.id, 'onboarding-copy', 'pending');
  const rector = session(shop.id, 'nightly-rector-20260925-0200', 'pr-open');
  updateSession(db, rector.id, { prUrl: 'https://github.com/acme/shop-api/pull/212' });
  const dark = session(web.id, 'dark-mode', 'ready');
  const exports = session(shop.id, 'billing-exports', 'failed');
  updateSession(db, exports.id, { failureStage: 'agent', lastError: 'Story US-002 failed three times.' });
  const merged = session(web.id, 'old-merged-thing', 'merged');

  createRecurringTask(db, {
    repositoryId: shop.id,
    name: 'nightly-rector',
    prompt: 'Run rector.',
    cronExpression: '0 2 * * *',
    baseBranch: 'develop',
    prTarget: 'develop',
    nextRunAt: '2026-09-26T00:00:00.000Z',
  });
  const weekly = createRecurringTask(db, {
    repositoryId: web.id,
    name: 'weekly-deps',
    prompt: 'Bump dependencies.',
    cronExpression: '0 3 * * 1',
    baseBranch: 'main',
    prTarget: 'main',
    nextRunAt: '2026-09-28T01:00:00.000Z',
  });
  recordRecurringTaskOccurrence(db, { recurringTaskId: weekly.id, outcome: 'failed', detail: 'Build failed.' });
  createRecurringTask(db, {
    repositoryId: web.id,
    name: 'monthly-audit',
    prompt: 'Audit.',
    cronExpression: '0 3 1 * *',
    baseBranch: 'main',
    prTarget: 'main',
    nextRunAt: '2026-10-01T01:00:00.000Z',
  });

  const review = createPrReview(db, {
    repositoryId: shop.id,
    prNumber: 209,
    prUrl: 'https://github.com/acme/shop-api/pull/209',
    prTitle: 'Speed up search',
    headBranch: 'search',
    baseBranch: 'develop',
  });
  updatePrReview(db, review.id, { status: 'failed' });

  const state: ChiefWorld['state'] = {
    pool: {
      active: 2,
      max: 3,
      free: 1,
      slots: [
        { kind: 'session', refId: billing.id, label: 'billing-export' },
        { kind: 'session', refId: sentry.id, label: 'sentry-fix-4821' },
      ],
      queued: 1,
      queue: [{ kind: 'session', refId: dark.id, label: 'dark-mode', position: 1, queuedAt: '2026-09-25T11:50:00.000Z' }],
    },
    hold: null,
    pullRequests: {
      fetchedAt: '2026-09-25T11:58:00.000Z',
      repositories: [
        {
          repositoryId: shop.id,
          repositoryName: 'shop-api',
          slug: 'acme/shop-api',
          error: null,
          message: null,
          truncated: false,
          pullRequests: [
            pull(212, 'Nightly rector run', rector.id),
            pull(209, 'Speed up search', null),
          ],
        },
      ],
    },
    logText: Array.from({ length: 30 }, (_, i) => `line ${i + 1}: ${'x'.repeat(40)}`).join('\n'),
    calls: [],
    failures: new Map(),
    prdErrors: [],
    prRuns: new Map(),
    conflicts: new Map(),
    fixNow: { ok: true, prNumber: 0, headBranch: 'chief/x', baseBranch: 'develop' },
    feedback: {},
    firing: { outcome: 'started', detail: null, sessionId: rector.id },
  };
  /** Records an action, or throws the failure a test put in for it. */
  const act = (method: string, arg: unknown): void => {
    state.calls.push({ method, arg });
    const failure = state.failures.get(method);
    if (failure !== undefined) throw failure;
  };
  const view = (id: string): SessionView => {
    const row = getSession(db, id);
    if (row === null) throw new Error(`No session ${id}`);
    return { ...row, scheduledStartAt: row.scheduledStartAt } as unknown as SessionView;
  };
  const ready = (id: string, ok: boolean): ReadyResult => ({
    ok,
    started: false,
    session: view(id),
    prd: { path: '.chief/prd.md', exists: true, parses: ok, storyCount: ok ? 3 : 0, errors: ok ? [] : state.prdErrors, updatedAt: null, bytes: 0 },
    stories: listStories(db, id),
  });
  const setStatus = (id: string, status: Session['status']): BuildView => {
    updateSession(db, id, { status });
    return buildView(db, id, state.pool);
  };

  const services: ChiefServices = {
    db,
    builds: {
      pool: () => state.pool,
      status: (sessionId) => buildView(db, sessionId, state.pool),
      start: async (sessionId) => {
        act('builds.start', sessionId);
        return Promise.resolve(setStatus(sessionId, 'building'));
      },
      stop: async (sessionId) => {
        act('builds.stop', sessionId);
        return Promise.resolve(setStatus(sessionId, 'ready'));
      },
      dequeue: (sessionId) => {
        act('builds.dequeue', sessionId);
        state.pool = { ...state.pool, queued: 0, queue: state.pool.queue.filter((entry) => entry.refId !== sessionId) };
        return buildView(db, sessionId, state.pool);
      },
    },
    sessions: {
      // Like the real one: the row is written before the clone, which never ends here.
      create: async (request) => {
        act('sessions.create', request);
        createSession(db, {
          repositoryId: request.repositoryId,
          name: request.name,
          baseBranch: request.baseBranch ?? 'main',
          prTargetBranch: request.prTargetBranch,
          status: 'pending',
        });
        return new Promise<SessionSetupView>(() => undefined);
      },
      markReady: async (id) => {
        act('sessions.markReady', id);
        if (state.prdErrors.length > 0) return Promise.resolve(ready(id, false));
        updateSession(db, id, { status: 'ready' });
        return Promise.resolve(ready(id, true));
      },
      backToPlanning: (id) => {
        act('sessions.backToPlanning', id);
        updateSession(db, id, { status: 'pending' });
        return ready(id, true);
      },
      setSchedule: (id, scheduledStartAt) => {
        act('sessions.setSchedule', { id, scheduledStartAt });
        updateSession(db, id, { scheduledStartAt });
        return view(id);
      },
    },
    retries: {
      retry: async (sessionId): Promise<RetryResult> => {
        act('retries.retry', sessionId);
        const build = setStatus(sessionId, 'building');
        return Promise.resolve({
          ok: true,
          sessionId,
          action: 'build',
          stage: 'agent',
          status: 'building',
          prUrl: null,
          message: 'Build restarted at the first story that is not done.',
          build,
          delivery: null,
        });
      },
    },
    now: () => NOW,
    buildLogs: {
      history: (s): BuildLogHistory => ({
        path: `.chief/${s.name}.log`,
        truncated: false,
        iterations:
          s.status === 'building'
            ? [
                { iteration: 3, storyId: 'US-003', startedAt: '2026-09-25T11:50:00.000Z', endedAt: null, exitCode: null, text: state.logText },
              ]
            : [],
      }),
    },
    pullRequests: {
      cached: () => state.pullRequests,
      list: () => (state.pullRequests === null ? Promise.reject(new Error('GitHub is unreachable')) : Promise.resolve(state.pullRequests)),
      feedback: async (repositoryId, number) => {
        act('pullRequests.feedback', { repositoryId, number });
        return Promise.resolve({
          slug: 'acme/shop-api',
          number,
          title: 'x',
          url: `https://github.com/acme/shop-api/pull/${number}`,
          state: 'OPEN',
          headRef: `branch-${number}`,
          headSha: 'head',
          headSlug: 'acme/shop-api',
          baseRef: 'develop',
          fromFork: false,
          threads: [],
          reviews: [],
          truncated: false,
          ...state.feedback,
        });
      },
    },
    prReviews: {
      start: async (repositoryId, prNumber) => {
        act('prReviews.start', { repositoryId, prNumber });
        return Promise.resolve({ id: `review-${prNumber}`, status: 'running', queued: false, queuePosition: null } as unknown as PrReviewView);
      },
    },
    prFeedback: {
      start: async (repositoryId, prNumber) => {
        act('prFeedback.start', { repositoryId, prNumber });
        const run = { id: `run-${prNumber}`, repositoryId, prNumber, status: 'running', queued: false, queuePosition: null, threads: [] };
        state.prRuns.set(`${repositoryId}#${prNumber}`, run as unknown as PrRunView);
        return Promise.resolve(run as unknown as PrRunView);
      },
      stop: async (runId) => {
        act('prFeedback.stop', runId);
        return Promise.resolve({ id: runId, status: 'pending', lastError: 'Stopped.' } as unknown as PrRunView);
      },
      find: (repositoryId, prNumber) => state.prRuns.get(`${repositoryId}#${prNumber}`) ?? null,
    },
    prConflicts: {
      fixNow: async (repositoryId, prNumber) => {
        act('prConflicts.fixNow', { repositoryId, prNumber });
        return Promise.resolve(state.fixNow);
      },
      conflicted: (repositoryId, prNumber) => state.conflicts.get(`${repositoryId}#${prNumber}`) ?? null,
    },
    github: {
      postReview: async (repositoryId, prNumber, body) => {
        act('github.postReview', { repositoryId, prNumber, body });
        return Promise.resolve({ id: 99, url: `https://github.com/acme/shop-api/pull/${prNumber}#pullrequestreview-99` });
      },
    },
    hold: { until: () => state.hold },
    recurringTasks: {
      // Like the real one: the history row is the record, whatever the outcome.
      fireNow: async (taskId) => {
        act('recurringTasks.fireNow', taskId);
        const firing = state.firing;
        if (firing === 'pending') return new Promise(() => undefined);
        const occurrence = recordRecurringTaskOccurrence(db, { recurringTaskId: taskId, ...firing });
        return Promise.resolve({ fired: firing.outcome === 'started', occurrence });
      },
    },
  };

  return {
    db,
    services,
    ids: {
      shop: shop.id,
      web: web.id,
      billing: billing.id,
      sentry: sentry.id,
      onboarding: onboarding.id,
      rector: rector.id,
      dark: dark.id,
      exports: exports.id,
      merged: merged.id,
    },
    state,
  };
}

function pull(number: number, title: string, sessionId: string | null): PullRequestListView['repositories'][number]['pullRequests'][number] {
  return {
    number,
    title,
    url: `https://github.com/acme/shop-api/pull/${number}`,
    headRef: `branch-${number}`,
    baseRef: 'develop',
    draft: false,
    fromFork: false,
    authorLogin: 'someone',
    updatedAt: '2026-09-25T10:00:00.000Z',
    sessionId,
  };
}

function buildView(db: Database, sessionId: string, pool: BuildPoolView): BuildView {
  const session = getSession(db, sessionId);
  if (session === null) throw new Error(`No session ${sessionId}`);
  const stories = listStories(db, sessionId);
  const current = stories.find((story) => story.status === 'in-progress') ?? null;
  const queued = pool.queue.find((entry) => entry.refId === sessionId) ?? null;
  return {
    sessionId,
    sessionName: session.name,
    status: session.status,
    running: session.status === 'building',
    iteration: session.status === 'building' ? 3 : 0,
    maxIterations: 12,
    currentStoryId: current?.storyId ?? null,
    attempts: 0,
    stories,
    prd: { path: '.chief/prd.md', exists: stories.length > 0, parses: stories.length > 0, storyCount: stories.length, errors: [], updatedAt: null, bytes: 0 },
    lastError: session.lastError,
    failureStage: session.failureStage,
    agentTimeoutMs: 1_800_000,
    buildModel: null,
    startedAt: null,
    queued: queued !== null,
    queuePosition: queued?.position ?? null,
    activeBuilds: pool.active,
    maxConcurrentBuilds: pool.max,
  };
}


/** A confirmation gate outside a call: `sent` collects what it tells the browser. */
export function testGate(now: () => number = () => NOW.getTime()): { gate: ConfirmationGate; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  let seq = 0;
  const gate = new ConfirmationGate({
    holder: { pendingConfirmation: null },
    now,
    send: (message) => sent.push(message),
    newId: () => `c${String(++seq)}`,
  });
  return { gate, sent };
}
