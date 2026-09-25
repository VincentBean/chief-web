/**
 * Turning a session agent's `claude --output-format stream-json` into
 * `SessionAgentEvent`s (docs/voice-plan.md §10.3).
 *
 * Checked against the recordings in `__fixtures__/` (Claude Code 2.1.280, see
 * the README there). The docs/voice-plan.md §10 assumptions hold: `-p --input-format
 * stream-json` keeps reading stdin across turns on one process, the user
 * message and `control_request` interrupt shapes are accepted as written
 * (`process.ts`), and partial text arrives in the `stream_event` envelope. So
 * there is no per-turn `--resume` fallback. What the plan did not say, and
 * what this parser handles:
 *
 * - **Deltas carry no message id.** `content_block_delta` has only `index` and
 *   `delta`; the id is on the `message_start` before it. The parser remembers
 *   the current message id from `message_start`, and that id is what the
 *   complete `assistant` line is deduplicated against.
 * - **`assistant` comes once per content block**, not once per message: a
 *   thinking block, a text block and each `tool_use` are separate lines with
 *   the same `message.id`, each sent just before its `content_block_stop`. So
 *   dedupe skips only the *text blocks* of a streamed message; a `tool_use`
 *   under the same id is still a `tool`.
 * - **`system/init` repeats at the start of every turn** on the same process,
 *   with the same `session_id`. Every one becomes an `init`; persisting it
 *   must be idempotent.
 * - **Lines are not nested by turn structure.** A `user` tool_result line can
 *   arrive between the `input_json_delta`s of the next `tool_use` block.
 * - **An interrupt** is answered with a `control_response` (same
 *   `request_id`), then the partial `assistant` text, a `user` line whose
 *   content is a *text* block `[Request interrupted by user]` (not a
 *   tool_result), and a `result` with `subtype: 'error_during_execution'`,
 *   `is_error: true` and `terminal_reason: 'aborted_streaming'`. No deltas
 *   follow the `control_response`.
 * - Other lines (`system/status`, `system/thinking_tokens`,
 *   `rate_limit_event`, `control_response`, thinking and `input_json_delta`
 *   deltas, `message_start/stop`) are `unknown`, for a debug log only.
 */
import { LineBuffer } from '../../build/stream.js';

export type SessionAgentEvent =
  /** The process's Claude session; persist to `voice_session_agents`. */
  | { type: 'init'; claudeSessionId: string; model: string | null }
  /** Text to speak and to show; each character arrives exactly once. */
  | { type: 'delta'; text: string }
  /** A tool call with its complete input, for a tool card. */
  | { type: 'tool'; toolUseId: string | null; name: string; input: unknown }
  | { type: 'toolResult'; toolUseId: string | null; ok: boolean }
  /**
   * The turn is over (`result`). `ok` is a clean finish; `interrupted` is the
   * end of a turn stopped by an interrupt request (or any other abort).
   */
  | {
      type: 'turnEnd';
      ok: boolean;
      interrupted: boolean;
      subtype: string;
      durationMs: number;
      costUsd?: number;
    }
  /** Anything else: `kind` is `type` or `type/subtype`, `not_json` for other output. */
  | { type: 'unknown'; kind: string };

/** Separates two text blocks of one turn, so the chunker sees a paragraph break. */
const BLOCK_SEPARATOR = '\n\n';

export class SessionAgentEventParser {
  private readonly lines = new LineBuffer();
  /** The message whose `stream_event`s are arriving now (from `message_start`). */
  private currentMessageId: string | null = null;
  /** Messages whose text was already emitted as deltas this turn. */
  private readonly streamed = new Set<string>();
  /** Whether a text block is open in the stream (its first delta not yet seen). */
  private blockStarting = false;
  private textThisTurn = false;

  /** Every event of the lines `chunk` completed. */
  push(chunk: string): SessionAgentEvent[] {
    return this.lines.push(chunk).flatMap((line) => this.line(line));
  }

  /** The events of a last line the stream ended without a newline. */
  flush(): SessionAgentEvent[] {
    const rest = this.lines.flush();
    return rest === null ? [] : this.line(rest);
  }

