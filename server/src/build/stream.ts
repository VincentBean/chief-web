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
 * - **An envelope of an unknown kind is summarised, not dropped.** A newer
 *   Claude Code (or an experimental tool like the advisor) emits event kinds
 *   this parser has never seen; showing one clipped line is what keeps a
 *   consultation the operator paid for from vanishing out of the log.
 * - **Nothing is buffered until the end.** `push()` renders every *complete*
 *   line it has and keeps the partial one for the next chunk.
 */

/** How much of a tool call's input is shown on its line. */
export const MAX_TOOL_INPUT_CHARS = 200;

/** How much of a tool's result is echoed under it. */
export const MAX_TOOL_RESULT_CHARS = 400;
const MAX_TOOL_RESULT_LINES = 3;

/**
 * The advisor tool (US-008).
 *
 * `--advisor` turns on a *server-side* tool: the agent calls `advisor()`, the
 * whole conversation goes to a stronger model, and its guidance comes back as
 * a block the agent then acts on. It reaches the stream under a family of
 * names — the call is a `tool_use` / `server_tool_use` named `advisor`, the
 * answer an `advisor_tool_result` (or `advisor_result`, or
 * `advisor_tool_result_error` when the advisor refused) — and an experimental
 * tool is free to rename any of them, so everything starting with `advisor` is
 * treated as one, whether it arrives as a content block or as its own envelope.
 */
const ADVISOR_NAME_PREFIX = 'advisor';

/**
 * Splits a byte stream of JSON lines into whole lines. Shared by the build log
 * formatter and the session agent's event parser (`voice/session-agent/events.ts`).
 */
export class LineBuffer {
  /** The tail of the last chunk, up to the first newline of the next one. */
  private partial = '';

  /** Every line `chunk` completed, without its newline. */
  push(chunk: string): string[] {
    const lines = (this.partial + chunk).split('\n');
    // The last element is whatever came after the final newline — possibly a
    // half-received JSON object, which must not be parsed yet.
    this.partial = lines.pop() ?? '';
    return lines;
  }

  /** The unterminated last line when the stream ends; `null` when there is none. */
  flush(): string | null {
    const rest = this.partial;
    this.partial = '';
    return rest === '' ? null : rest;
  }
}

export class AgentOutputFormatter {
  private readonly lines = new LineBuffer();

  /** Renders every complete line in `chunk`; `''` when it completed none. */
  push(chunk: string): string {
    return this.lines
      .push(chunk)
      .map((line) => renderLine(line))
      .join('');
  }

  /** Renders the last line when the stream ends without a newline. */
  flush(): string {
    const rest = this.lines.flush();
    return rest === null ? '' : renderLine(rest);
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
      return renderUnknown(event);
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
    const type = part['type'];
    if (type === 'text') {
      const text = (asString(part['text']) ?? '').trim();
      if (text !== '') out += `${text}\n`;
    } else if (type === 'tool_use' || type === 'server_tool_use') {
      out += isAdvisorName(part['name'])
        ? renderAdvisorCall(part)
        : `[tool] ${asString(part['name']) ?? 'tool'}${toolArguments(part['input'])}\n`;
    } else if (isAdvisorName(type)) {
      // The advisor answers inside the same assistant message that called it:
      // a server-side tool's result is a content block, not a `user` event.
      out += renderAdvisorResult(part);
    }
    // `thinking` blocks are deliberately dropped: they are long, and the log is
    // there to show what the agent *did*.
  }
  return out;
}

/** True for any block or envelope of the advisor family; false for anything else. */
function isAdvisorName(value: unknown): boolean {
  return (asString(value) ?? '').toLowerCase().startsWith(ADVISOR_NAME_PREFIX);
}

/**
 * `[advisor] consulting opus` — one line, naming the model that was asked.
 *
 * The call itself carries no arguments worth showing (the tool takes none: the
 * conversation so far *is* the input), so the model is the whole story. It is
 * looked for in the places a server-side tool block can carry it, and the line
 * still reads when none of them is there.
 */
function renderAdvisorCall(part: Record<string, unknown>): string {
  return `[advisor] consulting ${advisorModelOf(part) ?? 'the advisor model'}\n`;
}

/** The advisor's guidance, under the same clipping every other tool result gets. */
function renderAdvisorResult(part: Record<string, unknown>): string {
  const guidance = abbreviate(toolResultText(part['content'] ?? part['text']));
  if (guidance !== '') return `${guidance}\n`;
  // No text at all: refused, redacted, or an error block. Say so rather than
  // leaving the consultation as a call with no answer under it.
  const reason = asString(part['error_code'] ?? part['error'] ?? part['subtype']);
  return `[advisor] no guidance returned${reason === null ? '' : ` (${reason})`}\n`;
}

function advisorModelOf(part: Record<string, unknown>): string | null {
  const input = asRecord(part['input']);
  return (
    asString(part['model']) ??
    asString(part['advisor_model']) ??
    asString(input?.['model']) ??
    asString(input?.['advisor']) ??
    null
  );
}

/**
 * An envelope whose `type` this parser does not know.
 *
 * Dropping an advisor consultation is how a second opinion goes missing from
 * a log that is the operator's only view of the run, so an advisor-shaped
 * envelope gets the advisor's own rendering. Everything else is still dropped:
 * the CLI emits a `rate_limit_event` per API turn, and rendering those as raw
 * JSON would bury the run in hundreds of lines nobody asked for. A newer kind
 * worth showing is worth a case of its own here.
 */
function renderUnknown(event: Record<string, unknown>): string {
  const type = asString(event['type']) ?? 'event';
  return isAdvisorName(type) ? renderAdvisorEnvelope(event) : '';
}

/** An advisor consultation that arrived as its own envelope rather than a block. */
function renderAdvisorEnvelope(event: Record<string, unknown>): string {
  const model = advisorModelOf(event);
  const head = model === null ? '' : `[advisor] consulting ${model}\n`;
  const guidance = abbreviate(
    toolResultText(event['content'] ?? event['text'] ?? event['result'] ?? messageContentOf(event)),
  );
  if (guidance !== '') return `${head}${guidance}\n`;
  return head === '' ? renderAdvisorResult(event) : head;
}

function messageContentOf(event: Record<string, unknown>): unknown {
  return asRecord(event['message'])?.['content'];
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

/**
 * A tool result is either a string, the content blocks of one, or — as the
 * advisor answers — a single block wrapping its text one level down.
 */
function toolResultText(content: unknown, depth = 0): string {
  const direct = asString(content);
  if (direct !== null) return direct;
  if (Array.isArray(content)) {
    return content
      .map((part) => textOfBlock(asRecord(part), depth))
      .filter((text) => text !== '')
      .join('\n');
  }
  return textOfBlock(asRecord(content), depth);
}

function textOfBlock(block: Record<string, unknown> | null, depth: number): string {
  if (block === null) return '';
  const text = asString(block['text']);
  if (text !== null) return text;
  // `{ content: [...] }` around the text; bounded so no shape can loop here.
  return depth >= 2 ? '' : toolResultText(block['content'], depth + 1);
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
