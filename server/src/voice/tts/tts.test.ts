import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type WebSocket, WebSocketServer } from 'ws';

import { type Config, loadConfig } from '../../config.js';
import { closeDatabase, type Database, getSetting, IN_MEMORY, openDatabase, setSetting } from '../../db/index.js';
import {
  ElevenLabsTts,
  MAX_IN_FLIGHT,
  OpenRouterTts,
  parseElevenLabsMessage,
  SWITCHED_TOAST,
  type TtsProviderName,
  TtsService,
  type TtsSink,
} from './index.js';

interface FixtureLine {
  readonly dir: 'send' | 'recv';
  readonly msg: Record<string, unknown>;
}

const FIXTURE: FixtureLine[] = readFileSync(new URL('./__fixtures__/el-multi-context.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as FixtureLine);

const RESET_UNIX = 1_790_000_000;
const NOW = Date.parse('2026-09-25T12:00:00Z');

/* ------------------------------------------------------------------------ */
/* The fake providers                                                       */
/* ------------------------------------------------------------------------ */

let server: http.Server;
let wss: WebSocketServer;
let config: Config;
/** Upgrade requests seen: path + query and the key header. */
let upgrades: { url: string; key: string | undefined }[] = [];
/** Every JSON message the fake ElevenLabs received, per connection (1-based). */
let received: { conn: number; msg: Record<string, unknown> }[] = [];
/** How the fake answers an upgrade; `accept` by default. */
let onUpgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
/** How the fake ElevenLabs answers a message on an accepted socket. */
let onMessage: (ws: WebSocket, msg: Record<string, unknown>, conn: number) => void;
/** The fake OpenRouter `/audio/speech`. */
let speech: (req: http.IncomingMessage, body: Record<string, unknown>, res: http.ServerResponse) => void;
let speechBodies: Record<string, unknown>[] = [];

function accept(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = upgrades.length;
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      received.push({ conn, msg });
      onMessage(ws, msg, conn);
    });
  });
}

/** A fake that speaks every text it gets with alignment, and finishes on close_context. */
function speaker(ws: WebSocket, msg: Record<string, unknown>): void {
  const contextId = msg['context_id'];
  if (typeof contextId !== 'string' || contextId === 'keepalive') return;
  if (typeof msg['text'] === 'string' && msg['text'].trim() !== '') {
    const text = msg['text'];
    ws.send(JSON.stringify({ audio: Buffer.from(`pcm:${text.trim()}`).toString('base64'), alignment: { chars: [...text] }, contextId }));
  }
  if (msg['close_context'] === true) ws.send(JSON.stringify({ isFinal: true, contextId }));
}

function orSpeaks(_req: http.IncomingMessage, body: Record<string, unknown>, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'audio/pcm' });
  res.write(`or:${String(body['input'])}:1;`);
  setImmediate(() => res.end(`or:${String(body['input'])}:2;`));
}

let db: Database;
let toasts: string[];
let errors: { code: string; message: string; fatal: false }[];
let chars: { provider: TtsProviderName; segmentId: number; turn: number; chars: number }[];
let switched: TtsProviderName[];
const sink: TtsSink = {
  toast: (text) => toasts.push(text),
  error: (error) => errors.push(error),
  chars: (usage) => chars.push(usage),
  providerChanged: (provider) => switched.push(provider),
};

before(async () => {
  wss = new WebSocketServer({ noServer: true });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      if (path === '/el/v1/user/subscription') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ tier: 'starter', character_count: 30_000, character_limit: 30_000, next_character_count_reset_unix: RESET_UNIX }));
        return;
      }
      if (path === '/or/audio/speech') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        speechBodies.push(body);
        speech(req, body, res);
        return;
      }
      res.writeHead(404).end();
    });
  });
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const key = req.headers['xi-api-key'];
    upgrades.push({ url: req.url ?? '', key: typeof key === 'string' ? key : undefined });
    onUpgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  config = loadConfig({
    CHIEF_WEB_PASSWORD: 'correct horse battery staple',
    OPENROUTER_API_URL: `http://127.0.0.1:${String(port)}/or`,
    ELEVENLABS_API_URL: `http://127.0.0.1:${String(port)}/el`,
  });
});

