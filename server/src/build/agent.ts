import type { ExecSpec } from '../docker/index.js';
import { prdDirFor } from '../prd/index.js';
import { RUNNER_WORKSPACE_DIR } from '../runner/index.js';
import { CONTAINER_REPO_DIR } from '../sessions/index.js';
import { agentCommand } from './prompts.js';

/**
 * How a build iteration's `claude` process is started and addressed from
 * *inside* the session container (US-013).
 *
 * The Engine API has no "kill exec" and the pid it reports is a **host** pid,
 * so — exactly like a browser terminal (US-007) — the agent is started under a
 * one-line wrapper that records its own pid before `exec`ing the real command.
 * "Stop build" reads that file back and signals it, which is the only way to
 * end a headless agent gracefully rather than by discarding its container.
 *
 * It is also the only way to end one that ran out of time. Closing the exec
 * stream — all a timeout can do from the outside — leaves the agent running
 * with the workspace still under it, so every pid an iteration records has to
 * stay addressable until something has confirmed it is gone.
 */

/** Directory inside the session container holding the agents' pid files. */
export const AGENT_PID_DIR = '/tmp/.chief-build';

/**
 * One pid file per *iteration*, not per session.
 *
 * A single file per session was overwritten by the next iteration, which meant
 * an agent that outlived its iteration — the whole reason for reaping one —
 * became unreachable the moment its successor started. Keying the file on the
 * iteration keeps every agent this session has ever started addressable, and
 * {@link agentSignalSpec} sweeps all of them at once.
 */
export function agentPidFile(sessionId: string, iteration: number): string {
  return `${AGENT_PID_DIR}/${sessionId}-${String(iteration)}.pid`;
}

/**
 * One pid file per story *attempt* (async stories US-006): with several story
 * agents in one container, stop, a timeout's reap and the restart sweep each
 * have to be able to aim at one story's agent and leave the others alone.
 *
 * Still under {@link agentPidGlob}, so the session-wide sweep finds it. It can
 * never be mistaken for an iteration's file: a story id is not a number.
 */
export function storyAgentPidFile(sessionId: string, storyId: string, attempt: number): string {
  return `${AGENT_PID_DIR}/${sessionId}-${storyId}-${String(attempt)}.pid`;
}

/** Every attempt's pid file of one story; a shell glob, not a path. */
export function storyAgentPidGlob(sessionId: string, storyId: string): string {
  return `${AGENT_PID_DIR}/${sessionId}-${storyId}-*.pid`;
}

/**
 * Printed by {@link agentSignalSpec} for each agent it found still running.
 *
 * A sweep that prints nothing found nothing, and a reap can stop there instead
 * of sitting through a grace period for an agent that was never there — which
 * is the normal case for both of the paths that reap.
 */
export const AGENT_SIGNALLED = 'chief-signalled';

/**
 * Every pid file this session has, for the sweep; a shell glob, not a path.
 *
 * Deliberately loose enough to match the one-file-per-session name this used
 * to write (`<id>.pid`, no iteration): the containers that hold those files
 * outlive the server that wrote them, so the first sweep after an upgrade is
 * the only thing that will ever be in a position to reap what they left. Two
 * session ids cannot be a prefix of one another — they are uuids, all of one
 * length — so the wildcard cannot reach into another session.
 */
export function agentPidGlob(sessionId: string): string {
  return `${AGENT_PID_DIR}/${sessionId}*.pid`;
}

/**
 * Wraps `command` so its pid is recorded before it takes over the process.
 *
 * The command is passed as positional arguments and run with `exec "$@"`, so
 * nothing in it is ever re-parsed by the shell — which matters here more than
 * anywhere else, because the prompt is tens of kilobytes of markdown full of
 * backticks, quotes and `$`.
 */
export function wrapAgentCommand(
  sessionId: string,
  iteration: number,
  command: readonly string[],
): string[] {
  return wrapWithPidFile(AGENT_PID_DIR, agentPidFile(sessionId, iteration), 'chief-build', command);
}

