/**
 * What chief-web writes to a session agent's stdin (plan §10.2, §10.5).
 *
 * The session agent is `claude -p --input-format stream-json`: every line on
 * its stdin is one JSON message. These builders are the only place the shapes
 * are spelled out, and `__fixtures__/record.ts` writes exactly their output to
 * the real CLI, so the recordings next to it prove the CLI accepts them.
 *
 * The recordings confirm plan §10's framing on Claude Code 2.1.280: one
 * process reads user messages from stdin turn after turn, and the interrupt
 * stops the current turn without ending the process. So one long-lived process
 * per session is the design; the fallback of one `-p` process per turn with
 * `--resume` (`VOICE_SESSION_AGENT_MODE=per-turn`) is not needed and not
 * built. See `events.ts` for the output details the plan left out.
 */
import { pidFileSignalSpec, wrapWithPidFile } from '../../build/agent.js';
import type { AttachedExec, ExecOutput, ExecSpec } from '../../docker/index.js';
import { logger } from '../../lib/logger.js';
import { CONTAINER_REPO_DIR } from '../../sessions/index.js';
import { type SessionAgentEvent, SessionAgentEventParser } from './events.js';

/** One user turn: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}`. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

/**
 * Stops the turn in progress: `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}`.
 *
 * The CLI answers with a `control_response` carrying the same `request_id`,
 * then ends the turn with a `result` line.
 */
