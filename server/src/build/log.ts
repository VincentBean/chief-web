import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '../config.js';
import { type Database, getSession, nowIso, type Session } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { agentLogPathFor } from '../prd/index.js';
import { sessionAgentLogFile } from '../sessions/index.js';

/**
 * The build log of a session (US-016).
 *
 * The file *is* the log. Every line the loop produces is appended to
 * `.chief/prds/<name>/agent.log` in the workspace and handed to whoever is
 * watching in the same synchronous step, so a browser attaching mid-iteration
 * reads the file and then receives exactly the lines written after that read —
 * no in-memory mirror to fall out of step with it, and no gap in between.
 *
 * That is also what makes the history outlive everything: a build finished
 * yesterday, a server restarted since and a tab opened for the first time all
 * read the same sections out of the same file.
 */

/** Written before an iteration's output; the start of a section. */
export const ITERATION_START_PATTERN = /^=== chief-web iteration (\d+) \| (.*) \| (\S+) ===$/;

/** Written after it, carrying how the agent exited. */
export const ITERATION_END_PATTERN = /^=== chief-web iteration (\d+) ended \| exit (\S+) \| (\S+) ===$/;

/** How much of the file is read back; the tail is what anyone wants to see. */
export const LOG_TAIL_BYTES = 512 * 1024;

/** Placeholder in a marker for a value there is none of. */
const NONE = '-';

/** Header of the entry the store adds to the clone's local ignore list. */
export const GIT_EXCLUDE_HEADER = "# chief-web's own build log; not part of the work.";

/** One iteration's section of the log. */
export interface BuildLogIteration {
  readonly iteration: number;
  readonly storyId: string | null;
  readonly startedAt: string;
  /** `null` while the iteration is still running. */
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly text: string;
}

export interface BuildLogHistory {
  /** Absolute-in-the-clone path of the file, as the UI names it. */
  readonly path: string;
  readonly iterations: readonly BuildLogIteration[];
  /** True when older output was dropped because the file is long. */
  readonly truncated: boolean;
}

/** What a watcher is told after it has been given the history. */
export type BuildLogEvent =
  | {
      readonly type: 'begin';
      readonly iteration: number;
      readonly storyId: string | null;
      readonly startedAt: string;
    }
  | { readonly type: 'append'; readonly text: string }
  | {
      readonly type: 'end';
      readonly exitCode: number | null;
      readonly endedAt: string;
    };

export type BuildLogListener = (event: BuildLogEvent) => void;

/** One iteration's writer, handed to the loop for the length of the run. */
export interface BuildLogWriter {
  write(text: string): void;
  /** Closes the section. Safe to call twice; only the first one counts. */
  end(exitCode: number | null): void;
}

/** The slice of the store the build loop uses; tests pass {@link NullBuildLogs}. */
export interface BuildLogs {
  begin(session: Session, iteration: number, storyId: string | null): BuildLogWriter;
}

/** A store that keeps nothing, for a service constructed without one. */
export class NullBuildLogs implements BuildLogs {
  begin(): BuildLogWriter {
    return { write: () => {}, end: () => {} };
  }
}