/**
 * The pid-file trick itself, for any directory: `label` is `$0` of the
 * wrapper shell. Session voice agents use it under `/tmp/.chief-voice`.
 */
export function wrapWithPidFile(dir: string, file: string, label: string, command: readonly string[]): string[] {
  return ['/bin/sh', '-c', `mkdir -p ${dir} 2>/dev/null; echo $$ > ${file}; exec "$@"`, label, ...command];
}

/**
 * Where a story agent runs when it does not run in the clone (async stories
 * US-006): its own worktree, and a pid file keyed on the story and attempt.
 */
export interface StoryTarget {
  readonly storyId: string;
  readonly attempt: number;
  readonly workingDir: string;
}

/**
 * One headless `claude -p` iteration: in the clone, or — given a `story` — in
 * that story's worktree.
 */
export function agentExecSpec(
  sessionId: string,
  iteration: number,
  prompt: string,
  model?: string | null,
  advisor?: string | null,
  effort?: string | null,
  mcpConfigFile?: string | null,
  story?: StoryTarget | null,
): ExecSpec {
  const command = agentCommand(prompt, model, advisor, effort, mcpConfigFile);
  return {
    cmd:
      story == null
        ? wrapAgentCommand(sessionId, iteration, command)
        : wrapWithPidFile(AGENT_PID_DIR, storyAgentPidFile(sessionId, story.storyId, story.attempt), 'chief-build', command),
    workingDir: story?.workingDir ?? CONTAINER_REPO_DIR,
  };
}

/**
 * Sends `signal` to every agent this session has recorded: to each pid, to its
 * process group, and to its direct children.
 *
 * The agent itself is `exec`ed, so a recorded pid *is* `claude` and the middle
 * line is the one that matters. The other two are for what it started: an
 * iteration that is running the project's test suite when it is signalled
 * would otherwise leave that suite — and the database servers it started —
 * behind, still holding the workspace.
 *
 * A pid is only signalled when `/proc` still shows it running the agent. Pids
 * are recycled, and by the time a leftover file is swept its number may belong
 * to something else entirely; a record that no longer points at an agent is
 * deleted rather than shot at. `remove` deletes the ones that do, and belongs
 * to the last pass of a reap — an earlier pass has to leave the record behind
 * or the pass after it has nothing left to aim at.
 *
 * Every failure is swallowed and the exit code is always 0 — an agent that has
 * already finished is a success, not something to report. What it does print is
 * {@link AGENT_SIGNALLED}, once per agent it actually signalled, which is how a
 * reap knows whether there is anything to come back and kill.
 */
export function agentSignalSpec(
  sessionId: string,
  signal: string,
  options: { readonly remove?: boolean; readonly storyId?: string | null | undefined } = {},
): ExecSpec {
  // With a story id, only that story's agents (async stories US-006).
  const glob = options.storyId == null ? agentPidGlob(sessionId) : storyAgentPidGlob(sessionId, options.storyId);
  return pidFileSignalSpec(glob, signal, options.remove === undefined ? {} : { remove: options.remove });
}

/**
 * {@link agentSignalSpec} over any pid-file glob; see there. `match` is what
 * `/proc/<pid>/cmdline` must contain for the pid to still count as ours
 * (`claude` unless said otherwise).
 */
export function pidFileSignalSpec(
  glob: string,
  signal: string,
  options: { readonly remove?: boolean; readonly match?: string } = {},
): ExecSpec {
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `for file in ${glob}; do ` +
        `[ -f "$file" ] || continue; ` +
        `pid=$(cat "$file" 2>/dev/null); ` +
        `if [ -n "$pid" ] && grep -qa ${options.match ?? 'claude'} /proc/"$pid"/cmdline 2>/dev/null; then ` +
        `kill -${signal} -"$pid" 2>/dev/null; ` +
        `kill -${signal} "$pid" 2>/dev/null; ` +
        `pkill -${signal} -P "$pid" 2>/dev/null; ` +
        `echo ${AGENT_SIGNALLED}; ` +
        `${options.remove === true ? 'rm -f "$file"; ' : ''}` +
        `else rm -f "$file"; fi; ` +
        `done; exit 0`,
    ],
  };
}