export function interruptRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt' },
  })}\n`;
}

/* ------------------------------------------------------------- the process */

/** Directory inside the session container holding the voice agents' pid files. */
export const VOICE_PID_DIR = '/tmp/.chief-voice';

/** The container's unprivileged user, the one build agents and terminals run as. */
export const SESSION_AGENT_USER = '1000';

/** How long the TERM through the pid file may take. */
const SIGNAL_TIMEOUT_MS = 10_000;
/** How long {@link SessionAgentProcess.stop} waits for the exit before dropping the connection. */
const STOP_GRACE_MS = 5_000;

/** One pid file per session: a session has at most one voice agent. */
export function voicePidFile(sessionId: string): string {
  return `${VOICE_PID_DIR}/${sessionId}.pid`;
}

export interface SessionAgentCommandOptions {
  /** `voice_session_model`; no flag at all when `null`, exactly like `planningCommand`. */
  readonly model: string | null;
  /** The Claude session to continue, from `voice_session_agents`. */
  readonly resumeId: string | null;
  /** Appendix A.2 part 1, the voice rules. */
  readonly systemPrompt: string;
}

/** `claude` with the flags of plan §10.1. */
export function sessionAgentCommand(options: SessionAgentCommandOptions): string[] {
  return [
    'claude',
    ...(options.model == null ? [] : ['--model', options.model]),
    '--dangerously-skip-permissions',
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    ...(options.resumeId === null ? [] : ['--resume', options.resumeId]),
    '--append-system-prompt',
    options.systemPrompt,
  ];
}

/** The session agent, as uid 1000 in the clone, under the build agents' pid-file wrapper. */
export function sessionAgentExecSpec(sessionId: string, options: SessionAgentCommandOptions): ExecSpec {
  return {
    cmd: wrapWithPidFile(VOICE_PID_DIR, voicePidFile(sessionId), 'chief-voice', sessionAgentCommand(options)),
    workingDir: CONTAINER_REPO_DIR,
    user: SESSION_AGENT_USER,
  };
}

/** Signals the session's voice agent through its pid file (`agentSignalSpec`'s sweep). */
export function voiceSignalSpec(sessionId: string, signal: string): ExecSpec {
  return pidFileSignalSpec(voicePidFile(sessionId), signal, { remove: true });
}

/** The slice of `DockerApi` a session agent needs; the fake daemon's client in tests. */
export interface SessionAgentDocker {
  attachExec(container: string, spec: ExecSpec): Promise<AttachedExec>;
  runExec(container: string, spec: ExecSpec, timeoutMs?: number): Promise<ExecOutput>;
}

export interface StartSessionAgentInput {
  readonly sessionId: string;
  readonly containerId: string;
  readonly command: SessionAgentCommandOptions;
  /** Told about every `init`, so the conversation id can be persisted. */
  readonly onInit?: (claudeSessionId: string) => void;
  readonly now?: () => number;
}

/**
 * One running `claude` for one session: stdin lines in, parsed
 * {@link SessionAgentEvent}s out, in order, through {@link next}. It lives
 * across turns and calls; the registry decides when it goes.
 */
export class SessionAgentProcess {
  /** True once the planning prompt is in the conversation (sent, or resumed). */
  opened: boolean;
  /** When the call last used it, for the registry's least-recently-used order. */
  lastUsedAt: number;
  private stopRequested = false;
  private exitedFlag = false;
  private readonly queue: SessionAgentEvent[] = [];
  private wake: (() => void) | null = null;
  /** Resolves when the output has ended: the process exited or the connection went. */
  readonly finished: Promise<void>;

  private constructor(
    private readonly docker: SessionAgentDocker,
    readonly sessionId: string,
    readonly containerId: string,
    private readonly attached: AttachedExec,
    input: StartSessionAgentInput,
  ) {
    this.opened = input.command.resumeId !== null;
    this.lastUsedAt = input.now?.() ?? Date.now();
    this.finished = this.read(input.onInit);
  }

  static async start(docker: SessionAgentDocker, input: StartSessionAgentInput): Promise<SessionAgentProcess> {
    const attached = await docker.attachExec(input.containerId, sessionAgentExecSpec(input.sessionId, input.command));
    return new SessionAgentProcess(docker, input.sessionId, input.containerId, attached, input);
  }

  get execId(): string {
    return this.attached.execId;
  }

  get exited(): boolean {
    return this.exitedFlag;
  }

  /** Gone without anyone asking it to go. */
  get crashed(): boolean {
    return this.exitedFlag && !this.stopRequested;
  }

  /** Writes one stdin line (from the builders above); a no-op once the process is gone. */
  write(line: string): void {
    if (!this.exitedFlag) this.attached.stdin.write(line);
  }

  /** Drops events nobody is waiting for, e.g. the tail of a turn no one listened to. */
  discardPending(): void {
    this.queue.length = 0;
  }

  /** The next event; `null` once the process is gone and everything was read, or when `signal` aborts. */
  async next(signal?: AbortSignal): Promise<SessionAgentEvent | null> {
    for (;;) {
      const event = this.queue.shift();
      if (event !== undefined) return event;
      if (this.exitedFlag || signal?.aborted === true) return null;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          signal?.removeEventListener('abort', done);
          this.wake = null;
          resolve();
        };
        this.wake = done;
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }

  /**
   * Ends it on purpose: `signal` (TERM by default) to the pid in the pid file,
   * then stdin closed, and the connection dropped if it has still not exited
   * after a grace period. Not a crash.
   */
  async stop(signal = 'TERM'): Promise<void> {
    this.stopRequested = true;
    if (this.exitedFlag) return;
    try {
      await this.docker.runExec(this.containerId, voiceSignalSpec(this.sessionId, signal), SIGNAL_TIMEOUT_MS);
    } catch (cause) {
      logger.warn('could not signal the session voice agent', { session: this.sessionId, error: String(cause) });
    }
    this.attached.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), STOP_GRACE_MS);
      timer.unref();
    });
    const outcome = await Promise.race([this.finished.then(() => 'exited' as const), grace]);
    clearTimeout(timer);
    if (outcome === 'late') this.attached.stdin.destroy();
    await this.finished;
  }

  private async read(onInit: ((claudeSessionId: string) => void) | undefined): Promise<void> {
    const parser = new SessionAgentEventParser();
    const deliver = (events: readonly SessionAgentEvent[]): void => {
      for (const event of events) {
        if (event.type === 'init') onInit?.(event.claudeSessionId);
        if (event.type === 'unknown') continue;
        this.queue.push(event);
      }
      if (events.length > 0) this.wake?.();
    };
    try {
      for await (const chunk of this.attached.output) {
        if (chunk.stream === 'stdout') deliver(parser.push(chunk.text));
        else logger.debug('session voice agent stderr', { session: this.sessionId, text: chunk.text.slice(0, 500) });
      }
      deliver(parser.flush());
    } catch (cause) {
      logger.warn('session voice agent output failed', { session: this.sessionId, error: String(cause) });
    } finally {
      this.exitedFlag = true;
      this.wake?.();
      if (!this.stopRequested) logger.warn('session voice agent exited', { session: this.sessionId, exec: this.execId });
    }
  }
}
