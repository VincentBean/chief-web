import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { fetchSettings, fetchVoiceStatus, type VoiceSettings, type VoiceStatus } from '../api.ts';
import { navigate, useLocation } from '../router.tsx';
import { useToast } from '../toast.tsx';
import { CallAudio, type SttOptions, type TalkMode } from './call-audio.ts';
import {
  type AgentKind,
  type CallFocus,
  type CallPhase,
  type ClientMessage,
  type ConfirmationOutcome,
  type ServerMessage,
  type SttMode,
  type ToolStatus,
  WS_CLOSE_BAD_ORIGIN,
  WS_CLOSE_CALL_ENDED,
  WS_CLOSE_CALL_IN_PROGRESS,
  WS_CLOSE_NOT_CONFIGURED,
  WS_CLOSE_TAKEN_OVER,
} from './protocol.ts';

/**
 * The call, owned above the pages (voice US-010) so it survives navigation:
 * the socket, the audio, the transcript and every action the panel offers.
 * `CallPanel` and the sidebar's Call item only read this context.
 *
 * One call at a time, like the server. `start()` must run inside the click
 * (or key press) that asked for it: `CallAudio` creates and resumes its
 * audio contexts in its constructor, which browsers only allow during a
 * user gesture, so nothing before it may await.
 */

const WS_PATH = '/api/voice/stream';
const CLIENT_VERSION = 'web-1';
/** The server keeps a dropped call this long (`RESUME_WINDOW_MS`). */
const RESUME_WINDOW_MS = 30_000;
const RESUME_DELAY_MS = 1000;
const MODE_KEY = 'chief.voice.mode';
/** Used until Settings has been read; the server's own default. */
const DEFAULT_VAD_SILENCE_MS = 700;

/** Where the microphone's HTTPS requirement is explained. */
export const HTTPS_DOCS_URL = 'https://github.com/VincentBean/chief-web/blob/main/docs/voice.md#https';

export type CallStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended';

export type TranscriptEntry =
  | { readonly kind: 'user'; readonly key: string; readonly turn: number; readonly text: string }
  | {
      readonly kind: 'agent';
      readonly key: string;
      readonly turn: number;
      readonly agent: AgentKind;
      readonly text: string;
      readonly interrupted: boolean;
    }
  | {
      readonly kind: 'tool';
      readonly key: string;
      readonly id: string;
      readonly name: string;
      readonly status: ToolStatus;
      readonly summary: string;
    }
  | {
      readonly kind: 'confirm';
      readonly key: string;
      readonly id: string;
      readonly prompt: string;
      readonly expiresAt: string;
      readonly resolution: ConfirmationOutcome | null;
    }
  | { readonly kind: 'notice'; readonly key: string; readonly text: string };

export interface CallUsage {
  readonly elCreditsUsed: number;
  readonly orCostUsd: number;
  readonly elCreditsRemaining: number | null;
}

export interface CallState {
  /** `null` until `/api/voice/status` answered. */
  readonly availability: VoiceStatus | null;
  /** False when `voice_enabled` is off: the Call item is hidden. */
  readonly enabled: boolean;
  readonly status: CallStatus;
  readonly phase: CallPhase;
  readonly focusedOn: CallFocus;
  /** Epoch ms of the first `ready`, for the timer. */
  readonly startedAt: number | null;
  readonly transcript: readonly TranscriptEntry[];
  readonly micOpen: boolean;
  readonly micMuted: boolean;
  readonly voiceMuted: boolean;
  readonly mode: TalkMode;
  readonly talking: boolean;
  /** Live caption of what the operator is saying (Scribe partials or Web Speech), '' when none (US-022). */
  readonly caption: string;
  readonly usage: CallUsage | null;
  /** Why the microphone or the call could not start, shown in the panel. */
  readonly problem: CallProblem | null;
  readonly panelOpen: boolean;
  readonly panelRef: RefObject<HTMLElement | null>;
}

export type CallProblem =
  | { readonly kind: 'insecure' }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'error'; readonly message: string };

export interface CallActions {
  /** Opens the panel and starts a call when none runs. Call from a gesture. */
  open(): void;
  closePanel(): void;
  /** `focus` opens the call on a session's own agent (`?focus=session:<id>`). */
  start(options?: { takeover?: boolean; focus?: CallFocus }): void;
  hangup(): void;
  ptt(down: boolean): void;
  /** The stop button: interrupts the agent's turn, with no reply (always works, whatever `voice_barge_in` says). */
  stopAgent(): void;
  focus(target: 'chief' | { sessionId: string }): void;
  text(text: string): void;
  muteMic(muted: boolean): void;
  muteVoice(muted: boolean): void;
  setMode(mode: TalkMode): void;
  /** Answers a confirmation pill; the server runs or drops exactly that one. */
  resolve(id: string, confirm: boolean): void;
}

