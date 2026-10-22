import fs from 'node:fs';

import type { Config } from '../config.js';
import { type Database, type Session, updateStory } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { CodeFenceScanner, STORY_HEADING_PATTERN } from '../prd/parse.js';
import { sessionPrdFile, sessionProgressFile } from '../sessions/index.js';
import type { BuildLogWriter } from './log.js';
import type { AgentRunner } from './runner.js';

/**
 * Bringing a finished parallel story back into the session (async stories
 * US-007), as pure functions plus the one piece of state the merge needs.
 *
 * `prd.md` and `progress.md` live under `.chief/`, which is never committed,
 * so git never merges them: every story's worktree has its own copy, and
 * chief-web writes the result into the clone itself. Neither file is ever
 * handed to git or to an agent to merge.
 */

/** `Merge US-003 - Add login`: the message of a story's merge commit. */
export function mergeMessage(storyId: string, title: string): string {
  return `Merge ${storyId} - ${title}`;
}

/**
 * The session's `prd.md` with only `storyId`'s block taken from the worktree.
 *
 * A block runs from the story's heading up to the next `##`/`###` heading, the
 * way the parser and `setStoryStatuses` read it, so it carries the status line
 * and the acceptance-criteria checkboxes the agent ticked. Everything else —
 * including the blocks other stories' merges already brought in — is the
 * session's. A story either side does not have leaves the session's file as it
 * is: chief-web never invents a story, and never drops one.
 */
export function mergePrd(sessionPrd: string, worktreePrd: string, storyId: string): string {
  const theirs = storyBlock(worktreePrd.split('\n'), storyId);
  const lines = sessionPrd.split('\n');
  const ours = storyBlock(lines, storyId);
  if (theirs === null || ours === null) return sessionPrd;

  const block = worktreePrd.split('\n').slice(theirs.start, theirs.end);
  return [...lines.slice(0, ours.start), ...block, ...lines.slice(ours.end)].join('\n');
}

/** `[start, end)` line range of a story's block, or null when there is none. */
function storyBlock(lines: readonly string[], storyId: string): { start: number; end: number } | null {
  const fences = new CodeFenceScanner();
  let start: number | null = null;
  for (const [index, line] of lines.entries()) {
    if (fences.consume(line)) continue;
    const trimmed = line.trim();
    const heading = STORY_HEADING_PATTERN.exec(trimmed);
    const boundary = heading !== null || line.startsWith('## ') || line.startsWith('### ');
    if (start !== null && boundary) return { start, end: index };
    if (heading !== null && heading[1] === storyId) start = index;
  }
  return start === null ? null : { start, end: lines.length };
}

/**
 * The session's `progress.md` with the lines the story added appended.
 *
 * `start` is the session's `progress.md` as it was copied into the worktree;
 * the lines the story added are the ones its copy has now that `start` did not,
 * found with a line diff rather than as a suffix, because the agent is also
 * told to add patterns at the top. They go at the end of the session's version,
 * which may have grown since from other stories' merges.
 */
export function mergeProgress(session: string, start: string, worktree: string): string {
  const added = addedLines(start, worktree);
  if (added.length === 0) return session;
  const separator = session === '' || session.endsWith('\n') ? '' : '\n';
  const tail = worktree.endsWith('\n') ? '\n' : '';
  return `${session}${separator}${added.join('\n')}${tail}`;
}

/**
 * The lines of `after` that are not in `before`, in order: the insertions of a
 * longest-common-subsequence diff. A trailing newline is not a line.
 */
export function addedLines(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = lcs[i] ?? [];
    const next = lcs[i + 1] ?? [];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (i < a.length && (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      i += 1;
    } else {
      added.push(b[j] ?? '');
      j += 1;
    }
  }
  return added;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * One merge into `/workspace/repo` at a time, per session.
 *
 * Every story's merge touches the same clone, the same index and the same
 * `.chief/` files, so a second one that finishes while the first is merging
 * waits its turn; sessions do not wait for each other. A merge that throws
 * does not hold up the ones behind it.
 */
export class MergeQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(sessionId: string, merge: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const next = previous.then(merge, merge);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    void tail.then(() => {
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    });
    return next;
  }
}

