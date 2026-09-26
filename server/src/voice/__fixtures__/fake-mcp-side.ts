import type { FakeDockerDaemon, FakeExec } from '../../docker/fake-daemon.js';
import { BROWSER_REQUEST_DIR } from '../browser-ask.js';

/** The request id {@link FakeMcpSide.request} writes unless told otherwise. */
export const FAKE_REQUEST_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0123456789ab';

/**
 * The container's side of the "watch with me" relay (voice feedback US-007):
 * the request files the chief MCP server would have written, and every answer
 * file written through stdin. Chains the daemon's previous exec handler.
 */
export class FakeMcpSide {
  /** Request files per container. */
  readonly requests = new Map<string, { id: string; hint: string; createdAt: string }[]>();
  /** Answer files as written: container, exec, raw content. */
  readonly answers: { containerId: string; exec: FakeExec; content: string }[] = [];
  failWrites = false;
  /** Called once an answer file is written, as the MCP server would read it. */
  onAnswer: ((containerId: string, answer: Record<string, unknown>) => void) | null = null;

  constructor(
    daemon: FakeDockerDaemon,
    private readonly now: () => number,
  ) {
    const previous = daemon.onExec;
    daemon.onExec = (exec) => {
      const command = exec.cmd.join(' ');
      if (command.includes(`${BROWSER_REQUEST_DIR}/*.request`)) {
        const lines = (this.requests.get(exec.containerId) ?? []).map((request) => `${JSON.stringify(request)}\n`);
        return { stdout: lines.join('') };
      }
      if (command.includes('.answer.tmp') && exec.attachStdin) {
        let content = '';
        return {
          onLine: (line) => {
            content += line;
          },
          onStdinEnd: () => {
            this.answers.push({ containerId: exec.containerId, exec, content });
            daemon.finish(exec.id, this.failWrites ? 1 : 0);
            if (!this.failWrites) this.onAnswer?.(exec.containerId, JSON.parse(content) as Record<string, unknown>);
          },
        };
      }
      return previous?.(exec) ?? {};
    };
  }

  request(containerId: string, id = FAKE_REQUEST_ID, hint = 'the checkout page', createdAt = new Date(this.now()).toISOString()): void {
    const list = this.requests.get(containerId) ?? [];
    list.push({ id, hint, createdAt });
    this.requests.set(containerId, list);
  }

  answersFor(containerId: string): Record<string, unknown>[] {
    return this.answers.filter((a) => a.containerId === containerId).map((a) => JSON.parse(a.content) as Record<string, unknown>);
  }
}
