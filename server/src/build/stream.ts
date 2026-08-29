/**
 * Turning `claude --output-format stream-json` into a readable log (US-016).
 *
 * A headless `claude -p` in its default text format prints nothing until it is
 * finished, which for a build iteration is up to an hour — so there is nothing
 * to stream. `--output-format stream-json --verbose` emits one JSON object per
 * line as the run happens (chief passes the same flags), and this is the thing
 * that turns those objects back into the lines an operator wants to read.
 *
 * Two rules shape it:
 *
 * - **A line that is not a known event is passed through verbatim.** Anything
 *   `claude` writes to stderr, a crash, a warning from the runner image — the
 *   log is the only place they can appear, and swallowing them would make a
 *   failing iteration look silent.
 * - **Nothing is buffered until the end.** `push()` renders every *complete*
 *   line it has and keeps the partial one for the next chunk.
 */

/** How much of a tool call's input is shown on its line. */
export const MAX_TOOL_INPUT_CHARS = 200;

/** How much of a tool's result is echoed under it. */
export const MAX_TOOL_RESULT_CHARS = 400;
const MAX_TOOL_RESULT_LINES = 3;

export class AgentOutputFormatter {
  /** The tail of the last chunk, up to the first newline of the next one. */
  private partial = '';

  /** Renders every complete line in `chunk`; `''` when it completed none. */
  push(chunk: string): string {
    const text = this.partial + chunk;
    const lines = text.split('\n');
    // The last element is whatever came after the final newline — possibly a
    // half-received JSON object, which must not be parsed yet.
    this.partial = lines.pop() ?? '';
    return lines.map((line) => renderLine(line)).join('');
  }

  /** Renders the last line when the stream ends without a newline. */
  flush(): string {
    const rest = this.partial;
    this.partial = '';
    return rest === '' ? '' : renderLine(rest);
  }
}

/** One line of the agent's stdout as the log should show it, newline included. */
export function renderLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed === '') return '';

  const event = asRecord(parseJson(trimmed));
  if (event === null) return `${line}\n`;

  switch (event['type']) {
    case 'system':
      return renderSystem(event);
    case 'assistant':
      return renderAssistant(event);
    case 'user':
      return renderUser(event);
    case 'result':
      return renderResult(event);
    default:
      // A known envelope of an unknown kind: a newer Claude Code emitting an
      // event this parser has never seen is not worth a wall of raw JSON.
      return '';
  }
}

function renderSystem(event: Record<string, unknown>): string {
  if (event['subtype'] !== 'init') return '';
  const model = asString(event['model']) ?? 'unknown model';
  const cwd = asString(event['cwd']);
  return `[claude] started with ${model}${cwd === null ? '' : ` in ${cwd}`}\n`;
}

function renderAssistant(event: Record<string, unknown>): string {
  let out = '';
  for (const part of contentOf(event)) {
    if (part['type'] === 'text') {
      const text = (asString(part['text']) ?? '').trim();
      if (text !== '') out += `${text}\n`;
    } else if (part['type'] === 'tool_use') {
      out += `[tool] ${asString(part['name']) ?? 'tool'}${toolArguments(part['input'])}\n`;
    }
    // `thinking` blocks are deliberately dropped: they are long, and the log is
    // there to show what the agent *did*.
  }
  return out;
}

function renderUser(event: Record<string, unknown>): string {
  let out = '';
  for (const part of contentOf(event)) {
    if (part['type'] !== 'tool_result') continue;
    const failed = part['is_error'] === true;
    const body = abbreviate(toolResultText(part['content']));
    out += body === '' ? `[${failed ? 'failed' : 'ok'}]\n` : `[${failed ? 'failed' : 'ok'}] ${body}\n`;
  }
  return out;
}

function renderResult(event: Record<string, unknown>): string {
  const subtype = asString(event['subtype']) ?? 'result';
  const seconds = asNumber(event['duration_ms']);
  const turns = asNumber(event['num_turns']);
  const cost = asNumber(event['total_cost_usd']);
  const parts = [
    seconds === null ? null : `${(seconds / 1000).toFixed(1)}s`,
    turns === null ? null : `${String(turns)} turns`,
    cost === null ? null : `$${cost.toFixed(4)}`,
  ].filter((part): part is string => part !== null);

  const failed = event['is_error'] === true || subtype !== 'success';
  const summary = `[claude] ${failed ? `ended: ${subtype}` : 'finished'}${
    parts.length === 0 ? '' : ` (${parts.join(', ')})`
  }\n`;
  // The final assistant message is already in the log; only repeat it when the
  // run ended badly, where it is the reason.
  const detail = failed ? abbreviate(asString(event['result']) ?? '') : '';
  return detail === '' ? summary : `${summary}${detail}\n`;
}

/** `{ command: 'npm test' }` → ` npm test`; anything else, compact JSON. */
function toolArguments(input: unknown): string {
  const record = asRecord(input);
  if (record === null) return '';
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'prompt', 'description']) {
    const value = asString(record[key]);
    if (value !== null && value !== '') return `: ${clip(collapse(value), MAX_TOOL_INPUT_CHARS)}`;
  }
  const keys = Object.keys(record);
  return keys.length === 0 ? '' : `: ${clip(collapse(JSON.stringify(record)), MAX_TOOL_INPUT_CHARS)}`;
}

/** A tool result is either a string or the content blocks of one. */
function toolResultText(content: unknown): string {
  const direct = asString(content);
  if (direct !== null) return direct;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => asString(asRecord(part)?.['text']) ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

/** The first few lines of a long block, so one tool cannot flood the log. */
function abbreviate(text: string): string {
  const lines = text.trim().split('\n');
  const kept = lines.slice(0, MAX_TOOL_RESULT_LINES).join('\n');
  const clipped = clip(kept, MAX_TOOL_RESULT_CHARS);
  return lines.length > MAX_TOOL_RESULT_LINES && clipped === kept ? `${clipped}\n…` : clipped;
}

function contentOf(event: Record<string, unknown>): Record<string, unknown>[] {
  const content = asRecord(event['message'])?.['content'];
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== null);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