/**
 * `git rev-parse HEAD` in the clone, or in a story's worktree; the loop's
 * evidence that a commit landed.
 */
export function headShaSpec(workingDir: string = CONTAINER_REPO_DIR): ExecSpec {
  return { cmd: ['git', 'rev-parse', 'HEAD'], workingDir };
}

/** Where the story worktrees live inside the container (async stories US-006). */
export const WORKTREES_DIR = `${RUNNER_WORKSPACE_DIR}/worktrees`;

/** `/workspace/worktrees/<story-id>`: one story's own checkout. */
export function storyWorktreeDir(storyId: string): string {
  return `${WORKTREES_DIR}/${storyId}`;
}

/** `chief-story/<session-name>/<story-id>`: the branch a story commits on. */
export function storyBranch(sessionName: string, storyId: string): string {
  return `chief-story/${sessionName}/${storyId}`;
}

/**
 * The `.git/info/exclude` line for the worktrees directory. It sits beside the
 * clone, not in it, so git would not see it anyway; the line makes sure of it
 * should the layout ever change.
 */
export const WORKTREES_EXCLUDE = '/worktrees/';

/**
 * Removes the worktree and deletes the branch, whatever state either is in:
 * the remove of a merged or abandoned story, and the "leftover from an earlier
 * run" clean-up in front of every add.
 */
const REMOVE_WORKTREE_SCRIPT = `git worktree remove --force "$CHIEF_WORKTREE" 2>/dev/null || true
rm -rf "$CHIEF_WORKTREE"
git worktree prune
git branch -D "$CHIEF_STORY_BRANCH" >/dev/null 2>&1 || true`;

/**
 * Creates the worktree a parallel story runs in (async stories US-006), off the
 * session branch's HEAD in `/workspace/repo`.
 *
 * `.chief/` is never committed, so a fresh worktree has no `prd.md` and no
 * `progress.md`: both are copied in from the clone, because the agent updates
 * the worktree's copies and chief-web reads them back from there. A feedback
 * session's screenshots come along; the live `agent.log` does not.
 *
 * Every value goes in through the environment, as in session setup, so nothing
 * from a session name is ever parsed as shell.
 */
export function addStoryWorktreeSpec(sessionName: string, storyId: string): ExecSpec {
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `set -e
mkdir -p .git/info
grep -qxF "$CHIEF_EXCLUDE" .git/info/exclude 2>/dev/null || echo "$CHIEF_EXCLUDE" >> .git/info/exclude
${REMOVE_WORKTREE_SCRIPT}
mkdir -p "$CHIEF_WORKTREES"
base=$(git rev-parse --verify HEAD)
git worktree add "$CHIEF_WORKTREE" -b "$CHIEF_STORY_BRANCH" "$base"
mkdir -p "$CHIEF_WORKTREE/$CHIEF_PRD_DIR"
for file in prd.md progress.md; do
    if [ -f "$CHIEF_PRD_DIR/$file" ]; then cp "$CHIEF_PRD_DIR/$file" "$CHIEF_WORKTREE/$CHIEF_PRD_DIR/$file"; fi
done
if [ -d "$CHIEF_PRD_DIR/screenshots" ]; then cp -R "$CHIEF_PRD_DIR/screenshots" "$CHIEF_WORKTREE/$CHIEF_PRD_DIR/"; fi`,
    ],
    env: [
      ...worktreeEnv(sessionName, storyId),
      `CHIEF_WORKTREES=${WORKTREES_DIR}`,
      `CHIEF_PRD_DIR=${prdDirFor(sessionName)}`,
      `CHIEF_EXCLUDE=${WORKTREES_EXCLUDE}`,
    ],
    workingDir: CONTAINER_REPO_DIR,
  };
}

