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
  type Session,
  syncStories,
  updatePrReview,
  updateSession,
} from '../../../db/index.js';
import type { PullRequestListView } from '../../../pullrequests/index.js';
import type { ChiefServices } from '../tools.js';

/**
 * A seeded install for chief's tests (voice US-008): the state of plan §9.3's
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
  };

  const services: ChiefServices = {
    db,
    builds: {
      pool: () => state.pool,
      status: (sessionId) => buildView(db, sessionId, state.pool),
    },
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
    pullRequests: { cached: () => state.pullRequests },
    hold: { until: () => state.hold },
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