after(async () => {
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  upgrades = [];
  received = [];
  speechBodies = [];
  onUpgrade = accept;
  onMessage = speaker;
  speech = orSpeaks;
  toasts = [];
  errors = [];
  chars = [];
  switched = [];
  db = openDatabase(IN_MEMORY);
  setSetting(db, 'elevenlabs_api_key', 'sk_el_test');
  setSetting(db, 'openrouter_api_key', 'sk-or-test');
  setSetting(db, 'voice_voice_id', 'voice123');
});

function el(keepAliveMs?: number): ElevenLabsTts {
  return new ElevenLabsTts({
    baseUrl: config.elevenlabsApiUrl,
    apiKey: 'sk_el_test',
    modelId: 'eleven_flash_v2_5',
    ...(keepAliveMs === undefined ? {} : { keepAliveMs }),
  });
}

function refuse(status: number, body: unknown): typeof onUpgrade {
  return (_req, socket) => {
    const text = JSON.stringify(body);
    socket.end(`HTTP/1.1 ${String(status)} Refused\r\ncontent-type: application/json\r\ncontent-length: ${String(Buffer.byteLength(text))}\r\nconnection: close\r\n\r\n${text}`);
  };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

function collector(): { chunks: Buffer[]; text: () => string; onAudio: (chunk: Buffer) => void } {
  const chunks: Buffer[] = [];
  return { chunks, text: () => Buffer.concat(chunks).toString('utf8'), onAudio: (chunk) => chunks.push(chunk) };
}

/* ------------------------------------------------------------------------ */
/* ElevenLabs                                                               */
/* ------------------------------------------------------------------------ */

describe('ElevenLabs multi-context parser (voice US-006)', () => {
  it('reads every recorded server message', () => {
    const parsed = FIXTURE.filter((l) => l.dir === 'recv').map((l) => parseElevenLabsMessage(JSON.stringify(l.msg)));
    assert.deepEqual(
      parsed.map((m) => [m.contextId, m.audio?.length ?? null, m.alignedChars, m.final, m.error?.kind ?? null]),
      [
        ['t1', 960, 11, false, null],
        ['t1', 960, 8, false, null],
        ['t1', 960, 21, false, null],
        ['t1', 960, 10, false, null],
        ['t1', 480, null, false, null],
        ['t1', null, null, true, null],
        ['t2', 960, 7, false, null],
        ['t2', 960, 12, false, null],
        ['t2', null, null, true, null],
        [null, null, null, false, 'quota'],
      ],
    );
  });

  it('ignores what is not JSON', () => {
    assert.deepEqual(parseElevenLabsMessage('nope'), { contextId: null, audio: null, alignedChars: null, final: false, error: null });
  });
});

describe('ElevenLabsTts (voice US-006)', () => {
  it('replays the recorded session: the handshake, one context per turn, flush, and audio per segment', async () => {
    const t1 = FIXTURE.filter((l) => l.dir === 'recv' && l.msg['contextId'] === 't1');
    onMessage = (ws, msg) => {
      if (msg['close_context'] === true && msg['context_id'] === 't1') for (const l of t1) ws.send(JSON.stringify(l.msg));
    };
    const tts = el();
    await tts.open({ callId: 'c1', voiceId: 'voice123' });
    const signal = new AbortController().signal;
    const [a, b, c] = [collector(), collector(), collector()];
    const results = await Promise.all([
      tts.speak({ segmentId: 1, turn: 1, text: 'Build twelve is green.', last: false }, signal, a.onAudio),
      tts.speak({ segmentId: 2, turn: 1, text: 'The pull request is ready for review.', last: false }, signal, b.onAudio),
      tts.speak({ segmentId: 3, turn: 1, text: '', last: true }, signal, c.onAudio),
    ]);
    await tts.close();

    assert.equal(upgrades.length, 1);
    const url = new URL(upgrades[0]?.url ?? '', 'http://x');
    assert.equal(url.pathname, '/el/v1/text-to-speech/voice123/multi-stream-input');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      model_id: 'eleven_flash_v2_5',
      output_format: 'pcm_24000',
      auto_mode: 'true',
      inactivity_timeout: '180',
    });
    assert.equal(upgrades[0]?.key, 'sk_el_test');
    const sent = received.map((r) => r.msg);
    const recorded = FIXTURE.slice(0, 5).map((l) => l.msg);
    assert.deepEqual(sent.slice(0, 5), recorded);
    assert.deepEqual(sent[5], { close_socket: true });

    assert.deepEqual(a.chunks.map((x) => x.length), [960, 960]);
    assert.deepEqual(b.chunks.map((x) => x.length), [960, 960]);
    assert.deepEqual(c.chunks.map((x) => x.length), [480]);
    assert.deepEqual(results, [{ chars: 23 }, { chars: 38 }, { chars: 0 }]);
  });

  it('sends a keep-alive after the configured silence', async () => {
    const tts = el(40);
    await tts.open({ callId: 'c1', voiceId: 'voice123' });
    await until(() => received.some((r) => r.msg['text'] === '' && r.msg['context_id'] === 'keepalive'));
    await tts.close();
    assert.deepEqual(received[0]?.msg, { text: ' ', context_id: 'keepalive' });
  });

  it('barge-in: cancelTurn closes the context, drops its audio and does not reconnect', async () => {
    let socket: WebSocket | null = null;
    onMessage = (ws, msg) => {
      socket = ws;
      if (msg['context_id'] === 't2' && typeof msg['text'] === 'string' && msg['text'] !== '') {
        ws.send(JSON.stringify({ audio: Buffer.from('first').toString('base64'), alignment: { chars: [...'Ik zet'] }, contextId: 't2' }));
      }
    };
    const tts = el();
    await tts.open({ callId: 'c1', voiceId: 'voice123' });
    const heard = collector();
    const speaking = tts.speak({ segmentId: 7, turn: 2, text: 'Ik zet de build nu stop.', last: false }, new AbortController().signal, heard.onAudio);
    await until(() => heard.chunks.length === 1);
    tts.cancelTurn(2);
    assert.deepEqual(await speaking, { chars: 25 });
    await until(() => received.some((r) => r.msg['close_context'] === true));
    assert.deepEqual(received.at(-1)?.msg, { context_id: 't2', close_context: true });
    (socket as WebSocket | null)?.send(JSON.stringify({ audio: Buffer.from('late').toString('base64'), contextId: 't2' }));
    await wait(30);
    assert.equal(heard.text(), 'first');

    // The next turn goes out on the same socket.
    onMessage = speaker;
    const next = collector();
    await tts.speak({ segmentId: 8, turn: 3, text: 'Okay.', last: true }, new AbortController().signal, next.onAudio);
    assert.equal(next.text(), 'pcm:Okay.');
    assert.equal(upgrades.length, 1);
    await tts.close();
  });

  it('rejects an aborted segment with the signal reason', async () => {
    onMessage = () => undefined;
    const tts = el();
    await tts.open({ callId: 'c1', voiceId: 'voice123' });
    const controller = new AbortController();
    const speaking = tts.speak({ segmentId: 1, turn: 1, text: 'Hallo daar.', last: false }, controller.signal, () => undefined);
    await until(() => received.length === 2);
    controller.abort(new Error('barge-in'));
    await assert.rejects(speaking, /barge-in/);
    await tts.close();
  });
});