/**
 * `git worktree remove --force` and `git branch -D` for a story that was merged
 * or abandoned (async stories US-006).
 */
export function removeStoryWorktreeSpec(sessionName: string, storyId: string): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', REMOVE_WORKTREE_SCRIPT],
    env: worktreeEnv(sessionName, storyId),
    workingDir: CONTAINER_REPO_DIR,
  };
}

function worktreeEnv(sessionName: string, storyId: string): string[] {
  return [`CHIEF_WORKTREE=${storyWorktreeDir(storyId)}`, `CHIEF_STORY_BRANCH=${storyBranch(sessionName, storyId)}`];
}

/**
 * Paths a workspace check leaves alone: `.chief/` holds `prd.md`, `progress.md`
 * and the screenshots, which are never committed, so they always show up as
 * untracked — and a clean must never take them.
 */
const OUTSIDE_CHIEF = ['--', '.', ':(exclude).chief'];
const QUOTED_OUTSIDE_CHIEF = OUTSIDE_CHIEF.map((part) => `'${part}'`).join(' ');

/**
 * `git status --porcelain` in the clone, `.chief/` aside: how chief-web sees
 * whether the read-only dependency-analysis agent changed anything (async
 * stories US-005).
 */
export function workspaceStatusSpec(): ExecSpec {
  return { cmd: ['git', 'status', '--porcelain', ...OUTSIDE_CHIEF], workingDir: CONTAINER_REPO_DIR };
}

/**
 * `git checkout -- . && git clean -fd`, `.chief/` aside: throws away what the
 * analysis agent changed when it was told not to.
 */
export function restoreWorkspaceSpec(): ExecSpec {
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `git checkout ${QUOTED_OUTSIDE_CHIEF} && git clean -fd ${QUOTED_OUTSIDE_CHIEF}`,
    ],
    workingDir: CONTAINER_REPO_DIR,
  };
}

/** How often a merge is tried while another git command holds `index.lock`. */
export const MERGE_LOCK_ATTEMPTS = 5;

/**
 * `git merge --no-ff chief-story/<session>/<story-id> -m "Merge US-xxx - <title>"`
 * in `/workspace/repo` (async stories US-007).
 *
 * The worktrees share the clone's `.git`, so a commit in one of them can hold
 * `index.lock` for a moment; a merge that failed on that never started, and is
 * tried again a few times. On success stdout is the merge commit's SHA. On any
 * other failure the merge is left as git left it, and stdout lists the
 * unmerged paths — none means it was not a conflict. The message carries the
 * story's title, so it goes in through the environment, never into the script.
 */
export function mergeStorySpec(sessionName: string, storyId: string, message: string): ExecSpec {
  return {
    cmd: [
      '/bin/sh',
      '-c',
      `attempt=1
while ! out=$(git merge --no-ff "$CHIEF_STORY_BRANCH" -m "$CHIEF_MERGE_MESSAGE" 2>&1); do
    case "$out" in
        *index.lock*)
            if [ "$attempt" -lt "$CHIEF_LOCK_ATTEMPTS" ]; then attempt=$((attempt + 1)); sleep 1; continue; fi ;;
    esac
    printf '%s\\n' "$out" >&2
    git diff --name-only --diff-filter=U
    exit 1
done
git rev-parse HEAD`,
    ],
    env: [
      ...worktreeEnv(sessionName, storyId),
      `CHIEF_MERGE_MESSAGE=${message}`,
      `CHIEF_LOCK_ATTEMPTS=${String(MERGE_LOCK_ATTEMPTS)}`,
    ],
    workingDir: CONTAINER_REPO_DIR,
  };
}