export type CallContext = CallState & CallActions;

const Context = createContext<CallContext | null>(null);

function readMode(): TalkMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'push-to-talk' ? 'push-to-talk' : 'hands-free';
  } catch {
    return 'hands-free';
  }
}

function storeMode(mode: TalkMode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Private mode or a full quota: the mode just is not remembered.
  }
}

/** The words behind `4422`'s reason, pointing at the place that fixes it. */
function notConfiguredText(reason: string): string {
  switch (reason) {
    case 'voice_disabled':
      return 'Voice is turned off. Turn it on in Settings → Voice.';
    case 'openrouter_key_missing':
      return 'Voice needs an OpenRouter API key. Add one in Settings → Voice.';
    case 'elevenlabs_key_missing':
      return 'Scribe needs an ElevenLabs API key. Add one in Settings → Voice.';
    default:
      return 'Voice is not set up yet. See Settings → Voice.';
  }
}

/**
 * Marks the element for a moment; `styles/feedback.css` pulses it. The target
 * is a `data-voice-target` name first, then an id, then a CSS selector.
 */
function highlight(target: string): void {
  let element: Element | null = document.querySelector(`[data-voice-target="${CSS.escape(target)}"]`);
  element ??= document.getElementById(target);
  if (element === null) {
    try {
      element = document.querySelector(target);
    } catch {
      element = null;
    }
  }
  if (element === null) return;
  const marked = element;
  marked.setAttribute('data-voice-highlight', '');
  marked.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  window.setTimeout(() => marked.removeAttribute('data-voice-highlight'), 2400);
}

/** Applies one server message to the transcript. */
function applyToTranscript(entries: readonly TranscriptEntry[], message: ServerMessage): readonly TranscriptEntry[] {
  switch (message.type) {
    case 'user.transcript':
      return [...entries, { kind: 'user', key: `u${String(message.turn)}`, turn: message.turn, text: message.text }];
    case 'agent.delta': {
      const last = entries[entries.length - 1];
      // A tool card between two deltas starts a new line, so text keeps its order.
      if (last?.kind === 'agent' && last.turn === message.turn) {
        return [...entries.slice(0, -1), { ...last, text: last.text + message.text }];
      }
      return [
        ...entries,
        {
          kind: 'agent',
          key: `a${String(message.turn)}-${String(entries.length)}`,
          turn: message.turn,
          agent: message.agent,
          text: message.text,
          interrupted: false,
        },
      ];
    }
    case 'agent.done':
      if (!message.interrupted) return entries;
      return entries.map((entry) =>
        entry.kind === 'agent' && entry.turn === message.turn ? { ...entry, interrupted: true } : entry,
      );
    case 'tool': {
      const index = entries.findIndex((entry) => entry.kind === 'tool' && entry.id === message.id);
      const next: TranscriptEntry = {
        kind: 'tool',
        key: `t${message.id}`,
        id: message.id,
        name: message.name,
        status: message.status,
        summary: message.summary,
      };
      return index === -1 ? [...entries, next] : entries.map((entry, i) => (i === index ? next : entry));
    }
    case 'confirm': {
      // One confirmation is pending at a time; an older pill is superseded.
      const others = entries.filter((entry) => entry.kind !== 'confirm' || entry.resolution !== null);
      return [
        ...others,
        {
          kind: 'confirm',
          key: `c${message.id}`,
          id: message.id,
          prompt: message.prompt,
          expiresAt: message.expiresAt,
          resolution: null,
        },
      ];
    }
    case 'confirm.resolved':
      // A spoken yes/no, a focus switch, expiry or the end of the call; the
      // server's word also overrides a click it found stale.
      return entries.map((entry) =>
        entry.kind === 'confirm' && entry.id === message.id
          ? { ...entry, resolution: message.outcome }
          : entry,
      );
    case 'error':
      return [...entries, { kind: 'notice', key: `e${String(entries.length)}`, text: message.message }];
    default:
      return entries;
  }
}

/**
 * The STT mode `hello` asks for: the configured provider, except that the
 * `browser` one (audio goes to the browser vendor) only runs in development.
 */
