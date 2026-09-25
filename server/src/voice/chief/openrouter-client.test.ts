import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { OPENROUTER_REFERER, OPENROUTER_TITLE } from '../stt/openrouter.js';
import { type ChatEvent, type ChatTool, OpenRouterError, RETRY_BACKOFF_MS, streamChat } from './openrouter-client.js';

/**
 * OpenRouter streams written to the shape of its streaming docs (OpenAI
 * chunks, `: OPENROUTER PROCESSING` comments, a trailing usage chunk).
 */
function fixture(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}.sse`, import.meta.url), 'utf8');
}

/**
 * What the fake OpenRouter answers to the next request, in order. A stream
 * body goes out in small pieces so lines and UTF-8 characters are split
 * across reads; `hold` leaves the response open after the body.
 */
interface Reply {
  readonly status: number;
  readonly body: string;
  readonly hold?: boolean;
}

interface Seen {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
  readonly at: number;
  /** The client's source port, to tell a reused socket from a new one. */
  readonly port: number | undefined;
}

let replies: Reply[] = [];
let seen: Seen[] = [];
/** Resolves when a held response's connection is closed by the client. */
let heldClosed: Promise<void> = Promise.resolve();

const TOOLS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_sessions',
      description: 'Lists sessions.',
      parameters: { type: 'object', properties: { status: { type: 'string' } } },
    },
  },
];

describe('OpenRouter streaming chat client (voice US-005)', () => {
  let provider: http.Server;
  let baseUrl: string;

  before(async () => {
    provider = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({
          url: req.url ?? '',
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          at: Date.now(),
          port: req.socket.remotePort,
        });
        const reply = replies.shift() ?? { status: 500, body: '{"error":{"message":"no reply queued"}}' };
        if (reply.status !== 200) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(reply.body);
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (reply.hold === true) {
          heldClosed = new Promise((resolve) => res.on('close', () => resolve()));
        }
        void writeInPieces(res, Buffer.from(reply.body, 'utf8')).then(() => {
          if (reply.hold !== true) res.end();
        });
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((provider.address() as AddressInfo).port)}/api/v1`;
  });

  after(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });

  beforeEach(() => {
    replies = [];
    seen = [];
  });

  function stream(signal?: AbortSignal): AsyncGenerator<ChatEvent, void, undefined> {
    return streamChat({
      baseUrl,
      apiKey: 'sk-or-test',
      model: 'inclusionai/ling-3.0-flash',
      messages: [
        { role: 'system', content: 'You are chief.' },
        { role: 'user', content: 'Hoe staan de builds ervoor?' },
      ],
      tools: TOOLS,
      signal,
    });
  }

  async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
    const out: ChatEvent[] = [];
    for await (const event of events) out.push(event);
    return out;
  }

  it('posts a streaming request with usage, tools and latency routing', async () => {
    replies = [{ status: 200, body: fixture('text-reply') }];
    await collect(stream());

    assert.equal(seen.length, 1);
    const [request] = seen;
    assert.equal(request?.url, '/api/v1/chat/completions');
    assert.equal(request.headers['authorization'], 'Bearer sk-or-test');
    assert.equal(request.headers['http-referer'], OPENROUTER_REFERER);
    assert.equal(request.headers['x-title'], OPENROUTER_TITLE);
    assert.deepEqual(request.body, {
      model: 'inclusionai/ling-3.0-flash',
      messages: [
        { role: 'system', content: 'You are chief.' },
        { role: 'user', content: 'Hoe staan de builds ervoor?' },
      ],
      tools: TOOLS,
      stream: true,
      usage: { include: true },
      provider: { sort: 'latency' },
    });
  });

  it('streams text deltas, skips comment lines and reports usage before done', async () => {
    replies = [{ status: 200, body: fixture('text-reply') }];
    const events = await collect(stream());

    assert.deepEqual(events, [
      { type: 'delta', text: 'Er draaien ' },
      { type: 'delta', text: 'twee builds. ' },
      { type: 'delta', text: 'Één wacht op review – zal ik hem openen?' },
      { type: 'usage', promptTokens: 1834, completionTokens: 21, cachedTokens: 1536, costUsd: 0.0000398 },
      { type: 'done', finishReason: 'stop' },
    ]);
  });

  it('accumulates fragmented tool arguments by index', async () => {
    replies = [{ status: 200, body: fixture('tool-calls') }];
    const events = await collect(stream());

    assert.deepEqual(events, [
      { type: 'delta', text: 'Even kijken.' },
      { type: 'tool_call', index: 0, id: 'call_7f3a', name: 'list_sessions', arguments: '{"status": "running"}' },
      { type: 'tool_call', index: 1, id: 'call_8b1c', name: 'get_pull_request', arguments: '{"number": 42}' },
      { type: 'tool_call', index: 2, id: 'call_9d2e', name: 'get_status', arguments: '{}' },
      { type: 'usage', promptTokens: 2210, completionTokens: 48, cachedTokens: 0, costUsd: 0.00004943 },
      { type: 'done', finishReason: 'tool_calls' },
    ]);
  });

  it('hands the connection back to the keep-alive agent after [DONE]', async () => {
    replies = [
      { status: 200, body: fixture('text-reply') },
      { status: 200, body: fixture('text-reply') },
    ];
    await collect(stream());
    // The trailing blank line after [DONE] and the end of the body may still
    // be on their way; chief's next step always comes later than this.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await collect(stream());
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.port, seen[0]?.port, 'the second request reused the socket');
  });

  it('closes the response body promptly when the signal aborts mid-stream', async () => {
    const full = fixture('text-reply');
    // Everything up to (not including) the second text chunk, then silence.
    const cut = full.indexOf('data:', full.indexOf('Er draaien'));
    replies = [{ status: 200, body: full.slice(0, cut), hold: true }];
    const controller = new AbortController();
    const events: ChatEvent[] = [];

    const run = (async () => {
      for await (const event of stream(controller.signal)) {
        events.push(event);
        if (event.type === 'delta') controller.abort();
      }
    })();

    const started = Date.now();
    await assert.rejects(run, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    await heldClosed;
    assert.ok(Date.now() - started < 500, 'the connection closed promptly');
    assert.deepEqual(events, [{ type: 'delta', text: 'Er draaien ' }]);
  });

  it('closes the connection when the consumer stops iterating', async () => {
    replies = [{ status: 200, body: fixture('tool-calls'), hold: true }];
    for await (const event of stream()) {
      if (event.type === 'delta') break;
    }
    await heldClosed;
  });

  it('retries once after a 429, with the backoff', async () => {
    replies = [
      { status: 429, body: '{"error":{"message":"Rate limited","code":429}}' },
      { status: 200, body: fixture('text-reply') },
    ];
    const events = await collect(stream());

    assert.equal(seen.length, 2);
    assert.ok(seen[1]!.at - seen[0]!.at >= RETRY_BACKOFF_MS - 5, 'waited before retrying');
    assert.deepEqual(events.at(-1), { type: 'done', finishReason: 'stop' });
  });

  it('retries a 5xx only once, then throws an OpenRouterError', async () => {
    const body = '{"error":{"message":"Upstream overloaded","code":503}}';
    replies = [
      { status: 503, body },
      { status: 503, body },
      { status: 200, body: fixture('text-reply') },
    ];
    await assert.rejects(collect(stream()), (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.status, 503);
      assert.equal(error.body, body);
      assert.match(error.message, /Upstream overloaded/);
      return true;
    });
    assert.equal(seen.length, 2);
  });

  it('does not retry other errors', async () => {
    const body = '{"error":{"message":"No endpoints found that support tool use.","code":404}}';
    replies = [{ status: 404, body }];
    await assert.rejects(collect(stream()), (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.status, 404);
      assert.equal(error.body, body);
      return true;
    });
    assert.equal(seen.length, 1);
  });

  it('turns an error chunk mid-stream into an OpenRouterError after the text so far', async () => {
    replies = [{ status: 200, body: fixture('mid-stream-error') }];
    const events: ChatEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of stream()) events.push(event);
      })(),
      (error: unknown) => {
        assert.ok(error instanceof OpenRouterError);
        assert.equal(error.status, 502);
        assert.match(error.message, /Provider disconnected/);
        return true;
      },
    );
    assert.deepEqual(events, [{ type: 'delta', text: 'Ik ga ' }]);
  });

  it('throws when the stream ends without [DONE]', async () => {
    const full = fixture('text-reply');
    replies = [{ status: 200, body: full.slice(0, full.indexOf('data: [DONE]')) }];
    await assert.rejects(collect(stream()), (error: unknown) => error instanceof OpenRouterError && error.status === 0);
  });
});

async function writeInPieces(res: http.ServerResponse, body: Buffer): Promise<void> {
  // 23 bytes splits lines, JSON and the multi-byte characters of the fixtures.
  for (let at = 0; at < body.length; at += 23) {
    if (res.destroyed) return;
    res.write(body.subarray(at, at + 23));
    await new Promise((resolve) => setImmediate(resolve));
  }
}