/** A finished story, as the merge needs it. */
export interface FinishedStory {
  readonly storyId: string;
  readonly title: string;
  /** The story's own commit on its branch: HEAD of its worktree. */
  readonly commitSha: string | null;
  /** The worktree's `prd.md` and `progress.md`, on the host. */
  readonly prdFile: string;
  readonly progressFile: string;
  /** The clone's `progress.md` as it was copied into the worktree. */
  readonly progressStart: string;
  /** The story's build-log section; the merge's lines go under it. */
  readonly log?: BuildLogWriter;
}

/**
 * Merges finished stories' branches into their session branch (async stories
 * US-007), one merge per session at a time.
 *
 * Git merges the code. `prd.md` and `progress.md` are merged here and written
 * into the clone's `.chief/`, uncommitted like everything under it: the
 * session's `prd.md` with only this story's block taken from the worktree, and
 * the session's `progress.md` with the story's added lines appended. Then the
 * row is `done`, carrying the story's own commit and the merge commit, and the
 * worktree is removed.
 */
export class StoryMerger {
  private readonly queue = new MergeQueue();

  constructor(
    private readonly config: Pick<Config, 'workspacesDir'>,
    private readonly db: Database,
    private readonly runner: AgentRunner,
  ) {}

  /**
   * True when the story was merged. False when it was not — a conflict, or a
   * merge git refused — in which case the merge is aborted, the clone and its
   * `.chief/` files are as they were, and the worktree is left to the caller.
   */
  merge(session: Pick<Session, 'id' | 'name'>, containerId: string, story: FinishedStory): Promise<boolean> {
    return this.queue.run(session.id, () => this.mergeNow(session, containerId, story));
  }

  private async mergeNow(
    session: Pick<Session, 'id' | 'name'>,
    containerId: string,
    story: FinishedStory,
  ): Promise<boolean> {
    const { storyId } = story;
    const merge = this.runner.mergeStory;
    if (merge === undefined) return false;
    const worktreePrd = fs.readFileSync(story.prdFile, 'utf8');
    const worktreeProgress = readOrEmpty(story.progressFile);

    const outcome = await merge.call(this.runner, containerId, session.name, storyId, mergeMessage(storyId, story.title));
    if (outcome.code !== 'merged') {
      await this.runner.abortStoryMerge?.(containerId, session.name, storyId);
      story.log?.write(
        outcome.code === 'conflicted'
          ? `\n${storyId}: merge conflict in ${outcome.files.join(', ')}; the merge was aborted.\n`
          : `\n${storyId}: the merge into the session branch failed: ${outcome.message}\n`,
      );
      logger.warn('story merge did not go through', { session: session.id, story: storyId, outcome: outcome.code });
      return false;
    }

    // Written in place, like the status mark, so the files keep the owner the
    // runner needs: the server is root in Docker and a fresh file would be root's.
    const prdFile = sessionPrdFile(this.config, session);
    fs.writeFileSync(prdFile, mergePrd(fs.readFileSync(prdFile, 'utf8'), worktreePrd, storyId));
    const progressFile = sessionProgressFile(this.config, session);
    const current = readOrEmpty(progressFile);
    const progress = mergeProgress(current, story.progressStart, worktreeProgress);
    if (progress !== current) fs.writeFileSync(progressFile, progress);

    updateStory(this.db, session.id, storyId, {
      status: 'done',
      commitSha: story.commitSha,
      mergeSha: outcome.mergeSha,
    });
    story.log?.write(`\n${storyId}: merged into the session branch as ${outcome.mergeSha}\n`);
    logger.info('story merged', { session: session.id, story: storyId, merge: outcome.mergeSha });
    await this.runner.removeStoryWorktree?.(containerId, session.name, storyId);
    return true;
  }
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
