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
  findPrConflictFix,
  IN_MEMORY,
  openDatabase,
  type PrConflictFix,
  type Repository,
  setSetting,
  setSettingNumber,
} from '../db/index.js';
import { PUSH_SCRIPT } from '../delivery/index.js';
import type { ExecOutput, ExecSpec } from '../docker/index.js';
import { UsageLimitHold } from '../limits/index.js';
import type { BuildSlots, PrRunContainers } from '../prfeedback/index.js';
import { checkoutScript } from '../prfeedback/index.js';
import type { SessionExecutor } from '../sessions/index.js';
import { ConflictFixError, PrConflictFixService } from './fix.js';
import { mergeScript } from './merge.js';
import type { ConflictedPullRequest } from './service.js';

const SLUG = 'acme/demo';
const HEAD_SHA = 'head000';

/** Every script the pipeline can run, named, so a test can assert the order. */
const STEPS = new Map<string, string>([
  [checkoutScript('check-head'), 'check-head'],
  [checkoutScript('clone'), 'clone'],
  [checkoutScript('checkout'), 'checkout'],
  [mergeScript('fetch-base'), 'fetch-base'],
  [mergeScript('merge'), 'merge'],
  [mergeScript('conflicts'), 'conflicts'],
  [mergeScript('stage'), 'stage'],
  [mergeScript('status'), 'status'],
  [mergeScript('markers'), 'markers'],
  [mergeScript('commit'), 'commit'],
  [mergeScript('abort'), 'abort'],
  [PUSH_SCRIPT, 'push'],
]);

/** The container's git, as far as a fix run can tell. */
class StubExec implements SessionExecutor {
  /** Every step that ran, in order. */
  readonly steps: string[] = [];
  /** The positional arguments each step was given: the file names. */
  readonly files = new Map<string, string[]>();
  /** What `git rev-parse HEAD` says the checkout landed on. */
  headSha = HEAD_SHA;
  /** 0 merges cleanly; anything else stops on conflicts. */
  mergeExit = 1;
  conflicts = ['src/one.ts', 'src/two.ts'];
  statusOut = '';
  /** The files the marker grep prints: non-empty means unresolved. */
  markersOut = '';
  commitExit = 0;
  pushExit = 0;
  pushStderr = '';

  runExec(_container: string, spec: ExecSpec): Promise<ExecOutput> {
    const step = STEPS.get(String(spec.cmd[2] ?? '')) ?? 'unknown';
    this.steps.push(step);
    this.files.set(step, spec.cmd.slice(4).map(String));
    return Promise.resolve(this.answer(step));
  }

  private answer(step: string): ExecOutput {
    const ok = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    switch (step) {
      case 'checkout':
        return { ...ok, stdout: `${this.headSha}\n` };
      case 'merge':
        return {
          ...ok,
          exitCode: this.mergeExit,
          stderr: this.mergeExit === 0 ? '' : 'CONFLICT (content): Merge conflict in src/one.ts',
        };
      case 'conflicts':
        return { ...ok, stdout: this.conflicts.join('\0') };
      case 'status':
        return { ...ok, stdout: this.statusOut };
      case 'markers':
        return { ...ok, stdout: this.markersOut };
      case 'commit':
        return { ...ok, exitCode: this.commitExit };
      case 'push':
        return { ...ok, exitCode: this.pushExit, stderr: this.pushStderr };
      default:
        return ok;
    }
  }
}

/** Whatever the behaviour does *is* what the agent did. */
class MockRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];
  readonly reaps: string[] = [];
  head: string | null = 'merge-sha';
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

  reap(sessionId: string): Promise<void> {
    this.reaps.push(sessionId);
    return Promise.resolve();
  }

  headSha(): Promise<string | null> {
    return Promise.resolve(this.head);
  }
}

