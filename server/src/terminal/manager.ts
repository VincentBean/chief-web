import { randomUUID } from 'node:crypto';

import type { Config } from '../config.js';
import { DockerApi, DockerApiError, type TerminalSize } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import { wrapTerminalCommand } from './command.js';
import { TerminalSession, type TerminalView } from './session.js';

/** A failure with an HTTP status the route can hand straight back. */
export class TerminalError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TerminalError';
  }
}

/**
 * Default program for a new terminal: a login shell, preferring bash (which the
 * runner image ships) and falling back to sh so any container works.
 */
export const DEFAULT_TERMINAL_COMMAND: readonly string[] = [
  '/bin/sh',
  '-c',
  'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi',
];

/** Enough for xterm.js to render before the browser reports its real size. */
export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };

/** How much of a terminal's argv is written to the log; see `describeCommand`. */
const MAX_LOGGED_COMMAND_CHARS = 200;

export const MIN_TERMINAL_DIMENSION = 1;
export const MAX_TERMINAL_DIMENSION = 1000;

export interface CreateTerminalInput {
  /** Container id or name to exec into. */
  readonly container: string;
  readonly command?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly size?: TerminalSize;
}

export interface TerminalManagerOptions {
  readonly scrollbackLines: number;
  readonly scrollbackBytes: number;
  readonly maxTerminals: number;
}

/**
 * Registry of live PTYs, keyed by an id the browser keeps in its URL.
 *
 * Terminals are deliberately *not* persisted to SQLite: an exec dies with the
 * daemon connection, so a row surviving a server restart would only ever point
 * at something that no longer exists.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TerminalSession>();

  constructor(
    private readonly docker: DockerApi,
    private readonly options: TerminalManagerOptions,
  ) {}

  list(): TerminalView[] {
    return [...this.terminals.values()]
      .map((terminal) => terminal.toView())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): TerminalSession | undefined {
    return this.terminals.get(id);
  }

  /** Running containers the operator can open a terminal in. */
  async listContainers(): Promise<
    { id: string; name: string; image: string; state: string; status: string }[]
  > {
    try {
      const containers = await this.docker.listContainers();
      return containers.map(({ id, name, image, state, status }) => ({
        id,
        name,
        image,
        state,
        status,
      }));
    } catch (error) {
      throw dockerFailure(error);
    }
  }

  async create(input: CreateTerminalInput): Promise<TerminalView> {
    const live = [...this.terminals.values()].filter((terminal) => terminal.isRunning).length;
    if (live >= this.options.maxTerminals) {
      throw new TerminalError(
        429,
        'too_many_terminals',
        `At most ${this.options.maxTerminals} terminals can be open at once. Close one first.`,
      );
    }

    const command = input.command ?? DEFAULT_TERMINAL_COMMAND;
    const size = input.size ?? DEFAULT_TERMINAL_SIZE;

    let containerName: string;
    try {
      const container = await this.docker.inspectContainer(input.container);
      if (!container.running) {
        throw new TerminalError(
          409,
          'container_not_running',
          `Container "${input.container}" is not running.`,
        );
      }
      containerName = container.name;
    } catch (error) {
      if (error instanceof TerminalError) throw error;
      if (error instanceof DockerApiError && error.status === 404) {
        throw new TerminalError(
          404,
          'container_not_found',
          `No container matches "${input.container}".`,
        );
      }
      throw dockerFailure(error);
    }

    // The id is minted before the exec so the wrapper can record its pid under
    // a name only this terminal uses.
    const id = randomUUID();

    try {
      const execId = await this.docker.createExec(input.container, {
        cmd: wrapTerminalCommand(id, command),
        // A terminal without TERM renders as a dumb one; xterm.js speaks
        // xterm-256color.
        env: ['TERM=xterm-256color', ...Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`)],
        ...(input.cwd === undefined ? {} : { workingDir: input.cwd }),
      });
      const stream = await this.docker.startExec(execId, size);

      const session = new TerminalSession(
        {
          id,
          execId,
          container: input.container,
          containerName,
          command,
          size,
          stream,
          createdAt: new Date().toISOString(),
          scrollbackLines: this.options.scrollbackLines,
          scrollbackBytes: this.options.scrollbackBytes,
        },
        this.docker,
      );
      this.terminals.set(session.id, session);
      logger.info('terminal opened', {
        terminal: session.id,
        container: containerName,
        command: describeCommand(command),
      });
      return session.toView();
    } catch (error) {
      throw dockerFailure(error);
    }
  }

  /** Kills the process and forgets the terminal. `false` when the id is unknown. */
  async remove(id: string): Promise<boolean> {
    const terminal = this.terminals.get(id);
    if (terminal === undefined) return false;
    this.terminals.delete(id);
    await terminal.kill();
    return true;
  }

  /**
   * Server shutdown: detach every tab but leave the processes alone. They die
   * with the hijacked connections, which the runtime closes for us.
   */
  closeAll(): void {
    for (const terminal of this.terminals.values()) terminal.detachAll();
    this.terminals.clear();
  }
}

export function createTerminalManager(config: Config): TerminalManager {
  return new TerminalManager(new DockerApi(config.dockerSocket), {
    scrollbackLines: config.terminalScrollbackLines,
    scrollbackBytes: config.terminalScrollbackBytes,
    maxTerminals: config.maxTerminals,
  });
}

/**
 * A log line, not the command itself: a planning terminal (US-011) carries a
 * multi-kilobyte prompt as its second argument, which would otherwise be
 * written out in full on every start.
 */
function describeCommand(command: readonly string[]): string {
  const joined = command.join(' ');
  return joined.length <= MAX_LOGGED_COMMAND_CHARS
    ? joined
    : `${joined.slice(0, MAX_LOGGED_COMMAND_CHARS)}… (${String(joined.length)} chars)`;
}

/** Docker being unreachable is an upstream problem, so 502 — never 401. */
function dockerFailure(error: unknown): TerminalError {
  if (error instanceof TerminalError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new TerminalError(502, 'docker_unavailable', `Docker rejected the request: ${detail}`);
}
