import type { FakeDockerDaemon, FakeExec } from '../../../docker/fake-daemon.js';

export const CLAUDE_SESSION = 'claude-conv-1';

/** The login `#secret` puts in a tool call and its result (US-009). */
export const SECRET_LOGIN = { username: 'operator-ann@example.com', password: 'hunter2-s3cret!' } as const;

/** What `#long` opens with: past the chunker's 40-character minimum, so it is a segment by itself (the chunker waits for the word after it). */
export const LONG_OPENING = 'Heard you, and here is a longer thought about the export feature you asked for.';

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/**
 * A stream-json `claude` on the fake daemon: one scripted turn per user line,
 * shaped like the recorded fixtures. Markers in the message steer it:
 * `#crash` exits, `#read` uses a tool first, `#secret` uses one whose input
 * and result carry a login, `#long` opens with a sentence long enough to be
 * spoken on its own, `#hang` never ends the turn by itself
 * and `#deaf` also ignores the interrupt request (only a signal ends it).
 */
export class FakeClaude {
  /** Every stdin line per exec id, parsed. */
  readonly stdin = new Map<string, Record<string, unknown>[]>();
  private message = 0;

  constructor(private readonly daemon: FakeDockerDaemon) {
    daemon.onExec = (exec) => (exec.attachStdin && !exec.tty ? this.agent(exec) : this.signal(exec));
  }

  agentExecs(): FakeExec[] {
    return this.daemon.execs().filter((exec) => exec.attachStdin && !exec.tty);
  }

  userTexts(execId: string): string[] {
    return (this.stdin.get(execId) ?? [])
      .filter((entry) => entry['type'] === 'user')
      .map((entry) => ((entry['message'] as { content: { text: string }[] }).content[0] as { text: string }).text);
  }

  private agent(exec: FakeExec): { onLine: (text: string) => void } {
    const lines: Record<string, unknown>[] = [];
    let deaf = false;
    this.stdin.set(exec.id, lines);
    const emit = (value: unknown): void => this.daemon.emitFramed(exec.id, line(value));
    return {
      onLine: (text) => {
        const entry = JSON.parse(text) as Record<string, unknown>;
        lines.push(entry);
        if (entry['type'] === 'control_request') {
          if (deaf) return;
          emit({ type: 'control_response', response: { subtype: 'success', request_id: entry['request_id'] } });
          emit({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: 5, total_cost_usd: 0 });
          return;
        }
        const said = ((entry['message'] as { content: { text: string }[] }).content[0] as { text: string }).text;
        if (said.includes('#crash')) {
          this.daemon.finish(exec.id, 1);
          return;
        }
        const id = `msg_${String(++this.message)}`;
        emit({ type: 'system', subtype: 'init', session_id: CLAUDE_SESSION, model: 'claude-sonnet' });
        if (said.includes('#read')) {
          emit({ type: 'assistant', message: { id: `${id}t`, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/workspace/repo/server/src/auth/service.ts' } }] }, parent_tool_use_id: null });
          emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }, parent_tool_use_id: null });
        }
        if (said.includes('#secret')) {
          const { username, password } = SECRET_LOGIN;
          const input = { command: `curl -u ${username}:${password} http://localhost:3000/api/me`, username, password };
          emit({ type: 'assistant', message: { id: `${id}s`, content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input }] }, parent_tool_use_id: null });
          emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: `logged in as ${username} with ${password}` }] }, parent_tool_use_id: null });
        }
        emit({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null });
        emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null });
        emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: said.includes('#long') ? `${LONG_OPENING} And ` : 'Heard you. ' } }, parent_tool_use_id: null });
        deaf = said.includes('#deaf');
        if (said.includes('#hang') || deaf) return; // never ends the turn on its own
        emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'What next?' } }, parent_tool_use_id: null });
        emit({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, total_cost_usd: 0.01 });
      },
    };
  }

  /** `voiceSignalSpec`: the pid file names the session; the signal ends its agent. */
  private signal(exec: FakeExec): { stdout: string } {
    const command = exec.cmd.join(' ');
    const kill = /kill -([A-Z]+)/.exec(command);
    const pidFile = /\/tmp\/\.chief-voice\/[^ ;]+\.pid/.exec(command)?.[0];
    const target = this.agentExecs().find(
      (agent) => agent.running && agent.containerId === exec.containerId && pidFile !== undefined && agent.cmd.join(' ').includes(pidFile),
    );
    if (kill !== null && target !== undefined) {
      this.daemon.finish(target.id, kill[1] === 'INT' ? 130 : 143);
      return { stdout: 'chief-signalled\n' };
    }
    return { stdout: '' };
  }
}