export class BuildLogStore implements BuildLogs {
  private readonly listeners = new Map<string, Set<BuildLogListener>>();
  /** Sessions whose log file could not be written; warned about once each. */
  private readonly unwritable = new Set<string>();
  /** Sessions whose clone has already been told to ignore the log. */
  private readonly ignoring = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly db: Database,
  ) {}

  /** Opens a section for iteration `iteration` and returns its writer. */
  begin(session: Session, iteration: number, storyId: string | null): BuildLogWriter {
    const startedAt = nowIso();
    let ended = false;

    this.ignoreInGit(session);

    this.append(session, `\n=== chief-web iteration ${String(iteration)} | ${storyId ?? NONE} | ${startedAt} ===\n`);
    this.publish(session.id, { type: 'begin', iteration, storyId, startedAt });

    return {
      write: (text: string): void => {
        if (ended || text === '') return;
        this.append(session, text);
        this.publish(session.id, { type: 'append', text });
      },
      end: (exitCode: number | null): void => {
        if (ended) return;
        ended = true;
        const endedAt = nowIso();
        const code = exitCode === null ? NONE : String(exitCode);
        this.append(
          session,
          `=== chief-web iteration ${String(iteration)} ended | exit ${code} | ${endedAt} ===\n`,
        );
        this.publish(session.id, { type: 'end', exitCode, endedAt });
      },
    };
  }

  /**
   * Subscribes to `sessionId` and returns everything written so far.
   *
   * Synchronous from end to end on purpose: the history is read and the
   * listener registered without yielding, so a line written by an iteration in
   * flight is either already in the file that was read or delivered as an
   * event — never both, and never neither.
   */
  attach(
    sessionId: string,
    listener: BuildLogListener,
  ): { history: BuildLogHistory; detach: () => void } | null {
    const session = getSession(this.db, sessionId);
    if (session === null) return null;

    const history = this.history(session);
    const listeners = this.listeners.get(sessionId) ?? new Set<BuildLogListener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);

    return {
      history,
      detach: (): void => {
        listeners.delete(listener);
        if (listeners.size === 0) this.listeners.delete(sessionId);
      },
    };
  }

  /** The tail of the log file, split into per-iteration sections. */
  history(session: Session): BuildLogHistory {
    const relative = agentLogPathFor(session.name);
    const raw = this.readTail(session);
    if (raw === null) return { path: relative, iterations: [], truncated: false };
    const parsed = parseLog(raw.text);
    return {
      path: relative,
      iterations: parsed.iterations,
      truncated: parsed.truncated || raw.truncated,
    };
  }

  private readTail(session: Session): { text: string; truncated: boolean } | null {
    const file = sessionAgentLogFile(this.config, session);
    let handle: number;
    try {
      handle = fs.openSync(file, 'r');
    } catch {
      // No build has run for this session yet; an empty log is not an error.
      return null;
    }
    try {
      const size = fs.fstatSync(handle).size;
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      return { text: buffer.toString('utf8'), truncated: start > 0 };
    } catch (cause) {
      logger.warn('could not read the build log', { session: session.id, error: String(cause) });
      return null;
    } finally {
      fs.closeSync(handle);
    }
  }

  /**
   * Keeps the log out of the agent's commits.
   *
   * It is written into the clone, so a `git add -A` — which agents do — would
   * sweep chief-web's own half-finished log into the work it is committing.
   * `.git/info/exclude` is the right place to say so: it is local to this
   * clone, is never pushed, and does not change a file the repository owns the
   * way a `.gitignore` entry would.
   */
  private ignoreInGit(session: Session): void {
    if (this.ignoring.has(session.id)) return;
    this.ignoring.add(session.id);

    const file = path.join(sessionRepoDir(this.config, session.id), '.git', 'info', 'exclude');
    const entry = `/${agentLogPathFor(session.name)}`;
    try {
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (current.split('\n').includes(entry)) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const separator = current === '' || current.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(file, `${separator}${GIT_EXCLUDE_HEADER}\n${entry}\n`);
    } catch (cause) {
      logger.warn('could not exclude the build log from the clone', {
        session: session.id,
        file,
        error: String(cause),
      });
    }
  }

  private append(session: Session, text: string): void {
    const file = sessionAgentLogFile(this.config, session);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text);
      this.unwritable.delete(session.id);
    } catch (cause) {
      // A log that cannot be written must never end a build: the watchers still
      // get the output, and the next iteration tries the file again.
      if (!this.unwritable.has(session.id)) {
        this.unwritable.add(session.id);
        logger.warn('could not append to the build log', {
          session: session.id,
          file,
          error: String(cause),
        });
      }
    }
  }

  private publish(sessionId: string, event: BuildLogEvent): void {
    const listeners = this.listeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (cause) {
        // One broken watcher is not the build's problem.
        logger.warn('a build log listener threw', { session: sessionId, error: String(cause) });
      }
    }
  }
}

/**
 * Splits a log file back into the sections its markers delimit.
 *
 * Output before the first marker is dropped rather than guessed at: it is the
 * tail of an iteration whose header the read did not reach.
 */
export function parseLog(text: string): { iterations: BuildLogIteration[]; truncated: boolean } {
  const iterations: BuildLogIteration[] = [];
  let current: (BuildLogIteration & { text: string }) | null = null;
  let lines: string[] = [];
  let truncated = false;

  const close = (endedAt: string | null, exitCode: number | null): void => {
    if (current === null) return;
    iterations.push({ ...current, endedAt, exitCode, text: lines.join('\n') });
    current = null;
    lines = [];
  };

  for (const line of text.split('\n')) {
    const start = ITERATION_START_PATTERN.exec(line);
    if (start !== null) {
      close(null, null);
      current = {
        iteration: Number(start[1]),
        storyId: start[2] === NONE || start[2] === undefined ? null : start[2],
        startedAt: start[3] as string,
        endedAt: null,
        exitCode: null,
        text: '',
      };
      continue;
    }

    const end = ITERATION_END_PATTERN.exec(line);
    if (end !== null && current !== null) {
      close(end[3] as string, end[2] === NONE ? null : Number(end[2]));
      continue;
    }

    if (current === null) {
      if (line.trim() !== '') truncated = true;
      continue;
    }
    lines.push(line);
  }
  close(null, null);

  return { iterations: iterations.map(trimSection), truncated };
}

/** One trailing newline, whatever the file had: a section is whole lines. */
function trimSection(iteration: BuildLogIteration): BuildLogIteration {
  const text = iteration.text.replace(/^\n+/, '').replace(/\n+$/, '');
  return { ...iteration, text: text === '' ? '' : `${text}\n` };
}

export function createBuildLogStore(config: Config, db: Database): BuildLogStore {
  return new BuildLogStore(config, db);
}
