import { logger } from '../lib/logger.js';
import { listRequestFiles, REQUEST_DISCOVERY_MS, REQUEST_POLL_MS, type RequestFileDocker, writeAnswerFile } from './request-files.js';

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

/** The answer file, as `runner/chief-mcp.js` reads it. */
export type BuildAnswer =
  | { readonly started: true; readonly queued: boolean }
  | { readonly started: false; readonly errors: readonly string[] }
  | { readonly started: false; readonly reason: string };

/** What the relay needs of the session's container. */
export interface BuildRequestDeps {
  readonly docker: RequestFileDocker;
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
        const fresh = (await listRequestFiles(this.deps.docker, containerId, BUILD_REQUEST_DIR, 'build')).filter((request) => !this.seen.has(request.id));
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

  /** Writes the answer file through stdin; false when that failed. */
  private write(sessionId: string, containerId: string, id: string, answer: BuildAnswer): Promise<boolean> {
    return writeAnswerFile(this.deps.docker, containerId, BUILD_REQUEST_DIR, id, { id, ...answer }, { what: 'build', session: sessionId });
  }
}
