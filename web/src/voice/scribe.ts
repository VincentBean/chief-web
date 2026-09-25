/**
 * ElevenLabs Scribe v2 Realtime, browser-direct (voice US-022; docs/voice-plan.md §7.2).
 * The microphone's 100 ms PCM16 batches go straight to ElevenLabs over a
 * socket opened with a single-use token from `POST /api/voice/scribe-token`;
 * partials become captions (and the barge-in signal), commits become
 * `transcript.final` on the call socket.
 *
 * Silence is billed, so it is not streamed: nothing is sent while the agent
 * speaks unless barge-in is on, the socket closes after
 * `VOICE_SCRIBE_IDLE_CLOSE_MS` without speech, and the next local VAD speech
 * start opens a new one (with a new token) and sends the last 300 ms first.
 */
import { ApiError } from '../api.ts';
import { CAPTURE_SAMPLE_RATE } from './mic.ts';

/** What `POST /api/voice/scribe-token` answers. */
export interface ScribeSession {
  readonly token: string;
  readonly url: string;
  readonly language: string;
  readonly secondaryLanguage: string | null;
  /** Empty unless `voice_keyterms_enabled`. */
  readonly keyterms: readonly string[];
  readonly idleCloseMs: number;
}

export async function mintScribeSession(): Promise<ScribeSession> {
  const res = await fetch('/api/voice/scribe-token', { method: 'POST', credentials: 'same-origin' });
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // No JSON: the status says enough.
    }
    throw new ApiError(res.status, body.error ?? 'scribe_token_failed', body.message ?? null);
  }
  return (await res.json()) as ScribeSession;
}

/** docs/voice-plan.md §7.2: VAD commits after 0.8 s of silence. */
export const SCRIBE_VAD_SILENCE_SECS = 0.8;
export const SCRIBE_MODEL = 'scribe_v2_realtime';
/** Kept locally before a (re)open, so the first syllable is not lost. */
export const PRE_ROLL_MS = 300;
/** A partial unchanged this long goes to chief early (`voice_speculative_chief`). */
export const STABLE_PARTIAL_MS = 300;
/** Errors after which Scribe is given up for the rest of the call. */
export const FATAL_SCRIBE_ERRORS = ['quota_exceeded', 'auth_error', 'session_time_limit_exceeded'] as const;
/** Sockets in a row that close before their session starts, before giving up. */
const MAX_FAILED_OPENS = 3;
/** Audio held while a socket opens, at most. */
const MAX_PENDING_MS = 10_000;
const USAGE_REPORT_MS = 5_000;
const BYTES_PER_SECOND = CAPTURE_SAMPLE_RATE * 2;

export function scribeUrl(session: ScribeSession): string {
  const params = new URLSearchParams();
  params.append('model_id', SCRIBE_MODEL);
  params.append('token', session.token);
  params.append('audio_format', `pcm_${String(CAPTURE_SAMPLE_RATE)}`);
  params.append('commit_strategy', 'vad');
  params.append('vad_silence_threshold_secs', String(SCRIBE_VAD_SILENCE_SECS));
  params.append('language_code', session.language);
  if (session.secondaryLanguage !== null) params.append('secondary_languages', session.secondaryLanguage);
  for (const term of session.keyterms) params.append('keyterms', term);
  return `${session.url}?${params.toString()}`;
}

export interface ScribeSink {
  /** A non-empty partial transcript. */
  partial(text: string): void;
  /** A committed transcript. */
  committed(text: string): void;
  /** Scribe is gone for this call (quota, auth, time limit, no token). */
  fatal(reason: string): void;
  /** Seconds of audio streamed since the last report. */
  seconds(seconds: number): void;
  /** `voice_speculative_chief`: a partial held still for {@link STABLE_PARTIAL_MS}. */
  stable?(text: string): void;
  /** The words moved on after `stable`. */
  unstable?(): void;
}

export interface ScribeOptions {
  /** Whether audio is held back now (the agent speaks and barge-in is off). */
  paused: () => boolean;
  speculative: boolean;
  mint?: () => Promise<ScribeSession>;
  openSocket?: (url: string) => WebSocket;
}

export class ScribeClient {
  private ws: WebSocket | null = null;
  private state: 'closed' | 'opening' | 'open' | 'dead' = 'closed';
  /** The last {@link PRE_ROLL_MS} of microphone audio, always. */
  private readonly ring: ArrayBuffer[] = [];
  private ringBytes = 0;
  /** Audio waiting for the socket to open. */
  private pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private lastSpeechAt = 0;
  private idleCloseMs = 20_000;
  private failedOpens = 0;
  private unreportedBytes = 0;
  private readonly timer: number;
  private lastPartial = '';
  private stableTimer: number | null = null;
  private stableSent = false;