/* ------------------------------------------------------------------------ */
/* OpenRouter                                                               */
/* ------------------------------------------------------------------------ */

describe('OpenRouterTts (voice US-006)', () => {
  it('posts each segment with response_format pcm, streams it, and keeps at most two in flight', async () => {
    const held: http.ServerResponse[] = [];
    let peak = 0;
    let open = 0;
    speech = (req, _body, res) => {
      open += 1;
      peak = Math.max(peak, open);
      assert.equal(req.headers.authorization, 'Bearer sk-or-test');
      res.writeHead(200, { 'content-type': 'audio/pcm' });
      res.write('a');
      held.push(res);
      res.on('finish', () => {
        open -= 1;
      });
    };
    const tts = new OpenRouterTts({ baseUrl: config.openrouterApiUrl, apiKey: 'sk-or-test', model: 'm/tts', voice: 'Kore', sampleRate: 24000 });
    const signal = new AbortController().signal;
    const outs = [collector(), collector(), collector()];
    const done = [1, 2, 3].map((n, i) => tts.speak({ segmentId: n, turn: 1, text: `Zin ${String(n)}.`, last: n === 3 }, signal, (outs[i] as ReturnType<typeof collector>).onAudio));
    await until(() => held.length === 2);
    await wait(30);
    assert.equal(held.length, 2, 'the third segment waits');
    held.shift()?.end('b');
    await until(() => held.length === 2);
    for (const res of held.splice(0)) res.end('b');
    assert.deepEqual(await Promise.all(done), [{ chars: 6 }, { chars: 6 }, { chars: 6 }]);
    assert.equal(peak, MAX_IN_FLIGHT);
    assert.deepEqual(outs.map((o) => o.text()), ['ab', 'ab', 'ab']);
    assert.deepEqual(speechBodies[0], { model: 'm/tts', input: 'Zin 1.', voice: 'Kore', response_format: 'pcm' });
    assert.deepEqual(tts.format, { kind: 'pcm16', sampleRate: 24000 });
  });
});

