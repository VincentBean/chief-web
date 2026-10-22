import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import type { ExecOutput, ExecSpec } from '../docker/index.js';
import {
  createRepository,
  createSession,
  type Database,
  getStory,
  IN_MEMORY,
  openDatabase,
  type Session,
  syncStories,
} from '../db/index.js';
import { parsePrd, setStoryStatus } from '../prd/index.js';
import { mergeStorySpec } from './agent.js';
import { addedLines, mergeMessage, mergePrd, mergeProgress, MergeQueue, StoryMerger } from './merge.js';
import { createAgentRunner } from './runner.js';

const PRD = `# PRD: Demo

## User Stories

### US-001: First story
**Status:** todo
**Priority:** 1
**Description:** The first thing.

**Acceptance Criteria:**
- [ ] It works
- [ ] Typecheck passes

### US-002: Second story
**Status:** todo
**Priority:** 2
**Description:** The second thing.

**Acceptance Criteria:**
- [ ] It also works

## Open Questions

- None.
`;

/** What an agent leaves in its worktree's copy: its own story done and ticked. */
function finish(prd: string, storyId: string): string {
  const done = setStoryStatus(prd, storyId, 'done').content;
  const start = done.indexOf(`### ${storyId}:`);
  const end = done.indexOf('\n### ', start + 1) === -1 ? done.indexOf('\n## ', start + 1) : done.indexOf('\n### ', start + 1);
  return done.slice(0, start) + done.slice(start, end).replaceAll('- [ ]', '- [x]') + done.slice(end);
}

const statuses = (prd: string): Record<string, string> =>
  Object.fromEntries(parsePrd(prd).stories.map((story) => [story.id, story.status]));

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mergePrd (async stories US-007)', () => {
  it("takes only the finished story's block from the worktree", () => {
    // The worktree also ticked a box in someone else's story and edited the
    // introduction: neither may reach the session's copy.
    const worktree = finish(PRD, 'US-002').replace('# PRD: Demo', '# PRD: Changed').replace('- [ ] It works', '- [x] It works');
    const merged = mergePrd(PRD, worktree, 'US-002');

    assert.deepEqual(statuses(merged), { 'US-001': 'todo', 'US-002': 'done' });
    assert.ok(merged.includes('- [x] It also works'));
    assert.ok(merged.includes('- [ ] It works'));
    assert.ok(merged.startsWith('# PRD: Demo'));
    assert.ok(merged.endsWith('## Open Questions\n\n- None.\n'));
  });

  it('keeps both stories when each changed a different block', () => {
    const one = finish(PRD, 'US-001');
    const two = finish(PRD, 'US-002');
    // US-001 is merged first; US-002's worktree was cut before that and still
    // says US-001 is todo — which must not undo the first merge.
    const merged = mergePrd(mergePrd(PRD, one, 'US-001'), two, 'US-002');

    assert.deepEqual(statuses(merged), { 'US-001': 'done', 'US-002': 'done' });
    assert.equal(merged.match(/- \[x\]/g)?.length, 3);
    assert.equal(merged.includes('- [ ]'), false);
    assert.equal(merged, mergePrd(mergePrd(PRD, two, 'US-002'), one, 'US-001'), 'the order does not matter');
  });

  it('leaves the session copy alone when either side lacks the story', () => {
    assert.equal(mergePrd(PRD, PRD.replace('### US-002', '### US-009'), 'US-002'), PRD);
    assert.equal(mergePrd(PRD, finish(PRD, 'US-002'), 'US-003'), PRD);
  });

  it('ignores a heading inside a code fence', () => {
    const fenced = PRD.replace('**Description:** The first thing.', '**Description:** The first thing.\n\n```\n### US-002: not a story\n```');
    const merged = mergePrd(fenced, finish(fenced, 'US-001'), 'US-001');
    assert.ok(merged.includes('```\n### US-002: not a story\n```'));
    assert.deepEqual(statuses(merged), { 'US-001': 'done', 'US-002': 'todo' });
  });
});