  constructor(
    private readonly sink: ScribeSink,
    private readonly options: ScribeOptions,
  ) {
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  /** Every capture batch (PCM16 LE, 16 kHz mono, ~100 ms). */
  push(batch: ArrayBuffer): void {
    if (this.state === 'dead') return;
    this.ring.push(batch);
    this.ringBytes += batch.byteLength;
    while (this.ring.length > 1 && this.ringBytes - (this.ring[0]?.byteLength ?? 0) >= (BYTES_PER_SECOND * PRE_ROLL_MS) / 1000) {
      this.ringBytes -= this.ring.shift()?.byteLength ?? 0;
    }
    if (this.options.paused()) return;
    if (this.state === 'open') this.send(batch);
    else if (this.state === 'opening' && this.pendingBytes < (BYTES_PER_SECOND * MAX_PENDING_MS) / 1000) {
      this.pending.push(batch);
      this.pendingBytes += batch.byteLength;
    }
  }

  /** The local VAD heard speech start: (re)open with the pre-roll. */
  speechStarted(): void {
    this.lastSpeechAt = Date.now();
    if (this.state !== 'closed') return;
    this.pending = [...this.ring];
    this.pendingBytes = this.ringBytes;
    void this.open();
  }

  get active(): boolean {
    return this.state !== 'dead';
  }

  close(): void {
    window.clearInterval(this.timer);
    this.clearStable();
    this.state = 'dead';
    this.shut();
    this.report();
  }

  private async open(): Promise<void> {
    this.state = 'opening';
    let session: ScribeSession;
    try {
      // Single use: every socket gets a fresh token.
      session = await (this.options.mint ?? mintScribeSession)();
    } catch (cause) {
      this.giveUp(cause instanceof ApiError && cause.status === 429 ? 'token_rate_limited' : 'token_failed');
      return;
    }
    if (this.state !== 'opening') return;
    this.idleCloseMs = session.idleCloseMs;
    const ws = (this.options.openSocket ?? ((url) => new WebSocket(url)))(scribeUrl(session));
    this.ws = ws;
    let started = false;
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      let message: { message_type?: string; text?: string; error?: string };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (message.message_type === 'session_started') {
        started = true;
        this.failedOpens = 0;
        this.state = 'open';
        for (const batch of this.pending) this.send(batch);
        this.pending = [];
        this.pendingBytes = 0;
        return;
      }
      this.onMessage(message.message_type ?? '', message.text ?? '');
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.state === 'dead') return;
      this.state = 'closed';
      this.pending = [];
      this.pendingBytes = 0;
      if (!started && ++this.failedOpens >= MAX_FAILED_OPENS) this.giveUp('unreachable');
    };
  }

  private onMessage(type: string, text: string): void {
    if ((FATAL_SCRIBE_ERRORS as readonly string[]).includes(type)) {
      this.giveUp(type);
      return;
    }
    const trimmed = text.trim();
    if (type === 'partial_transcript') {
      if (trimmed === '') return;
      this.lastSpeechAt = Date.now();
      this.sink.partial(trimmed);
      this.watchStable(trimmed);
    } else if (type === 'committed_transcript') {
      this.clearStable();
      this.lastPartial = '';
      this.stableSent = false;
      if (trimmed === '') return;
      this.lastSpeechAt = Date.now();
      this.sink.committed(trimmed);
    }
  }

  private watchStable(text: string): void {
    if (!this.options.speculative || text === this.lastPartial) return;
    this.lastPartial = text;
    this.clearStable();
    if (this.stableSent) {
      this.stableSent = false;
      this.sink.unstable?.();
    }
    this.stableTimer = window.setTimeout(() => {
      this.stableTimer = null;
      this.stableSent = true;
      this.sink.stable?.(text);
    }, STABLE_PARTIAL_MS);
  }

  private clearStable(): void {
    if (this.stableTimer !== null) window.clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private send(batch: ArrayBuffer): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64(batch),
        commit: false,
        sample_rate: CAPTURE_SAMPLE_RATE,
      }),
    );
    this.unreportedBytes += batch.byteLength;
  }

  private tick(): void {
    if (this.state === 'open' && Date.now() - this.lastSpeechAt >= this.idleCloseMs) {
      this.state = 'closed';
      this.shut();
    }
    if (this.unreportedBytes >= (BYTES_PER_SECOND * USAGE_REPORT_MS) / 1000) this.report();
  }

  private report(): void {
    if (this.unreportedBytes === 0) return;
    this.sink.seconds(this.unreportedBytes / BYTES_PER_SECOND);
    this.unreportedBytes = 0;
  }

  private shut(): void {
    const ws = this.ws;
    this.ws = null;
    this.pending = [];
    this.pendingBytes = 0;
    if (ws !== null && ws.readyState <= WebSocket.OPEN) ws.close(1000);
  }

  private giveUp(reason: string): void {
    if (this.state === 'dead') return;
    this.close();
    this.sink.fatal(reason);
  }
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