/* ------------------------------------------------------------------------ */
/* TtsService: the fallback policy                                          */
/* ------------------------------------------------------------------------ */

describe('TtsService (voice US-006)', () => {
  function service(): TtsService {
    return new TtsService(db, config, sink, { now: () => NOW });
  }

  async function say(tts: TtsService, segmentId: number, text: string, last = true): Promise<{ result: Awaited<ReturnType<TtsService['speak']>>; audio: string; starts: string[] }> {
    const heard = collector();
    const starts: string[] = [];
    const result = await tts.speak({ segmentId, turn: 1, text, last }, new AbortController().signal, {
      onStart: (format, provider) => starts.push(`${provider}:${format.kind}`),
      onAudio: heard.onAudio,
    });
    return { result, audio: heard.text(), starts };
  }

  it('streams through ElevenLabs, in order, and reports the characters sent', async () => {
    const tts = service();
    await tts.open('call-1');
    assert.equal(tts.providerName, 'elevenlabs');
    const firstOut = collector();
    const secondOut = collector();
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      tts.speak({ segmentId: 1, turn: 1, text: 'Build twelve is green.', last: false }, signal, { onAudio: firstOut.onAudio }),
      tts.speak({ segmentId: 2, turn: 1, text: 'Done.', last: true }, signal, { onAudio: secondOut.onAudio }),
    ]);
    await tts.close();
    assert.deepEqual([firstOut.text(), secondOut.text()], ['pcm:Build twelve is green.', 'pcm:Done.']);
    assert.deepEqual([first.spoken, second.spoken], [true, true]);
    assert.deepEqual(chars, [
      { provider: 'elevenlabs', segmentId: 1, turn: 1, chars: 23 },
      { provider: 'elevenlabs', segmentId: 2, turn: 1, chars: 6 },
    ]);
    assert.deepEqual(toasts, []);
  });

  it('402: switches to OpenRouter, toasts, and holds ElevenLabs off until the credit reset', async () => {
    onUpgrade = refuse(402, { detail: { type: 'payment_required', code: 'insufficient_credits', message: 'Out of credits' } });
    const tts = service();
    await tts.open('call-1');
    assert.equal(tts.providerName, 'openrouter');
    const spoken = await say(tts, 1, 'Hallo daar.');
    await tts.close();
    assert.equal(spoken.audio, 'or:Hallo daar.:1;or:Hallo daar.:2;');
    assert.deepEqual(spoken.starts, ['openrouter:pcm16']);
    assert.deepEqual(toasts, [SWITCHED_TOAST]);
    assert.deepEqual(switched, ['openrouter']);
    assert.deepEqual(chars, [{ provider: 'openrouter', segmentId: 1, turn: 1, chars: 11 }]);
    assert.equal(getSetting(db, 'voice_el_exhausted_until'), new Date(RESET_UNIX * 1000).toISOString());
  });

  it('a quota error mid-call switches the segment to OpenRouter and stores the hold', async () => {
    const quota = FIXTURE.at(-1)?.msg;
    onMessage = (ws, msg) => {
      if (msg['context_id'] === 't1') ws.send(JSON.stringify(quota));
    };
    const tts = service();
    await tts.open('call-1');
    const spoken = await say(tts, 1, 'Hallo daar.');
    await tts.close();
    assert.equal(spoken.result.provider, 'openrouter');
    assert.equal(spoken.audio, 'or:Hallo daar.:1;or:Hallo daar.:2;');
    assert.deepEqual(toasts, [SWITCHED_TOAST]);
    assert.equal(getSetting(db, 'voice_el_exhausted_until'), new Date(RESET_UNIX * 1000).toISOString());
  });

  it('401: switches without holding ElevenLabs off', async () => {
    onUpgrade = refuse(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } });
    const tts = service();
    await tts.open('call-1');
    await tts.close();
    assert.equal(tts.providerName, 'openrouter');
    assert.deepEqual(toasts, [SWITCHED_TOAST]);
    assert.equal(getSetting(db, 'voice_el_exhausted_until'), null);
  });

  it('one socket failure reconnects; a second within 30 s switches to OpenRouter', async () => {
    onMessage = (ws, msg) => {
      if (typeof msg['context_id'] === 'string' && msg['context_id'] !== 'keepalive') ws.terminate();
    };
    const tts = service();
    await tts.open('call-1');
    const spoken = await say(tts, 1, 'Nog even geduld.');
    await tts.close();
    assert.equal(upgrades.length, 2, 'one reconnect, then the switch');
    assert.equal(spoken.result.provider, 'openrouter');
    assert.equal(spoken.audio, 'or:Nog even geduld.:1;or:Nog even geduld.:2;');
    assert.deepEqual(toasts, [SWITCHED_TOAST]);
    assert.equal(getSetting(db, 'voice_el_exhausted_until'), null);
  });

  it('two socket failures more than 30 s apart do not switch', async () => {
    let now = NOW;
    let drop = true;
    onMessage = (ws, msg) => {
      if (drop && msg['context_id'] === 't1') {
        drop = false;
        ws.terminate();
        return;
      }
      speaker(ws, msg);
    };
    const tts = new TtsService(db, config, sink, { now: () => now });
    await tts.open('call-1');
    assert.equal((await say(tts, 1, 'Een.')).result.provider, 'elevenlabs');
    now += 31_000;
    drop = true;
    assert.equal((await say(tts, 2, 'Twee.')).result.provider, 'elevenlabs');
    await tts.close();
    assert.equal(upgrades.length, 3);
    assert.deepEqual(toasts, []);
  });

  it('starts later calls on OpenRouter while ElevenLabs is exhausted, and on ElevenLabs after the reset', async () => {
    setSetting(db, 'voice_el_exhausted_until', new Date(NOW + 60_000).toISOString());
    const held = service();
    await held.open('call-2');
    assert.equal(held.providerName, 'openrouter');
    assert.equal((await say(held, 1, 'Hoi.')).result.provider, 'openrouter');
    await held.close();
    assert.equal(upgrades.length, 0);
    assert.deepEqual(toasts, []);

    setSetting(db, 'voice_el_exhausted_until', new Date(NOW - 1).toISOString());
    const after = service();
    await after.open('call-3');
    await after.close();
    assert.equal(after.providerName, 'elevenlabs');
    assert.equal(upgrades.length, 1);
    assert.equal(getSetting(db, 'voice_el_exhausted_until'), null);
  });

  it('both providers failing leaves the reply as text and sends one non-fatal error per turn', async () => {
    onUpgrade = refuse(401, { detail: { status: 'invalid_api_key' } });
    speech = (_req, _body, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream down' } }));
    };
    const tts = service();
    await tts.open('call-1');
    const one = await say(tts, 1, 'Een.', false);
    const two = await say(tts, 2, 'Twee.');
    await tts.close();
    assert.deepEqual([one.result.spoken, two.result.spoken], [false, false]);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.fatal, false);
    assert.equal(errors[0]?.code, 'tts_failed');
    assert.match(errors[0]?.message ?? '', /upstream down/);
    assert.deepEqual(chars, []);
  });

  it('with no ElevenLabs voice chosen the call starts on OpenRouter', async () => {
    setSetting(db, 'voice_voice_id', '');
    const tts = service();
    await tts.open('call-1');
    await tts.close();
    assert.equal(tts.providerName, 'openrouter');
    assert.equal(upgrades.length, 0);
  });

  after(() => closeDatabase(db));
});
