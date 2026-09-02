import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { agentCommand } from '../build/index.js';
import type { AgentInvocation, AgentResult, AgentRunner } from '../build/index.js';
import { type Config, loadConfig } from '../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  deleteSetting,
  IN_MEMORY,
  openDatabase,
  type Session,
  setSetting,
} from '../db/index.js';
import { sessionWorkspaceDir } from '../orchestrator/index.js';
import type { SessionContainers } from '../sessions/index.js';
import { parseReviewFindings } from './findings.js';
import { CONTAINER_FINDINGS_PATH, reviewPrompt } from './prompts.js';
import { REVIEW_ITERATION, ReviewService } from './service.js';

/** A findings document of exactly the shape the prompt asks for. */
function document(findings: unknown[], summary = 'One real bug, otherwise fine.'): string {
  return JSON.stringify({ summary, findings });
}

class MockRunner implements AgentRunner {
  readonly invocations: AgentInvocation[] = [];
  readonly reaps: string[] = [];
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
    return Promise.resolve('sha');
  }
}

describe('the review prompt', () => {
  const input = {
    targetBranch: 'develop',
    featureBranch: 'chief/booking-fields',
    timeoutMs: 1_800_000,
  };

  it('names both branches and diffs one against the other', () => {
    const prompt = reviewPrompt(input);
    assert.ok(prompt.includes('chief/booking-fields'));
    assert.ok(prompt.includes('git diff origin/develop...HEAD'));
    assert.ok(prompt.includes('into `develop`'));
  });

  it('asks for correctness bugs and clear quality issues, and nothing else', () => {
    const prompt = reviewPrompt(input);
    assert.ok(prompt.includes('Correctness bugs'));
    assert.ok(prompt.includes('Clear quality issues'));
    assert.ok(prompt.includes('No findings at all is a good and common outcome'));
  });

  it('specifies the JSON document, its fields, and where to write it', () => {
    const prompt = reviewPrompt(input);
    assert.ok(prompt.includes(CONTAINER_FINDINGS_PATH));
    assert.ok(prompt.includes('"summary"'));
    assert.ok(prompt.includes('"findings"'));
    assert.ok(prompt.includes('"path"'));
    assert.ok(prompt.includes('"line"'));
    assert.ok(prompt.includes('"body"'));
    // The line has to be one GitHub can anchor a comment to.
    assert.ok(prompt.includes('in the new version of that file'));
  });

  it('forbids changing anything: the branch belongs to someone else', () => {
    const prompt = reviewPrompt(input);
    assert.ok(prompt.includes('**Change nothing.**'));
    assert.ok(prompt.includes('do not commit'));
  });

  it('states the budget in whole minutes', () => {
    assert.ok(reviewPrompt(input).includes('**30 minutes**'));
    assert.ok(reviewPrompt({ ...input, timeoutMs: 60_000 }).includes('**1 minute**'));
  });
});

describe('parsing the review agent\'s findings', () => {
  it('accepts a document of the right shape', () => {
    const parsed = parseReviewFindings(
      document([{ path: 'server/src/app.ts', line: 42, body: 'This never runs.' }]),
    );
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.report, {
      summary: 'One real bug, otherwise fine.',
      findings: [{ path: 'server/src/app.ts', line: 42, body: 'This never runs.' }],
    });
  });

  it('accepts an empty findings list with a summary', () => {
    const parsed = parseReviewFindings(document([], 'Nothing to report; the change is small.'));
    assert.equal(parsed.error, null);
    assert.deepEqual(parsed.report?.findings, []);
    assert.equal(parsed.report?.summary, 'Nothing to report; the change is small.');
  });

  it('finds the document inside a fenced block and surrounding prose', () => {
    const raw = `Here is my review.\n\n\`\`\`json\n${document([])}\n\`\`\`\n\nHope that helps.`;
    assert.equal(parseReviewFindings(raw).error, null);
  });

  it('makes the path repository-relative', () => {
    const parsed = parseReviewFindings(
      document([{ path: '/workspace/repo/server/src/app.ts', line: 1, body: 'x' }]),
    );
    assert.equal(parsed.report?.findings[0]?.path, 'server/src/app.ts');
  });

  for (const [name, raw] of [
    ['nothing at all', null],
    ['an empty string', ''],
    ['prose', 'I reviewed the diff and it all looks fine to me.'],
    ['broken JSON', '{ "summary": "x", "findings": [ }'],
    ['a JSON array', '[{ "path": "a.ts", "line": 1, "body": "x" }]'],
    ['no summary', JSON.stringify({ findings: [] })],
    ['an empty summary', document([], '   ')],
    ['no findings array', JSON.stringify({ summary: 'Fine.' })],
    ['a finding without a path', document([{ line: 1, body: 'x' }])],
    ['a finding with an empty body', document([{ path: 'a.ts', line: 1, body: ' ' }])],
    ['a finding without a line', document([{ path: 'a.ts', body: 'x' }])],
    ['a line of zero', document([{ path: 'a.ts', line: 0, body: 'x' }])],
    ['a fractional line', document([{ path: 'a.ts', line: 12.5, body: 'x' }])],
    ['a line as a string', document([{ path: 'a.ts', line: '12', body: 'x' }])],
    ['a path that escapes the repository', document([{ path: '../etc/passwd', line: 1, body: 'x' }])],
  ] as const) {
    it(`rejects ${name}`, () => {
      const parsed = parseReviewFindings(raw);
      assert.equal(parsed.report, null);
      assert.ok((parsed.error ?? '').length > 0);
    });
  }

  it('rejects the whole document when a single finding is malformed', () => {
    const parsed = parseReviewFindings(
      document([
        { path: 'a.ts', line: 1, body: 'A real finding.' },
        { path: 'b.ts', line: null, body: 'A broken one.' },
      ]),
    );
    assert.equal(parsed.report, null);
    assert.match(parsed.error ?? '', /Finding 2/);
  });
});

