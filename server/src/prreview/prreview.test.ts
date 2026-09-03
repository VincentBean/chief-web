import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentRunner } from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  countActivePrReviews,
  createRepository,
  type Database,
  findPrReview,
  IN_MEMORY,
  openDatabase,
  type Repository,
  setSetting,
  setSettingNumber,
} from '../db/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { GithubApiError } from '../lib/github.js';
import type { PullRequestFeedback } from '../lib/github-review.js';
import { UsageLimitHold } from '../limits/index.js';
import type { BuildSlots, PrRunContainers } from '../prfeedback/index.js';
import type {
  PublishedReview,
  ReviewPassResult,
  ReviewPublisher,
  ReviewReport,
  ReviewSubject,
  ReviewTarget,
} from '../review/index.js';
import type { SessionExecutor } from '../sessions/index.js';
import {
  PrReviewError,
  type PrReviewGateway,
  type PrReviewer,
  PrReviewService,
  type PrReviewSolver,
} from './service.js';

const TOKEN = 'ghp_token';
const SLUG = 'VincentBean/leo';
const HEAD = 'deadbeefdeadbeef';

function pullFixture(overrides: Partial<PullRequestFeedback> = {}): PullRequestFeedback {
  return {
    slug: SLUG,
    number: 61,
    title: 'booking-proposal-fields',
    url: `https://github.com/${SLUG}/pull/61`,
    state: 'OPEN',
    headRef: 'feature/booking-proposal-fields',
    headSha: HEAD,
    headSlug: SLUG,
    baseRef: 'develop',
    fromFork: false,
    threads: [],
    reviews: [],
    truncated: false,
    ...overrides,
  };
}

const finding = { path: 'src/example.ts', line: 42, body: 'This never runs.' };

function passResult(report: ReviewReport | null, code: ReviewPassResult['code'] = 'ok'): ReviewPassResult {
  return {
    ok: report !== null,
    sessionId: 'ignored',
    code: report === null ? code : 'ok',
    message: report === null ? 'The agent fell over.' : 'The review found things.',
    report,
    output: 'agent output',
  };
}

class StubGithub implements PrReviewGateway {
  result = pullFixture();
  error: unknown = null;

  pullRequest(): Promise<PullRequestFeedback> {
    if (this.error !== null) return Promise.reject(this.error);
    return Promise.resolve(this.result);
  }
}

class StubReviewer implements PrReviewer {
  readonly subjects: ReviewSubject[] = [];
  result: ReviewPassResult = passResult({ summary: 'One bug.', findings: [finding] });
  behaviour: () => void = () => {};

  reviewInContainer(subject: ReviewSubject): Promise<ReviewPassResult> {
    this.subjects.push(subject);
    this.behaviour();
    return Promise.resolve(this.result);
  }
}

class StubPublisher implements ReviewPublisher {
  readonly published: { target: ReviewTarget; report: ReviewReport }[] = [];
  error: unknown = null;

  publish(_token: string, target: ReviewTarget, report: ReviewReport): Promise<PublishedReview> {
    if (this.error !== null) return Promise.reject(this.error);
    this.published.push({ target, report });
    return Promise.resolve({
      url: `https://github.com/${target.slug}/pull/${String(target.number)}#pullrequestreview-9`,
      inlineComments: report.findings.length,
      foldedFindings: 0,
    });
  }
}

class StubSolver implements PrReviewSolver {
  readonly starts: { repositoryId: string; prNumber: number }[] = [];
  error: unknown = null;

  start(repositoryId: string, prNumber: number): Promise<{ id: string }> {
    this.starts.push({ repositoryId, prNumber });
    if (this.error !== null) return Promise.reject(this.error);
    return Promise.resolve({ id: 'run-1' });
  }
}

class StubSlots implements BuildSlots {
  free = 1;
  readonly heldUntil: string[] = [];
  pumps = 0;

  freeSlots(): number {
    return this.free;
  }

