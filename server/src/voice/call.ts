
import type { Config } from '../config.js';
import {
  createVoiceCall,
  type Database,
  getSession,
  insertVoiceTurn,
  updateVoiceCall,
  updateVoiceTurn,
  type VoiceEndReason,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import type { PrdStatus } from '../prd/index.js';
import { getVoiceSettings, setVoiceScribeCreditsPerMin } from '../settings/index.js';
import { type BrowserAskDeps, BrowserAsks } from './browser-ask.js';
import { sameUtterance } from './chief/speculation.js';
import { ACK_EARCONS, type EarconClip, earconLanguage, type EarconName } from './earcons.js';
import { describeEvent, draftedLine, eventSessionId, isAnnounced, type VoiceBusEvent, type VoiceEvent } from './events.js';
import { matchCallIntent } from './intents.js';
import {
  type AgentKind,
  type CallFocus,
  type CallPhase,
  type ClientMessage,
  decodeFrame,
  FRAME_KIND_UTTERANCE,
  parseClientMessage,
  type PlanningSessionView,
  type ServerMessage,
  type TurnTimes,
  type SttMode,
  type ToolStatus,
  type UiAction,
  WS_CLOSE_CALL_ENDED,
} from './protocol.js';
import type { PlanningState, PlanningStateName } from './session-agent/planning-state.js';
import { resumePrompt } from './session-agent/prompt.js';
import { voiceAgentMode } from './session-agent/registry.js';
import { SentenceChunker, toSpeakable, type WaitingSession, waitingSummary } from './speakable.js';
import type { ElevenLabsSubscription } from './providers.js';
import type { SttResult } from './stt/index.js';
import type { SpeakCallbacks, SpeakResult, TtsSink } from './tts/index.js';
import type { TtsFormat, TtsProviderName, TtsSegment } from './tts/types.js';
import {
  CallUsage,
  type UsageDelta,
  GENERATION_LOOKUP_DELAY_MS,
  GENERATION_RETRY_MS,
  SCRIBE_CALIBRATION_MIN_SECONDS,
  scribeCreditsPerMinute,
  SUBSCRIPTION_REFRESH_MS,
} from './usage.js';

/** Timers the call runs on; tests pass a fake one to drive the idle timeout. */
export interface CallClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: CallClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** What an agent yields while it answers one utterance. */
export type AgentEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly name: string;
      readonly status: ToolStatus;
      readonly summary: string;
      readonly detail?: string;
    }
  | { readonly type: 'ui'; readonly ui: UiAction }
  /** Chief's OpenRouter dollars, or a Claude Code turn of a session agent (US-023). */
  | { readonly type: 'usage'; readonly costUsd?: number; readonly claudeTurns?: number }
  /** Plays a cached earcon now, e.g. "one sec" while a session agent boots (US-021). */
  | { readonly type: 'earcon'; readonly name: EarconName };

/** One utterance for the focused agent. */
export interface AgentInput {
  readonly text: string;
  readonly turn: number;
  readonly signal: AbortSignal;
  /**
   * Set by the `to_session` intent (US-019): chief runs this tool first, as
   * if it had called it, then speaks about the result. Only chief reads it.
   */
  readonly invoke?: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };
  /**
   * `voice_speculative_chief` (US-022): what the agent's own `speculate`
   * started for this utterance's partial. Only the agent that made it reads it.
   */
  readonly prefetched?: SpeculativeStep;
  /**
   * Set on the first turn to a planning session the focus has just moved to
   * while it waits for the operator (US-011): a session agent sends this
   * instead of its greeting, with the operator's first words when there are any.
   */
  readonly resume?: string;
}

/** Opaque to the call: whatever an agent's `speculate` hands back. */
export type SpeculativeStep = object;

/**
 * The focused agent: chief (US-008) or a session agent (US-018). It must stop
 * promptly when `signal` aborts; throwing `signal.reason` is fine.
 */
export interface VoiceAgent {
  readonly kind: AgentKind;
  run(input: AgentInput): AsyncIterable<AgentEvent>;
  /**
   * Starts answering a partial transcript early, with no side effects, or
   * null when it cannot. Aborting `signal` discards it (US-022).
   */
  speculate?(text: string, signal: AbortSignal): SpeculativeStep | null;
}

/** The slice of `SttService` a call uses. */
export interface CallStt {
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<SttResult>;
}

/** The slice of `TtsService` a call uses. */
export interface CallTts {
  readonly providerName: TtsProviderName;
  readonly format: TtsFormat;
  open(callId: string): Promise<void>;
  speak(seg: TtsSegment, signal: AbortSignal, callbacks: SpeakCallbacks): Promise<SpeakResult>;
  cancelTurn(turn: number): void;
  close(): Promise<void>;
}

/** The earcon cache (US-021) as a call sees it: every clip of the voice `provider` speaks with. */
export interface CallEarcons {
  load(provider: TtsProviderName, signal: AbortSignal): Promise<readonly EarconClip[]>;
}

/** The socket as the call sees it; the service adapts a `ws` socket to this. */
export interface CallTransport {
  send(message: ServerMessage): void;
  sendAudio(segmentId: number, chunk: Buffer): void;
  close(code: number, reason: string): void;
}

export interface VoiceCallDeps {
  readonly db: Database;
  readonly config: Config;
  readonly stt: CallStt;
  /** One text-to-speech service per call, reporting to the call's sink. */
  readonly tts: (sink: TtsSink) => CallTts;
  /** The agent that answers while `focus` is in effect, on `call`. */
  readonly agent: (focus: CallFocus, call: VoiceCall) => VoiceAgent;
  readonly clock: CallClock;
  /** Told once, when the call has ended, so the service can let go of it. */
  readonly onEnded?: (call: VoiceCall) => void;
  /** Told whenever the call's focus moves to a session (not when it opens on one). */
  readonly onSessionFocused?: (sessionId: string) => void;
  /**
   * Told when the focus has left a session the operator spoke to in this
   * call, once the turn that was running has wound down (US-005); the service
   * sends a planning session's agent off to draft alone. Never awaited.
   */
  readonly onSessionLeft?: (sessionId: string) => void;
  /**
   * The planning poller (US-019): read after every session-agent turn, so a
   * `prd.md` that just became valid publishes `prd.valid`, and for the
   * PRD state chief names on the way back.
   */
  readonly planning?: CallPlanning;
  /**
   * Where the planning sessions stand (US-009), for the other sessions chief
   * names on the way back and when the focused one is done.
   */
  readonly planningStates?: CallPlanningStates;
  /** Pre-rendered acknowledgements (US-021); without them the call has none. */
  readonly earcons?: CallEarcons;
  /** The providers' own usage numbers (US-023); without them the meter is local only. */
  readonly usage?: CallUsageSources;
  /** The "watch with me" card (voice feedback US-007); without it the card never shows. */
  readonly browser?: BrowserAskDeps;
}

/** Where a call reads what the providers say it spent (US-023). */
export interface CallUsageSources {
  /** `GET /v1/user/subscription`, or null without an ElevenLabs key. */
  subscription(): Promise<ElevenLabsSubscription | null>;
  /** One OpenRouter generation's USD, or null while its stats are not there yet. */
  generationCost(id: string): Promise<number | null>;
}

/** The slice of `PlanningService` a call reads. */
export interface CallPlanning {
  status(sessionId: string): { readonly sessionName: string; readonly prd: PrdStatus };
}

/** The slice of `PlanningStates` a call reads. */
export interface CallPlanningStates {
  planningState(sessionId: string): PlanningState | null;
  listPlanningSessions(): readonly PlanningState[];
}

export type { VoiceEvent } from './events.js';

/** How long both sides must have been quiet before chief speaks a background event (docs/voice-plan.md §12). */
export const EVENT_QUIET_MS = 2_000;
/** An acknowledgement plays when no agent audio has started this long after the operator's turn ended (docs/voice-plan.md §3.1). */
export const ACK_AFTER_MS = 700;
/** How long call start waits for earcons that still have to be rendered; they finish in the background for the next call. */
export const EARCON_WAIT_MS = 5_000;

/** docs/voice-plan.md §5. */
export interface VoiceCallState {
  readonly id: string;
  focus: CallFocus;
  phase: CallPhase;
  /** Increments per user utterance (and for the idle goodbye). */
  turn: number;
  /** Aborts the LLM stream and the TTS context of the turn in progress. */
  activeTurn: AbortController | null;
  /** The current turn's text the browser reported as played. */
  spokenSoFar: string;
  ttsProvider: TtsProviderName;
  queue: VoiceEvent[];
  /** The voice is off (US-021): replies stream as text only, and no earcons play. */
  muted: boolean;
}

/** What the idle timeout says before hanging up, in the call's language. */
export const IDLE_GOODBYE: Readonly<Record<string, string>> = {
  nl: 'Ik hoor al een tijdje niets meer, dus ik hang op. Tot later!',
  en: "I haven't heard from you in a while, so I'm hanging up. Talk to you later!",
};
/** What the `hangup` intent says before hanging up. */
export const HANGUP_GOODBYE: Readonly<Record<string, string>> = {
  nl: 'Oké, tot later!',
  en: 'Okay, talk to you later!',
};

/**
 * The one line chief says when the operator comes back from a session agent
 * (docs/voice-plan.md §11): "Back with me. csv-export-invoices has a draft PRD
 * with 2 open questions.", followed by the other planning sessions (US-009).
 */