/** The build loop as a fix sees it: the slot cap, the pump, and the hold. */
class StubSlots implements BuildSlots {
  free = 1;
  pumps = 0;
  readonly heldUntil: string[] = [];

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

describe('resolving a pull request’s merge conflicts', () => {
  let config: Config;
  let dataDir: string;
  let db: Database;
  let repository: Repository;
  let exec: StubExec;
  let runner: MockRunner;
  let slots: StubSlots;
  let hold: UsageLimitHold;
  let containersStarted: string[];
  let containersRemoved: string[];
  let seq = 0;

  const containers: PrRunContainers = {
    startPrRun: (run) => {
      containersStarted.push(run.id);
      return Promise.resolve({
        id: `container-${run.id.slice(0, 8)}`,
        name: `chief-web-pr-${String(run.prNumber)}`,
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-prconflictfix-'));
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
      name: `demo-${String(seq)}`,
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: SLUG,
      defaultBaseBranch: 'main',
    });
    setSetting(db, 'github_token', 'ghp_token');
    setSettingNumber(db, 'max_concurrent_sessions', 3);
    exec = new StubExec();
    runner = new MockRunner();
    slots = new StubSlots();
    containersStarted = [];
    containersRemoved = [];
    // The hold lives in a settings row on the shared database, so it outlives
    // the test that armed it unless it is lifted here.
    hold = new UsageLimitHold(db);
    hold.clear();
  });

  const conflicted = (overrides: Partial<ConflictedPullRequest> = {}): ConflictedPullRequest => ({
    repositoryId: repository.id,
    repositoryName: repository.name,
    slug: SLUG,
    prNumber: 61,
    prUrl: `https://github.com/${SLUG}/pull/61`,
    prTitle: 'Charge the booking in minor units',
    prBody: 'Money is compared as integers everywhere, so rounding cannot drift.',
    headBranch: 'chief/booking-minor-units',
    baseBranch: 'main',
    headSha: HEAD_SHA,
    baseSha: 'base000',
    ...overrides,
  });

  const service = (): PrConflictFixService =>
    new PrConflictFixService(config, db, containers, exec, runner, slots, hold);

  /** Runs one fix to completion and hands back the row it left behind. */
  const runOnce = async (
    fixer: PrConflictFixService,
    pull: ConflictedPullRequest = conflicted(),
  ): Promise<PrConflictFix | null> => {
    await fixer.start(pull);
    const started = findPrConflictFix(db, pull.repositoryId, pull.prNumber);
    assert.notEqual(started, null, 'the run should have a row while it is in flight');
    await fixer.whenIdle(started?.id ?? '');
    return findPrConflictFix(db, pull.repositoryId, pull.prNumber);
  };

  it('resolves the conflict with an agent and pushes the merge commit', async () => {
    const fix = await runOnce(service());

    assert.equal(fix?.status, 'succeeded');
    assert.equal(fix?.attempts, 1);
    assert.equal(fix?.failureStage, null);
    assert.equal(fix?.mergeSha, 'merge-sha');
    assert.notEqual(fix?.finishedAt, null);
    // The whole pipeline, in order: check out the head, merge the base in, let
    // the agent edit, then stage, check and commit — and only then push.
    assert.deepEqual(exec.steps, [
      'check-head',
      'clone',
      'checkout',
      'fetch-base',
      'merge',
      'conflicts',
      'stage',
      'status',
      'markers',
      'commit',
      'push',
    ]);
    // Only the conflicted files are staged and checked for markers.
    assert.deepEqual(exec.files.get('stage'), ['src/one.ts', 'src/two.ts']);
    assert.deepEqual(exec.files.get('markers'), ['src/one.ts', 'src/two.ts']);
    assert.deepEqual(containersStarted, [fix?.id]);
    assert.deepEqual(containersRemoved, [fix?.id]);
    assert.equal(slots.pumps, 1);
  });

  it('tries again after a failed attempt, and succeeds on the second (US-006)', async () => {
    // The first agent leaves a marker behind; the second one does the job.
    exec.markersOut = 'src/one.ts\n';
    runner.behaviour = () => {
      if (runner.invocations.length >= 2) exec.markersOut = '';
    };

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'succeeded');
    assert.equal(fix?.attempts, 2);
    assert.equal(fix?.failureStage, null);
    assert.equal(fix?.lastError, null);
    assert.equal(fix?.mergeSha, 'merge-sha');
    assert.equal(runner.invocations.length, 2);
    // The failed attempt put the branch back before the second one checked it
    // out again, and the whole run took one container.
    assert.deepEqual(exec.steps, [
      'check-head',
      'clone',
      'checkout',
      'fetch-base',
      'merge',
      'conflicts',
      'stage',
      'status',
      'markers',
      'abort',
      'check-head',
      'clone',
      'checkout',
      'fetch-base',
      'merge',
      'conflicts',
      'stage',
      'status',
      'markers',
      'commit',
      'push',
    ]);
    assert.deepEqual(containersStarted, [fix?.id]);
    assert.deepEqual(containersRemoved, [fix?.id]);
  });

  it('gives up after three attempts, records the stage and cleans the container up (US-006)', async () => {
    // Every attempt's agent leaves the same marker behind.
    exec.markersOut = 'src/two.ts\n';

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'failed');
    assert.equal(fix?.attempts, 3);
    assert.equal(fix?.failureStage, 'verify');
    assert.notEqual(fix?.finishedAt, null);
    // Every attempt is in the message, so the operator can see whether it was
    // the same failure three times or three different ones.
    assert.match(fix?.lastError ?? '', /after 3 attempts/);
    assert.match(fix?.lastError ?? '', /Attempt 1 failed at verifying the resolution/);
    assert.match(fix?.lastError ?? '', /Attempt 3 failed at verifying the resolution/);
    assert.match(fix?.lastError ?? '', /src\/two\.ts/);
    assert.equal(runner.invocations.length, 3);
    // Three attempts, three aborted merges, nothing pushed — and the container
    // is gone whichever way the run ended.
    assert.equal(exec.steps.filter((step) => step === 'abort').length, 3);
    assert.ok(!exec.steps.includes('push'));
    assert.deepEqual(containersRemoved, [fix?.id]);
    assert.equal(slots.pumps, 1);
  });

