import WebSocket from 'ws';

import { TtsError, type TtsErrorKind, type TtsFormat, type TtsProvider, type TtsSegment } from './types.js';

/**
 * ElevenLabs text-to-speech over the multi-context WebSocket (voice US-006;
 * plan §8.3). One socket per call, opened at call start so the handshake is not
 * paid on the first reply, and one context per turn (`t<turn>`), so a barge-in
 * closes that context and the audio stops without reconnecting.
 *
 * Field names follow the "Multi-Context WebSocket" API reference: the client
 * sends snake_case (`text`, `context_id`, `flush`, `close_context`,
 * `close_socket`), the server answers camelCase (`audio`, `contextId`,
 * `isFinal`, `alignment.chars`). The guide's samples read `is_final`, so both
 * spellings are accepted.
 */

export const ELEVENLABS_SAMPLE_RATE = 24000;
/** Plan §8.3: a keep-alive after this long without sending anything. */
export const KEEP_ALIVE_MS = 15_000;
/** The API's maximum, in seconds. */
const INACTIVITY_TIMEOUT_S = 180;
/** A context of its own for keep-alives, so a ping never touches a closed turn. */
const KEEP_ALIVE_CONTEXT = 'keepalive';

export interface ElevenLabsTtsOptions {
  /** `ELEVENLABS_API_URL`, e.g. `https://api.elevenlabs.io`; the scheme becomes ws(s). */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly keepAliveMs?: number;
}

/** One incoming message, reduced to what the provider acts on. */
export interface ElevenLabsMessage {
  readonly contextId: string | null;
  readonly audio: Buffer | null;
  /** Non-space characters the chunk's `alignment` covers; `null` without alignment. */
  readonly alignedChars: number | null;
  readonly final: boolean;
  readonly error: { readonly kind: TtsErrorKind; readonly message: string } | null;
}

export function parseElevenLabsMessage(raw: string): ElevenLabsMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { contextId: null, audio: null, alignedChars: null, final: false, error: null };
  }
  const msg = isRecord(parsed) ? parsed : {};
  const contextId = typeof msg['contextId'] === 'string' ? msg['contextId'] : typeof msg['context_id'] === 'string' ? msg['context_id'] : null;
  const audio = typeof msg['audio'] === 'string' && msg['audio'] !== '' ? Buffer.from(msg['audio'], 'base64') : null;
  const alignment = isRecord(msg['alignment']) ? msg['alignment'] : null;
  const chars = alignment !== null && Array.isArray(alignment['chars']) ? alignment['chars'] : null;
  const alignedChars = chars === null ? null : chars.filter((c) => typeof c === 'string' && c.trim() !== '').length;
  const final = msg['isFinal'] === true || msg['is_final'] === true;
  const error =
    msg['error'] !== undefined && msg['error'] !== null
      ? { kind: classify(0, raw), message: typeof msg['message'] === 'string' ? msg['message'] : String(JSON.stringify(msg['error'])) }
      : null;
  return { contextId, audio, alignedChars, final, error };
}

/** What a status, close reason or error body means for the fallback policy. */
export function classify(status: number, text: string): TtsErrorKind {
  if (status === 402 || /quota|insufficient_credits|payment_required|credits/i.test(text)) return 'quota';
  if (status === 401 || status === 403 || /invalid_api_key|authentication_error|unauthori[sz]ed|api key/i.test(text)) {
    return 'unauthorized';
  }
  return 'socket';
}

interface Pending {
  readonly seg: TtsSegment;
  /** Non-space characters still to be covered by aligned audio. */
  remaining: number;
  readonly onAudio: (chunk: Buffer) => void;
  readonly resolve: (value: { chars: number }) => void;
  readonly reject: (cause: unknown) => void;
  readonly cleanup: () => void;
  aborted: boolean;
}

export class ElevenLabsTts implements TtsProvider {
  readonly name = 'elevenlabs' as const;
  readonly format: TtsFormat = { kind: 'pcm16', sampleRate: ELEVENLABS_SAMPLE_RATE };