  pump(): Promise<void> {
    this.pumps += 1;
    return Promise.resolve();
  }

  holdAll(until: string): Promise<void> {
    this.heldUntil.push(until);
    return Promise.resolve();
  }
}

const runner: AgentRunner = {
  run: () => Promise.resolve({ exitCode: 0, output: '', timedOut: false }),
  stop: () => Promise.resolve(),
  reap: () => Promise.resolve(),
  headSha: () => Promise.resolve(HEAD),
};

describe('reviewing an open pull request by hand', () => {
  let config: Config;
  let dataDir: string;
  let db: Database;
  let repository: Repository;
  let github: StubGithub;
  let reviewer: StubReviewer;
  let publisher: StubPublisher;
  let solver: StubSolver;
  let slots: StubSlots;
  let hold: UsageLimitHold;
  let execs: ExecSpec[];
  let checkoutSha: string;
  let containersStarted: string[];
  let containersRemoved: string[];
  let seq = 0;

  const exec: SessionExecutor = {
    runExec: (_container, spec): Promise<ExecOutput> => {
      execs.push(spec);
      const script = String(spec.cmd[2] ?? '');
      return Promise.resolve({
        exitCode: 0,
        stdout: script.includes('rev-parse') ? `${checkoutSha}\n` : '',
        stderr: '',
        timedOut: false,
      });
    },
  };

  const containers: PrRunContainers = {
    startPrRun: (run) => {
      containersStarted.push(run.id);
      return Promise.resolve({
        id: `container-${run.id.slice(0, 8)}`,
        name: 'chief-web-pr-61',
        running: true,
        state: 'running',
      });
    },
    removePrRun: (runId) => {
      containersRemoved.push(runId);
      return Promise.resolve();
    },
  };

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-prreview-'));
    config = loadConfig({ DATA_DIR: dataDir });
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seq += 1;
    repository = createRepository(db, {
      name: `leo-${String(seq)}`,
      sshUrl: 'git@github.com:VincentBean/leo.git',
      githubSlug: SLUG,
      defaultBaseBranch: 'develop',
    });
    setSetting(db, 'github_token', TOKEN);
    setSettingNumber(db, 'max_concurrent_sessions', 3);
    github = new StubGithub();
    reviewer = new StubReviewer();
    publisher = new StubPublisher();
    solver = new StubSolver();
    slots = new StubSlots();
    execs = [];
    checkoutSha = HEAD;
    containersStarted = [];
    containersRemoved = [];
    hold = new UsageLimitHold(db);
    hold.clear();
  });

  const serviceWith = (overrides: { solver?: PrReviewSolver | null; token?: string | null } = {}) =>
    new PrReviewService(
      config,
      db,
      containers,
      exec,
      runner,
      reviewer,
      publisher,
      github,
      slots,
      () => (overrides.token === undefined ? TOKEN : overrides.token),
      () => (overrides.solver === undefined ? solver : overrides.solver),
      hold,
    );

  const reviewOnce = async (service: PrReviewService): Promise<string> => {
    const started = await service.start(repository.id, 61);
    await service.whenIdle(started.id);
    return started.id;
  };

  const refusal = async (promise: Promise<unknown>): Promise<PrReviewError> => {
    try {
      await promise;
    } catch (cause) {
      assert.ok(cause instanceof PrReviewError, `expected a PrReviewError, got ${String(cause)}`);
      return cause;
    }
    assert.fail('expected the start to be refused');
  };

  it('checks the branch out, reviews the diff against the base, and posts the review', async () => {
    const service = serviceWith();
    const id = await reviewOnce(service);
    const view = service.status(id);

    assert.equal(view.status, 'finished');
    assert.equal(view.running, false);
    assert.equal(view.headSha, HEAD);
    assert.equal(view.inlineComments, 1);
    assert.equal(view.foldedFindings, 0);
    assert.match(view.reviewUrl ?? '', /pullrequestreview-9$/);

    // The container is the feedback run's kind, keyed by the review's id…
    assert.deepEqual(containersStarted, [id]);
    assert.deepEqual(containersRemoved, [id]);
    // …the checkout targets the pull request's head branch…
    const checkoutEnv = execs.flatMap((spec) => spec.env ?? []);
    assert.ok(checkoutEnv.includes('CHIEF_HEAD_BRANCH=feature/booking-proposal-fields'));
    // …and the pass is pointed at the pull request's base, in that container.
    assert.equal(reviewer.subjects.length, 1);
    assert.equal(reviewer.subjects[0]?.id, id);
    assert.equal(reviewer.subjects[0]?.targetBranch, 'develop');
    assert.equal(reviewer.subjects[0]?.featureBranch, 'feature/booking-proposal-fields');
    assert.equal(reviewer.subjects[0]?.containerId, `container-${id.slice(0, 8)}`);

    assert.equal(publisher.published.length, 1);
    assert.deepEqual(publisher.published[0]?.target, { slug: SLUG, number: 61 });
    // The slot is given back once the pass is over.
    assert.equal(slots.pumps, 1);
  });

  it('hands the findings to the feedback solver, and says so', async () => {
    const service = serviceWith();
    const id = await reviewOnce(service);

    assert.deepEqual(solver.starts, [{ repositoryId: repository.id, prNumber: 61 }]);
    assert.match(service.status(id).solverMessage ?? '', /A run was started on #61/);
  });

  it('starts no feedback run when the review found nothing', async () => {
    reviewer.result = passResult({ summary: 'Fine.', findings: [] });
    const service = serviceWith();
    const id = await reviewOnce(service);

    assert.equal(service.status(id).status, 'finished');
    assert.equal(publisher.published.length, 1);
    assert.deepEqual(solver.starts, []);
    assert.equal(service.status(id).solverMessage, null);
  });

  it('records a refused hand-off without failing the review', async () => {
    solver.error = new Error('Every build slot is in use.');
    const service = serviceWith();
    const id = await reviewOnce(service);
    const view = service.status(id);

    assert.equal(view.status, 'finished');
    assert.match(view.solverMessage ?? '', /No run was started.*Every build slot is in use/);
  });

  it('is counted against the build cap while it runs', async () => {
    const service = serviceWith();
    let duringPass = -1;
    reviewer.behaviour = () => {
      duringPass = countActivePrReviews(db);
    };
    await reviewOnce(service);
    assert.equal(duringPass, 1);
    assert.equal(countActivePrReviews(db), 0);
  });

  it('reuses one row per pull request across passes', async () => {
    const service = serviceWith();
    const first = await reviewOnce(service);
    const second = await reviewOnce(service);
    assert.equal(first, second);
    assert.equal(service.status(second).attempt, 2);
  });

  it('fails at the checkout when the branch moved since the pull request was read', async () => {
    checkoutSha = 'cafebabecafebabe';
    const service = serviceWith();
    const id = await reviewOnce(service);
    const view = service.status(id);

    assert.equal(view.status, 'failed');
    assert.equal(view.failureStage, 'checkout');
    assert.match(view.lastError ?? '', /Someone pushed to the branch/);
    assert.equal(reviewer.subjects.length, 0);
    assert.equal(publisher.published.length, 0);
  });

  it('fails at the agent when the pass produced nothing, and posts nothing', async () => {
    reviewer.result = passResult(null, 'agent_failed');
    const service = serviceWith();
    const id = await reviewOnce(service);
    const view = service.status(id);

    assert.equal(view.status, 'failed');
    assert.equal(view.failureStage, 'agent');
    assert.match(view.lastError ?? '', /The agent fell over/);
    assert.equal(publisher.published.length, 0);
    assert.deepEqual(solver.starts, []);
  });

  it('names the findings as the stage when the document could not be parsed', async () => {
    reviewer.result = passResult(null, 'invalid_findings');
    const service = serviceWith();
    const id = await reviewOnce(service);
    assert.equal(service.status(id).failureStage, 'findings');
  });

  it('fails at publishing when GitHub refuses the review', async () => {
    publisher.error = new GithubApiError('github_forbidden', 'Resource not accessible', 403);
    const service = serviceWith();
    const id = await reviewOnce(service);
    const view = service.status(id);

    assert.equal(view.status, 'failed');
    assert.equal(view.failureStage, 'publish');
    assert.match(view.lastError ?? '', /Resource not accessible/);
    assert.deepEqual(solver.starts, []);
  });

  it('holds every agent when the pass ran into the usage limit', async () => {
    reviewer.result = passResult(null, 'usage_limit');
    const service = serviceWith();
    const id = await reviewOnce(service);
    const view = service.status(id);

    assert.equal(view.status, 'failed');
    assert.equal(view.failureStage, 'agent');
    assert.match(view.lastError ?? '', /usage limit/);
    assert.equal(slots.heldUntil.length, 1);
    assert.ok(hold.active());
    assert.equal(publisher.published.length, 0);
  });

  it('refuses to start during a usage-limit hold', async () => {
    hold.arm();
    const error = await refusal(serviceWith().start(repository.id, 61));
    assert.equal(error.code, 'usage_limit_hold');
    assert.equal(findPrReview(db, repository.id, 61), null);
  });

  it('refuses without a free build slot', async () => {
    slots.free = 0;
    const error = await refusal(serviceWith().start(repository.id, 61));
    assert.equal(error.code, 'no_free_slot');
  });

  it('refuses without a GitHub token', async () => {
    const error = await refusal(serviceWith({ token: null }).start(repository.id, 61));
    assert.equal(error.code, 'github_token_missing');
  });

  it('refuses a pull request that is not open', async () => {
    github.result = pullFixture({ state: 'MERGED' });
    const error = await refusal(serviceWith().start(repository.id, 61));
    assert.equal(error.code, 'pull_request_not_open');
    assert.deepEqual(containersStarted, []);
  });

  it('refuses a pull request from a fork: the deploy key cannot read it', async () => {
    github.result = pullFixture({ fromFork: true, headSlug: 'someone/leo' });
    const error = await refusal(serviceWith().start(repository.id, 61));
    assert.equal(error.code, 'pull_request_from_fork');
  });

  it('refuses an unknown repository', async () => {
    const error = await refusal(serviceWith().start('nope', 61));
    assert.equal(error.status, 404);
  });

  it('refuses a second review of the same pull request while one is running', async () => {
    const service = serviceWith();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reviewer.reviewInContainer = async (subject) => {
      reviewer.subjects.push(subject);
      await gate;
      return reviewer.result;
    };

    const first = await service.start(repository.id, 61);
    const error = await refusal(service.start(repository.id, 61));
    assert.equal(error.code, 'review_already_active');

    release();
    await service.whenIdle(first.id);
    assert.equal(service.status(first.id).status, 'finished');
  });

  it('stops a running review without posting anything', async () => {
    const service = serviceWith();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    reviewer.reviewInContainer = async (subject) => {
      reviewer.subjects.push(subject);
      await gate;
      return reviewer.result;
    };

    const started = await service.start(repository.id, 61);
    assert.equal(started.running, true);
    const stopping = service.stop(started.id);
    release();
    const stopped = await stopping;

    assert.equal(stopped.running, false);
    assert.equal(stopped.status, 'pending');
    assert.equal(stopped.lastError, 'Stopped.');
    assert.equal(publisher.published.length, 0);
  });

  it('lists the review on the pull request it belongs to', async () => {
    const service = serviceWith();
    assert.equal(service.find(repository.id, 61), null);
    const id = await reviewOnce(service);
    assert.equal(service.find(repository.id, 61)?.id, id);
    assert.throws(() => service.status('missing'), (error: unknown) => {
      return error instanceof PrReviewError && error.status === 404;
    });
  });
});
