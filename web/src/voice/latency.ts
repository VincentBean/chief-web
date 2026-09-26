/**
 * The debug overlay's arithmetic (voice US-026): a turn's timestamps as the
 * deltas between its stages. `docs/voice.md#latency` explains each stage.
 */
import type { TurnTimes } from './protocol.ts';

export interface LatencyStage {
  readonly label: string;
  /** What the stage is and which setting moves it, for the tooltip. */
  readonly title: string;
  readonly ms: number | null;
}

/** Target for speech end → first audio played. */
export const LATENCY_TARGET_MS = 2000;

function between(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  return Date.parse(to) - Date.parse(from);
}

/** The server heard the end of speech → the transcript was ready; null without a server-side speech end. */
export function sttMs(times: TurnTimes | undefined): number | null {
  return times === undefined ? null : between(times.speechEnd, times.transcript);
}

export function latencyStages(times: TurnTimes): LatencyStage[] {
  return [
    { label: 'STT', title: 'Speech end → transcript (Speech-to-text model, VAD silence)', ms: sttMs(times) },
    { label: 'LLM', title: 'Transcript → first token (Chat model, or the session agent)', ms: between(times.transcript, times.firstToken) },
    { label: 'Chunk', title: 'First token → first speakable sentence', ms: between(times.firstToken, times.firstChunk) },
    { label: 'TTS', title: 'First sentence → first audio sent (Text-to-speech provider and model)', ms: between(times.firstChunk, times.firstAudioSent) },
    { label: 'Play', title: 'First audio sent → first audio played in this browser (network, jitter buffer)', ms: between(times.firstAudioSent, times.firstAudioPlayed) },
  ];
}

/** From the end of speech (or the transcript, when that is all there is) to the first audio played. */
export function totalMs(times: TurnTimes): number | null {
  return between(times.speechEnd ?? times.transcript, times.firstAudioPlayed);
}

/** The newest turn the operator started (it has a transcript). */
export function lastTimedTurn(latency: Readonly<Record<number, TurnTimes>>): TurnTimes | null {
  let newest: number | null = null;
  for (const [key, times] of Object.entries(latency)) {
    const turn = Number(key);
    if (times.transcript !== null && (newest === null || turn > newest)) newest = turn;
  }
  return newest === null ? null : (latency[newest] ?? null);
}

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${String(Math.round(ms))} ms`;
}
