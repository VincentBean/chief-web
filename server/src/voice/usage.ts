import type { UpdateVoiceCallInput } from '../db/index.js';
import type { ElevenLabsSubscription } from './providers.js';

/** How often a call re-reads `GET /v1/user/subscription` (docs/voice-plan.md §13). */
export const SUBSCRIPTION_REFRESH_MS = 5 * 60_000;
/** OpenRouter's generation stats can lag the response; the lookup waits this long first. */
export const GENERATION_LOOKUP_DELAY_MS = 3_000;
/** And tries again once after this long when the first read found nothing. */
export const GENERATION_RETRY_MS = 10_000;
/** Scribe seconds a call needs before its subscription delta says anything about the rate. */
export const SCRIBE_CALIBRATION_MIN_SECONDS = 30;

/** One addition to a call's counters; every field is optional. */
export interface UsageDelta {
  readonly elChars?: number;
  readonly scribeSeconds?: number;
  readonly sttSeconds?: number;
  readonly sttCostUsd?: number;
  readonly chatCostUsd?: number;
  readonly ttsCostUsd?: number;
  readonly claudeTurns?: number;
}

export interface UsageTotals {
  readonly elChars: number;
  readonly scribeSeconds: number;
  readonly sttSeconds: number;
  readonly sttCostUsd: number;
  readonly chatCostUsd: number;
  readonly ttsCostUsd: number;
  readonly claudeTurns: number;
}

/** What the panel meter gets (the `usage` server message without its type). */
export interface UsageReport {
  /** ElevenLabs characters (credits) this call spent on its voice. */
  readonly elCreditsUsed: number;
  /** OpenRouter dollars this call: speech-to-text, chief, and the backup voice once looked up. */
  readonly orCostUsd: number;
  /** The authoritative balance at the last refresh, less what the call spent since. */
  readonly elCreditsRemaining?: number;
  /** The plan's monthly allowance. */
  readonly elCreditsLimit?: number;
}

/**
 * The usage of one call (voice US-023; docs/voice-plan.md §13): ElevenLabs characters,
 * Scribe seconds, STT seconds and dollars, chief's chat dollars, the backup
 * voice's dollars (looked up after the call from its generation ids) and
 * Claude turns. Clock-free and I/O-free: the call feeds it and persists
 * {@link toCallUpdate}.
 */
export class CallUsage {
  private totals: UsageTotals = {
    elChars: 0,
    scribeSeconds: 0,
    sttSeconds: 0,
    sttCostUsd: 0,
    chatCostUsd: 0,
    ttsCostUsd: 0,
    claudeTurns: 0,
  };
  private readonly generations: string[] = [];
  /** The first subscription read, for the call's credit delta. */
  private first: ElevenLabsSubscription | null = null;
  /** The last read, and the call's characters at that moment. */
  private last: { readonly subscription: ElevenLabsSubscription; readonly atElChars: number } | null = null;

  add(delta: UsageDelta): void {
    const t = this.totals;
    this.totals = {
      elChars: t.elChars + (delta.elChars ?? 0),
      scribeSeconds: t.scribeSeconds + (delta.scribeSeconds ?? 0),
      sttSeconds: t.sttSeconds + (delta.sttSeconds ?? 0),
      sttCostUsd: t.sttCostUsd + (delta.sttCostUsd ?? 0),
      chatCostUsd: t.chatCostUsd + (delta.chatCostUsd ?? 0),
      ttsCostUsd: t.ttsCostUsd + (delta.ttsCostUsd ?? 0),
      claudeTurns: t.claudeTurns + (delta.claudeTurns ?? 0),
    };
  }

  /** An OpenRouter speech request whose cost is looked up after the call. */
  addGeneration(id: string): void {
    this.generations.push(id);
  }

  get generationIds(): readonly string[] {
    return this.generations;
  }

  snapshot(): UsageTotals {
    return this.totals;
  }

  get orCostUsd(): number {
    const t = this.totals;
    return t.sttCostUsd + t.chatCostUsd + t.ttsCostUsd;
  }

  /** An authoritative balance: the meter's local estimate restarts from it. */
  noteSubscription(subscription: ElevenLabsSubscription): void {
    this.first ??= subscription;
    this.last = { subscription, atElChars: this.totals.elChars };
  }

  get firstSubscription(): ElevenLabsSubscription | null {
    return this.first;
  }

  report(): UsageReport {
    const base = { elCreditsUsed: this.totals.elChars, orCostUsd: this.orCostUsd };
    if (this.last === null) return base;
    const { subscription, atElChars } = this.last;
    const since = this.totals.elChars - atElChars;
    return {
      ...base,
      elCreditsRemaining: Math.max(0, subscription.remaining - since),
      elCreditsLimit: subscription.characterLimit,
    };
  }

  /** The `voice_calls` counters; `or_cost_usd` is every OpenRouter dollar. */
  toCallUpdate(): UpdateVoiceCallInput {
    const t = this.totals;
    return {
      elChars: t.elChars,
      sttSeconds: t.sttSeconds,
      scribeSeconds: t.scribeSeconds,
      orCostUsd: this.orCostUsd,
      claudeTurns: t.claudeTurns,
    };
  }
}

/**
 * Scribe's price in credits per minute on the operator's plan, from what the
 * balance moved over a call beyond the voice's own characters. Null when the
 * call says nothing useful: too little Scribe, or no movement to attribute.
 */
export function scribeCreditsPerMinute(
  start: ElevenLabsSubscription,
  end: ElevenLabsSubscription,
  elChars: number,
  scribeSeconds: number,
): number | null {
  if (scribeSeconds < SCRIBE_CALIBRATION_MIN_SECONDS) return null;
  // A reset between the two reads makes the delta meaningless.
  if (end.characterCount < start.characterCount) return null;
  const scribeCredits = end.characterCount - start.characterCount - elChars;
  if (scribeCredits <= 0) return null;
  return scribeCredits / (scribeSeconds / 60);
}