describe('the headless review pass', () => {
  let config: Config;
  let dataDir: string;
  let db: Database;
  let session: Session;
  let runner: MockRunner;
  let started: string[];
  let seq = 0;

  const containers: SessionContainers = {
    start: (target) => {
      started.push(target.id);
      return Promise.resolve({
        id: `container-${target.id.slice(0, 8)}`,
        name: 'chief-web-session',
        running: true,
        state: 'running',
      });
    },
    remove: () => Promise.resolve(),
  };

  const service = (): ReviewService => new ReviewService(config, db, containers, runner);

  /** Writes the findings file where the container's volume would leave it. */
  const writeFindings = (raw: string): void => {
    const dir = sessionWorkspaceDir(config, session.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, path.basename(CONTAINER_FINDINGS_PATH)), raw);
  };

  /** What the agent leaves behind while it runs; the file appears mid-pass. */
  const agentWrites = (raw: string): void => {
    runner.behaviour = () => { writeFindings(raw); };
  };

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-review-'));
    config = loadConfig({ DATA_DIR: dataDir });
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seq += 1;
    const repository = createRepository(db, {
      name: `leo-${String(seq)}`,
      sshUrl: 'git@github.com:VincentBean/leo.git',
      githubSlug: 'VincentBean/leo',
      defaultBaseBranch: 'develop',
    });
    session = createSession(db, {
      repositoryId: repository.id,
      name: `review-${String(seq)}`,
      baseBranch: 'develop',
      prTargetBranch: 'develop',
      status: 'finished',
      codeReview: true,
    });
    deleteSetting(db, 'review_model');
    runner = new MockRunner();
    started = [];
  });

  it('runs one agent in the session\'s own container and returns the findings', async () => {
    agentWrites(document([{ path: 'a.ts', line: 7, body: 'Off by one.' }]));

    const result = await service().review(session);

    assert.equal(result.ok, true);
    assert.equal(result.code, 'ok');
    assert.deepEqual(result.report?.findings, [{ path: 'a.ts', line: 7, body: 'Off by one.' }]);
    assert.deepEqual(started, [session.id]);
    assert.equal(runner.invocations.length, 1);
    assert.equal(runner.invocations[0]?.containerId, `container-${session.id.slice(0, 8)}`);
    assert.equal(runner.invocations[0]?.iteration, REVIEW_ITERATION);
    assert.ok(runner.invocations[0]?.prompt.includes('git diff origin/develop...HEAD'));
  });

  it('passes --model when a review model is set, and none when it is null', async () => {
    agentWrites(document([]));

    await service().review(session);
    assert.equal(runner.invocations[0]?.model, null);
    assert.ok(!agentCommand('p', runner.invocations[0]?.model).includes('--model'));

    setSetting(db, 'review_model', 'opus');
    await service().review(session);
    assert.equal(runner.invocations[1]?.model, 'opus');
    const command = agentCommand('p', runner.invocations[1]?.model);
    assert.deepEqual(command.slice(0, 3), ['claude', '--model', 'opus']);
  });

  it('treats an empty findings list as a successful review', async () => {
    agentWrites(document([], 'Nothing to report.'));

    const result = await service().review(session);

    assert.equal(result.ok, true);
    assert.deepEqual(result.report, { summary: 'Nothing to report.', findings: [] });
    assert.match(result.message, /nothing to comment on/);
  });

  it('fails the attempt when the output cannot be parsed', async () => {
    agentWrites('I had a look and it seems fine.');

    const result = await service().review(session);

    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_findings');
    assert.equal(result.report, null);
  });

  it('falls back to the agent\'s output when it wrote no file', async () => {
    runner.result = { exitCode: 0, output: `Done:\n${document([])}`, timedOut: false };

    const result = await service().review(session);

    assert.equal(result.ok, true);
    assert.deepEqual(result.report?.findings, []);
  });

  it('never reads a previous attempt\'s findings', async () => {
    writeFindings(document([{ path: 'a.ts', line: 7, body: 'From the last attempt.' }]));
    runner.result = { exitCode: 0, output: 'nothing usable', timedOut: false };

    const result = await service().review(session);

    assert.equal(result.ok, false);
    assert.equal(result.report, null);
  });

  it('reaps the agent and fails the attempt on a timeout', async () => {
    runner.result = { exitCode: null, output: 'half a review', timedOut: true };

    const result = await service().review(session);

    assert.equal(result.code, 'agent_timed_out');
    assert.deepEqual(runner.reaps, [session.id]);
  });

  it('reports a usage limit as its own code', async () => {
    runner.result = {
      exitCode: 1,
      output: 'Claude usage limit reached. Your limit will reset at 3pm.',
      timedOut: false,
    };

    const result = await service().review(session);

    assert.equal(result.code, 'usage_limit');
    assert.equal(result.report, null);
  });

  it('reports a non-zero exit with no findings as a failed agent', async () => {
    runner.result = { exitCode: 1, output: 'command not found: claude', timedOut: false };

    const result = await service().review(session);

    assert.equal(result.code, 'agent_failed');
    assert.match(result.message, /exited with code 1/);
  });

  it('answers rather than throwing when the container will not start', async () => {
    const broken: SessionContainers = {
      start: () => Promise.reject(new Error('no such image')),
      remove: () => Promise.resolve(),
    };

    const result = await new ReviewService(config, db, broken, runner).review(session);

    assert.equal(result.code, 'container_unavailable');
    assert.match(result.message, /no such image/);
    assert.equal(runner.invocations.length, 0);
  });
});
