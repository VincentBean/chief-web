import http from 'node:http';
import https from 'node:https';

import { errorText } from '../providers.js';
import { OPENROUTER_REFERER, OPENROUTER_TITLE } from '../stt/openrouter.js';
import { TtsError, type TtsFormat, type TtsProvider, type TtsSegment } from './types.js';

/**
 * OpenRouter text-to-speech, the fallback voice (voice US-006; plan §8.4): one
 * `POST /audio/speech` per segment with `response_format: 'pcm'`, the body
 * streamed to the call as it arrives. At most two segments are in flight, so
 * segment n+1 synthesizes while n plays without flooding the provider.
 *
 * `node:http` with keep-alive agents for the same reason as stt/openrouter.ts.
 */

/** Plan §8.4: segment n+1 synthesizes while n plays, and no more. */
export const MAX_IN_FLIGHT = 2;

const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
};

export interface OpenRouterTtsOptions {
  /** `OPENROUTER_API_URL`, e.g. `https://openrouter.ai/api/v1`. */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly voice: string;
  /** `voice_or_tts_sample_rate`: the model decides it, the operator tells us. */
  readonly sampleRate: number;
}

export class OpenRouterTts implements TtsProvider {
  readonly name = 'openrouter' as const;
  readonly format: TtsFormat;

  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Per turn, the requests of that turn, so a barge-in can abort them. */
  private readonly turns = new Map<number, Set<AbortController>>();

  constructor(private readonly opts: OpenRouterTtsOptions) {
    this.format = { kind: 'pcm16', sampleRate: opts.sampleRate };
  }

  async open(): Promise<void> {
    // Nothing per call: requests share the module's keep-alive agents.
  }

  async speak(seg: TtsSegment, signal: AbortSignal, onAudio: (chunk: Buffer) => void): Promise<{ chars: number }> {
    const text = seg.text.trim();
    if (text === '') return { chars: 0 };
    const own = new AbortController();
    const turn = this.turns.get(seg.turn) ?? new Set<AbortController>();
    this.turns.set(seg.turn, turn);
    turn.add(own);
    const both = AbortSignal.any([signal, own.signal]);
    try {
      await this.acquire(both);
      try {
        await this.request(text, both, onAudio);
      } finally {
        this.release();
      }
      return { chars: text.length };
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      // Cancelled by cancelTurn: the audio is not wanted, which is no failure.
      if (own.signal.aborted) return { chars: text.length };
      throw cause;
    } finally {
      turn.delete(own);
      if (turn.size === 0) this.turns.delete(seg.turn);
    }
  }

  cancelTurn(turn: number): void {
    for (const controller of this.turns.get(turn) ?? []) controller.abort(new Error('turn cancelled'));
    this.turns.delete(turn);
  }

  async close(): Promise<void> {
    for (const turn of [...this.turns.keys()]) this.cancelTurn(turn);
  }

  /** The peak of concurrent requests would never exceed {@link MAX_IN_FLIGHT}. */
  get inFlight(): number {
    return this.active;
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < MAX_IN_FLIGHT) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(grant);
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private request(text: string, signal: AbortSignal, onAudio: (chunk: Buffer) => void): Promise<void> {
    const target = new URL(`${this.opts.baseUrl}/audio/speech`);
    const isHttp = target.protocol === 'http:';
    const body = JSON.stringify({ model: this.opts.model, input: text, voice: this.opts.voice, response_format: 'pcm' });
    return new Promise<void>((resolve, reject) => {
      const req = (isHttp ? http : https).request(
        target,
        {
          method: 'POST',
          agent: isHttp ? agents['http:'] : agents['https:'],
          signal,
          headers: {
            Authorization: `Bearer ${this.opts.apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'HTTP-Referer': OPENROUTER_REFERER,
            'X-Title': OPENROUTER_TITLE,
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              const answer = Buffer.concat(chunks).toString('utf8');
              const kind = status === 401 || status === 403 ? 'unauthorized' : status === 402 ? 'quota' : 'http';
              reject(new TtsError(kind, status, `OpenRouter answered ${String(status)}: ${errorText(answer)}`));
            });
            res.on('error', reject);
            return;
          }
          res.on('data', (chunk: Buffer) => {
            if (!signal.aborted) onAudio(chunk);
          });
          res.on('end', () => resolve());
          res.on('error', (cause) => reject(signal.aborted ? signal.reason : netError(cause)));
        },
      );
      req.on('error', (cause) => reject(signal.aborted ? signal.reason : netError(cause)));
      req.end(body);
    });
  }
}

function netError(cause: Error): TtsError {
  return new TtsError('network', 0, `OpenRouter could not be reached: ${cause.message}`);
}