function requestedSttMode(status: VoiceStatus | null): SttMode {
  const provider = status?.providers.stt;
  if (provider === 'elevenlabs-realtime') return provider;
  if (provider === 'browser' && import.meta.env.DEV) return provider;
  return 'openrouter';
}

export function CallProvider({ children }: { readonly children: ReactNode }) {
  const toast = useToast();
  const { pathname } = useLocation();

  const [availability, setAvailability] = useState<VoiceStatus | null>(null);
  const [status, setStatus] = useState<CallStatus>('idle');
  const [phase, setPhase] = useState<CallPhase>('listening');
  const [focus, setFocus] = useState<CallFocus>({ kind: 'chief' });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [micOpen, setMicOpen] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [mode, setModeState] = useState<TalkMode>(readMode);
  const [talking, setTalking] = useState(false);
  const [caption, setCaption] = useState('');
  const [usage, setUsage] = useState<CallUsage | null>(null);
  const [problem, setProblem] = useState<CallProblem | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const panelRef = useRef<HTMLElement | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const audio = useRef<CallAudio | null>(null);
  const callId = useRef<string | null>(null);
  const droppedAt = useRef<number | null>(null);
  const voiceMutedRef = useRef(false);
  const modeRef = useRef(mode);
  const vadSilenceMs = useRef(DEFAULT_VAD_SILENCE_MS);
  const availabilityRef = useRef<VoiceStatus | null>(null);
  availabilityRef.current = availability;
  /** The STT mode `ready` confirmed, and the settings that shape it (US-022). */
  const sttMode = useRef<SttMode>('openrouter');
  const sttOptions = useRef<SttOptions>({ liveCaptions: 'off', speculative: false, language: 'nl' });
  // The latest toaster and handlers, for the socket callbacks.
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // Re-read on every navigation: cheap, and a Settings save shows up at once.
  useEffect(() => {
    const controller = new AbortController();
    fetchVoiceStatus(controller.signal)
      .then(setAvailability)
      .catch(() => {
        // An older server or a hiccup: the Call item stays as it was.
      });
    return () => controller.abort();
  }, [pathname]);

  const send = useCallback((message: ClientMessage): void => {
    const ws = socket.current;
    if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  /** Tears the call down on this side; the transcript stays readable. */
  const finish = useCallback((next: CallStatus): void => {
    const ws = socket.current;
    socket.current = null;
    if (ws !== null && ws.readyState <= WebSocket.OPEN) ws.close(WS_CLOSE_CALL_ENDED);
    const current = audio.current;
    audio.current = null;
    void current?.close();
    callId.current = null;
    droppedAt.current = null;
    setMicOpen(false);
    setTalking(false);
    setCaption('');
    setPhase('ended');
    setStatus(next);
  }, []);

  const onMessage = useCallback(
    (message: ServerMessage): void => {
      // Mute voice is text only: the server stops speaking too (US-021); what
      // was already on its way never starts playing here.
      const sound = message.type === 'tts.segment' || message.type === 'earcon';
      if (!sound || !voiceMutedRef.current) audio.current?.handleMessage(message);

      switch (message.type) {
        case 'ready':
          sttMode.current = message.sttMode;
          audio.current?.setStt(message.sttMode, sttOptions.current);
          callId.current = message.callId;
          droppedAt.current = null;
          setFocus(message.focus);
          setStatus('live');
          setStartedAt((current) => (message.resumed && current !== null ? current : Date.now()));
          return;
        case 'state':
          setFocus(message.focus);
          voiceMutedRef.current = message.muted;
          setVoiceMuted(message.muted);
          if (message.phase === 'ended') finish('ended');
          else setPhase(message.phase);
          return;
        case 'usage':
          setUsage({
            elCreditsUsed: message.elCreditsUsed,
            orCostUsd: message.orCostUsd,
            elCreditsRemaining: message.elCreditsRemaining ?? null,
          });
          return;
        case 'ui':
          if (message.action === 'navigate') navigate(message.path);
          else if (message.action === 'highlight') highlight(message.target);
          else toastRef.current.info(message.text);
          return;
        case 'error':
          if (message.fatal) toastRef.current.error(message.message);
          setTranscript((entries) => applyToTranscript(entries, message));
          return;
        default:
          if (message.type === 'user.transcript') setCaption('');
          setTranscript((entries) => applyToTranscript(entries, message));
      }
    },
    [finish],
  );

  const connect = useCallback(
    (query: string): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}${query}`);
      // `decodeFrame` takes an ArrayBuffer; the default Blob would throw.
      ws.binaryType = 'arraybuffer';
      socket.current = ws;
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'hello',
            // What Settings asks for; the server answers the mode in effect in `ready`.
            sttMode: requestedSttMode(availabilityRef.current),
            sampleRateOut: 24_000,
            clientVersion: CLIENT_VERSION,
          } satisfies ClientMessage),
        );
      };
      ws.onmessage = (event: MessageEvent) => {
        if (socket.current !== ws) return;
        if (event.data instanceof ArrayBuffer) {
          // Muted, the player has no segment for speech audio; earcon audio is still kept.
          audio.current?.handleBinary(event.data);
          return;
        }
        try {
          onMessage(JSON.parse(String(event.data)) as ServerMessage);
        } catch {
          // A malformed frame is not worth ending the call over.
        }
      };
      ws.onclose = (event: CloseEvent) => {
        if (socket.current !== ws) return;
        socket.current = null;
        const toaster = toastRef.current;
        switch (event.code) {
          case WS_CLOSE_CALL_ENDED:
            finish('ended');
            return;
          case WS_CLOSE_NOT_CONFIGURED:
            toaster.warn(notConfiguredText(event.reason));
            finish('idle');
            return;
          case WS_CLOSE_CALL_IN_PROGRESS:
            setProblem({ kind: 'in-progress' });
            finish('idle');
            return;
          case WS_CLOSE_TAKEN_OVER:
            toaster.info('The call moved to another tab.');
            finish('ended');
            return;
          case WS_CLOSE_BAD_ORIGIN:
            toaster.error('The server refused this address for calls. Open chief at its PUBLIC_URL.');
            finish('idle');
            return;
          case 4401: // the gateway's unauthorized close
            window.location.replace('/login');
            return;
          default:
            break;
        }
        // A dropped socket: the server keeps the call for 30 s.
        const id = callId.current;
        const since = droppedAt.current ?? Date.now();
        if (id !== null && Date.now() - since < RESUME_WINDOW_MS - RESUME_DELAY_MS) {
          droppedAt.current = since;
          setStatus('reconnecting');
          window.setTimeout(() => {
            if (callId.current === id && socket.current === null) connect(`?resume=${encodeURIComponent(id)}`);
          }, RESUME_DELAY_MS);
          return;
        }
        toaster.error('The call dropped.');
        finish('ended');
      };
    },
    [finish, onMessage],
  );

  const start = useCallback(
    (options: { takeover?: boolean; focus?: CallFocus } = {}): void => {
      if (socket.current !== null || audio.current !== null) return;
      const initial: CallFocus = options.focus ?? { kind: 'chief' };
      if (!window.isSecureContext) {
        setProblem({ kind: 'insecure' });
        setPanelOpen(true);
        return;
      }
      setProblem(null);
      setTranscript([]);
      setUsage(null);
      setCaption('');
      sttMode.current = 'openrouter';
      setStartedAt(null);
      setPhase('listening');
      setFocus(initial);
      setMicMuted(false);
      setStatus('connecting');
      setPanelOpen(true);

      // Synchronously, inside the gesture.
      let created: CallAudio;
      try {
        created = new CallAudio({
          json: send,
          binary: (frame) => {
            const ws = socket.current;
            if (ws !== null && ws.readyState === WebSocket.OPEN) ws.send(frame);
          },
          caption: setCaption,
          fallback: (reason) => {
            sttMode.current = 'openrouter';
            toastRef.current.warn(`Scribe stopped (${reason.replaceAll('_', ' ')}); the call continues on OpenRouter speech-to-text.`);
          },
        });
      } catch (cause: unknown) {
        setProblem({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
        setStatus('idle');
        return;
      }
      audio.current = created;
      const query = new URLSearchParams();
      if (initial.kind === 'session') query.set('focus', `session:${initial.sessionId}`);
      if (options.takeover === true) query.set('takeover', '1');
      const search = query.toString();
      connect(search === '' ? '' : `?${search}`);

      void (async () => {
        let pttGlobal = false;
        let bargeIn: VoiceSettings['bargeIn'] = 'careful';
        try {
          const settings = await fetchSettings();
          vadSilenceMs.current = settings.voice.vadSilenceMs;
          pttGlobal = settings.voice.pttGlobal;
          bargeIn = settings.voice.bargeIn;
          sttOptions.current = {
            liveCaptions: settings.voice.liveCaptions,
            speculative: settings.voice.speculativeChief,
            language: settings.voice.language,
          };
        } catch {
          // The defaults do.
        }
        if (audio.current !== created) return;
        created.setStt(sttMode.current, sttOptions.current);
        try {
          await created.start({
            mode: modeRef.current,
            vadSilenceMs: vadSilenceMs.current,
            pttGlobal,
            bargeIn,
            panel: () => panelRef.current,
          });
          if (audio.current === created) setMicOpen(true);
        } catch (cause: unknown) {
          if (audio.current !== created) return;
          // The call goes on as text: the operator can still type and listen.
          const reason = cause instanceof Error ? cause.message : String(cause);
          setProblem({ kind: 'error', message: `The microphone did not open: ${reason}` });
        }
      })();
    },
    [connect, send],
  );

  const hangup = useCallback((): void => {
    if (socket.current?.readyState === WebSocket.OPEN) {
      send({ type: 'hangup' });
      // The server ends the call and closes with 1000; stop listening now.
      void audio.current?.close();
      audio.current = null;
      setMicOpen(false);
      return;
    }
    finish('ended');
  }, [finish, send]);

  const ptt = useCallback((down: boolean): void => {
    const current = audio.current;
    if (current === null) return;
    if (down) current.pttDown();
    else current.pttUp();
    setTalking(down);
  }, []);

  const stopAgent = useCallback((): void => {
    const current = audio.current;
    if (current !== null) current.stopAgent();
    else send({ type: 'text', text: 'stop' });
  }, [send]);

  const muteMic = useCallback((muted: boolean): void => {
    audio.current?.setMicMuted(muted);
    setMicMuted(muted);
  }, []);

  const muteVoice = useCallback((muted: boolean): void => {
    voiceMutedRef.current = muted;
    setVoiceMuted(muted);
    if (muted) audio.current?.player.stop();
    send({ type: 'voice.mute', muted });
  }, [send]);

  const setMode = useCallback((next: TalkMode): void => {
    modeRef.current = next;
    setModeState(next);
    storeMode(next);
    void audio.current?.setMode(next, vadSilenceMs.current).catch((cause: unknown) => {
      setProblem({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    });
  }, []);

  const resolve = useCallback(
    (id: string, confirm: boolean): void => {
      send({ type: 'confirm.resolve', id, accept: confirm });
      setTranscript((entries) =>
        entries.map((entry) =>
          entry.kind === 'confirm' && entry.id === id
            ? { ...entry, resolution: confirm ? 'confirmed' : 'cancelled' }
            : entry,
        ),
      );
    },
    [send],
  );

  const open = useCallback((): void => {
    setPanelOpen(true);
    if (socket.current === null && audio.current === null) start();
    else window.requestAnimationFrame(() => panelRef.current?.focus());
  }, [start]);

  // Leaving the app ends the call rather than leaving it to the resume timer.
  useEffect(() => {
    const onUnload = (): void => {
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'hangup' }));
    };
    window.addEventListener('pagehide', onUnload);
    return () => window.removeEventListener('pagehide', onUnload);
  }, []);

  const value = useMemo<CallContext>(
    () => ({
      availability,
      enabled: availability !== null && availability.reason !== 'voice_disabled',
      status,
      phase,
      focusedOn: focus,
      startedAt,
      transcript,
      micOpen: micOpen && !micMuted,
      micMuted,
      voiceMuted,
      mode,
      talking,
      caption,
      usage,
      problem,
      panelOpen,
      panelRef,
      open,
      closePanel: () => setPanelOpen(false),
      start,
      hangup,
      ptt,
      stopAgent,
      focus: (target) => send({ type: 'focus', target }),
      text: (text) => {
        const trimmed = text.trim();
        if (trimmed !== '') send({ type: 'text', text: trimmed });
      },
      muteMic,
      muteVoice,
      setMode,
      resolve,
    }),
    [
      availability,
      status,
      phase,
      focus,
      startedAt,
      transcript,
      micOpen,
      micMuted,
      voiceMuted,
      mode,
      talking,
      caption,
      usage,
      problem,
      panelOpen,
      open,
      start,
      hangup,
      ptt,
      stopAgent,
      send,
      muteMic,
      muteVoice,
      setMode,
      resolve,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCall(): CallContext {
  const value = useContext(Context);
  if (value === null) throw new Error('useCall() outside <CallProvider>');
  return value;
}