export function backWithMe(
  language: string,
  session: { readonly sessionName: string; readonly prd: PrdStatus } | null,
  others: readonly WaitingSession[] = [],
): string {
  const nl = language === 'nl';
  const back = nl ? 'Je bent weer bij mij.' : 'Back with me.';
  const summary = waitingSummary(language, others);
  if (session === null) return summary === '' ? back : `${back} ${summary}`;
  const { sessionName: name, prd } = session;
  const stories = prd.storyCount;
  const questions = prd.exists ? prd.openQuestions : 0;
  const withQuestions =
    questions <= 0
      ? ''
      : nl
        ? ` met ${String(questions)} ${questions === 1 ? 'open vraag' : 'open vragen'}`
        : ` with ${String(questions)} open ${questions === 1 ? 'question' : 'questions'}`;
  let state: string;
  if (!prd.exists) state = nl ? `${name} heeft nog geen PRD.` : `${name} has no PRD yet.`;
  else if (!prd.parses || stories === 0) state = nl ? `${name} heeft een concept-PRD${withQuestions}.` : `${name} has a draft PRD${withQuestions}.`;
  else if (questions > 0) {
    state = nl
      ? `De PRD van ${name} heeft ${String(stories)} ${stories === 1 ? 'story' : 'stories'} en ${String(questions)} ${questions === 1 ? 'open vraag' : 'open vragen'}.`
      : `${name} has a PRD with ${String(stories)} ${stories === 1 ? 'story' : 'stories'} and ${String(questions)} open ${questions === 1 ? 'question' : 'questions'}.`;
  } else if (nl) state = `De PRD van ${name} heeft ${String(stories)} ${stories === 1 ? 'story' : 'stories'} en is in orde.`;
  else state = `${name} has a PRD with ${String(stories)} ${stories === 1 ? 'story' : 'stories'} that parses cleanly.`;
  return summary === '' ? `${back} ${state}` : `${back} ${state} ${summary}`;
}

/** Why a detached turn failed, as the resume message quotes it (US-011). */
const FAILURE_REASONS: Readonly<Record<NonNullable<PlanningState['failure']>, string>> = {
  timeout: 'it ran out of time before the PRD was finished',
  error: 'it stopped with an error before the PRD was finished',
};

function asWaiting(state: PlanningState): WaitingSession {
  return {
    sessionName: state.sessionName,
    repositoryName: state.repositoryName,
    state: state.state,
    openQuestions: state.openQuestions.length,
  };
}

/**
 * What chief says when the `carry_on` intent sends a planning session off to
 * work alone (US-006): "Okay, csv-export is working on it. Back with me."
 */
export function carryingOn(language: string, sessionName: string): string {
  return language === 'nl'
    ? `Oké, ${sessionName} gaat ermee aan de slag. Je bent weer bij mij.`
    : `Okay, ${sessionName} is working on it. Back with me.`;
}

/** What the `mute` intent answers, as text: it is never spoken. */
export const MUTED_LINE: Readonly<Record<string, string>> = {
  nl: 'Stem uit. Ik antwoord in tekst tot je unmute zegt.',
  en: "Voice off. I'll answer in text until you say unmute.",
};
export const UNMUTED_LINE: Readonly<Record<string, string>> = {
  nl: 'Mijn stem staat weer aan.',
  en: 'Voice back on.',
};
/** The `repeat` intent before anything was spoken. */
export const NOTHING_TO_REPEAT: Readonly<Record<string, string>> = {
  nl: 'Ik heb nog niets gezegd.',
  en: "I haven't said anything yet.",
};

/** The goodbye is not allowed to keep a dead call open. */
const GOODBYE_MAX_MS = 15_000;

/**
 * One call (voice US-007; docs/voice-plan.md §5): the state machine between the socket, STT,
 * the focused agent and TTS. Exactly one turn is active at a time; a new
 * utterance while one runs interrupts it first (barge-in).
 */
/** How many recent turns keep their timing for `latency` (US-026). */
const TIMED_TURNS_KEPT = 8;
const NO_TIMES: TurnTimes = {
  speechEnd: null,
  transcript: null,
  firstToken: null,
  firstChunk: null,
  firstAudioSent: null,
  firstAudioPlayed: null,
};

export class VoiceCall {
  readonly state: VoiceCallState;
  /** The session agent's "watch with me" cards (voice feedback US-007). */
  private readonly browserAsks: BrowserAsks | null;
  private transport: CallTransport | null = null;
  private tts: CallTts | null = null;
  private sttMode: SttMode = 'openrouter';
  /** True once the `voice_calls` row exists (at `ready`). */
  private persisted = false;
  private segmentSeq = 0;
  private readonly segmentTexts = new Map<number, SpokenSegment>();
  /** What the browser reported played of each segment of the current turn, for `spokenSoFar`. */
  private readonly heard = new Map<number, string>();
  /** The agent reply row of each turn, for `metrics`. */
  private readonly replyRows = new Map<number, number>();
  /** What is known of the recent turns' timing (US-026), for `latency` and the reply row. */
  private readonly turnTimes = new Map<number, TurnTimes>();
  private running: Promise<void> = Promise.resolve();
  /** Bumped by every utterance; a stale one that was superseded while waiting gives up. */
  private ticket = 0;
  /** Aborted when the call ends: the transcriptions still in flight give up. */
  private readonly lifetime = new AbortController();
  /** The utterances being transcribed, one after another, so they reach the queue in the order spoken. */
  private transcribing: Promise<void> = Promise.resolve();
  /**
   * What the operator said that no turn has taken yet. The next operator turn
   * takes all of it, so an utterance overtaken while it waited for the queue is
   * answered together with the one that overtook it instead of being lost.
   */
  private readonly unanswered: string[] = [];
  private idleTimer: unknown = null;
  /** Set by chief's `end_call`: hang up once the turn's goodbye is out. */
  private hangUpAfter = false;
  /** A session focus whose agent still has to be started and heard (docs/voice-plan.md §11 step 4–5). */
  private greetPending: string | null = null;
  /** A session chief created from feedback: the call goes to its agent once its setup is announced (voice feedback US-003). */
  private handOffOnSetup: string | null = null;
  private readonly agents = new Map<string, VoiceAgent>();
  /** Sessions whose agent answered the operator in this call: only those have something to draft from. */
  private readonly briefed = new Set<string>();
  /** The resume message (US-011) a planning session's agent still has to be sent, per session. */
  private readonly resumes = new Map<string, string>();
  /** The planning list the panel was last sent (US-013), to send only a change; null forces the next one. */
  private planningSent: string | null = null;
  /** What the call spent (US-023), persisted to `voice_calls` and sent as `usage`. */
  readonly usage = new CallUsage();
  private subscriptionTimer: unknown = null;
  /** The after-call cost lookup, once `end` started it. */
  private settling: Promise<void> | null = null;
  /** Chief's early start on a stable partial (US-022), until the commit adopts or drops it. */
  private speculation: { readonly text: string; readonly controller: AbortController; readonly step: SpeculativeStep } | null = null;
  /** The last sign of speech in either direction, for the event gate. */
  private lastActivityAt = 0;
  /** Set between the operator starting to speak and the utterance (or a misfire). */
  private speechOpenSince: number | null = null;
  private drainTimer: unknown = null;
  /** The call's earcons, in its language, once loaded; the browser got their audio after `ready`. */
  private readonly earcons = new Map<EarconName, { readonly segmentId: number; readonly sampleRate: number; readonly pcm: Buffer }>();
  /** The 700 ms acknowledgement timer of the utterance waiting for its first audio. */
  private ack: { timer: unknown } | null = null;
  private acks = 0;
  /** The audio of the last turn that spoke, for the `repeat` intent. */
  private recording: Recording | null = null;

  constructor(
    id: string,
    focus: CallFocus,
    private readonly deps: VoiceCallDeps,
  ) {
    this.state = {
      id,
      focus,
      phase: 'listening',
      turn: 0,
      activeTurn: null,
      spokenSoFar: '',
      ttsProvider: 'openrouter',
      queue: [],
      muted: false,
    };
    this.browserAsks =
      deps.browser === undefined ? null : new BrowserAsks(deps.browser, { clock: deps.clock, send: (message) => this.send(message) });
  }

  /**
   * The session agent called `open_browser_with_operator` (voice feedback
   * US-007): its browser starts and the panel shows the card.
   */
  askBrowser(sessionId: string): void {
    if (this.ended) return;
    void this.browserAsks?.ask(sessionId);
  }

  /** That tool call is over on the agent's side; a card it still had goes away. */
  browserToolDone(sessionId: string): void {
    this.browserAsks?.toolDone(sessionId);
  }

  /** The session agent called a browser tool (US-012): the browser is in use, its idle clock starts over. */
  browserActivity(sessionId: string): void {
    this.deps.browser?.browsers.touch?.(sessionId);
  }

  get id(): string {
    return this.state.id;
  }

  get ended(): boolean {
    return this.state.phase === 'ended';
  }

  /** Whether a socket is carrying the call right now. */
  get attached(): boolean {
    return this.transport !== null;
  }

  /** Where the call is focused right now. */
  get focus(): CallFocus {
    return this.state.focus;
  }

