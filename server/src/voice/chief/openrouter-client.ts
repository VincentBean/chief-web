import http from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';

import { errorText } from '../providers.js';
import { OPENROUTER_REFERER, OPENROUTER_TITLE } from '../stt/openrouter.js';

/**
 * OpenRouter chat completions, streamed (voice US-005): chief's brain. One
 * request per model step; text arrives as `delta` events while it is being
 * generated (so the sentence chunker can start speaking early), tool calls
 * arrive whole once the model has finished them, and the step ends with
 * what it cost and a `done`.
 *
 * Dependency-free on purpose, over `node:http(s)` with a keep-alive agent
 * for the same reason as the STT client: the TLS handshake to OpenRouter is
 * a noticeable slice of a spoken turn's latency.
 */

const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
};

/** How long to wait before the one retry of a 429, a 5xx or a dropped connection. */
export const RETRY_BACKOFF_MS = 300;

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/** The OpenAI-shaped message OpenRouter takes. */
export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: readonly ChatToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface ChatTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSON Schema of the arguments object. */
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

export type ChatEvent =
  /** A piece of the assistant's text, as it streamed in. */
  | { readonly type: 'delta'; readonly text: string }
  /** A complete tool call; `arguments` is the model's raw JSON text (`'{}'` when it sent none). */
  | { readonly type: 'tool_call'; readonly index: number; readonly id: string; readonly name: string; readonly arguments: string }
  /** What the request cost, from OpenRouter's final usage chunk. */
  | {
      readonly type: 'usage';
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly cachedTokens: number;
      readonly costUsd: number;
    }
  /** The stream ended with `[DONE]`; `finishReason` as the model gave it (`stop`, `tool_calls`, `length`, …). */
  | { readonly type: 'done'; readonly finishReason: string | null };

/**
 * A request OpenRouter refused (non-2xx after the retry), an error it
 * reported mid-stream, a connection that failed, or a stream that broke off
 * before `[DONE]`. `status` is 0 when there was no HTTP answer.
 */
