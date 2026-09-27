/**
 * Wire protocol of the call socket `/api/voice/stream` (voice US-007; docs/voice-plan.md §6).
 * The browser keeps a copy in `web/src/voice/protocol.ts` (copied, not
 * imported).
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
  readonly payload: Buffer;
}

export function encodeFrame(kind: number, segmentId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(kind, 0);
  header.writeUInt32LE(segmentId, 1);
  return Buffer.concat([header, payload]);
}

/** `null` for a frame too short to hold the header. */
export function decodeFrame(frame: Buffer): Frame | null {
  if (frame.length < FRAME_HEADER_BYTES) return null;
  return {
    kind: frame.readUInt8(0),
    segmentId: frame.readUInt32LE(1),
    payload: frame.subarray(FRAME_HEADER_BYTES),
  };
}

/* ------------------------------------------------------------------ parsing */

/** Longest typed or transcribed message accepted, in characters. */
const MAX_TEXT_CHARS = 4000;

/** `null` when the payload is not a message this server understands. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;

  switch (m['type']) {
    case 'hello': {
      const sttMode = m['sttMode'];
      return {
        type: 'hello',
        // An unknown mode is not a protocol error: the call falls back to OpenRouter.
        sttMode: STT_MODES.includes(sttMode as SttMode) ? (sttMode as SttMode) : 'openrouter',
        sampleRateOut: typeof m['sampleRateOut'] === 'number' ? m['sampleRateOut'] : 24000,
        clientVersion: typeof m['clientVersion'] === 'string' ? m['clientVersion'] : '',
      };
    }
    case 'transcript.final': {
      const text = textOf(m['text']);
      if (text === null) return null;
      return {
        type: 'transcript.final',
        text,
        ...(typeof m['language'] === 'string' ? { language: m['language'] } : {}),
        ...(typeof m['sttMs'] === 'number' ? { sttMs: m['sttMs'] } : {}),
      };
    }
    case 'text': {
      const text = textOf(m['text']);
      return text === null ? null : { type: 'text', text };
    }
    case 'speech.start':
    case 'speech.cancel':
    case 'speculation.cancel':
    case 'hangup':
      return { type: m['type'] };
    case 'transcript.partial': {
      const text = textOf(m['text']);
      return text === null ? null : { type: 'transcript.partial', text };
    }
    case 'stt.fallback':
      return { type: 'stt.fallback', reason: typeof m['reason'] === 'string' ? m['reason'].slice(0, 100) : 'unknown' };
    case 'scribe.usage': {
      const seconds = m['seconds'];
      // A report covers a few seconds; anything else is not a report.
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return null;
      return { type: 'scribe.usage', seconds };
    }
    case 'voice.mute':
      return typeof m['muted'] === 'boolean' ? { type: 'voice.mute', muted: m['muted'] } : null;
    case 'ptt':
      return typeof m['down'] === 'boolean' ? { type: 'ptt', down: m['down'] } : null;
    case 'playback.progress': {
      const { segmentId, playedMs, done } = m;
      if (!isCount(segmentId) || typeof playedMs !== 'number' || typeof done !== 'boolean') return null;
      return { type: 'playback.progress', segmentId, playedMs, done };
    }
    case 'focus': {
      const target = m['target'];
      if (target === 'chief') return { type: 'focus', target };
      if (typeof target === 'object' && target !== null) {
        const sessionId = (target as Record<string, unknown>)['sessionId'];
        if (typeof sessionId === 'string' && sessionId !== '') return { type: 'focus', target: { sessionId } };
      }
      return null;
    }
    case 'browser.answer': {
      const { id, url, credentials, save } = m;
      if (typeof id !== 'string' || id === '' || typeof url !== 'string') return null;
      const parsedUrl = parseBrowserUrl(url);
      if (parsedUrl === null) return null;
      if (save !== undefined && typeof save !== 'boolean') return null;
      if (credentials === undefined) {
        return { type: 'browser.answer', id, url: parsedUrl, ...(save === undefined ? {} : { save }) };
      }
      const login = parseCredentials(credentials);
      if (login === null) return null;
      return { type: 'browser.answer', id, url: parsedUrl, credentials: login, ...(save === undefined ? {} : { save }) };
    }
    case 'browser.cancel': {
      const id = m['id'];
      return typeof id === 'string' && id !== '' ? { type: 'browser.cancel', id } : null;
    }
    case 'metrics': {
      const { turn, firstAudioPlayedAt } = m;
      if (!isCount(turn) || typeof firstAudioPlayedAt !== 'string') return null;
      return { type: 'metrics', turn, firstAudioPlayedAt };
    }
    default:
      return null;
  }
}

/** Parses `?focus=chief` / `?focus=session:<id>`; anything else is chief. */
export function parseFocus(raw: string | null): CallFocus {
  if (raw !== null && raw.startsWith('session:') && raw.length > 'session:'.length) {
    return { kind: 'session', sessionId: raw.slice('session:'.length) };
  }
  return { kind: 'chief' };
}

/** A typed login (a username and a non-empty password) or a saved login's id. */
function parseCredentials(value: unknown): BrowserCredentials | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  const savedLoginId = c['savedLoginId'];
  if (savedLoginId !== undefined) {
    return typeof savedLoginId === 'string' && savedLoginId !== '' && savedLoginId.length <= 100 ? { savedLoginId } : null;
  }
  const { username, password } = c;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (password === '' || username.length > MAX_CREDENTIAL_CHARS || password.length > MAX_CREDENTIAL_CHARS) return null;
  return { username, password };
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || text.length > MAX_TEXT_CHARS ? null : text;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