  /**
   * Moves the call's focus (docs/voice-plan.md §11): the switch is kept in `voice_turns`, the panel hears `state`
   * and a session focus opens the session's page. The session's agent is
   * started and speaks its opening once the turn in progress is over.
   *
   * Called from inside a turn (`focus_session`, a session agent giving the
   * call back); {@link switchFocus} is the one that interrupts first.
   */
  setFocus(focus: CallFocus): void {
    const current = this.state.focus;
    this.greetPending = null;
    if (sameFocus(current, focus)) {
      this.sendState();
      return;
    }
    // The call moved elsewhere: the feedback session no longer takes it over.
    this.handOffOnSetup = null;
    this.state.focus = focus;
    if (current.kind === 'session') this.leave(current.sessionId);
    const sessionId = focus.kind === 'session' ? focus.sessionId : null;
    if (this.persisted) {
      const name = sessionId === null ? 'chief' : (this.readPlanning(sessionId)?.sessionName ?? sessionId);
      insertVoiceTurn(this.deps.db, { callId: this.id, turn: this.state.turn, speaker: 'event', sessionId, text: `[focus] ${name}` });
    }
    this.sendState();
    if (sessionId === null) return;
    // Before `onSessionFocused`: it forgets how the last detached turn ended.
    this.prepareResume(sessionId);
    this.deps.onSessionFocused?.(sessionId);
    this.send({ type: 'ui', action: 'navigate', path: `/sessions/${encodeURIComponent(sessionId)}` });
    this.greetPending = sessionId;
    if (this.state.activeTurn === null) void this.enqueue((controller) => this.greet(controller));
  }

  /**
   * Once `sessionId`'s setup succeeds, and chief has announced it, the call
   * moves to the session's agent, which opens on the session's feedback. The
   * call ending, the focus moving or the setup failing first drops it.
   */
  handOffWhenReady(sessionId: string): void {
    if (this.ended) return;
    this.handOffOnSetup = sessionId;
  }

  /** Makes the handoff {@link handOffWhenReady} promised, if it still stands. */
  private handOff(sessionId: string): void {
    if (this.handOffOnSetup !== sessionId) return;
    this.handOffOnSetup = null;
    if (this.ended || this.state.focus.kind !== 'chief') return;
    this.setFocus({ kind: 'session', sessionId });
  }

  /**
   * The panel's focus chip: interrupts the turn in progress, then switches
   * (and starts the session agent) as {@link setFocus} does.
   */
  switchFocus(focus: CallFocus): void {
    this.touch();
    // The aborted turn winds down on the agent that started it; the new
    // focus is in effect at once, and its agent speaks once that turn is out.
    this.state.activeTurn?.abort(new Error('focus switched'));
    this.setFocus(focus);
  }

  /**
   * The focus left `sessionId` (US-005), whichever way: the detach waits for
   * the turn that was running, since an interrupted session agent reads its
   * process up to the `result` first, but the new focus does not wait for it.
   */
  private leave(sessionId: string): void {
    const onLeft = this.deps.onSessionLeft;
    if (onLeft === undefined || !this.briefed.has(sessionId)) return;
    void this.running.then(() => {
      // Back on it already: the operator talks to it instead.
      if (sameFocus(this.state.focus, { kind: 'session', sessionId })) return;
      onLeft(sessionId);
    });
  }

  /**
   * Hangs up once the turn in progress has been spoken, so a goodbye in the
   * same reply is heard (chief's `end_call`). Without a turn it ends now.
   */
  hangUpAfterTurn(): void {
    if (this.state.activeTurn === null) this.endSoon('hangup');
    else this.hangUpAfter = true;
  }

  get mode(): SttMode {
    return this.sttMode;
  }

  /** True once `start` has created the `voice_calls` row. */
  get started(): boolean {
    return this.persisted;
  }

  /** The socket that carries the call from now on. */
  attach(transport: CallTransport): void {
    this.transport = transport;
  }

  /** The first `hello`: opens TTS, creates the `voice_calls` row and goes live. */
  start(sttMode: SttMode): Promise<void> {
    const opening = this.open(sttMode);
    // Utterances that arrive while TTS opens wait for the row to exist.
    this.running = opening.catch(() => undefined);
    return opening;
  }

  private async open(sttMode: SttMode): Promise<void> {
    this.sttMode = sttMode;
    this.tts = this.deps.tts(this.sink());
    await this.tts.open(this.id);
    if (this.ended) return;
    await this.loadEarcons(this.tts.providerName);
    if (this.ended) return;
    this.state.ttsProvider = this.tts.providerName;
    createVoiceCall(this.deps.db, {
      id: this.id,
      sttProvider: sttMode,
      ttsProvider: this.tts.providerName,
      startedAt: this.isoNow(),
    });
    this.persisted = true;
    this.lastActivityAt = this.deps.clock.now();
    this.sendReady(false);
    this.armIdle();
    this.sendUsage();
    void this.refreshSubscription();
  }

  /** The `hello` of a socket continuing this call after a drop (`?resume=`). */
  resume(): void {
    this.sendReady(true);
    this.armIdle();
    this.markActivity();
    this.sendUsage();
  }

  /**
   * The socket went away without a hang-up: stop talking, keep the call.
   * False when `transport` was no longer the call's socket.
   */
  detach(transport: CallTransport): boolean {
    if (this.transport !== transport) return false;
    this.transport = null;
    this.clearIdle();
    this.state.activeTurn?.abort(new Error('socket closed'));
    this.dropSpeculation();
    return true;
  }

  /** Replaces the socket without ending the call: the old one is told why. */
  replaceTransport(code: number, reason: string): void {
    const old = this.transport;
    this.transport = null;
    old?.close(code, reason);
  }

  /** A frame from the browser. */
  handleFrame(data: Buffer, isBinary: boolean): void {
    if (this.ended) return;
    if (isBinary) {
      const frame = decodeFrame(data);
      if (frame === null || frame.kind !== FRAME_KIND_UTTERANCE) {
        this.send({ type: 'error', code: 'bad_frame', message: 'Unsupported binary frame.', fatal: false });
        return;
      }
      if (this.sttMode !== 'openrouter') {
        this.send({ type: 'error', code: 'unexpected_audio', message: `Audio is transcribed in the browser in ${this.sttMode} mode.`, fatal: false });
        return;
      }
      this.submitAudio(frame.payload);
      return;
    }
    const message = parseClientMessage(data.toString('utf8'));
    if (message === null) {
      this.send({ type: 'error', code: 'bad_message', message: 'Unsupported message.', fatal: false });
      return;
    }
    this.handleMessage(message);
  }

  handleMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'hello':
        // Only the first one matters; the service consumed it.
        return;
      case 'text':
        this.submitText(message.text, null);
        return;
      case 'voice.mute':
        this.setMuted(message.muted);
        return;
      case 'transcript.final':
        this.submitText(message.text, this.isoNow());
        return;
      case 'transcript.partial':
        this.speculate(message.text);
        return;
      case 'speculation.cancel':
        this.dropSpeculation();
        return;
      case 'scribe.usage':
        if (this.persisted && message.seconds > 0) this.addUsage({ scribeSeconds: message.seconds });
        return;
      case 'stt.fallback':
        // Scribe gave up (quota, auth, session limit): WAV utterances from now on.
        if (this.sttMode === 'openrouter') return;
        logger.info('voice call falls back to OpenRouter speech-to-text', { call: this.id, from: this.sttMode, reason: message.reason });
        this.sttMode = 'openrouter';
        this.dropSpeculation();
        if (this.persisted) updateVoiceCall(this.deps.db, this.id, { sttProvider: 'openrouter' });
        return;
      case 'speech.start':
        // Background events wait until the utterance is in.
        this.speechOpenSince = this.deps.clock.now();
        this.touch();
        this.bargeIn('speech');
        return;
      case 'speech.cancel':
        // A VAD misfire: a tentative barge-in stays undone. The turn it cut
        // is over and its audio is not played again; the call just listens.
        this.speechOpenSince = null;
        this.touch();
        return;
      case 'ptt':
        this.speechOpenSince = message.down ? this.deps.clock.now() : null;
        this.touch();
        if (message.down) this.bargeIn('ptt');
        return;
      case 'playback.progress':
        this.touch();
        this.notePlayed(message.segmentId, message.playedMs, message.done);
        return;
      case 'focus':
        this.switchFocus(message.target === 'chief' ? { kind: 'chief' } : { kind: 'session', sessionId: message.target.sessionId });
        return;
      case 'confirm.resolve':
        // Nothing is ever pending any more (US-001); the message itself goes in US-002.
        return;
      case 'browser.answer':
        this.touch();
        void this.browserAsks?.answer(message);
        return;
      case 'browser.cancel':
        this.touch();
        void this.browserAsks?.cancel(message.id);
        return;
      case 'metrics': {
        // Only the first report counts; a turn the call no longer tracks is ignored.
        if (this.turnTimes.get(message.turn)?.firstAudioPlayed !== null) return;
        this.noteTimes(message.turn, { firstAudioPlayed: message.firstAudioPlayedAt });
        // The audio usually plays before the reply row exists; that insert picks it up then.
        const row = this.replyRows.get(message.turn);
        if (row !== undefined) updateVoiceTurn(this.deps.db, row, { tFirstAudioPlayed: message.firstAudioPlayedAt });
        return;
      }
      case 'hangup':
        this.endSoon('hangup');
        return;
    }
  }

  /** {@link end} from a callback: a failure is logged, never an unhandled rejection. */
  endSoon(reason: VoiceEndReason, closeCode = WS_CLOSE_CALL_ENDED, closeReason = 'call_ended'): void {
    this.end(reason, closeCode, closeReason).catch((cause: unknown) => {
      logger.error('voice call did not end cleanly', { call: this.id, error: String(cause) });
    });
  }

  /**
   * Ends the call once; later calls are no-ops. Closes the socket with
   * `closeCode` and the `voice_calls` row with `reason`.
   */
  async end(reason: VoiceEndReason, closeCode = WS_CLOSE_CALL_ENDED, closeReason = 'call_ended'): Promise<void> {
    if (this.ended) return;
    this.clearIdle();
    this.clearDrain();
    if (this.subscriptionTimer !== null) this.deps.clock.clearTimeout(this.subscriptionTimer);
    this.subscriptionTimer = null;
    this.clearAck();
    // An open "watch with me" card is answered `cancelled`, so the tool stops waiting.
    const browserAsks = this.browserAsks?.cancelAll();
    // Nobody is left to look at the session browsers (US-012): they stop with the call.
    const browsersStopped = this.deps.browser?.browsers.stopAll?.().catch((cause: unknown) => {
      logger.warn('could not stop the session browsers', { call: this.id, error: String(cause) });
    });
    this.state.activeTurn?.abort(new Error('call ended'));
    this.lifetime.abort(new Error('call ended'));
    this.dropSpeculation();
    this.state.phase = 'ended';
    this.sendState();
    const transport = this.transport;
    this.transport = null;
    transport?.close(closeCode, closeReason);
    if (this.persisted) {
      updateVoiceCall(this.deps.db, this.id, { endedAt: this.isoNow(), endReason: reason });
    }
    this.deps.onEnded?.(this);
    if (this.persisted) this.settling = this.settle();
    await this.running.catch(() => undefined);
    await browserAsks;
    await browsersStopped;
    await this.tts?.close();
  }

  /** Resolves once the after-call cost lookup has written its totals (tests). */
  settled(): Promise<void> {
    return this.settling ?? Promise.resolve();
  }

  /* --------------------------------------------------------------- usage */

  /**
   * The authoritative ElevenLabs balance: at call start and every
   * {@link SUBSCRIPTION_REFRESH_MS} after, until the call ends. A failed read
   * keeps the local estimate going from the last good one.
   */
  private async refreshSubscription(): Promise<void> {
    this.subscriptionTimer = null;
    const subscription = await this.readSubscription();
    if (this.ended) return;
    if (subscription !== null) {
      this.usage.noteSubscription(subscription);
      this.sendUsage();
    }
    this.subscriptionTimer = this.deps.clock.setTimeout(() => void this.refreshSubscription(), SUBSCRIPTION_REFRESH_MS);
  }

  private async readSubscription(): Promise<ElevenLabsSubscription | null> {
    try {
      return (await this.deps.usage?.subscription()) ?? null;
    } catch (cause) {
      logger.warn('could not read the ElevenLabs balance', { call: this.id, error: String(cause) });
      return null;
    }
  }

  /**
   * After the call: the backup voice's dollars from OpenRouter's generation
   * stats (they lag the request, so wait, and look a missing one up once
   * more), and for a Scribe call, Scribe's price per minute from how far the
   * balance moved beyond the voice's own characters.
   */
  private async settle(): Promise<void> {
    const sources = this.deps.usage;
    if (sources === undefined) return;
    const pending = [...this.usage.generationIds];
    const scribe = this.usage.snapshot().scribeSeconds >= SCRIBE_CALIBRATION_MIN_SECONDS;
    if (pending.length === 0 && !scribe) return;
    try {
      await this.sleep(GENERATION_LOOKUP_DELAY_MS);
      let missing = await this.lookUpGenerations(sources, pending);
      if (missing.length > 0) {
        await this.sleep(GENERATION_RETRY_MS);
        missing = await this.lookUpGenerations(sources, missing);
        if (missing.length > 0) logger.warn('OpenRouter had no cost for some speech requests', { call: this.id, missing: missing.length });
      }
      updateVoiceCall(this.deps.db, this.id, this.usage.toCallUpdate());
      const start = this.usage.firstSubscription;
      if (scribe && start !== null) {
        const end = await this.readSubscription();
        const { elChars, scribeSeconds } = this.usage.snapshot();
        const rate = end === null ? null : scribeCreditsPerMinute(start, end, elChars, scribeSeconds);
        if (rate !== null) setVoiceScribeCreditsPerMin(this.deps.db, rate);
      }
    } catch (cause) {
      logger.warn('could not settle the call usage', { call: this.id, error: String(cause) });
    }
  }

  /** Adds what OpenRouter knows; returns the ids it did not know yet. */
  private async lookUpGenerations(sources: CallUsageSources, ids: readonly string[]): Promise<string[]> {
    const costs = await Promise.all(ids.map((id) => sources.generationCost(id).catch(() => null)));
    const missing: string[] = [];
    costs.forEach((cost, index) => {
      if (cost === null) missing.push(ids[index] as string);
      else this.usage.add({ ttsCostUsd: cost });
    });
    return missing;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.deps.clock.setTimeout(resolve, ms);
    });
  }

  private sendUsage(): void {
    this.send({ type: 'usage', ...this.usage.report() });
  }

  /* ------------------------------------------------------------ barge-in */

  /** What the operator heard of the current turn: the cut-off note quotes it. */
  spokenSoFar(): string {
    return this.state.spokenSoFar;
  }

  /**
   * The operator started talking over the turn in progress (docs/voice-plan.md §13.5): it
   * is aborted, which cuts the model stream, cancels the TTS turn and sends
   `tts.stop` (the browser stopped playing already). A handler that is
   * running finishes. With `voice_barge_in` off, speech during playback is
   * ignored; push-to-talk (and the stop button) always interrupt.
   */
  private bargeIn(source: 'speech' | 'ptt'): void {
    const turn = this.state.activeTurn;
    const phase = this.state.phase;
    if (turn === null || (phase !== 'thinking' && phase !== 'speaking')) return;
    // While the agent thinks, the start of speech is not yet words: a pause
    // mid-sentence, a cough or a misfire would throw the answer away. The
    // utterance interrupts it once it transcribes to something.
    if (source === 'speech' && phase === 'thinking') return;
    if (source === 'speech' && phase === 'speaking' && getVoiceSettings(this.deps.db).bargeIn === 'off') return;
    turn.abort(new Error('barge-in'));
  }

  /**
   * `playback.progress` → `spokenSoFar` (docs/voice-plan.md §8.4): a finished segment
   * counts whole; a partial one by the share of its audio played, mapped
   * proportionally onto its characters.
   */
  private notePlayed(segmentId: number, playedMs: number, done: boolean): void {
    const segment = this.segmentTexts.get(segmentId);
    if (segment === undefined) return;
    if (done) this.segmentTexts.delete(segmentId);
    if (segment.turn !== this.state.turn) return;
    let text = segment.text;
    if (!done) {
      const share = playedShare(segment, playedMs);
      text = segment.text.slice(0, Math.round(segment.text.length * share)).trimEnd();
    }
    this.heard.set(segmentId, text);
    this.state.spokenSoFar = [...this.heard]
      .sort(([a], [b]) => a - b)
      .map(([, played]) => played)
      .filter((played) => played !== '')
      .join(' ');
  }

  /* --------------------------------------------------------------- turns */

  private submitAudio(wav: Buffer): void {
    const speechEnd = this.isoNow();
    this.speechOpenSince = null;
    this.touch();
    const ack = this.armAck();
    if (this.state.activeTurn === null) this.setPhase('thinking');
    // Transcribed before anything is interrupted: only words stop the turn
    // that is running, not a cough, a rejected clip or a failed request.
    const text = this.transcribing.then(() => this.transcribe(wav));
    this.transcribing = text.then(
      () => undefined,
      () => undefined,
    );
    void text.then((said) => {
      if (said === null) {
        this.clearAck(ack);
        if (this.state.activeTurn === null && !this.ended) {
          this.setPhase('listening');
          this.armIdle();
        }
        return;
      }
      this.unanswered.push(said);
      void this.enqueue((controller) =>
        this.runTurn(said, controller, { tSpeechEnd: speechEnd, tTranscript: this.isoNow() }).finally(() => this.clearAck(ack)),
      );
    }, (cause: unknown) => {
      logger.error('voice transcription failed', { call: this.id, error: String(cause) });
    });
  }

  /** One utterance's words, or null when there are none to answer (said so where it failed). */
  private async transcribe(wav: Buffer): Promise<string | null> {
    if (this.ended || this.tts === null) return null;
    let result: SttResult;
    try {
      result = await this.deps.stt.transcribe(wav, this.lifetime.signal);
    } catch (cause) {
      if (this.ended) return null;
      logger.warn('voice transcription failed', { error: String(cause) });
      // docs/voice-plan.md §7.1: say so, and keep listening.
      this.earcon('sorry');
      this.send({ type: 'error', code: 'stt_failed', message: 'I could not transcribe that.', fatal: false });
      return null;
    }
    if (result.kind === 'rejected') {
      this.send({ type: 'error', code: `audio_${result.reason}`, message: result.message, fatal: false });
      return null;
    }
    this.addUsage({ sttSeconds: result.seconds, sttCostUsd: result.costUsd });
    return result.kind === 'dropped' || this.ended ? null : result.text;
  }

  /** The `text` path (typed) and `transcript.final` (browser STT): no server STT. */
  private submitText(text: string, tTranscript: string | null): void {
    this.speechOpenSince = null;
    this.touch();
    const ack = this.armAck();
    this.unanswered.push(text);
    void this.enqueue((controller) => this.runTurn(text, controller, { tTranscript }).finally(() => this.clearAck(ack)));
  }

  /**
   * Runs `work` as the one active turn, after interrupting (and waiting out)
   * whatever turn was running. An utterance overtaken by a newer one while it
   * waited is dropped.
   */
  private async enqueue(work: (controller: AbortController) => Promise<void>): Promise<void> {
    const ticket = ++this.ticket;
    this.state.activeTurn?.abort(new Error('interrupted'));
    await this.running.catch(() => undefined);
    if (ticket !== this.ticket || this.ended || this.transport === null || !this.persisted) return;

    const controller = new AbortController();
    this.state.activeTurn = controller;
    this.setPhase('thinking');
    const done = work(controller).catch((cause: unknown) => {
      logger.error('voice turn failed', { call: this.id, error: String(cause) });
    });
    this.running = done;
    await done;
    // A goodbye the operator talked over does not hang up.
    const hangUp = this.hangUpAfter && !controller.signal.aborted;
    this.hangUpAfter = false;
    if (this.state.activeTurn === controller) {
      this.state.activeTurn = null;
      if (hangUp && !this.ended) {
        this.endSoon('hangup');
      } else if (!this.ended) {
        this.setPhase('listening');
        this.armIdle();
        // A switch made during the turn: the session agent speaks next,
        // unless the operator already said something it will answer.
        if (this.greetPending !== null && ticket === this.ticket) void this.enqueue((next) => this.greet(next));
      }
    }
  }

  /** Starts the focused session's agent with no words of the operator's, so it opens the conversation. */
  private async greet(controller: AbortController): Promise<void> {
    const sessionId = this.greetPending;
    this.greetPending = null;
    const focus = this.state.focus;
    if (sessionId === null || focus.kind !== 'session' || focus.sessionId !== sessionId) return;
    // Only a session agent opens a conversation; chief answering a session focus (no registry) waits.
    if (this.agentFor(focus).kind !== 'session') return;
    await this.runTurn('', controller, {}, 'greeting');
  }

  private async runTurn(
    text: string,
    controller: AbortController,
    times: { readonly tSpeechEnd?: string; readonly tTranscript?: string | null },
    /** `event`: background events for chief; `greeting`: a session agent's opening, with no utterance. */
    mode: 'user' | 'event' | 'greeting' = 'user',
    /** An `event` turn the call answers with this fixed line instead of chief's model. */
    line?: string,
  ): Promise<void> {
    const { signal } = controller;
    const tts = this.tts;
    if (tts === null) return;
    const turn = ++this.state.turn;
    this.state.spokenSoFar = '';
    this.heard.clear();
    // Reports about an earlier turn's audio no longer count.
    for (const [id, segment] of this.segmentTexts) if (segment.turn !== turn) this.segmentTexts.delete(id);
    // Cut at once, not when the agent has wound down: an interrupted session
    // agent may take seconds to reach its `result` (docs/voice-plan.md §10.5).
    const cut = (): void => {
      tts.cancelTurn(turn);
      this.send({ type: 'tts.stop', turn });
    };
    if (signal.aborted) cut();
    else signal.addEventListener('abort', cut, { once: true });
    try {
      await this.answer(text, turn, controller, times, mode, line);
    } finally {
      signal.removeEventListener('abort', cut);
    }
  }

  private async answer(
    text: string,
    turn: number,
    controller: AbortController,
    times: { readonly tSpeechEnd?: string; readonly tTranscript?: string | null },
    mode: 'user' | 'event' | 'greeting',
    line?: string,
  ): Promise<void> {
    const { signal } = controller;
    const tts = this.tts;
    if (tts === null) return;
    const background = mode === 'event';
    // Background events are always chief's to speak; the focus stays put.
    let focus: CallFocus = background ? { kind: 'chief' } : this.state.focus;
    // Words an overtaken utterance left behind come first.
    if (mode === 'user') {
      const said = this.unanswered.splice(0);
      if (said.length > 1) text = said.join(' ');
    }

    if (mode !== 'greeting') {
      if (!background) this.send({ type: 'user.transcript', turn, text });
      insertVoiceTurn(this.deps.db, {
        callId: this.id,
        turn,
        speaker: background ? 'event' : 'user',
        sessionId: focus.kind === 'session' ? focus.sessionId : null,
        text,
        ...(times.tSpeechEnd === undefined ? {} : { tSpeechEnd: times.tSpeechEnd }),
        ...(times.tTranscript === undefined ? {} : { tTranscript: times.tTranscript }),
      });
    }
    this.noteTimes(turn, { speechEnd: times.tSpeechEnd ?? null, transcript: times.tTranscript ?? null });
    if (line !== undefined) {
      await this.sayLine(tts, turn, line, signal);
      return;
    }

    // The operator spoke first: the session agent answers that, not a greeting.
    if (mode === 'user') this.greetPending = null;
    let invoke: AgentInput['invoke'];
    const intent = mode === 'user' ? matchCallIntent(text) : null;
    switch (intent?.kind) {
      case 'stop_talking':
        // The turn it interrupted is already aborted; nothing is said.
        this.send({ type: 'agent.done', turn, interrupted: false });
        return;
      case 'hangup':
        await this.sayLine(tts, turn, this.inLanguage(HANGUP_GOODBYE), signal);
        this.hangUpAfter = true;
        return;
      case 'to_chief':
        if (focus.kind === 'chief') break;
        this.setFocus({ kind: 'chief' });
        await this.sayLine(
          tts,
          turn,
          backWithMe(
            getVoiceSettings(this.deps.db).language,
            this.readPlanning(focus.sessionId),
            this.otherPlanningSessions(focus.sessionId).map(asWaiting),
          ),
          signal,
        );
        return;
      case 'carry_on': {
        // Only a planning session is sent off; anywhere else it is just words for the agent.
        if (focus.kind !== 'session' || !this.isPlanning(focus.sessionId)) break;
        const { sessionId } = focus;
        // Asked outright, so it goes off even if all it said so far was its greeting.
        this.briefed.add(sessionId);
        this.setFocus({ kind: 'chief' });
        const name = this.readPlanning(sessionId)?.sessionName ?? getSession(this.deps.db, sessionId)?.name ?? sessionId;
        await this.sayLine(tts, turn, carryingOn(getVoiceSettings(this.deps.db).language, name), signal);
        return;
      }
      case 'repeat':
        await this.replay(tts, turn, signal);
        return;
      case 'mute':
        this.setMuted(true);
        await this.sayLine(tts, turn, this.inLanguage(MUTED_LINE), signal);
        return;
      case 'unmute':
        this.setMuted(false);
        await this.sayLine(tts, turn, this.inLanguage(UNMUTED_LINE), signal);
        return;
      case 'to_session':
        // Chief resolves the name with `focus_session` and asks when it is ambiguous.
        focus = { kind: 'chief' };
        invoke = { tool: 'focus_session', args: { session: intent.name } };
        break;
      case undefined:
        break;
    }
    const sessionId = focus.kind === 'session' ? focus.sessionId : null;
    const agent = this.agentFor(focus);
    if (mode === 'user' && sessionId !== null && agent.kind === 'session') this.briefed.add(sessionId);
    const stateBefore = sessionId !== null && agent.kind === 'session' ? this.planningStateOf(sessionId) : null;
    const resume = sessionId !== null && agent.kind === 'session' ? this.resumes.get(sessionId) : undefined;
    const prefetched =
      mode === 'user' && invoke === undefined && focus.kind === 'chief'
        ? this.adoptSpeculation(text, signal)
        : this.dropSpeculation();
    const marks: { tFirstToken?: string; tFirstChunk?: string; tFirstAudioSent?: string } = {};
    const speaks: Promise<void>[] = [];
    let flushed: string[] | null = null;
    const chunker = new SentenceChunker((segment) => {
      marks.tFirstChunk ??= this.isoNow();
      if (flushed !== null) flushed.push(segment);
      else speaks.push(this.speak(tts, turn, segment, false, signal, marks));
    }, getVoiceSettings(this.deps.db).pronunciations);

    let reply = '';
    const tools: { name: string; status: ToolStatus; summary: string }[] = [];
    try {
      for await (const event of agent.run({
        text,
        turn,
        signal,
        ...(invoke === undefined ? {} : { invoke }),
        ...(prefetched === undefined ? {} : { prefetched }),
        ...(resume === undefined ? {} : { resume }),
      })) {
        // Anything past the "one sec" means the agent was sent the resume.
        if (resume !== undefined && sessionId !== null && event.type !== 'earcon') this.resumes.delete(sessionId);
        // Past a barge-in only a finished tool's card still goes out.
        const late = signal.aborted;
        if (late && !(event.type === 'tool' && event.status !== 'running')) break;
        switch (event.type) {
          case 'delta':
            marks.tFirstToken ??= this.isoNow();
            reply += event.text;
            this.send({ type: 'agent.delta', turn, agent: agent.kind, text: event.text });
            chunker.push(event.text);
            break;
          case 'tool':
            this.send({
              type: 'tool',
              turn,
              id: event.id,
              name: event.name,
              status: event.status,
              summary: event.summary,
              ...(event.detail === undefined ? {} : { detail: event.detail }),
            });
            if (event.status !== 'running') tools.push({ name: event.name, status: event.status, summary: event.summary });
            break;
          case 'ui':
            this.send({ type: 'ui', ...event.ui });
            break;
          case 'usage':
            this.addUsage({ chatCostUsd: event.costUsd ?? 0, claudeTurns: event.claudeTurns ?? 0 });
            break;
          case 'earcon':
            this.earcon(event.name);
            break;
        }
        if (late) break;
      }
      if (!signal.aborted) {
        flushed = [];
        chunker.flush();
        const tail = flushed as string[];
        flushed = null;
        if (tail.length === 0) tail.push('');
        tail.forEach((segment, i) => {
          speaks.push(this.speak(tts, turn, segment, i === tail.length - 1, signal, marks));
        });
      }
    } catch (cause) {
      if (!signal.aborted) {
        logger.warn('voice agent failed', { call: this.id, error: String(cause) });
        this.send({ type: 'error', code: 'agent_failed', message: 'The agent could not answer.', fatal: false });
      }
    }
    await Promise.allSettled(speaks);

    const interrupted = signal.aborted;
    this.send({ type: 'agent.done', turn, interrupted });
    if (reply !== '' || tools.length > 0) {
      const row = insertVoiceTurn(this.deps.db, {
        callId: this.id,
        turn,
        speaker: agent.kind,
        sessionId,
        text: reply,
        interrupted,
        toolsJson: tools.length > 0 ? JSON.stringify(tools) : null,
        ...this.replyTimes(turn, marks),
      });
      this.replyRows.set(turn, row.id);
    }
    this.noteReply(turn, agent.kind, reply);
    if (sessionId !== null && agent.kind === 'session') {
      if (!interrupted && resume !== undefined) this.resumes.delete(sessionId);
      this.pollPrd(sessionId);
      // Re-read after every turn (US-011): an answered question shows on the panel at once.
      const after = this.planningOf(sessionId);
      this.planningChanged();
      if (!interrupted && stateBefore !== 'done' && after?.state === 'done') this.remindOfOthers(sessionId);
    }
  }

  /** A fixed line the call says itself, as chief: an intent's answer, not a model's. */
  private async sayLine(tts: CallTts, turn: number, text: string, signal: AbortSignal): Promise<void> {
    this.send({ type: 'agent.delta', turn, agent: 'chief', text });
    const spoken = toSpeakable(text, getVoiceSettings(this.deps.db).pronunciations);
    const marks: { tFirstAudioSent?: string } = {};
    await this.speak(tts, turn, spoken, true, signal, marks).catch(() => undefined);
    // `runTurn` already sent `tts.stop` if this was cut off.
    const interrupted = signal.aborted;
    this.send({ type: 'agent.done', turn, interrupted });
    const row = insertVoiceTurn(this.deps.db, {
      callId: this.id,
      turn,
      speaker: 'chief',
      text,
      interrupted,
      ...this.replyTimes(turn, marks),
    });
    this.replyRows.set(turn, row.id);
    this.noteReply(turn, 'chief', text);
  }

  /**
   * The `repeat` intent: the last turn that spoke goes out again from the
   * call's own copy of its audio, with no provider call. Muted, it is text only.
   */
  private async replay(tts: CallTts, turn: number, signal: AbortSignal): Promise<void> {
    const last = this.recording;
    if (last === null) {
      await this.sayLine(tts, turn, this.inLanguage(NOTHING_TO_REPEAT), signal);
      return;
    }
    const text = last.text !== '' ? last.text : last.segments.map((segment) => segment.text).join(' ');
    this.send({ type: 'agent.delta', turn, agent: last.agent, text });
    const marks: { tFirstAudioSent?: string } = {};
    for (const segment of last.segments) {
      if (signal.aborted || this.state.muted) break;
      const segmentId = ++this.segmentSeq;
      const bytes = segment.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      this.segmentTexts.set(segmentId, { turn, text: segment.text, bytes, sampleRate: segment.sampleRate });
      this.audioStarted();
      this.send({ type: 'tts.segment', segmentId, turn, text: segment.text, sampleRate: segment.sampleRate, format: segment.format });
      for (const chunk of segment.chunks) {
        marks.tFirstAudioSent ??= this.isoNow();
        this.transport?.sendAudio(segmentId, chunk);
      }
      this.send({ type: 'tts.end', segmentId });
    }
    const interrupted = signal.aborted;
    this.send({ type: 'agent.done', turn, interrupted });
    const row = insertVoiceTurn(this.deps.db, {
      callId: this.id,
      turn,
      speaker: last.agent,
      text,
      interrupted,
      ...this.replyTimes(turn, marks),
    });
    this.replyRows.set(turn, row.id);
  }

  /** The recording of `turn`, if it spoke, learns whose reply it was and its text. */
  private noteReply(turn: number, agent: AgentKind, text: string): void {
    if (this.recording?.turn !== turn) return;
    this.recording.agent = agent;
    this.recording.text = text;
  }

  private inLanguage(lines: Readonly<Record<string, string>>): string {
    return lines[getVoiceSettings(this.deps.db).language] ?? (lines['en'] as string);
  }

  /** The session's name and PRD as the planning poller sees them; null without one, or on a failure. */
  /** A session whose agent plans (`plan` mode), not one it only answers questions about. */
  private isPlanning(sessionId: string): boolean {
    const session = getSession(this.deps.db, sessionId);
    return session !== null && voiceAgentMode(session) === 'plan';
  }

  private planningStateOf(sessionId: string): PlanningStateName | null {
    return this.planningOf(sessionId)?.state ?? null;
  }

  private planningOf(sessionId: string): PlanningState | null {
    try {
      return this.deps.planningStates?.planningState(sessionId) ?? null;
    } catch (cause) {
      logger.warn('voice call could not read the planning state', { session: sessionId, error: String(cause) });
      return null;
    }
  }

  /**
   * The focus moved to `sessionId` (US-011): a planning session that waits
   * for the operator (`waiting`, `done` or `failed`) is resumed with its
   * open questions instead of greeted, and the panel hears where it stands.
   */
  private prepareResume(sessionId: string): void {
    this.resumes.delete(sessionId);
    const planning = this.planningOf(sessionId);
    this.planningChanged();
    if (planning === null) return;
    const { state } = planning;
    if (state !== 'waiting' && state !== 'done' && state !== 'failed') return;
    this.resumes.set(
      sessionId,
      resumePrompt(planning.openQuestions, {
        state,
        ...(planning.failure === undefined ? {} : { failure: FAILURE_REASONS[planning.failure] }),
      }),
    );
  }

  /**
   * Tells the panel where every planning session stands (US-013), when
   * anything in the list changed since it was last sent. The service calls
   * this too, when a detached turn starts or ends.
   */
  planningChanged(): void {
    if (this.ended || this.deps.planningStates === undefined) return;
    let sessions: PlanningSessionView[];
    try {
      sessions = this.deps.planningStates.listPlanningSessions().map((planning) => ({
        sessionId: planning.sessionId,
        name: planning.sessionName,
        repository: planning.repositoryName,
        state: planning.state,
        openQuestions: planning.openQuestions.length,
        stories: planning.stories,
      }));
    } catch (cause) {
      logger.warn('voice call could not list the planning sessions', { error: String(cause) });
      return;
    }
    const key = JSON.stringify(sessions);
    if (this.planningSent === key || this.transport === null) return;
    this.planningSent = key;
    this.send({ type: 'planning', sessions });
  }

  /** Every planning session but `sessionId`, most recently updated first; empty on a failure. */
  private otherPlanningSessions(sessionId: string): PlanningState[] {
    try {
      return (this.deps.planningStates?.listPlanningSessions() ?? []).filter((state) => state.sessionId !== sessionId);
    } catch (cause) {
      logger.warn('voice call could not list the planning sessions', { error: String(cause) });
      return [];
    }
  }

  /**
   * The focused planning session has just become `done` (US-009): the other
   * planning sessions are named at the next quiet moment; the event keeps the
   * one waiting session, when there is exactly one, as its `offer`.
   */
  private remindOfOthers(sessionId: string): void {
    const settings = getVoiceSettings(this.deps.db);
    if (settings.eventVerbosity === 'none') return;
    const others = this.otherPlanningSessions(sessionId);
    const summary = waitingSummary(settings.language, others.map(asWaiting));
    if (summary === '') return;
    const waiting = others.filter((state) => state.state === 'waiting');
    const offer = waiting.length === 1 ? (waiting[0] as PlanningState) : null;
    this.state.queue.push({
      kind: 'planning.waiting',
      text: summary,
      sessionId,
      line: summary,
      ...(offer === null ? {} : { offer: { sessionId: offer.sessionId, name: offer.sessionName } }),
    });
    this.scheduleDrain();
  }

  private readPlanning(sessionId: string): { sessionName: string; prd: PrdStatus } | null {
    try {
      return this.deps.planning?.status(sessionId) ?? null;
    } catch (cause) {
      logger.warn('voice call could not read the planning status', { session: sessionId, error: String(cause) });
      return null;
    }
  }

  /**
   * Polls the planning poller after a session agent's turn (docs/voice-plan.md §10.6): a
   * `prd.md` that has just become valid comes back through `postEvent`.
   */
  private pollPrd(sessionId: string): void {
    this.readPlanning(sessionId);
  }

  /** Speaks one segment: `tts.segment`, binary audio, then `tts.end`. */
  private async speak(
    tts: CallTts,
    turn: number,
    text: string,
    last: boolean,
    signal: AbortSignal,
    marks: { tFirstAudioSent?: string },
  ): Promise<void> {
    // Muted: the text went out as deltas; nothing is sent to a provider.
    if (this.state.muted) return;
    const segmentId = ++this.segmentSeq;
    const entry: SpokenSegment = { turn, text, bytes: 0, sampleRate: 0 };
    this.segmentTexts.set(segmentId, entry);
    let started = false;
    let recorded: RecordedSegment | null = null;
    try {
      await tts.speak({ segmentId, turn, text, last }, signal, {
        onStart: (format) => {
          if (signal.aborted) return;
          started = true;
          entry.sampleRate = format.kind === 'pcm16' ? format.sampleRate : 0;
          recorded = this.record(turn, text, format);
          this.audioStarted();
          this.send({
            type: 'tts.segment',
            segmentId,
            turn,
            text,
            sampleRate: format.kind === 'pcm16' ? format.sampleRate : 0,
            format: format.kind,
          });
        },
        onAudio: (chunk) => {
          if (signal.aborted || this.state.muted) return;
          marks.tFirstAudioSent ??= this.isoNow();
          entry.bytes += chunk.length;
          (recorded as RecordedSegment | null)?.chunks.push(chunk);
          this.transport?.sendAudio(segmentId, chunk);
          this.touch();
        },
      });
    } finally {
      if (started && !signal.aborted) this.send({ type: 'tts.end', segmentId });
    }
  }

  /**
   * `transcript.partial` (US-022): chief starts on words that held still for
   * 300 ms. Only for a plain chief turn in Scribe mode with the setting on,
   * and never over a running turn.
   */
  private speculate(text: string): void {
    if (this.speculation !== null && sameUtterance(this.speculation.text, text)) return;
    this.dropSpeculation();
    if (this.sttMode !== 'elevenlabs-realtime' || !getVoiceSettings(this.deps.db).speculativeChief) return;
    if (!this.persisted || this.state.activeTurn !== null || this.state.focus.kind !== 'chief') return;
    const agent = this.agentFor({ kind: 'chief' });
    if (agent.speculate === undefined) return;
    const controller = new AbortController();
    const step = agent.speculate(text, controller.signal);
    if (step !== null) this.speculation = { text, controller, step };
  }

  /** Throws the early start away (the words moved on, or the commit said something else). */
  private dropSpeculation(): undefined {
    this.speculation?.controller.abort(new Error('speculation discarded'));
    this.speculation = null;
    return undefined;
  }

  /** The early start for `text`, now owned by the turn behind `signal`; undefined when there is none for it. */
  private adoptSpeculation(text: string, signal: AbortSignal): SpeculativeStep | undefined {
    const speculation = this.speculation;
    if (speculation === null || !sameUtterance(speculation.text, text)) return this.dropSpeculation();
    this.speculation = null;
    const abort = (): void => speculation.controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return speculation.step;
  }

  private agentFor(focus: CallFocus): VoiceAgent {
    const key = focus.kind === 'chief' ? 'chief' : `session:${focus.sessionId}`;
    let agent = this.agents.get(key);
    if (agent === undefined) {
      agent = this.deps.agent(focus, this);
      this.agents.set(key, agent);
    }
    return agent;
  }

  /* ------------------------------------------------------------- earcons */

  /**
   * Plays a cached earcon (docs/voice-plan.md §3.1), unless the voice is muted or the
   * call has none. The acknowledgement waiting for this utterance is done.
   * Chief's `focus_session` plays "one sec" through this while it boots.
   */
  earcon(name: EarconName): void {
    this.clearAck();
    if (this.state.muted || !this.earcons.has(name)) return;
    this.send({ type: 'earcon', name });
  }

  /**
   * Mute voice (US-021): replies stream as text only until unmuted; audio
   * already on its way is dropped and the browser stops playing.
   */
  setMuted(muted: boolean): void {
    if (this.state.muted === muted) {
      this.sendState();
      return;
    }
    this.state.muted = muted;
    if (muted) {
      this.clearAck();
      if (this.state.activeTurn !== null) this.send({ type: 'tts.stop', turn: this.state.turn });
    }
    this.sendState();
  }

  private async loadEarcons(provider: TtsProviderName): Promise<void> {
    const source = this.deps.earcons;
    if (source === undefined) return;
    let timer: unknown = null;
    let clips: readonly EarconClip[] | null = null;
    try {
      clips = await Promise.race([
        // Never aborted: a render that outlasts the wait still fills the cache.
        source.load(provider, new AbortController().signal),
        new Promise<null>((resolve) => {
          timer = this.deps.clock.setTimeout(() => resolve(null), EARCON_WAIT_MS);
        }),
      ]);
    } catch (cause) {
      logger.warn('voice earcons could not be loaded', { call: this.id, error: String(cause) });
    } finally {
      this.deps.clock.clearTimeout(timer);
    }
    if (clips === null) return;
    const language = earconLanguage(getVoiceSettings(this.deps.db).language);
    for (const clip of clips) {
      if (clip.language !== language) continue;
      this.earcons.set(clip.name, { segmentId: ++this.segmentSeq, sampleRate: clip.sampleRate, pcm: clip.pcm });
    }
  }

  /** After `ready`: every earcon's audio under the segment id `ready` gave it. */
  private sendEarconAudio(): void {
    for (const { segmentId, pcm } of this.earcons.values()) {
      this.transport?.sendAudio(segmentId, pcm);
      this.send({ type: 'tts.end', segmentId });
    }
  }

  /** Arms the 700 ms acknowledgement for an utterance that just came in. */
  private armAck(): { timer: unknown } {
    this.clearAck();
    const ack: { timer: unknown } = { timer: null };
    ack.timer = this.deps.clock.setTimeout(() => {
      if (this.ack !== ack) return;
      this.ack = null;
      const name = ACK_EARCONS[this.acks++ % ACK_EARCONS.length] as EarconName;
      this.earcon(name);
    }, ACK_AFTER_MS);
    this.ack = ack;
    return ack;
  }

  /** Stops the acknowledgement: `only` when it is still that utterance's. */
  private clearAck(only?: { timer: unknown }): void {
    const ack = this.ack;
    if (ack === null || (only !== undefined && ack !== only)) return;
    this.deps.clock.clearTimeout(ack.timer);
    this.ack = null;
  }

  /** The turn's first audio is going out: no acknowledgement needed. */
  private audioStarted(): void {
    this.clearAck();
    this.setPhase('speaking');
  }

  /** The segment's audio, kept as the turn's recording for `repeat`; a turn that speaks replaces the last one. */
  private record(turn: number, text: string, format: TtsFormat): RecordedSegment {
    if (this.recording?.turn !== turn) this.recording = { turn, agent: 'chief', text: '', segments: [] };
    const segment: RecordedSegment = {
      text,
      format: format.kind,
      sampleRate: format.kind === 'pcm16' ? format.sampleRate : 0,
      chunks: [],
    };
    this.recording.segments.push(segment);
    return segment;
  }

  /* -------------------------------------------------------------- events */

  /**
   * A background event (voice US-015; docs/voice-plan.md §12). It is toasted at once,
   * whatever happens next. Chief speaks it only if `voice_event_verbosity`
   * allows the kind and, while a session agent has the focus, only if it is
   * about that session; then it waits in `state.queue` for a quiet moment.
   * A finished draft (`planning.drafted`, US-008) is the exception: it is
   * spoken whatever the focus, as a fixed line the call says itself.
   */
  postEvent(event: VoiceBusEvent): void {
    if (this.ended || !this.persisted) return;
    // A PRD edited in the planning terminal changes a planning session too (US-013).
    this.planningChanged();
    const settings = getVoiceSettings(this.deps.db);
    const text = describeEvent(event, settings.timezone);
    this.send({ type: 'ui', action: 'toast', text });
    // A PRD the voice conversation just made valid (docs/voice-plan.md §10.6): the page
    // points at it, and chief says so even below `all` verbosity.
    const planned = event.kind === 'prd.valid' && this.agents.has(`session:${event.sessionId}`);
    if (planned) this.send({ type: 'ui', action: 'highlight', target: 'prd' });
    const handOff = event.kind === 'session.setup' && event.sessionId === this.handOffOnSetup;
    if (handOff && !event.ok) this.handOffOnSetup = null;
    const announced = isAnnounced(event.kind, settings.eventVerbosity) || (planned && settings.eventVerbosity !== 'none');
    const queued: VoiceEvent = {
      kind: event.kind,
      text,
      sessionId: eventSessionId(event),
      ...(event.kind === 'planning.drafted' ? { line: draftedLine(settings.language, event) } : {}),
    };
    if (!announced || !this.concerns(queued)) {
      // Nothing to wait for: the handoff happens now.
      if (handOff && event.ok) this.handOff(event.sessionId);
      return;
    }
    this.state.queue.push(queued);
    this.scheduleDrain();
  }

  /** Chief speaks about anything; a focused session agent's call only hears its own session, and every finished draft. */
  private concerns(event: VoiceEvent): boolean {
    const focus = this.state.focus;
    return focus.kind === 'chief' || event.kind === 'planning.drafted' || event.sessionId === focus.sessionId;
  }

  private markActivity(): void {
    this.lastActivityAt = this.deps.clock.now();
    if (this.state.queue.length > 0) this.scheduleDrain();
  }

  /** (Re)arms the one timer that delivers the queue once both sides have been quiet {@link EVENT_QUIET_MS}. */
  private scheduleDrain(): void {
    this.clearDrain();
    if (this.ended || this.state.queue.length === 0) return;
    const wait = Math.max(0, EVENT_QUIET_MS - (this.deps.clock.now() - this.lastActivityAt));
    this.drainTimer = this.deps.clock.setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, wait);
  }

  private clearDrain(): void {
    if (this.drainTimer !== null) this.deps.clock.clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  /**
   * Hands every queued event to chief as one `[event]` turn, if the call is
   * listening and quiet. Otherwise it waits: the end of the turn, the next
   * sign of speech or a resumed socket arms the timer again.
   */
  private drain(): void {
    if (this.ended || this.state.queue.length === 0) return;
    if (this.state.phase !== 'listening' || this.state.activeTurn !== null || this.transport === null) return;
    const now = this.deps.clock.now();
    if (this.speechOpenSince !== null) {
      // A speech start with no utterance for longer than one can last was a
      // lost message, not someone still talking.
      if (now - this.speechOpenSince < this.deps.config.voiceMaxUtteranceMs) return;
      this.speechOpenSince = null;
    }
    if (now - this.lastActivityAt < EVENT_QUIET_MS) {
      this.scheduleDrain();
      return;
    }
    // The focus may have moved since the events were queued.
    const queued = this.state.queue.splice(0).filter((event) => this.concerns(event));
    // A finished draft already says what a `prd.valid` for its session would.
    const drafted = new Set(queued.flatMap((event) => (event.kind === 'planning.drafted' ? [event.sessionId] : [])));
    const events = queued.filter((event) => !(event.kind === 'prd.valid' && drafted.has(event.sessionId)));
    if (events.length === 0) return;
    const lines = events.filter((event) => event.line !== undefined);
    const rest = events.filter((event) => event.line === undefined);
    const asEvents = (list: VoiceEvent[]): string => list.map((event) => `[event] ${event.text}`).join('\n');
    const handOff = this.handOffOnSetup;
    const ready = handOff !== null && events.some((event) => event.kind === 'session.setup' && event.sessionId === handOff);
    // One piece of work: a second `enqueue` would supersede the first.
    void this.enqueue(async (controller) => {
      if (lines.length > 0) {
        const line = lines.map((event) => event.line).join(' ');
        await this.runTurn(asEvents(lines), controller, {}, 'event', line);
      }
      if (rest.length > 0 && !controller.signal.aborted) await this.runTurn(asEvents(rest), controller, {}, 'event');
      // Chief has said the session is ready; the session's agent speaks next. An
      // operator who talked over the announcement is answered by chief instead.
      if (!ready) return;
      if (controller.signal.aborted) this.handOffOnSetup = null;
      else this.handOff(handOff);
    });
  }

  /* ---------------------------------------------------------------- idle */

  /** Speech in either direction: the idle clock starts over. */
  private touch(): void {
    if (this.idleTimer !== null) this.armIdle();
    this.markActivity();
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.ended || this.transport === null) return;
    this.idleTimer = this.deps.clock.setTimeout(() => {
      this.idleTimer = null;
      this.onIdle().catch((cause: unknown) => {
        logger.error('voice idle goodbye failed', { call: this.id, error: String(cause) });
        this.endSoon('idle');
      });
    }, this.deps.config.voiceIdleTimeoutMs);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.deps.clock.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async onIdle(): Promise<void> {
    if (this.ended) return;
    if (this.state.activeTurn !== null) {
      // A turn is still going; the timer restarts when it is done.
      return;
    }
    const tts = this.tts;
    if (tts !== null) {
      const controller = new AbortController();
      this.state.activeTurn = controller;
      const turn = ++this.state.turn;
      const settings = getVoiceSettings(this.deps.db);
      const text = IDLE_GOODBYE[settings.language] ?? (IDLE_GOODBYE['en'] as string);
      this.setPhase('speaking');
      this.send({ type: 'agent.delta', turn, agent: 'chief', text });
      let timer: unknown = null;
      await Promise.race([
        this.speak(tts, turn, toSpeakable(text, settings.pronunciations), true, controller.signal, {}).catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = this.deps.clock.setTimeout(resolve, GOODBYE_MAX_MS);
        }),
      ]);
      this.deps.clock.clearTimeout(timer);
      this.send({ type: 'agent.done', turn, interrupted: false });
      insertVoiceTurn(this.deps.db, { callId: this.id, turn, speaker: 'chief', text });
      if (this.state.activeTurn === controller) this.state.activeTurn = null;
    }
    await this.end('idle');
  }

  /* ------------------------------------------------------------- helpers */

  private sink(): TtsSink {
    return {
      toast: (text) => this.send({ type: 'ui', action: 'toast', text }),
      error: (error) => this.send({ type: 'error', ...error }),
      chars: ({ provider, chars, generationId }) => {
        if (provider === 'elevenlabs') this.addUsage({ elChars: chars });
        else if (generationId !== undefined) this.usage.addGeneration(generationId);
      },
      providerChanged: (provider) => {
        this.state.ttsProvider = provider;
        if (this.persisted) updateVoiceCall(this.deps.db, this.id, { ttsProvider: provider });
      },
    };
  }

  private addUsage(add: UsageDelta): void {
    this.usage.add(add);
    if (this.persisted) updateVoiceCall(this.deps.db, this.id, this.usage.toCallUpdate());
    this.sendUsage();
  }

  private sendReady(resumed: boolean): void {
    this.send({
      type: 'ready',
      callId: this.id,
      focus: this.state.focus,
      sttMode: this.sttMode,
      earcons: [...this.earcons].map(([name, { segmentId, sampleRate }]) => ({ name, segmentId, sampleRate })),
      sampleRate: this.tts?.format.kind === 'pcm16' ? this.tts.format.sampleRate : 0,
      resumed,
    });
    this.sendState();
    // A new socket has heard nothing yet.
    this.planningSent = null;
    this.planningChanged();
    this.sendEarconAudio();
  }

  private setPhase(phase: CallPhase): void {
    if (this.ended || this.state.phase === phase) return;
    this.state.phase = phase;
    this.sendState();
    if (phase === 'listening') this.markActivity();
  }

  private sendState(): void {
    this.send({ type: 'state', phase: this.state.phase, focus: this.state.focus, muted: this.state.muted });
  }

  private send(message: ServerMessage): void {
    this.transport?.send(message);
  }

  /**
   * Merges what is now known of `turn`'s timing and sends it as `latency`
   * (US-026). Only the last few turns are kept.
   */
  private noteTimes(turn: number, patch: Partial<TurnTimes>): void {
    const known = this.turnTimes.get(turn) ?? NO_TIMES;
    const times: TurnTimes = { ...known };
    for (const [key, value] of Object.entries(patch) as [keyof TurnTimes, string | null | undefined][]) {
      if (value !== undefined && value !== null) (times as Record<keyof TurnTimes, string | null>)[key] = value;
    }
    this.turnTimes.set(turn, times);
    for (const old of this.turnTimes.keys()) if (old <= turn - TIMED_TURNS_KEPT) this.turnTimes.delete(old);
    this.send({ type: 'latency', turn, times });
  }

  /** The reply row's timing columns: the turn's marks plus a `metrics` report that came first. */
  private replyTimes(
    turn: number,
    marks: { readonly tFirstToken?: string; readonly tFirstChunk?: string; readonly tFirstAudioSent?: string },
  ): { tFirstToken?: string; tFirstChunk?: string; tFirstAudioSent?: string; tFirstAudioPlayed?: string } {
    this.noteTimes(turn, {
      firstToken: marks.tFirstToken ?? null,
      firstChunk: marks.tFirstChunk ?? null,
      firstAudioSent: marks.tFirstAudioSent ?? null,
    });
    const played = this.turnTimes.get(turn)?.firstAudioPlayed ?? null;
    return { ...marks, ...(played === null ? {} : { tFirstAudioPlayed: played }) };
  }

  private isoNow(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }
}

