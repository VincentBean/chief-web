/**
 * Browser copy of the call socket's wire protocol (voice US-009; plan §6).
 *
 * KEEP IN SYNC with `server/src/voice/protocol.ts`: the types and constants
 * below are copied from it, not imported (the web build does not reach into
 * the server). Change both files together. Only the binary frame helpers
 * differ: the server's work on `Buffer`, these on `ArrayBuffer`.
 *
 * Text frames are JSON messages, defined below. Binary frames carry a 5-byte
 * header, `u8 kind` + `u32 LE segmentId`, then the payload: kind `0x01` is one
 * utterance as a WAV file (browser → server, segment id 0), kind `0x02` a
 * chunk of a spoken segment's audio (server → browser).
 */

/** Close codes of plan §6; `4401` (unauthorized) is the gateway's own. */
export const WS_CLOSE_BAD_ORIGIN = 4403;
export const WS_CLOSE_CALL_IN_PROGRESS = 4409;
export const WS_CLOSE_TAKEN_OVER = 4410;
export const WS_CLOSE_NOT_CONFIGURED = 4422;
/** The call ended normally (hang-up, idle, `end_call`). */
export const WS_CLOSE_CALL_ENDED = 1000;

export const FRAME_HEADER_BYTES = 5;
/** Browser → server: one complete utterance, 16 kHz mono PCM16 WAV. */
export const FRAME_KIND_UTTERANCE = 0x01;
/** Server → browser: audio for the segment announced by `tts.segment`. */
export const FRAME_KIND_AUDIO = 0x02;

export type SttMode = 'openrouter' | 'elevenlabs-realtime' | 'browser';
export const STT_MODES: readonly SttMode[] = ['openrouter', 'elevenlabs-realtime', 'browser'];

export type CallFocus = { readonly kind: 'chief' } | { readonly kind: 'session'; readonly sessionId: string };
export type CallPhase = 'listening' | 'thinking' | 'speaking' | 'ended';
export type AgentKind = 'chief' | 'session';

/* ------------------------------------------------------ browser → server */

/** Plan §6.1. The WAV utterance travels as a binary kind `0x01` frame. */
export type ClientMessage =
  | {
      readonly type: 'hello';
      readonly sttMode: SttMode;
      readonly sampleRateOut: number;
      readonly clientVersion: string;
    }
  | { readonly type: 'transcript.final'; readonly text: string; readonly language?: string; readonly sttMs?: number }
  | { readonly type: 'speech.start' }
  | { readonly type: 'speech.cancel' }
  | { readonly type: 'ptt'; readonly down: boolean }
  | { readonly type: 'playback.progress'; readonly segmentId: number; readonly playedMs: number; readonly done: boolean }
  | { readonly type: 'focus'; readonly target: 'chief' | { readonly sessionId: string } }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'hangup' }
  | { readonly type: 'metrics'; readonly turn: number; readonly firstAudioPlayedAt: string };

/* ------------------------------------------------------ server → browser */

export type ToolStatus = 'running' | 'ok' | 'error';

export type UiAction =
  | { readonly action: 'navigate'; readonly path: string }
  | { readonly action: 'highlight'; readonly target: string }
  | { readonly action: 'toast'; readonly text: string };

export interface ConfirmationView {
  readonly id: string;
  readonly prompt: string;
  readonly expiresAt: string;
}

/** Plan §6.2. Audio follows `tts.segment` as binary kind `0x02` frames. */
export type ServerMessage =
  | {
      readonly type: 'ready';
      readonly callId: string;
      readonly focus: CallFocus;
      /** The mode in effect, which may differ from the one `hello` asked for. */
      readonly sttMode: SttMode;
      readonly scribeToken?: string;
      readonly earcons: readonly Readonly<Record<string, number>>[];
      readonly sampleRate: number;
      /** True when this socket continued a call that dropped (`?resume=`). */
      readonly resumed: boolean;
    }
  | { readonly type: 'state'; readonly phase: CallPhase; readonly focus: CallFocus }
  | { readonly type: 'user.transcript'; readonly turn: number; readonly text: string }
  | { readonly type: 'agent.delta'; readonly turn: number; readonly agent: AgentKind; readonly text: string }
  | { readonly type: 'agent.done'; readonly turn: number; readonly interrupted: boolean }
  | {
      readonly type: 'tts.segment';
      readonly segmentId: number;
      readonly turn: number;
      readonly text: string;
      readonly sampleRate: number;
      readonly format: 'pcm16' | 'mp3';
    }
  | { readonly type: 'tts.end'; readonly segmentId: number }
  | { readonly type: 'tts.stop'; readonly turn: number }
  | {
      readonly type: 'tool';
      readonly turn: number;
      readonly id: string;
      readonly name: string;
      readonly status: ToolStatus;
      readonly summary: string;
      readonly detail?: string;
    }
  | ({ readonly type: 'confirm' } & ConfirmationView)
  | ({ readonly type: 'ui' } & UiAction)
  | { readonly type: 'usage'; readonly elCreditsUsed: number; readonly orCostUsd: number; readonly elCreditsRemaining?: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly fatal: boolean };

/* ------------------------------------------------------------ binary frames */

export interface Frame {
  readonly kind: number;
  readonly segmentId: number;
  /** A copy starting at offset 0, so typed-array views over it are aligned. */
  readonly payload: ArrayBuffer;
}

export function encodeFrame(kind: number, segmentId: number, payload: ArrayBuffer): ArrayBuffer {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, segmentId, true);
  frame.set(new Uint8Array(payload), FRAME_HEADER_BYTES);
  return frame.buffer;
}

/** `null` for a frame too short to hold the header. */
export function decodeFrame(frame: ArrayBuffer): Frame | null {
  if (frame.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(frame);
  return {
    kind: view.getUint8(0),
    segmentId: view.getUint32(1, true),
    payload: frame.slice(FRAME_HEADER_BYTES),
  };
}