  private voiceId: string | null = null;
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  /** Counts connections of this call; errors carry it so one drop counts once. */
  private connection = 0;
  private closed = false;
  private keepAlive: NodeJS.Timeout | null = null;
  /** Segments waiting for audio, per context, oldest first. */
  private readonly contexts = new Map<string, Pending[]>();
  /** Contexts whose audio is dropped (barge-in); later messages for them are ignored. */
  private readonly cancelled = new Set<string>();
  /** Contexts this socket has been sent text for; a barge-in during "thinking" has none to close. */
  private readonly opened = new Set<string>();
  private readonly keepAliveMs: number;
  /** Every connection this provider opened, for tests and diagnostics. */
  connections = 0;

  constructor(private readonly opts: ElevenLabsTtsOptions) {
    this.keepAliveMs = opts.keepAliveMs ?? KEEP_ALIVE_MS;
  }

  async open(call: { callId: string; voiceId: string }): Promise<void> {
    this.voiceId = call.voiceId;
    this.closed = false;
    await this.connect();
  }

  async speak(seg: TtsSegment, signal: AbortSignal, onAudio: (chunk: Buffer) => void): Promise<{ chars: number }> {
    signal.throwIfAborted();
    const contextId = `t${String(seg.turn)}`;
    const ws = await this.connect();
    signal.throwIfAborted();
    this.cancelled.delete(contextId);

    const text = seg.text.trim();
    if (text === '' && !seg.last) return { chars: 0 };
    const expected = text.replace(/\s/g, '').length;

    const done = new Promise<{ chars: number }>((resolve, reject) => {
      const onAbort = (): void => {
        pending.aborted = true;
        reject(signal.reason);
      };
      const pending: Pending = {
        seg,
        remaining: expected,
        onAudio,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener('abort', onAbort),
        aborted: false,
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const queue = this.contexts.get(contextId) ?? [];
      queue.push(pending);
      this.contexts.set(contextId, queue);
    });

    // The docs want text to end with a single space.
    if (text !== '') this.send(ws, { text: `${text} `, context_id: contextId });
    this.opened.add(contextId);
    if (seg.last) {
      this.send(ws, { text: '', context_id: contextId, flush: true });
      // A flushing context keeps generating after close_context and then
      // answers isFinal; closing now frees its slot (5 per socket) for turn n+1.
      this.send(ws, { context_id: contextId, close_context: true });
      this.opened.delete(contextId);
    }
    return done;
  }

  cancelTurn(turn: number): void {
    const contextId = `t${String(turn)}`;
    this.cancelled.add(contextId);
    if (this.opened.delete(contextId) && this.ws?.readyState === WebSocket.OPEN) {
      this.send(this.ws, { context_id: contextId, close_context: true });
    }
    // The characters were sent and are billed; the audio is simply not wanted.
    const queue = this.contexts.get(contextId) ?? [];
    this.contexts.delete(contextId);
    for (const p of queue) {
      p.cleanup();
      p.resolve({ chars: charsOf(p.seg) });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopKeepAlive();
    const ws = this.ws;
    this.ws = null;
    this.failAll(new TtsError('socket', 0, 'The ElevenLabs voice was closed.', this.connection));
    if (ws === null) return;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ close_socket: true }));
      } catch {
        // Closing anyway.
      }
    }
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 1000);
      timer.unref();
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.close(1000);
    });
  }

  /** The open socket, or a new one: after a drop the next segment reconnects. */
  private connect(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new TtsError('socket', 0, 'The ElevenLabs voice is closed.', this.connection));
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.connecting !== null) return this.connecting;
    const voiceId = this.voiceId;
    if (voiceId === null) return Promise.reject(new TtsError('unconfigured', 0, 'No ElevenLabs voice chosen.'));

    const connection = ++this.connection;
    this.connections += 1;
    const base = this.opts.baseUrl.replace(/^http/, 'ws');
    const query = new URLSearchParams({
      model_id: this.opts.modelId,
      output_format: `pcm_${String(ELEVENLABS_SAMPLE_RATE)}`,
      auto_mode: 'true',
      inactivity_timeout: String(INACTIVITY_TIMEOUT_S),
    });
    const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}/multi-stream-input?${query.toString()}`;

    const attempt = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { 'xi-api-key': this.opts.apiKey } });
      let opened = false;
      ws.on('unexpected-response', (_req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          reject(new TtsError(classify(status, body), status, `ElevenLabs refused the voice socket (${String(status)}): ${body.slice(0, 300)}`, connection));
          ws.terminate();
        });
        res.on('error', () => undefined);
      });
      ws.on('error', (cause) => {
        if (!opened) reject(new TtsError('socket', 0, `ElevenLabs could not be reached: ${cause.message}`, connection));
      });
      ws.on('open', () => {
        opened = true;
        this.ws = ws;
        this.send(ws, { text: ' ', context_id: KEEP_ALIVE_CONTEXT });
        resolve(ws);
      });
      ws.on('message', (data: WebSocket.RawData) => {
        this.onMessage(ws, Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.concat(data as Buffer[]).toString('utf8'));
      });
      ws.on('close', (code, reason) => {
        if (this.ws === ws) this.ws = null;
        this.opened.clear();
        if (!opened) return;
        this.stopKeepAlive();
        if (this.closed) return;
        const text = reason.toString('utf8');
        const kind = code === 1000 ? 'socket' : classify(0, text);
        this.failAll(new TtsError(kind, code, `The ElevenLabs voice socket closed (${String(code)}${text === '' ? '' : `: ${text}`}).`, connection));
      });
    });
    this.connecting = attempt;
    const clear = (): void => {
      if (this.connecting === attempt) this.connecting = null;
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private onMessage(ws: WebSocket, raw: string): void {
    const msg = parseElevenLabsMessage(raw);
    if (msg.error !== null) {
      this.failAll(new TtsError(msg.error.kind, 0, `ElevenLabs: ${msg.error.message}`, this.connection));
      ws.terminate();
      return;
    }
    const contextId = msg.contextId;
    if (contextId === null || this.cancelled.has(contextId)) return;
    const queue = this.contexts.get(contextId);
    if (queue === undefined) return;
    if (msg.audio !== null) {
      // Audio is tagged by context, not segment: it belongs to the oldest
      // segment whose characters the alignment has not covered yet.
      const head = queue[0];
      if (head !== undefined && !head.aborted) head.onAudio(msg.audio);
      let covered = msg.alignedChars ?? 0;
      while (covered > 0 && queue.length > 0) {
        const first = queue[0] as Pending;
        const used = Math.min(first.remaining, covered);
        first.remaining -= used;
        covered -= used;
        if (first.remaining > 0) break;
        queue.shift();
        first.cleanup();
        first.resolve({ chars: charsOf(first.seg) });
      }
    }
    if (msg.final) {
      this.contexts.delete(contextId);
      for (const p of queue) {
        p.cleanup();
        p.resolve({ chars: charsOf(p.seg) });
      }
    }
  }

  private failAll(error: TtsError): void {
    const queues = [...this.contexts.values()];
    this.contexts.clear();
    for (const queue of queues) {
      for (const p of queue) {
        p.cleanup();
        if (!p.aborted) p.reject(error);
      }
    }
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    ws.send(JSON.stringify(message));
    this.armKeepAlive(ws);
  }

  /** Plan §8.3: after 15 s of sending nothing, an empty text resets the clock. */
  private armKeepAlive(ws: WebSocket): void {
    this.stopKeepAlive();
    this.keepAlive = setTimeout(() => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN) this.send(ws, { text: '', context_id: KEEP_ALIVE_CONTEXT });
    }, this.keepAliveMs);
    this.keepAlive.unref();
  }

  private stopKeepAlive(): void {
    if (this.keepAlive !== null) clearTimeout(this.keepAlive);
    this.keepAlive = null;
  }
}

function charsOf(seg: TtsSegment): number {
  const text = seg.text.trim();
  return text === '' ? 0 : text.length + 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
