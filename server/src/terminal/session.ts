import type { Duplex } from 'node:stream';

import type { DockerApi, TerminalSize } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import { terminalCleanupCommand, terminalSignalCommand } from './command.js';
import { ScrollbackBuffer } from './scrollback.js';

export type TerminalStatus = 'running' | 'exited';

/** How long a hung-up process is given to leave before it is killed outright. */
const HANGUP_GRACE_MS = 500;
const HANGUP_POLL_MS = 50;

/** What the API and the WebSocket report about a terminal. */
export interface TerminalView {
  readonly id: string;
  /** Container id or name the exec runs in, as the caller supplied it. */
  readonly container: string;
  readonly containerName: string;
  readonly command: readonly string[];
  readonly status: TerminalStatus;
  /** `null` while running, or when Docker never reported one. */
  readonly exitCode: number | null;
  readonly cols: number;
  readonly rows: number;
  /** Number of browser tabs currently attached; 0 is normal and harmless. */
  readonly clients: number;
  /** How much replayable output is held server-side. */
  readonly scrollbackBytes: number;
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

/** A single attached browser tab. */
export interface TerminalListener {
  onData(chunk: Buffer): void;
  onExit(exitCode: number | null): void;
}

export interface TerminalSessionInit {
  readonly id: string;
  readonly execId: string;
  readonly container: string;
  readonly containerName: string;
  readonly command: readonly string[];
  readonly size: TerminalSize;
  readonly stream: Duplex;
  readonly createdAt: string;
  readonly scrollbackLines: number;
  readonly scrollbackBytes: number;
}

/**
 * One PTY inside a container, owned by the server rather than by a browser tab.
 *
 * This is what makes the terminal survive a page refresh: the hijacked exec
 * stream and the scrollback live here for as long as the process does, and
 * attaching or detaching a WebSocket only adds or removes a listener. Closing
 * the last tab therefore does nothing to the process.
 */
export class TerminalSession {
  readonly id: string;
  readonly container: string;
  readonly containerName: string;
  readonly command: readonly string[];
  readonly execId: string;
  readonly createdAt: string;

  private readonly stream: Duplex;
  private readonly scrollback: ScrollbackBuffer;
  private readonly listeners = new Set<TerminalListener>();
  private size: TerminalSize;
  private status: TerminalStatus = 'running';
  private exitCode: number | null = null;
  private lastActivityAt: string;

  constructor(
    init: TerminalSessionInit,
    private readonly docker: DockerApi,
  ) {
    this.id = init.id;
    this.execId = init.execId;
    this.container = init.container;
    this.containerName = init.containerName;
    this.command = init.command;
    this.createdAt = init.createdAt;
    this.lastActivityAt = init.createdAt;
    this.size = init.size;
    this.stream = init.stream;
    this.scrollback = new ScrollbackBuffer(init.scrollbackLines, init.scrollbackBytes);

    this.stream.on('data', (chunk: Buffer) => this.onOutput(chunk));
    this.stream.on('end', () => void this.onClosed());
    this.stream.on('close', () => void this.onClosed());
    // A daemon restart tears the socket down; that is an exit, not a crash.
    this.stream.on('error', (error: Error) => {
      logger.warn('terminal stream error', { terminal: this.id, error: error.message });
      void this.onClosed();
    });
  }

  get isRunning(): boolean {
    return this.status === 'running';
  }

  toView(): TerminalView {
    return {
      id: this.id,
      container: this.container,
      containerName: this.containerName,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      cols: this.size.cols,
      rows: this.size.rows,
      clients: this.listeners.size,
      scrollbackBytes: this.scrollback.byteLength,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }

  /** Output retained for replay, oldest first. */
  replay(): Buffer {
    return this.scrollback.snapshot();
  }

  /**
   * Subscribes a tab. The returned function detaches it and is safe to call
   * more than once; detaching never touches the underlying process.
   */
  attach(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    if (!this.isRunning) listener.onExit(this.exitCode);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Forwards keystrokes to the PTY. Ignored once the process has exited. */
  write(data: Buffer): void {
    if (!this.isRunning || data.length === 0) return;
    this.lastActivityAt = new Date().toISOString();
    this.stream.write(data);
  }

  async resize(size: TerminalSize): Promise<void> {
    if (!this.isRunning) return;
    if (size.cols === this.size.cols && size.rows === this.size.rows) return;
    this.size = size;
    try {
      await this.docker.resizeExec(this.execId, size);
    } catch (error) {
      // Racing a process that just exited is the common case here; the next
      // resize (or none at all) is fine.
      logger.debug('terminal resize failed', { terminal: this.id, error: String(error) });
    }
  }

  /**
   * Ends the session. The Engine API has no "kill exec", so the pid reported by
   * `GET /exec/{id}/json` is signalled from a second exec in the same
   * container; closing the stream alone would leave the shell running.
   *
   * The signal is **SIGHUP**, not SIGTERM: an interactive shell ignores SIGTERM
   * by design, so a `kill -TERM` leaves a stray `bash -l` behind. SIGHUP is what
   * a real terminal hangup delivers and what a shell acts on. Anything still
   * alive after that is killed outright.
   */
  async kill(): Promise<void> {
    if (this.isRunning) {
      try {
        await this.run(terminalSignalCommand(this.id, 'HUP', false));
        await this.run(
          (await this.stillRunning())
            ? terminalSignalCommand(this.id, 'KILL', true)
            : terminalCleanupCommand(this.id),
        );
      } catch (error) {
        logger.warn('could not signal terminal process', {
          terminal: this.id,
          error: String(error),
        });
      }
    }
    this.stream.destroy();
    await this.onClosed();
  }

  /** Runs a short-lived command in the same container, discarding its output. */
  private async run(cmd: readonly string[]): Promise<void> {
    const execId = await this.docker.createExec(this.container, { cmd });
    const stream = await this.docker.startExec(execId);
    stream.on('error', () => undefined);
    stream.resume();
    stream.end();
  }

  /** Polls until the exec is gone, up to {@link HANGUP_GRACE_MS}. */
  private async stillRunning(): Promise<boolean> {
    for (let waited = 0; waited < HANGUP_GRACE_MS; waited += HANGUP_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, HANGUP_POLL_MS));
      try {
        if (!(await this.docker.inspectExec(this.execId)).running) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Drops every attached tab without touching the process (server shutdown). */
  detachAll(): void {
    this.listeners.clear();
  }

  private onOutput(chunk: Buffer): void {
    this.lastActivityAt = new Date().toISOString();
    this.scrollback.append(chunk);
    for (const listener of this.listeners) listener.onData(chunk);
  }

  private async onClosed(): Promise<void> {
    if (!this.isRunning) return;
    this.status = 'exited';
    try {
      this.exitCode = (await this.docker.inspectExec(this.execId)).exitCode;
    } catch {
      this.exitCode = null;
    }
    logger.info('terminal exited', { terminal: this.id, exitCode: this.exitCode });
    for (const listener of this.listeners) listener.onExit(this.exitCode);
  }
}
