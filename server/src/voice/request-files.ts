import type { AttachedExec, ExecOutput, ExecSpec, ExecState } from '../docker/index.js';
import { logger } from '../lib/logger.js';

/**
 * The file round trip every relay to the `chief` MCP server
 * (`runner/chief-mcp.js`) shares: the tool writes `<dir>/<id>.request` in the
 * session container and waits for `<id>.answer`, which the server writes.
 * The browser card and `start_build` differ only in their directory.
 */

/** uid of the session agent, and so of its MCP server. */
export const REQUEST_USER = '1000';
/** How long a relay looks for the request file after the tool call showed up on the stream. */
export const REQUEST_DISCOVERY_MS = 10_000;
export const REQUEST_POLL_MS = 250;
const EXEC_TIMEOUT_MS = 10_000;

/** What the MCP server writes; the id names both files. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The slice of `DockerApi` a relay uses. */
export interface RequestFileDocker {
  runExec(container: string, spec: ExecSpec, timeoutMs?: number): Promise<ExecOutput>;
  attachExec(container: string, spec: ExecSpec): Promise<AttachedExec>;
  inspectExec(execId: string): Promise<ExecState>;
}

/** One request file: its id and creation time, plus whatever else the tool wrote. */
export type RequestFile = Readonly<Record<string, unknown>> & { readonly id: string; readonly createdAt: string };

/** Lists every pending request file in `dir`, one JSON object per line. */
export function listRequestsSpec(dir: string): ExecSpec {
  return {
    cmd: ['/bin/sh', '-c', `for f in ${dir}/*.request; do [ -f "$f" ] && cat "$f" && echo; done; true`],
    user: REQUEST_USER,
    tty: false,
    attachStdin: false,
  };
}

/**
 * Writes stdin to `<dir>/<id>.answer`, owner-only, then renames it into place
 * so the MCP server never reads half a file. `id` must match {@link REQUEST_ID}.
 */
export function answerWriteSpec(dir: string, id: string): ExecSpec {
  if (!REQUEST_ID.test(id)) throw new Error(`not a request id: ${id}`);
  const file = `${dir}/${id}.answer`;
  return {
    cmd: ['/bin/sh', '-c', `umask 077 && mkdir -p ${dir} && cat > ${file}.tmp && mv ${file}.tmp ${file}`],
    user: REQUEST_USER,
    tty: false,
    attachStdin: true,
  };
}

/** The request files in `dir` with a valid id; none when listing failed. `what` names the relay in the log. */
export async function listRequestFiles(docker: RequestFileDocker, containerId: string, dir: string, what: string): Promise<RequestFile[]> {
  let output: ExecOutput;
  try {
    output = await docker.runExec(containerId, listRequestsSpec(dir), EXEC_TIMEOUT_MS);
  } catch (cause) {
    logger.warn(`could not list ${what} requests`, { container: containerId, error: String(cause) });
    return [];
  }
  const requests: RequestFile[] = [];
  for (const line of output.stdout.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const { id, createdAt } = parsed;
      if (typeof id !== 'string' || !REQUEST_ID.test(id)) continue;
      requests.push({ ...parsed, id, createdAt: typeof createdAt === 'string' ? createdAt : '' });
    } catch {
      // A file the MCP server is still writing is renamed into place, so this is junk; skip it.
    }
  }
  return requests;
}

/** Writes `answer` into `<dir>/<id>.answer` through stdin; false when that failed (logged without its content). */
export async function writeAnswerFile(
  docker: RequestFileDocker,
  containerId: string,
  dir: string,
  id: string,
  answer: unknown,
  log: { readonly what: string; readonly session: string },
): Promise<boolean> {
  try {
    const exec = await docker.attachExec(containerId, answerWriteSpec(dir, id));
    exec.stdin.end(JSON.stringify(answer));
    let stderr = '';
    for await (const chunk of exec.output) if (chunk.stream === 'stderr') stderr += chunk.text;
    const state = await docker.inspectExec(exec.execId);
    if (state.exitCode === 0) return true;
    logger.warn(`could not write the ${log.what} answer`, { session: log.session, exitCode: state.exitCode, stderr: stderr.trim().slice(0, 200) });
    return false;
  } catch (cause) {
    logger.warn(`could not write the ${log.what} answer`, { session: log.session, error: String(cause) });
    return false;
  }
}
