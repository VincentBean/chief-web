import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { AgentInvocation, AgentResult, AgentRunner } from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  type Database,
  findPrRun,
  IN_MEMORY,
  listThreads,
  openDatabase,
  type Repository,
  setSetting,
  setSettingNumber,
} from '../db/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { GithubApiError } from '../lib/github.js';
import type { PullRequestFeedback } from '../lib/github-review.js';
import { UsageLimitHold } from '../limits/index.js';
import { sessionWorkspaceDir } from '../orchestrator/index.js';
import type { SessionExecutor } from '../sessions/index.js';
import { CONTAINER_OUTCOME_PATH } from './prompts.js';
import {
  type BuildSlots,
  type PrFeedbackGateway,
  PrFeedbackService,
  type PrRunContainers,
} from './service.js';

const TOKEN = 'ghp_token';
const SLUG = 'VincentBean/leo';

/** Feedback shaped like the operator's real pull request #61. */
function feedbackFixture(overrides: Partial<PullRequestFeedback> = {}): PullRequestFeedback {
  return {
    slug: SLUG,
    number: 61,
    title: 'booking-proposal-fields',
    url: `https://github.com/${SLUG}/pull/61`,
    state: 'OPEN',
    headRef: 'chief/booking-proposal-fields',
    headSha: 'deadbeefdeadbeef',
    headSlug: SLUG,
    baseRef: 'develop',
    fromFork: false,
    threads: [
      thread('PRRT_1', 3_887_174_693, 'BookingProposalReview.php', 650),
      thread('PRRT_2', 3_887_174_727, 'BookingProposalReview.php', 1024),
    ],
    reviews: [
      {
        id: 'PRR_1',
        authorLogin: 'copilot-pull-request-reviewer',
        authorType: 'Bot',
        state: 'COMMENTED',
        body: '## Pull request overview',
        url: `https://github.com/${SLUG}/pull/61#pullrequestreview-1`,
        submittedAt: '2026-08-29T10:00:00Z',
      },
    ],
    truncated: false,
    ...overrides,
  };
}

function thread(id: string, databaseId: number, file: string, line: number) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    path: `packages/leo/src/Livewire/${file}`,
    line,
    comments: [
      {
        databaseId,
        authorLogin: 'copilot-pull-request-reviewer',
        authorType: 'Bot',
        body: 'Something worth fixing.',
        url: `https://github.com/${SLUG}/pull/61#discussion_r${String(databaseId)}`,
      },
    ],
  };
}

/** Records every GitHub write so a test can assert what was said, and when. */
class StubGithub implements PrFeedbackGateway {
  result = feedbackFixture();
  feedbackError: unknown = null;
  replies: { commentId: number; body: string }[] = [];
  resolves: string[] = [];
  replyError: unknown = null;
  resolveError: unknown = null;

  feedback(): Promise<PullRequestFeedback> {
    if (this.feedbackError !== null) return Promise.reject(this.feedbackError);
    return Promise.resolve(this.result);
  }

  reply(
    _token: string,
    _slug: string,
    _number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number; url: string }> {
    if (this.replyError !== null) return Promise.reject(this.replyError);
    this.replies.push({ commentId, body });
    return Promise.resolve({ id: 1, url: 'https://github.com/reply/1' });
  }

  resolve(_token: string, threadId: string): Promise<{ isResolved: boolean }> {
    if (this.resolveError !== null) return Promise.reject(this.resolveError);
    this.resolves.push(threadId);
    return Promise.resolve({ isResolved: true });
  }
}

/** Whatever the behaviour does *is* what the agent did. */
class MockRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];
  readonly reaps: string[] = [];
  head: string | null = 'sha-before';
  result: AgentResult = { exitCode: 0, output: '', timedOut: false };
  behaviour: () => void = () => {};

  run(invocation: AgentInvocation): Promise<AgentResult> {
    this.invocations.push(invocation);
    this.behaviour();
    return Promise.resolve(this.result);
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  reap(runId: string): Promise<void> {
    this.reaps.push(runId);
    return Promise.resolve();
  }

  headSha(): Promise<string | null> {
    return Promise.resolve(this.head);
  }
}

