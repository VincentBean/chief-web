import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake OpenRouter for chief's tests (voice US-008): every chat request gets
 * the next scripted reply, streamed as SSE in small pieces, and is recorded
 * with its parsed body so a test can see what chief sent. `POST /audio/speech`
 * is the backup voice (voice US-027): {@link SPEECH_BYTES_PER_CHAR} bytes of
 * PCM per character of `input`, recorded in `speech` and never taking a reply.
 */

export const SPEECH_BYTES_PER_CHAR = 2;

export interface ScriptedReply {
  readonly status: number;
  readonly body: string;
}

export interface ScriptedOpenRouter {
  readonly baseUrl: string;
  /** Replies still to be given, in order; a request with none left gets a 500. */
  readonly replies: ScriptedReply[];
  readonly requests: Record<string, unknown>[];
  /** Every `/audio/speech` body, in order. */
  readonly speech: Record<string, unknown>[];
  close(): Promise<void>;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: 'gen-test',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: finishReason }],
  };
}

function stream(chunks: readonly Record<string, unknown>[], costUsd: number): string {
  const usage = { id: 'gen-test', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: costUsd } };
  return `: OPENROUTER PROCESSING\n\n${[...chunks, usage].map((entry) => `data: ${JSON.stringify(entry)}\n\n`).join('')}data: [DONE]\n\n`;
}

/** A plain text answer, one delta per piece. */
export function textReply(pieces: readonly string[], costUsd = 0.001): ScriptedReply {
  return {
    status: 200,
    body: stream([...pieces.map((content) => chunk({ content })), chunk({}, 'stop')], costUsd),
  };
}

/** Optional text first, then tool calls (arguments split in two fragments). */
export function toolReply(
  calls: readonly { readonly id: string; readonly name: string; readonly args: string }[],
  text = '',
  costUsd = 0.001,
): ScriptedReply {
  const chunks: Record<string, unknown>[] = [];
  if (text !== '') chunks.push(chunk({ content: text }));
  calls.forEach((call, index) => {
    const half = Math.floor(call.args.length / 2);
    chunks.push(chunk({ content: null, tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args.slice(0, half) } }] }));
    chunks.push(chunk({ content: null, tool_calls: [{ index, type: 'function', function: { arguments: call.args.slice(half) } }] }));
  });
  chunks.push(chunk({}, 'tool_calls'));
  return { status: 200, body: stream(chunks, costUsd) };
}

export function errorReply(status: number): ScriptedReply {
  return { status, body: JSON.stringify({ error: { code: status, message: 'scripted failure' } }) };
}

export async function startScriptedOpenRouter(): Promise<ScriptedOpenRouter> {
  const replies: ScriptedReply[] = [];
  const requests: Record<string, unknown>[] = [];
  const speech: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    const body: Buffer[] = [];
    req.on('data', (data: Buffer) => body.push(data));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8')) as Record<string, unknown>;
      if ((req.url ?? '').endsWith('/audio/speech')) {
        speech.push(parsed);
        res.writeHead(200, { 'content-type': 'audio/pcm' });
        res.end(Buffer.alloc(String(parsed['input']).length * SPEECH_BYTES_PER_CHAR, 1));
        return;
      }
      requests.push(parsed);
      const reply = replies.shift() ?? errorReply(500);
      if (reply.status !== 200) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      void (async () => {
        const bytes = Buffer.from(reply.body, 'utf8');
        for (let at = 0; at < bytes.length; at += 64) {
          res.write(bytes.subarray(at, at + 64));
          await new Promise((resolve) => setImmediate(resolve));
        }
        res.end();
      })();
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    replies,
    requests,
    speech,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
