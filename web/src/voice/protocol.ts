/**
 * Browser copy of the call socket's wire protocol (voice US-009; docs/voice-plan.md §6).
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

/** Close codes of docs/voice-plan.md §6; `4401` (unauthorized) is the gateway's own. */
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

/** docs/voice-plan.md §6.1. The WAV utterance travels as a binary kind `0x01` frame. */
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
  /** The panel's mute-voice button (US-021): text only until unmuted, like the `mute` intent. */
  | { readonly type: 'voice.mute'; readonly muted: boolean }
  | { readonly type: 'hangup' }
  /** The pill's Confirm / Cancel button (voice US-011). */
  | { readonly type: 'confirm.resolve'; readonly id: string; readonly accept: boolean }
  /**
   * The "watch with me" card's **Open** (voice feedback US-007): the URL the
   * session agent's browser opens, and the login to use, typed or saved.
   */
  | {
      readonly type: 'browser.answer';
      readonly id: string;
      readonly url: string;
      readonly credentials?: BrowserCredentials;
      /** "Save this login for <repository>" (US-010). */
      readonly save?: boolean;
    }
  /** The card's **Cancel**. */
  | { readonly type: 'browser.cancel'; readonly id: string }
  | { readonly type: 'metrics'; readonly turn: number; readonly firstAudioPlayedAt: string }
  /**
   * Scribe realtime (US-022): the browser gave up on Scribe (quota, auth, the
   * session time limit, no token) and sends WAV utterances from now on.
   */
  | { readonly type: 'stt.fallback'; readonly reason: string }
  /** Scribe realtime: seconds of microphone audio streamed since the last report. */
  | { readonly type: 'scribe.usage'; readonly seconds: number }
  /**
   * `voice_speculative_chief`: a partial transcript unchanged for 300 ms.
   * Chief may start on it; a `transcript.final` with the same text keeps
   * that answer, anything else throws it away.
   */
  | { readonly type: 'transcript.partial'; readonly text: string }
  /** The words moved on after a `transcript.partial`: drop that answer. */
  | { readonly type: 'speculation.cancel' };

/* ------------------------------------------------------ server → browser */

export type ToolStatus = 'running' | 'ok' | 'error';

export type UiAction =
  | { readonly action: 'navigate'; readonly path: string }
  | { readonly action: 'highlight'; readonly target: string }
  | { readonly action: 'toast'; readonly text: string };

/** How a confirmation stopped being pending. */
export type ConfirmationOutcome = 'confirmed' | 'cancelled' | 'expired';

export interface ConfirmationView {
  readonly id: string;
  readonly prompt: string;
  readonly expiresAt: string;
}

/** A login typed into the "watch with me" card, or a saved one by id. */
export type BrowserCredentials =
  | { readonly username: string; readonly password: string }
  | { readonly savedLoginId: string };

/** A repository's saved login as the card lists it; never its password. */
export interface SavedLoginView {
  readonly id: string;
  readonly label: string;
  readonly url: string;
}

/** How a "watch with me" card stopped being pending. */
export type BrowserAskOutcome = 'opened' | 'cancelled' | 'expired';

/** Longest URL the card accepts, in characters. */
export const MAX_BROWSER_URL_CHARS = 2000;
/** Longest username or password the card accepts, in characters. */
export const MAX_CREDENTIAL_CHARS = 500;

/**
 * The card's URL, normalised, or null unless it is an absolute `http:` or
 * `https:` URL.
 */
export function parseBrowserUrl(raw: string): string | null {
  const text = raw.trim();
  if (text === '' || text.length > MAX_BROWSER_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.href;
}

/** An earcon of `ready`: its audio arrives under `segmentId`, PCM16 at `sampleRate`. */
export interface EarconRef {
  readonly name: string;
  readonly segmentId: number;
  readonly sampleRate: number;
}

/**
 * Where the time of one turn went (US-026), ISO timestamps or null when that
 * stage did not happen: the server's clock, except `firstAudioPlayed`, which
 * is the browser's (the `metrics` message).
 */
export interface TurnTimes {
  readonly speechEnd: string | null;
  readonly transcript: string | null;
  readonly firstToken: string | null;
  readonly firstChunk: string | null;
  readonly firstAudioSent: string | null;
  readonly firstAudioPlayed: string | null;
}

/** A planning session as the call panel shows it (US-013). */
export interface PlanningSessionView {
  readonly sessionId: string;
  readonly name: string;
  readonly repository: string;
  readonly state: 'briefing' | 'drafting' | 'waiting' | 'done' | 'failed';
  readonly openQuestions: number;
  readonly stories: number;
}

/** docs/voice-plan.md §6.2. Audio follows `tts.segment` as binary kind `0x02` frames. */
export type ServerMessage =
  | {
      readonly type: 'ready';
      readonly callId: string;
      readonly focus: CallFocus;
      /** The mode in effect, which may differ from the one `hello` asked for. */
      readonly sttMode: SttMode;
      readonly scribeToken?: string;
      /**
       * The pre-rendered acknowledgements (US-021), in the call's language: each
       * one's audio follows as binary kind `0x02` frames under its segment id,
       * then a `tts.end`. Keep them; `earcon` plays one by name.
       */
      readonly earcons: readonly EarconRef[];
      readonly sampleRate: number;
      /** True when this socket continued a call that dropped (`?resume=`). */
      readonly resumed: boolean;
    }
  /** `muted`: the voice is off (the `mute` intent or `voice.mute`); replies are text only. */
  | { readonly type: 'state'; readonly phase: CallPhase; readonly focus: CallFocus; readonly muted: boolean }
  /**
   * Where every planning session stands (US-011, US-013): sent right after
   * `ready` and whenever one of them changed, most recently updated first.
   */
  | { readonly type: 'planning'; readonly sessions: readonly PlanningSessionView[] }
  /** Plays a cached earcon now (US-021): no agent audio 700 ms after the operator stopped, a booting session agent, a missed utterance. */
  | { readonly type: 'earcon'; readonly name: string }
  | { readonly type: 'user.transcript'; readonly turn: number; readonly text: string }
  | { readonly type: 'agent.delta'; readonly turn: number; readonly agent: AgentKind; readonly text: string }
  | { readonly type: 'agent.done'; readonly turn: number; readonly interrupted: boolean }
  /** A turn's timestamps so far (US-026), sent again whenever one more is known. */
  | { readonly type: 'latency'; readonly turn: number; readonly times: TurnTimes }
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
  | { readonly type: 'confirm.resolved'; readonly id: string; readonly outcome: ConfirmationOutcome }
  | ({ readonly type: 'ui' } & UiAction)
  /**
   * The session agent asked to look at a page with the operator (voice
   * feedback US-007): the call panel shows the "watch with me" card until
   * `browser.resolved`. `hint` is what the agent wants to look at.
   */
  | {
      readonly type: 'browser.ask';
      readonly id: string;
      readonly sessionId: string;
      readonly hint: string;
      readonly savedLogins: readonly SavedLoginView[];
      readonly expiresAt: string;
    }
  | { readonly type: 'browser.resolved'; readonly id: string; readonly outcome: BrowserAskOutcome }
  /**
   * The meter (US-023): this call's ElevenLabs credits and OpenRouter
   * dollars; the balance and monthly limit once ElevenLabs was asked, the
   * remaining credits estimated locally between its 5-minute refreshes.
   */
  | {
      readonly type: 'usage';
      readonly elCreditsUsed: number;
      readonly orCostUsd: number;
      readonly elCreditsRemaining?: number;
      readonly elCreditsLimit?: number;
    }
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