/** A segment sent to the browser, until its playback is reported done. */
interface SpokenSegment {
  readonly turn: number;
  readonly text: string;
  /** Audio bytes sent so far, and the PCM rate (0 for MP3), for the played share. */
  bytes: number;
  sampleRate: number;
}

/** One segment of the last spoken turn, as it went to the browser. */
interface RecordedSegment {
  readonly text: string;
  readonly format: TtsFormat['kind'];
  readonly sampleRate: number;
  readonly chunks: Buffer[];
}

interface Recording {
  readonly turn: number;
  agent: AgentKind;
  /** The reply as the transcript showed it. */
  text: string;
  readonly segments: RecordedSegment[];
}

/** Speech rate for MP3 segments, whose length the bytes do not tell: about 15 characters a second. */
const CHARS_PER_SECOND = 15;

/** The share of `segment` that `playedMs` of playback covers, 0–1. */
function playedShare(segment: SpokenSegment, playedMs: number): number {
  if (playedMs <= 0 || segment.text === '') return 0;
  const lengthMs =
    segment.sampleRate > 0 && segment.bytes > 0
      ? (segment.bytes / 2 / segment.sampleRate) * 1000
      : (segment.text.length / CHARS_PER_SECOND) * 1000;
  return Math.min(1, playedMs / lengthMs);
}

function sameFocus(a: CallFocus, b: CallFocus): boolean {
  return a.kind === 'chief' ? b.kind === 'chief' : b.kind === 'session' && b.sessionId === a.sessionId;
}