export class OpenRouterError extends Error {
  constructor(
    readonly status: number,
    /** The response body (or the mid-stream error chunk) as it came, or `''`. */
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export interface StreamChatOptions {
  /** e.g. `https://openrouter.ai/api/v1` (`OPENROUTER_API_URL`). */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ChatTool[];
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  /**
   * The turn's cancel (a barge-in or hang-up). Aborting closes the response
   * body; the iteration then rejects with the signal's reason, never an
   * `OpenRouterError`.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Streams one chat completion. Breaking out of the `for await` also closes
 * the connection.
 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<ChatEvent, void, undefined> {
  const body = JSON.stringify({
    model: opts.model,
    messages: opts.messages,
    ...(opts.tools.length === 0 ? {} : { tools: opts.tools }),
    ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    stream: true,
    usage: { include: true },
    provider: { sort: 'latency' },
  });
  const res = await openWithRetry(`${opts.baseUrl}/chat/completions`, body, opts.apiKey, opts.signal);
  let finished = false;
  try {
    yield* parseStream(res, opts.signal);
    finished = true;
  } finally {
    // After `[DONE]` the body is drained so the socket goes back to the
    // keep-alive agent; an abort, a break or an error closes it.
    if (finished) res.resume();
    else res.destroy();
  }
}

async function openWithRetry(
  url: string,
  body: string,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<http.IncomingMessage> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt === 1;
    let res: http.IncomingMessage;
    try {
      res = await open(url, body, apiKey, signal);
    } catch (cause) {
      if (signal?.aborted === true) throw signal.reason;
      // A stale keep-alive socket shows up as a reset; one fresh try is cheap.
      if (!last) {
        await sleep(RETRY_BACKOFF_MS, undefined, signal === undefined ? {} : { signal });
        continue;
      }
      throw new OpenRouterError(
        0,
        '',
        `OpenRouter could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const status = res.statusCode ?? 0;
    if (status >= 200 && status < 300) return res;

    const text = await readAll(res, signal);
    if (!last && (status === 429 || status >= 500)) {
      await sleep(RETRY_BACKOFF_MS, undefined, signal === undefined ? {} : { signal });
      continue;
    }
    throw new OpenRouterError(status, text, `OpenRouter answered ${String(status)}: ${errorText(text)}`);
  }
}

function open(url: string, body: string, apiKey: string, signal: AbortSignal | undefined): Promise<http.IncomingMessage> {
  const target = new URL(url);
  const transport = target.protocol === 'http:' ? http : https;
  const agent = target.protocol === 'http:' ? agents['http:'] : agents['https:'];
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: 'POST',
        agent,
        ...(signal === undefined ? {} : { signal }),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(body),
          'HTTP-Referer': OPENROUTER_REFERER,
          'X-Title': OPENROUTER_TITLE,
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function readAll(res: http.IncomingMessage, signal: AbortSignal | undefined): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of res) chunks.push(chunk as Buffer);
  } catch {
    if (signal?.aborted === true) throw signal.reason;
    // A body cut off mid-error is still worth reporting as far as it got.
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Server-sent events: `data:` lines make up an event, a blank line ends it,
 * lines starting with `:` are comments (OpenRouter's `: OPENROUTER
 * PROCESSING` keep-alives). Every event is one JSON chunk until `[DONE]`.
 */
async function* parseStream(res: http.IncomingMessage, signal: AbortSignal | undefined): AsyncGenerator<ChatEvent> {
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, PartialToolCall>();
  let toolCallsSent = false;
  let finishReason: string | null = null;
  let pending = '';
  let data: string[] = [];

  function* flushToolCalls(): Generator<ChatEvent> {
    if (toolCallsSent) return;
    toolCallsSent = true;
    for (const [index, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
      yield {
        type: 'tool_call',
        index,
        id: call.id,
        name: call.name,
        arguments: call.arguments.trim() === '' ? '{}' : call.arguments,
      };
    }
  }

  /** One complete event; returns true on `[DONE]`. */
  function* dispatch(payload: string): Generator<ChatEvent, boolean> {
    if (payload.trim() === '[DONE]') {
      yield* flushToolCalls();
      yield { type: 'done', finishReason };
      return true;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new OpenRouterError(0, payload, 'OpenRouter streamed a chunk that is not JSON.');
    }
    const record = asRecord(chunk);
    const error = asRecord(record['error']);
    if (record['error'] !== undefined) {
      const code = error['code'];
      throw new OpenRouterError(
        typeof code === 'number' ? code : 0,
        payload,
        `OpenRouter failed mid-stream: ${errorText(payload)}`,
      );
    }
    const choices = Array.isArray(record['choices']) ? (record['choices'] as unknown[]) : [];
    const choice = asRecord(choices[0]);
    const delta = asRecord(choice['delta']);
    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      yield { type: 'delta', text: delta['content'] };
    }
    if (Array.isArray(delta['tool_calls'])) {
      for (const [position, raw] of (delta['tool_calls'] as unknown[]).entries()) {
        const fragment = asRecord(raw);
        const index = typeof fragment['index'] === 'number' ? fragment['index'] : position;
        const fn = asRecord(fragment['function']);
        let call = toolCalls.get(index);
        if (call === undefined) {
          call = { id: '', name: '', arguments: '' };
          toolCalls.set(index, call);
        }
        if (typeof fragment['id'] === 'string' && fragment['id'] !== '' && call.id === '') call.id = fragment['id'];
        // Some providers repeat the name on every fragment; only the first counts.
        if (typeof fn['name'] === 'string' && fn['name'] !== '' && call.name === '') call.name = fn['name'];
        if (typeof fn['arguments'] === 'string') call.arguments += fn['arguments'];
      }
    }
    if (typeof choice['finish_reason'] === 'string') {
      finishReason = choice['finish_reason'];
      yield* flushToolCalls();
    }
    const usage = record['usage'];
    if (typeof usage === 'object' && usage !== null) {
      const u = asRecord(usage);
      const details = asRecord(u['prompt_tokens_details']);
      yield {
        type: 'usage',
        promptTokens: num(u['prompt_tokens']),
        completionTokens: num(u['completion_tokens']),
        cachedTokens: num(details['cached_tokens']),
        costUsd: num(u['cost']),
      };
    }
    return false;
  }

  /** Feeds one line; returns true once `[DONE]` has been seen. */
  function* line(text: string): Generator<ChatEvent, boolean> {
    if (text === '') {
      if (data.length === 0) return false;
      const payload = data.join('\n');
      data = [];
      return yield* dispatch(payload);
    }
    if (text.startsWith(':')) return false;
    if (text.startsWith('data:')) {
      data.push(text.slice(text.startsWith('data: ') ? 6 : 5));
    }
    // `event:`, `id:` and `retry:` carry nothing for us.
    return false;
  }

  try {
    // Returning at `[DONE]` must not destroy the body: `streamChat` drains it for keep-alive.
    for await (const chunk of res.iterator({ destroyOnReturn: false })) {
      pending += decoder.decode(chunk as Buffer, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const text = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (yield* line(text)) return;
      }
    }
  } catch (cause) {
    if (signal?.aborted === true) throw signal.reason;
    if (cause instanceof OpenRouterError) throw cause;
    throw new OpenRouterError(
      0,
      '',
      `OpenRouter's stream broke off: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  // The body ended: a last event without its blank line still counts.
  pending += decoder.decode();
  if (pending !== '' && (yield* line(pending.replace(/\r$/, '')))) return;
  if (yield* line('')) return;
  throw new OpenRouterError(0, '', 'OpenRouter ended the stream without [DONE].');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