describe('mergeProgress (async stories US-007)', () => {
  const START = '## Codebase Patterns\n- one\n\n## 2026-10-21 - US-000\n- did it\n---\n';

  it('appends what the story appended', () => {
    const worktree = `${START}\n## 2026-10-22 - US-002\n- did more\n---\n`;
    // Another story's entry was merged into the session in the meantime.
    const session = `${START}\n## 2026-10-22 - US-001\n- first\n---\n`;
    assert.equal(
      mergeProgress(session, START, worktree),
      `${session}\n## 2026-10-22 - US-002\n- did more\n---\n`,
    );
  });

  it('finds a pattern added at the top too, and appends it', () => {
    const worktree = START.replace('- one\n', '- one\n- two\n') + '\n## US-002\n---\n';
    assert.deepEqual(addedLines(START, worktree), ['- two', '', '## US-002', '---']);
  });

  it('changes nothing when the story added nothing', () => {
    assert.equal(mergeProgress('session\n', START, START), 'session\n');
    assert.equal(mergeProgress('', '', 'new\n'), 'new\n');
    assert.equal(mergeProgress('old', '', 'new'), 'old\nnew');
  });
});

describe('MergeQueue', () => {
  it('runs one merge per session at a time, in arrival order, and survives a failure', async () => {
    const queue = new MergeQueue();
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run('s', async () => {
      events.push('first:start');
      await gate;
      events.push('first:end');
      throw new Error('boom');
    });
    const second = queue.run('s', () => {
      events.push('second');
      return Promise.resolve(2);
    });
    const other = queue.run('t', () => {
      events.push('other session');
      return Promise.resolve(3);
    });
    assert.equal(await other, 3);
    release();
    await assert.rejects(first, /boom/);
    assert.equal(await second, 2);
    assert.deepEqual(events, ['first:start', 'other session', 'first:end', 'second']);
  });
});