  /** The events of one complete stdout line. */
  line(line: string): SessionAgentEvent[] {
    const trimmed = line.trim();
    if (trimmed === '') return [];
    const event = asRecord(parseJson(trimmed));
    if (event === null) return [{ type: 'unknown', kind: 'not_json' }];

    // A Task subagent's own output carries the id of the tool call that
    // started it; only the agent's answer is spoken, never its subagents'.
    if (event['parent_tool_use_id'] != null) return [unknown(event)];

    switch (event['type']) {
      case 'system':
        return this.system(event);
      case 'stream_event':
        return this.streamEvent(event);
      case 'assistant':
        return this.assistant(event);
      case 'user':
        return this.user(event);
      case 'result':
        return this.result(event);
      default:
        return [unknown(event)];
    }
  }

  private system(event: Record<string, unknown>): SessionAgentEvent[] {
    const sessionId = asString(event['session_id']);
    if (event['subtype'] !== 'init' || sessionId === null) return [unknown(event)];
    return [{ type: 'init', claudeSessionId: sessionId, model: asString(event['model']) }];
  }

  private streamEvent(envelope: Record<string, unknown>): SessionAgentEvent[] {
    const event = asRecord(envelope['event']);
    switch (event?.['type']) {
      case 'message_start':
        this.currentMessageId = asString(asRecord(event['message'])?.['id']);
        return [unknown(envelope)];
      case 'content_block_start':
        if (asRecord(event['content_block'])?.['type'] === 'text') this.blockStarting = true;
        return [unknown(envelope)];
      case 'content_block_delta': {
        const delta = asRecord(event['delta']);
        const text = asString(delta?.['text']);
        if (delta?.['type'] !== 'text_delta' || text === null || text === '') return [unknown(envelope)];
        if (this.currentMessageId !== null) this.streamed.add(this.currentMessageId);
        const separated = this.blockStarting && this.textThisTurn ? `${BLOCK_SEPARATOR}${text}` : text;
        this.blockStarting = false;
        this.textThisTurn = true;
        return [{ type: 'delta', text: separated }];
      }
      default:
        return [unknown(envelope)];
    }
  }

  private assistant(event: Record<string, unknown>): SessionAgentEvent[] {
    const message = asRecord(event['message']);
    const id = asString(message?.['id']);
    const alreadyStreamed = id !== null && this.streamed.has(id);
    const out: SessionAgentEvent[] = [];
    for (const block of contentOf(message)) {
      if (block['type'] === 'text') {
        // Without --include-partial-messages this is the only copy of the text.
        const text = asString(block['text']) ?? '';
        if (alreadyStreamed || text === '') continue;
        out.push({ type: 'delta', text: this.textThisTurn ? `${BLOCK_SEPARATOR}${text}` : text });
        this.textThisTurn = true;
      } else if (block['type'] === 'tool_use') {
        out.push({
          type: 'tool',
          toolUseId: asString(block['id']),
          name: asString(block['name']) ?? 'tool',
          input: block['input'] ?? {},
        });
      }
      // Thinking blocks are never spoken.
    }
    return out.length === 0 ? [unknown(event)] : out;
  }

  private user(event: Record<string, unknown>): SessionAgentEvent[] {
    const out: SessionAgentEvent[] = [];
    for (const block of contentOf(asRecord(event['message']))) {
      if (block['type'] !== 'tool_result') continue;
      out.push({ type: 'toolResult', toolUseId: asString(block['tool_use_id']), ok: block['is_error'] !== true });
    }
    // `[Request interrupted by user]` after an interrupt is a text block.
    return out.length === 0 ? [unknown(event)] : out;
  }

  private result(event: Record<string, unknown>): SessionAgentEvent[] {
    this.streamed.clear();
    this.currentMessageId = null;
    this.blockStarting = false;
    this.textThisTurn = false;

    const subtype = asString(event['subtype']) ?? 'result';
    const cost = asNumber(event['total_cost_usd']);
    return [
      {
        type: 'turnEnd',
        ok: subtype === 'success' && event['is_error'] !== true,
        interrupted: event['terminal_reason'] === 'aborted_streaming',
        subtype,
        durationMs: asNumber(event['duration_ms']) ?? 0,
        ...(cost === null ? {} : { costUsd: cost }),
      },
    ];
  }
}

function unknown(event: Record<string, unknown>): SessionAgentEvent {
  const type = asString(event['type']) ?? 'event';
  const inner = asString(asRecord(event['event'])?.['type']) ?? asString(event['subtype']);
  return { type: 'unknown', kind: inner === null ? type : `${type}/${inner}` };
}

function contentOf(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== null);
}

function parseJson(text: string): unknown {
  if (!text.startsWith('{')) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