  it('spends no attempt on a branch that moved under the run (US-006)', async () => {
    exec.headSha = 'moved111';

    await runOnce(service());

    // The head moved: trying twice more would only check the same wrong commit
    // out again, so the run is over after one look.
    assert.equal(exec.steps.filter((step) => step === 'checkout').length, 1);
    assert.equal(runner.invocations.length, 0);
  });

  it('checks the head branch out at the sha the scan saw, and tells the agent why the pull request exists', async () => {
    await runOnce(service());

    assert.equal(runner.invocations.length, 1);
    const prompt = runner.invocations[0]?.prompt ?? '';
    assert.match(prompt, /Charge the booking in minor units/);
    assert.match(prompt, /Money is compared as integers everywhere/);
    // The files git stopped on, and the two branches being merged.
    assert.match(prompt, /src\/one\.ts/);
    assert.match(prompt, /chief\/booking-minor-units/);
    assert.match(prompt, /origin\/main/);
    // And the prohibitions that keep git chief-web's job.
    assert.match(prompt, /do not push/i);
    assert.match(prompt, /Do not commit/);
    assert.match(prompt, /do not rebase/i);
    assert.match(prompt, /do not amend/i);
    assert.match(prompt, /create or switch branches/i);
  });

  it('aborts the merge and pushes nothing when the agent leaves conflict markers behind', async () => {
    exec.markersOut = 'src/two.ts\n';

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'failed');
    assert.equal(fix?.failureStage, 'verify');
    assert.match(fix?.lastError ?? '', /src\/two\.ts/);
    assert.ok(exec.steps.includes('abort'), 'the merge should be aborted');
    assert.ok(!exec.steps.includes('commit'), 'nothing should be committed');
    assert.ok(!exec.steps.includes('push'), 'nothing should be pushed');
  });

  it('fails without pushing when git still reports an unmerged path', async () => {
    exec.statusOut = 'UU src/one.ts\n M src/three.ts\n';

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'failed');
    assert.equal(fix?.failureStage, 'verify');
    // The unmerged path is the reason; the merely modified one next to it in
    // the same status output is not.
    assert.match(fix?.lastError ?? '', /still unresolved in src\/one\.ts\./);
    assert.ok(exec.steps.includes('abort'));
    assert.ok(!exec.steps.includes('push'));
  });

  it('pushes the plain merge commit when the base merges without a conflict', async () => {
    // GitHub said conflicted, git disagrees: the base moved but nothing this
    // branch changed moved with it.
    exec.mergeExit = 0;

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'succeeded');
    assert.equal(fix?.mergeSha, 'merge-sha');
    assert.equal(runner.invocations.length, 0, 'no agent is needed for a clean merge');
    // Git committed the merge itself, so the pipeline neither stages nor commits.
    assert.deepEqual(exec.steps, [
      'check-head',
      'clone',
      'checkout',
      'fetch-base',
      'merge',
      'push',
    ]);
  });

  it('abandons the run when the push is rejected as non-fast-forward', async () => {
    exec.pushExit = 1;
    exec.pushStderr =
      ' ! [rejected]        chief/booking-minor-units -> chief/booking-minor-units (fetch first)';

    const fix = await runOnce(service());

    // Not failed and not left running: the head moved, so the next tick sees
    // the pull request afresh and starts a run against the new head.
    assert.equal(fix, null);
  });

  it('fails on a push the remote refused for any other reason', async () => {
    exec.pushExit = 128;
    exec.pushStderr = 'ERROR: Permission to acme/demo.git denied to deploy key.';

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'failed');
    assert.equal(fix?.failureStage, 'push');
    assert.match(fix?.lastError ?? '', /Permission/);
  });

  it('abandons the run when the branch moved between the scan and the checkout', async () => {
    exec.headSha = 'moved111';

    const fix = await runOnce(service());

    assert.equal(fix, null, 'the row is dropped rather than marked failed');
    assert.ok(!exec.steps.includes('merge'), 'nothing is merged onto the wrong head');
  });

  it('fails at the merge when git stops for a reason that is not a conflict', async () => {
    exec.mergeExit = 128;
    exec.conflicts = [];

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'failed');
    assert.equal(fix?.failureStage, 'merge');
    assert.equal(runner.invocations.length, 0);
    assert.ok(!exec.steps.includes('push'));
  });

  it('refuses to start when every build slot is in use', async () => {
    slots.free = 0;

    await assert.rejects(
      () => service().start(conflicted()),
      (error: unknown) =>
        error instanceof ConflictFixError && error.code === 'no_free_slot',
    );
    // Nothing was spent: no row, no container, no agent.
    assert.equal(findPrConflictFix(db, repository.id, 61), null);
    assert.deepEqual(containersStarted, []);
  });

  it('refuses to start while Claude’s usage limit is held', async () => {
    hold.arm();

    await assert.rejects(
      () => service().start(conflicted()),
      (error: unknown) =>
        error instanceof ConflictFixError && error.code === 'usage_limit_hold',
    );
    assert.equal(findPrConflictFix(db, repository.id, 61), null);
    assert.deepEqual(containersStarted, []);
  });

  it('holds the whole server when the agent is refused for usage', async () => {
    runner.result = {
      exitCode: 1,
      output: 'Claude AI usage limit reached. Your limit will reset at 4pm.',
      timedOut: false,
    };

    const fix = await runOnce(service());

    assert.equal(fix?.status, 'failed');
    assert.equal(fix?.failureStage, 'agent');
    // The remaining attempts would walk into the same wall, so none is spent.
    assert.equal(fix?.attempts, 1);
    assert.equal(runner.invocations.length, 1);
    assert.equal(slots.heldUntil.length, 1);
    assert.notEqual(hold.until(), null);
    assert.deepEqual(runner.reaps, [fix?.id]);
    assert.ok(exec.steps.includes('abort'));
    assert.ok(!exec.steps.includes('push'));
  });

  it('judges a timed-out agent on the working tree it left, not its exit code', async () => {
    runner.result = { exitCode: null, output: 'no more time', timedOut: true };

    const fix = await runOnce(service());

    // The agent was reaped, and the resolution it left behind still verified.
    assert.deepEqual(runner.reaps, [fix?.id]);
    assert.equal(fix?.status, 'succeeded');
    assert.ok(exec.steps.includes('push'));
  });
});