describe('StoryMerger with git (async stories US-007)', () => {
  /**
   * A session workspace on disk, with `/workspace` in every exec moved there:
   * the real runner's scripts, run by a real git.
   */
  function workspace(): {
    db: Database;
    session: Session;
    merger: StoryMerger;
    git: (...args: string[]) => string;
    repo: string;
    runner: ReturnType<typeof createAgentRunner>;
    merges: string[];
    /** The conflict-resolution agent: whatever this does to the clone is what it did. */
    agent: { prompts: string[]; act: (repo: string) => void };
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-merge-'));
    tempDirs.push(root);
    const db = openDatabase(IN_MEMORY);
    const repositoryId = createRepository(db, {
      name: 'demo',
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
    }).id;
    const session = createSession(db, {
      repositoryId,
      name: 'demo',
      baseBranch: 'main',
      prTargetBranch: 'main',
    });
    const ws = path.join(root, session.id);
    const repo = path.join(ws, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const identity = {
      GIT_AUTHOR_NAME: 'chief',
      GIT_AUTHOR_EMAIL: 'chief@example.com',
      GIT_COMMITTER_NAME: 'chief',
      GIT_COMMITTER_EMAIL: 'chief@example.com',
    };
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
    git('init', '-q', '-b', 'chief/demo');
    fs.writeFileSync(path.join(repo, '.gitignore'), '.chief/\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    fs.mkdirSync(path.join(repo, '.chief/prds/demo'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.chief/prds/demo/prd.md'), PRD);
    fs.writeFileSync(path.join(repo, '.chief/prds/demo/progress.md'), '## Codebase Patterns\n');
    syncStories(
      db,
      session.id,
      parsePrd(PRD).stories.map((story) => ({
        storyId: story.id,
        title: story.title,
        priority: story.priority,
        status: story.status,
      })),
    );

    const merges: string[] = [];
    const agent = { prompts: [] as string[], act: (_repo: string): void => {} };
    const rewrite = (value: string): string => value.replace(/^\/workspace(?=\/|$)/, ws);
    const runner = createAgentRunner({
      runExec: (_container: string, spec: ExecSpec): Promise<ExecOutput> => {
        if (spec === undefined) throw new Error('no spec');
        const script = spec.cmd[2] ?? '';
        if (spec.cmd.includes('claude')) {
          agent.prompts.push(spec.cmd[spec.cmd.indexOf('-p') + 1] ?? '');
          agent.act(repo);
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
        }
        if (script.includes('git merge --no-ff')) merges.push(`start ${spec.env?.[1] ?? ''}`);
        const env = Object.fromEntries(
          (spec.env ?? []).map((entry) => {
            const [key = '', value = ''] = entry.split(/=(.*)/s);
            return [key, rewrite(value)];
          }),
        );
        return new Promise((resolve) => {
          execFile(
            spec.cmd[0] ?? '',
            spec.cmd.slice(1),
            { cwd: rewrite(spec.workingDir ?? '/workspace/repo'), env: { ...process.env, ...identity, ...env } },
            (error, stdout, stderr) => {
              if (script.includes('git merge --no-ff')) merges.push(`end ${spec.env?.[1] ?? ''}`);
              const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
              resolve({ exitCode: code, stdout, stderr, timedOut: false });
            },
          );
        });
      },
    });
    const merger = new StoryMerger({ workspacesDir: root, buildIterationTimeoutMs: 60_000 }, db, runner);
    return { db, session, merger, git, repo, runner, merges, agent };
  }

  /** What a story agent does in its worktree: a file, a commit, its PRD copy done. */
  async function build(
    world: ReturnType<typeof workspace>,
    storyId: string,
    file: string,
  ): Promise<{
    commitSha: string;
    prdFile: string;
    progressFile: string;
    progressStart: string;
    description: string;
    iteration: number;
  }> {
    const progressStart = fs.readFileSync(path.join(world.repo, '.chief/prds/demo/progress.md'), 'utf8');
    await world.runner.addStoryWorktree?.('c', world.session.name, storyId);
    const dir = path.join(path.dirname(world.repo), 'worktrees', storyId);
    fs.writeFileSync(path.join(dir, file), `${storyId}\n`);
    execFileSync('git', ['add', file], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=chief', '-c', 'user.email=c@example.com', 'commit', '-q', '-m', `feat: ${storyId}`], { cwd: dir });
    const prdFile = path.join(dir, '.chief/prds/demo/prd.md');
    fs.writeFileSync(prdFile, finish(fs.readFileSync(prdFile, 'utf8'), storyId));
    const progressFile = path.join(dir, '.chief/prds/demo/progress.md');
    fs.appendFileSync(progressFile, `\n## ${storyId}\n- learned\n---\n`);
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    return { commitSha, prdFile, progressFile, progressStart, description: `What ${storyId} is for.`, iteration: 1 };
  }

  it('merges a finished story cleanly and records both SHAs', async () => {
    const world = workspace();
    const finished = await build(world, 'US-002', 'two.txt');

    assert.deepEqual(
      await world.merger.merge(world.session, 'c', { storyId: 'US-002', title: 'Second story', ...finished }),
      { code: 'merged' },
    );

    const head = world.git('rev-parse', 'HEAD');
    const row = getStory(world.db, world.session.id, 'US-002');
    assert.equal(row?.status, 'done');
    assert.equal(row?.commitSha, finished.commitSha);
    assert.equal(row?.mergeSha, head);
    assert.equal(world.git('log', '-1', '--format=%s'), 'Merge US-002 - Second story');
    assert.equal(world.git('rev-parse', 'HEAD^2'), finished.commitSha, 'a --no-ff merge of the story commit');
    assert.ok(fs.existsSync(path.join(world.repo, 'two.txt')));
    // The `.chief/` files were merged by hand, and stay out of git.
    const prd = fs.readFileSync(path.join(world.repo, '.chief/prds/demo/prd.md'), 'utf8');
    assert.deepEqual(statuses(prd), { 'US-001': 'todo', 'US-002': 'done' });
    assert.equal(
      fs.readFileSync(path.join(world.repo, '.chief/prds/demo/progress.md'), 'utf8'),
      '## Codebase Patterns\n\n## US-002\n- learned\n---\n',
    );
    assert.equal(world.git('status', '--porcelain'), '');
    // The worktree and its branch are gone.
    assert.equal(fs.existsSync(path.join(path.dirname(world.repo), 'worktrees', 'US-002')), false);
    assert.equal(world.git('branch', '--list', 'chief-story/*'), '');
    assert.equal(getStory(world.db, world.session.id, 'US-001')?.mergeSha, null);
  });

  it('merges two stories that finish at the same moment one after the other', async () => {
    const world = workspace();
    const one = await build(world, 'US-001', 'one.txt');
    const two = await build(world, 'US-002', 'two.txt');

    const results = await Promise.all([
      world.merger.merge(world.session, 'c', { storyId: 'US-001', title: 'First story', ...one }),
      world.merger.merge(world.session, 'c', { storyId: 'US-002', title: 'Second story', ...two }),
    ]);

    assert.deepEqual(results, [{ code: 'merged' }, { code: 'merged' }]);
    // The second merge started only once the first had finished.
    assert.deepEqual(world.merges, [
      'start CHIEF_STORY_BRANCH=chief-story/demo/US-001',
      'end CHIEF_STORY_BRANCH=chief-story/demo/US-001',
      'start CHIEF_STORY_BRANCH=chief-story/demo/US-002',
      'end CHIEF_STORY_BRANCH=chief-story/demo/US-002',
    ]);
    const first = getStory(world.db, world.session.id, 'US-001');
    const second = getStory(world.db, world.session.id, 'US-002');
    assert.equal(first?.status, 'done');
    assert.equal(second?.status, 'done');
    assert.equal(second?.mergeSha, world.git('rev-parse', 'HEAD'));
    assert.equal(first?.mergeSha, world.git('rev-parse', 'HEAD^1'), 'merged on top of the first');
    assert.deepEqual(world.git('log', '--format=%s', '--merges').split('\n'), [
      'Merge US-002 - Second story',
      'Merge US-001 - First story',
    ]);
    const prd = fs.readFileSync(path.join(world.repo, '.chief/prds/demo/prd.md'), 'utf8');
    assert.deepEqual(statuses(prd), { 'US-001': 'done', 'US-002': 'done' });
    assert.equal(prd.includes('- [ ]'), false);
    const progress = fs.readFileSync(path.join(world.repo, '.chief/prds/demo/progress.md'), 'utf8');
    assert.equal(progress, '## Codebase Patterns\n\n## US-001\n- learned\n---\n\n## US-002\n- learned\n---\n');
  });

  it('has an agent resolve a conflict and commits the merge once it checks out (US-008)', async () => {
    const world = workspace();
    const one = await build(world, 'US-001', 'same.txt');
    const two = await build(world, 'US-002', 'same.txt');
    assert.deepEqual(
      await world.merger.merge(world.session, 'c', { storyId: 'US-001', title: 'First story', ...one }),
      { code: 'merged' },
    );
    const before = world.git('rev-parse', 'HEAD');
    world.agent.act = (repo): void => {
      // Mid-merge, the file has both sides in it; the agent keeps both.
      assert.match(fs.readFileSync(path.join(repo, 'same.txt'), 'utf8'), /^<<<<<<< /m);
      fs.writeFileSync(path.join(repo, 'same.txt'), 'US-001\nUS-002\n');
    };

    const result = await world.merger.merge(world.session, 'c', { storyId: 'US-002', title: 'Second story', ...two });

    assert.deepEqual(result, { code: 'merged' });
    assert.equal(world.agent.prompts.length, 1);
    const prompt = world.agent.prompts[0] ?? '';
    assert.ok(prompt.startsWith('# Merge conflicts merging US-002'));
    assert.ok(prompt.includes('What US-002 is for.'), 'the story description');
    assert.ok(prompt.includes('- `same.txt`'), 'the conflicting path');
    const head = world.git('rev-parse', 'HEAD');
    assert.equal(world.git('log', '-1', '--format=%s'), 'Merge US-002 - Second story');
    assert.equal(world.git('rev-parse', 'HEAD^1'), before);
    assert.equal(world.git('rev-parse', 'HEAD^2'), two.commitSha);
    assert.equal(fs.readFileSync(path.join(world.repo, 'same.txt'), 'utf8'), 'US-001\nUS-002\n');
    assert.equal(world.git('status', '--porcelain'), '');
    const row = getStory(world.db, world.session.id, 'US-002');
    assert.equal(row?.status, 'done');
    assert.equal(row?.mergeSha, head);
    const prd = fs.readFileSync(path.join(world.repo, '.chief/prds/demo/prd.md'), 'utf8');
    assert.deepEqual(statuses(prd), { 'US-001': 'done', 'US-002': 'done' });
    assert.equal(world.git('branch', '--list', 'chief-story/*'), '');
  });

  it('aborts a conflict the agent leaves unresolved and leaves the session as it was (US-008)', async () => {
    const world = workspace();
    const one = await build(world, 'US-001', 'same.txt');
    const two = await build(world, 'US-002', 'same.txt');
    assert.deepEqual(
      await world.merger.merge(world.session, 'c', { storyId: 'US-001', title: 'First story', ...one }),
      { code: 'merged' },
    );
    const head = world.git('rev-parse', 'HEAD');
    const prdBefore = fs.readFileSync(path.join(world.repo, '.chief/prds/demo/prd.md'), 'utf8');
    // The agent edits, but leaves a marker behind.
    world.agent.act = (repo): void => fs.writeFileSync(path.join(repo, 'same.txt'), 'US-001\n=======\nUS-002\n');

    const result = await world.merger.merge(world.session, 'c', { storyId: 'US-002', title: 'Second story', ...two });

    assert.equal(result.code, 'not_merged');
    assert.match(result.code === 'not_merged' ? result.reason : '', /same\.txt.*Conflict markers were left behind in same\.txt/);

    assert.equal(world.git('rev-parse', 'HEAD'), head);
    assert.equal(world.git('status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(world.repo, '.chief/prds/demo/prd.md'), 'utf8'), prdBefore);
    assert.equal(getStory(world.db, world.session.id, 'US-002')?.mergeSha, null);
  });

  it('clears a half-done merge, every worktree and every story branch after a restart (US-011)', async () => {
    const world = workspace();
    const one = await build(world, 'US-001', 'same.txt');
    await build(world, 'US-002', 'same.txt');
    assert.deepEqual(
      await world.merger.merge(world.session, 'c', { storyId: 'US-001', title: 'First story', ...one }),
      { code: 'merged' },
    );
    const head = world.git('rev-parse', 'HEAD');
    // A third story was still running, and the server died in the middle of
    // US-002's merge: git stopped on the conflict and nobody came back to it.
    await build(world, 'US-003', 'three.txt');
    const merging = await world.runner.mergeStory?.('c', world.session.name, 'US-002', 'Merge US-002 - Second story');
    assert.equal(merging?.code, 'conflicted');
    assert.ok(fs.existsSync(path.join(world.repo, '.git/MERGE_HEAD')));
    // Another session's branches, and one whose name only starts the same, stay.
    world.git('branch', 'chief-story/other/US-001');
    world.git('branch', 'chief-story/demo-two/US-001');

    const recovery = await world.runner.recoverStoryWorkspaces?.('c', world.session.name);

    assert.deepEqual(recovery, {
      abortedMerge: true,
      worktrees: ['US-002', 'US-003'],
      branches: ['chief-story/demo/US-002', 'chief-story/demo/US-003'],
      error: null,
    });
    assert.equal(fs.existsSync(path.join(world.repo, '.git/MERGE_HEAD')), false);
    assert.equal(world.git('rev-parse', 'HEAD'), head, 'the merged story stays merged');
    assert.equal(world.git('status', '--porcelain'), '');
    assert.equal(fs.existsSync(path.join(world.repo, 'three.txt')), false, "US-003's commit is gone with its branch");
    assert.deepEqual(fs.readdirSync(path.join(path.dirname(world.repo), 'worktrees')), []);
    assert.equal(world.git('worktree', 'list', '--porcelain').match(/^worktree /gm)?.length, 1);
    assert.deepEqual(world.git('branch', '--list', 'chief-story/*', '--format=%(refname:short)').split('\n'), [
      'chief-story/demo-two/US-001',
      'chief-story/other/US-001',
    ]);
    // The PRD is untracked, and the clean-up never touches it.
    assert.ok(fs.existsSync(path.join(world.repo, '.chief/prds/demo/prd.md')));

    // Nothing left: a second pass finds nothing and says so.
    assert.deepEqual(await world.runner.recoverStoryWorkspaces?.('c', world.session.name), {
      abortedMerge: false,
      worktrees: [],
      branches: [],
      error: null,
    });
  });
});

describe('mergeStorySpec', () => {
  it('merges the story branch with --no-ff in the clone, the message through the environment', () => {
    const spec = mergeStorySpec('demo', 'US-003', mergeMessage('US-003', 'Add "login"; $(rm -rf /)'));
    assert.equal(spec.workingDir, '/workspace/repo');
    assert.ok((spec.cmd[2] ?? '').includes('git merge --no-ff "$CHIEF_STORY_BRANCH" -m "$CHIEF_MERGE_MESSAGE"'));
    assert.ok((spec.cmd[2] ?? '').includes('*index.lock*'));
    assert.deepEqual(spec.env?.slice(1, 3), [
      'CHIEF_STORY_BRANCH=chief-story/demo/US-003',
      'CHIEF_MERGE_MESSAGE=Merge US-003 - Add "login"; $(rm -rf /)',
    ]);
  });
});