describe('answering pull request feedback', () => {
  let config: Config;
  let dataDir: string;
  let db: Database;
  let repository: Repository;
  let github: StubGithub;
  let runner: MockRunner;
  let execs: ExecSpec[];
  let pushOk: boolean;
  let containersStarted: string[];
  let slots: StubSlots;
  let hold: UsageLimitHold;
  let seq = 0;

  const exec: SessionExecutor = {
    runExec: (_container, spec): Promise<ExecOutput> => {
      execs.push(spec);
      const script = String(spec.cmd[2] ?? '');
      if (script.includes('git push')) {
        return Promise.resolve({
          exitCode: pushOk ? 0 : 1,
          stdout: '',
          stderr: pushOk ? '' : '! [rejected] chief/x -> chief/x (fetch first)',
          timedOut: false,
        });
      }
      // The checkout's last line is the sha `rev-parse` printed.
      return Promise.resolve({
        exitCode: 0,
        stdout: script.includes('rev-parse') ? 'deadbeefdeadbeef\n' : '',
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
    removePrRun: () => Promise.resolve(),
  };

  /** The build loop as a run sees it: the slot cap, the pump, and the hold. */
  class StubSlots implements BuildSlots {
    free = 1;
    readonly heldUntil: string[] = [];

    freeSlots(): number {
      return this.free;
    }

    pump(): Promise<void> {
      return Promise.resolve();
    }

    holdAll(until: string): Promise<void> {
      this.heldUntil.push(until);
      return Promise.resolve();
    }
  }

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-prfeedback-'));
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
    runner = new MockRunner();
    execs = [];
    pushOk = true;
    containersStarted = [];
    slots = new StubSlots();
    // The hold lives in a settings row on the shared database, so it outlives
    // the test that armed it unless it is lifted here.
    hold = new UsageLimitHold(db);
    hold.clear();
  });

  const serviceWith = (overrides: { slots?: BuildSlots } = {}): PrFeedbackService =>
    new PrFeedbackService(
      config,
      db,
      containers,
      exec,
      runner,
      github,
      overrides.slots ?? slots,
      () => 'ghp_token',
      hold,
    );

  /** Writes the agent's report where the service reads it: on the volume. */
  const reportFrom = (runId: string, body: unknown): void => {
    const dir = sessionWorkspaceDir(config, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, path.basename(CONTAINER_OUTCOME_PATH)),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  };

  const runOnce = async (service: PrFeedbackService): Promise<string> => {
    const started = await service.start(repository.id, 61);
    await service.whenIdle(started.id);
    return started.id;
  };

  it('pushes, then answers and resolves only what the agent addressed', async () => {
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', {
        addressed: [{ key: 'T1', summary: 'Compared minor units instead of floats.' }],
        skipped: [
          { key: 'T2', reason: 'That code is no longer on this branch.' },
          { key: 'R1', reason: 'The overview needs no change.' },
        ],
      });
      runner.head = 'sha-after';
    };

    const runId = await runOnce(service);
    const view = service.status(runId);

    assert.equal(view.status, 'finished');
    // The addressed thread is answered and resolved…
    assert.equal(github.resolves.length, 1);
    assert.equal(github.resolves[0], 'PRRT_1');
    // …the skipped one is answered but left open for a human…
    assert.equal(github.replies.length, 2);
    assert.match(github.replies[0]?.body ?? '', /addressed this in `sha-aft`/);
    assert.match(github.replies[1]?.body ?? '', /changed nothing/);
    assert.match(github.replies[1]?.body ?? '', /no longer on this branch/);
    // …and the review summary gets no GitHub write at all: it has no thread
    // and no comment id to reply to.
    assert.ok(!github.replies.some((reply) => reply.body.includes('overview')));
  });

  it('keeps a run that was cut short after it had written its report', async () => {
    const service = serviceWith();
    runner.result = { exitCode: null, output: 'still thinking…', timedOut: true };
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      // The report is written last, after the commit: this agent finished the
      // contract and lost only the tail of its own turn.
      reportFrom(run?.id ?? '', {
        addressed: [{ key: 'T1', summary: 'Compared minor units instead of floats.' }],
        skipped: [
          { key: 'T2', reason: 'That code is no longer on this branch.' },
          { key: 'R1', reason: 'The overview needs no change.' },
        ],
      });
      runner.head = 'sha-after';
    };

    const runId = await runOnce(service);
    const view = service.status(runId);

    // Judged on the same evidence as any other run — the cross-checks did not
    // move — rather than thrown away for missing a deadline it had met.
    assert.equal(view.status, 'finished');
    assert.equal(github.replies.length, 2);
    // And the agent it gave up on is not left in the container.
    assert.deepEqual(runner.reaps, [runId]);
  });

  it('fails a run that was cut short before it wrote a report', async () => {
    const service = serviceWith();
    runner.result = { exitCode: null, output: 'still running the suite…', timedOut: true };
    // No report, no commit: work in a tree nobody can describe.
    runner.behaviour = () => {};

    const runId = await runOnce(service);
    const view = service.status(runId);

    assert.equal(view.status, 'failed');
    assert.equal(view.failureStage, 'agent');
    assert.match(view.lastError ?? '', /ran out of time/);
    assert.match(view.lastError ?? '', /still running the suite/);
    assert.equal(github.replies.length, 0);
    assert.deepEqual(runner.reaps, [runId]);
  });

  it('says nothing on GitHub when the agent claimed work it did not commit', async () => {
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', { addressed: [{ key: 'T1', summary: 'done' }], skipped: [] });
      // HEAD does not move: the claim has nothing behind it.
    };

    const runId = await runOnce(service);
    const view = service.status(runId);

    assert.equal(view.status, 'failed');
    assert.equal(view.failureStage, 'agent');
    assert.equal(github.replies.length, 0, 'nothing may be claimed on GitHub');
    assert.equal(github.resolves.length, 0);
  });

  it('refuses to push a commit it cannot describe', async () => {
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', 'not json at all');
      runner.head = 'sha-after';
    };

    const runId = await runOnce(service);

    assert.equal(service.status(runId).failureStage, 'outcome');
    assert.ok(!execs.some((spec) => String(spec.cmd[2] ?? '').includes('git push')));
    assert.equal(github.replies.length, 0);
  });

  it('answers nothing when the push is rejected', async () => {
    pushOk = false;
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', { addressed: [{ key: 'T1', summary: 'done' }], skipped: [] });
      runner.head = 'sha-after';
    };

    const runId = await runOnce(service);
    const view = service.status(runId);

    assert.equal(view.failureStage, 'push');
    // A reply quoting a commit that is not on the remote would be a lie.
    assert.equal(github.replies.length, 0);
  });

  it('treats a pass that changed nothing as a real answer', async () => {
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', {
        addressed: [],
        skipped: [
          { key: 'T1', reason: 'The comment is mistaken.' },
          { key: 'T2', reason: 'Needs a human decision.' },
          { key: 'R1', reason: 'Nothing to do.' },
        ],
      });
    };

    const runId = await runOnce(service);
    const view = service.status(runId);

    assert.equal(view.status, 'finished');
    assert.equal(view.headSha, null, 'nothing was pushed');
    // The reasons are still worth posting: a thread nobody answers looks
    // ignored, and this is the evidence chief-web looked.
    assert.equal(github.replies.length, 2);
    assert.equal(github.resolves.length, 0, 'a skipped thread is never resolved');
  });

  it('treats a comment the agent never mentioned as unreported, not addressed', async () => {
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', { addressed: [{ key: 'T1', summary: 'done' }], skipped: [] });
      runner.head = 'sha-after';
    };

    const runId = await runOnce(service);
    const threads = listThreads(db, runId);

    assert.equal(threads.find((entry) => entry.feedbackKey === 'T2')?.outcome, 'unreported');
    assert.equal(github.resolves.length, 1, 'only the addressed thread is resolved');
    // It is still answered, so a reviewer is not left wondering whether it was
    // seen — but it stays open, because nothing checked it.
    assert.match(
      github.replies.find((reply) => reply.commentId === 3_887_174_727)?.body ?? '',
      /did not report on this thread/,
    );
  });

  it('records a refused resolve without losing the reply', async () => {
    github.resolveError = new GithubApiError('github_forbidden', 'Nope.', 403);
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', { addressed: [{ key: 'T1', summary: 'done' }], skipped: [] });
      runner.head = 'sha-after';
    };

    const runId = await runOnce(service);
    const view = service.status(runId);

    // T1 is answered as addressed; T2 was never mentioned, so it is answered
    // as unreported and left open.
    assert.equal(github.replies.length, 2);
    // A permission fact is permanent, so it is recorded rather than failed —
    // retrying would refuse identically.
    assert.equal(view.status, 'finished');
    // GitHub does not offer this mutation to fine-grained tokens at all, so the
    // refusal is a note about a thread that *was* answered — not a failure.
    assert.match(
      view.threads.find((entry) => entry.key === 'T1')?.error ?? '',
      /cannot resolve threads, so it is left open/,
    );
    assert.equal(view.threads.find((entry) => entry.key === 'T1')?.replied, true);
  });

  it('refuses a fork before anything is spawned', async () => {
    github.result = feedbackFixture({ fromFork: true, headSlug: 'someone/leo' });
    const service = serviceWith();

    await assert.rejects(
      () => service.start(repository.id, 61),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'pull_request_from_fork');
        return true;
      },
    );
    assert.deepEqual(containersStarted, [], 'no container may be created for a fork');
  });

  it('refuses a closed pull request, and one with nothing unresolved', async () => {
    github.result = feedbackFixture({ state: 'MERGED' });
    await assert.rejects(() => serviceWith().start(repository.id, 61), /merged/);

    github.result = feedbackFixture({ threads: [], reviews: [] });
    await assert.rejects(() => serviceWith().start(repository.id, 61), /no unresolved/i);
  });

  it('refuses when every build slot is taken, rather than queueing behind them', async () => {
    const full = new StubSlots();
    full.free = 0;
    const service = serviceWith({ slots: full });

    await assert.rejects(
      () => service.start(repository.id, 61),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'no_free_slot');
        return true;
      },
    );
  });

  it('refuses to start while Claude’s usage limit is held, and says until when', async () => {
    const until = hold.arm();

    await assert.rejects(
      () => serviceWith().start(repository.id, 61),
      (error: unknown) => {
        const refusal = error as { status: number; code: string; message: string };
        assert.equal(refusal.status, 409);
        assert.equal(refusal.code, 'usage_limit_hold');
        assert.match(refusal.message, /usage limit/i);
        assert.ok(refusal.message.includes(until), 'the resume time is named');
        return true;
      },
    );
    assert.deepEqual(containersStarted, [], 'nothing may be spent on a held account');
  });

  it('arms the hold and fails the run when the agent is refused mid-pass', async () => {
    const service = serviceWith();
    runner.behaviour = () => {
      // The CLI's refusal: nothing was done, and it exits non-zero.
      runner.result = {
        exitCode: 1,
        output: 'Claude AI usage limit reached. Your limit will reset at 9pm.',
        timedOut: false,
      };
    };

    const runId = await runOnce(service);
    const view = service.status(runId);
    const until = hold.until();

    assert.ok(until !== null, 'the global hold is armed');
    assert.equal(view.status, 'failed');
    assert.equal(view.failureStage, 'agent');
    assert.match(view.lastError ?? '', /usage limit/i);
    assert.ok((view.lastError ?? '').includes(until), 'the resume time is named');
    // The builds are running into the same wall, so they are parked on the very
    // same expiry rather than each discovering it for itself.
    assert.deepEqual(slots.heldUntil, [until]);
    // The refused agent's exec is walked away from, so it is reaped before a
    // retry checks the same branch out under it.
    assert.deepEqual(runner.reaps, [runId]);
    assert.deepEqual(github.replies, [], 'nothing may be said on GitHub about a pass that stopped');
  });

  it('does not repeat the same reply for the same commit on a second pass', async () => {
    const service = serviceWith();
    runner.behaviour = () => {
      const run = findPrRun(db, repository.id, 61);
      reportFrom(run?.id ?? '', { addressed: [{ key: 'T1', summary: 'done' }], skipped: [] });
      runner.head = 'sha-after';
    };

    await runOnce(service);
    assert.equal(github.replies.length, 2);

    // A second pass that lands on the same commit has nothing new to say.
    await runOnce(service);
    assert.equal(github.replies.length, 2, 'the same sentence must not be posted twice');
  });
});
