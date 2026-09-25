/**
 * Single-use tokens for ElevenLabs Scribe v2 Realtime (voice US-022; plan
 * §7.2). The browser streams its microphone straight to ElevenLabs, so it
 * needs a credential; it gets a token that works for one realtime session
 * and expires after 15 minutes, never the API key.
 *
 * The SDK's `tokens.singleUse.create("realtime_scribe")` is this REST call:
 * `POST /v1/single-use-token/realtime_scribe`, `xi-api-key`, no body,
 * answering `{"token": "sutkn_…"}` (API reference, "Create single use token").
 */
import { errorText, VoiceProviderError } from '../providers.js';

export const SCRIBE_TOKEN_TYPE = 'realtime_scribe';
/** ElevenLabs lets a single-use token live this long. */
export const SCRIBE_TOKEN_TTL_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface ScribeToken {
  readonly token: string;
  /** When ElevenLabs stops accepting it, counted from the mint. */
  readonly expiresAt: string;
}

export async function mintScribeToken(baseUrl: string, apiKey: string, now: Date = new Date()): Promise<ScribeToken> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/single-use-token/${SCRIBE_TOKEN_TYPE}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new VoiceProviderError(
      'elevenlabs',
      'unreachable',
      `ElevenLabs could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'unauthorized' : 'error';
    throw new VoiceProviderError('elevenlabs', kind, `ElevenLabs answered ${String(res.status)}: ${errorText(text)}`, res.status);
  }
  let token: unknown;
  try {
    token = (JSON.parse(text) as { token?: unknown }).token;
  } catch {
    token = undefined;
  }
  if (typeof token !== 'string' || token === '') {
    throw new VoiceProviderError('elevenlabs', 'error', 'ElevenLabs answered without a token.');
  }
  return { token, expiresAt: new Date(now.getTime() + SCRIBE_TOKEN_TTL_MS).toISOString() };
}

/**
 * A sliding-window cap on mints (plan §14.3: 10 per hour). Every mint counts,
 * not only failures: a token is a credential to spend credits with, and a
 * browser stuck in a reconnect loop should hit the wall, not the bill.
 */
export class MintLimit {
  private readonly mints: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records a mint and returns 0, or the whole seconds until one is allowed. */
  take(now: number): number {
    while (this.mints.length > 0 && (this.mints[0] as number) <= now - this.windowMs) this.mints.shift();
    if (this.mints.length >= this.max) {
      return Math.max(1, Math.ceil(((this.mints[0] as number) + this.windowMs - now) / 1000));
    }
    this.mints.push(now);
    return 0;
  }

  /** Gives a mint back (the provider refused, so nothing was spent). */
  release(): void {
    this.mints.pop();
  }
}
