import type { AttachedExec, ExecOutput, ExecSpec, ExecState } from '../docker/index.js';
import { logger } from '../lib/logger.js';
import { BROWSER_ASK_USER, REQUEST_DISCOVERY_MS, REQUEST_POLL_MS } from './browser-ask.js';

/**
 * The server's half of the `chief` MCP server's `start_build` tool (US-008,
 * `runner/chief-mcp.js`), the same round trip as the "watch with me" card.
 *
 * The tool writes `<BUILD_REQUEST_DIR>/<id>.request` in the session container
 * and waits for `<id>.answer`. When the session agent's stream shows the tool
 * call, the call finds the request, marks the session ready and starts its
 * build, and writes the outcome into the answer file.
 */

/** Where the MCP server and the call meet inside the container: the browser directory's sibling. */
export const BUILD_REQUEST_DIR = '/tmp/.chief-voice/build';
const EXEC_TIMEOUT_MS = 10_000;

/** What the MCP server writes; the id names both files. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The answer file, as `runner/chief-mcp.js` reads it. */
export type BuildAnswer =
  | { readonly started: true; readonly queued: boolean }
  | { readonly started: false; readonly errors: readonly string[] }
  | { readonly started: false; readonly reason: string };

/** Lists every pending request file, one JSON object per line. */
export function listBuildRequestsSpec(): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', `for f in ${BUILD_REQUEST_DIR}/*.request; do [ -f "$f" ] && cat "$f" && echo; done; true`],
    user: BROWSER_ASK_USER,
    tty: false,
    attachStdin: false,
  };
}

/** Writes stdin to `<id>.answer`, renamed into place so the MCP server never reads half a file. */
export function buildAnswerWriteSpec(id: string): ExecSpec {
  if (!REQUEST_ID.test(id)) throw new Error(`not a request id: ${id}`);
  const file = `${BUILD_REQUEST_DIR}/${id}.answer`;
  return {
    cmd: ['/bin/sh', '-c', `umask 077 && mkdir -p ${BUILD_REQUEST_DIR} && cat > ${file}.tmp && mv ${file}.tmp ${file}`],
    user: BROWSER_ASK_USER,
    tty: false,
    attachStdin: true,
  };
}

/** What the relay needs of the session's container. */
export interface BuildRequestDeps {
  readonly docker: {
    runExec(container: string, spec: ExecSpec, timeoutMs?: number): Promise<ExecOutput>;
    attachExec(container: string, spec: ExecSpec): Promise<AttachedExec>;
    inspectExec(execId: string): Promise<ExecState>;
  };
  /** The session's running container id. */
  readonly container: (sessionId: string) => Promise<string>;
  readonly discoveryMs?: number;
  readonly pollMs?: number;
}

/** One found request: answer it with {@link BuildRequest.answer}. */
export interface BuildRequest {
  readonly id: string;
  answer(answer: BuildAnswer): Promise<boolean>;
}

/** One call's `start_build` requests. */
export class BuildRequests {
  /** Request ids this call already handled, so a stale file is never answered twice. */
  private readonly seen = new Set<string>();
  /** Sessions whose request is being looked for or answered. */
  private readonly busy = new Set<string>();

  constructor(private readonly deps: BuildRequestDeps) {}

  /**
   * The newest request of `sessionId`'s container this call has not handled,
   * or null when none appeared in time or one is already being handled.
   */
  async find(sessionId: string, stopped: () => boolean): Promise<BuildRequest | null> {
    if (this.busy.has(sessionId)) return null;
    this.busy.add(sessionId);
    try {
      const containerId = await this.deps.container(sessionId);
      const deadline = Date.now() + (this.deps.discoveryMs ?? REQUEST_DISCOVERY_MS);
      for (;;) {
        if (stopped()) return null;
        const fresh = (await this.list(containerId)).filter((request) => !this.seen.has(request.id));
        const newest = fresh.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (newest !== undefined) {
          this.seen.add(newest.id);
          return { id: newest.id, answer: (answer) => this.write(sessionId, containerId, newest.id, answer) };
        }
        if (Date.now() >= deadline) {
          logger.warn('no build request file appeared', { session: sessionId });
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? REQUEST_POLL_MS));
      }
    } catch (cause) {
      logger.warn('could not find the build request', { session: sessionId, error: String(cause) });
      return null;
    } finally {
      this.busy.delete(sessionId);
    }
  }

  private async list(containerId: string): Promise<{ id: string; createdAt: string }[]> {
    let output: ExecOutput;
    try {
      output = await this.deps.docker.runExec(containerId, listBuildRequestsSpec(), EXEC_TIMEOUT_MS);
    } catch (cause) {
      logger.warn('could not list build requests', { container: containerId, error: String(cause) });
      return [];
    }
    const requests: { id: string; createdAt: string }[] = [];
    for (const line of output.stdout.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const { id, createdAt } = JSON.parse(line) as Record<string, unknown>;
        if (typeof id !== 'string' || !REQUEST_ID.test(id)) continue;
        requests.push({ id, createdAt: typeof createdAt === 'string' ? createdAt : '' });
      } catch {
        // Renamed into place by the MCP server, so this is junk; skip it.
      }
    }
    return requests;
  }

  /** Writes the answer file through stdin; false when that failed. */
  private async write(sessionId: string, containerId: string, id: string, answer: BuildAnswer): Promise<boolean> {
    try {
      const exec = await this.deps.docker.attachExec(containerId, buildAnswerWriteSpec(id));
      exec.stdin.end(JSON.stringify({ id, ...answer }));
      let stderr = '';
      for await (const chunk of exec.output) if (chunk.stream === 'stderr') stderr += chunk.text;
      const state = await this.deps.docker.inspectExec(exec.execId);
      if (state.exitCode === 0) return true;
      logger.warn('could not write the build answer', { session: sessionId, exitCode: state.exitCode, stderr: stderr.trim().slice(0, 200) });
      return false;
    } catch (cause) {
      logger.warn('could not write the build answer', { session: sessionId, error: String(cause) });
      return false;
    }
  }
}
