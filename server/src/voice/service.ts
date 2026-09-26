import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { WebSocket } from 'ws';

import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { logger } from '../lib/logger.js';
import {
  getElevenLabsApiKey,
  getOpenRouterApiKey,
  getVoiceElExhaustedUntil,
  getVoiceSettings,
} from '../settings/index.js';
import {
  type CallClock,
  type CallEarcons,
  type CallPlanning,
  type CallStt,
  type CallTransport,
  type CallTts,
  type CallUsageSources,
  systemClock,
  type VoiceAgent,
  VoiceCall,
} from './call.js';
import { ChiefAgent } from './chief/agent.js';
import { BasicChiefAgent } from './chief/basic-agent.js';
import type { ChiefServices } from './chief/tools.js';
import { EarconCache, earconVoice, providerRenderer } from './earcons.js';
import type { VoiceEventBus } from './events.js';
import { SessionVoiceAgent } from './session-agent/agent.js';
import type { SessionAgentRegistry } from './session-agent/registry.js';
import {
  type CallFocus,
  encodeFrame,
  FRAME_KIND_AUDIO,
  parseClientMessage,
  parseFocus,
  type SttMode,
  WS_CLOSE_CALL_IN_PROGRESS,
  WS_CLOSE_TAKEN_OVER,
} from './protocol.js';
import { fetchElevenLabsSubscription, fetchOpenRouterGenerationCost } from './providers.js';
import { SttService } from './stt/index.js';
import { TtsService, type TtsSink } from './tts/index.js';

/** How long a call whose socket dropped waits for `?resume=<callId>`. */
export const RESUME_WINDOW_MS = 30_000;
/** How long `GET /api/voice/status` reuses an ElevenLabs balance. */
export const EL_BALANCE_TTL_MS = 60_000;

/** Collaborators tests replace; production builds the real ones. */
export interface VoiceServiceDeps {
  readonly stt?: CallStt;
  readonly tts?: (sink: TtsSink) => CallTts;
  readonly agent?: (focus: CallFocus, call: VoiceCall) => VoiceAgent;
  /** What chief reads; without it chief is the tool-less basic agent. */
  readonly chief?: ChiefServices;
  readonly clock?: CallClock;
  readonly newCallId?: () => string;
  /** Background events (US-015) for the active call; without it chief hears none. */
  readonly events?: VoiceEventBus;
  /** Session voice agents (US-018); without them a session focus is answered by chief. */
  readonly sessionAgents?: SessionAgentRegistry;
  /** The planning poller a call reads after session-agent turns (US-019). */
  readonly planning?: CallPlanning;
  /**
   * Earcons (US-021). Without it, production renders them into
   * `<DATA_DIR>/voice-cache` with the real providers; a test that fakes
   * `tts` gets none unless it passes some.
   */
  readonly earcons?: CallEarcons;
  /**
   * The providers' usage numbers (US-023). Without it, production asks
   * ElevenLabs and OpenRouter; a test that fakes `tts` gets none.
   */
  readonly usage?: CallUsageSources;
}

export type VoiceReadiness =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'voice_disabled' | 'openrouter_key_missing' | 'elevenlabs_key_missing';
      readonly message: string;
    };

/**
 * Whether a call can start: voice is on and every key the configured
 * providers need is saved. OpenRouter is always needed (chief, and the
 * default STT and the backup voice); ElevenLabs only for Scribe, since the
 * voice falls back to OpenRouter without it.
 */
export function voiceReadiness(db: Database): VoiceReadiness {
  const settings = getVoiceSettings(db);
  if (!settings.enabled) return { ok: false, reason: 'voice_disabled', message: 'Voice is turned off in Settings.' };
  if (getOpenRouterApiKey(db) === null) {
    return { ok: false, reason: 'openrouter_key_missing', message: 'Save an OpenRouter API key in Settings → Voice.' };
  }
  if (settings.sttProvider === 'elevenlabs-realtime' && getElevenLabsApiKey(db) === null) {
    return { ok: false, reason: 'elevenlabs_key_missing', message: 'Scribe needs an ElevenLabs API key.' };
  }
  return { ok: true };
}

/**
 * The speech-to-text mode a call runs in: what `hello` asked for when that is
 * the configured provider (with its key), otherwise OpenRouter, which is
 * always available once the call is allowed at all.
 */
export function effectiveSttMode(db: Database, requested: SttMode): SttMode {
  if (requested === 'openrouter') return 'openrouter';
  if (getVoiceSettings(db).sttProvider !== requested) return 'openrouter';
  if (requested === 'elevenlabs-realtime' && getElevenLabsApiKey(db) === null) return 'openrouter';
  return requested;
}

export interface ElevenLabsBalance {
  readonly remaining: number;
  readonly limit: number;
  readonly resetsAt: string | null;
}

export interface VoiceStatus {
  readonly configured: boolean;
  readonly reason: string | null;
  readonly providers: {
    readonly stt: string;
    /** The voice a new call would start on. */
    readonly tts: 'elevenlabs' | 'openrouter';
    readonly chiefModel: string;
    readonly openrouter: boolean;
    readonly elevenlabs: boolean;
  };
  /** `null` without a key, or when ElevenLabs could not be asked. */
  readonly elBalance: ElevenLabsBalance | null;
  readonly activeCallId: string | null;
}

/**
 * Owns the call (voice US-007): at most one per server, since there is one
 * operator. A second socket gets `4409 call_in_progress` unless it asks for
 * `?takeover=1`; a socket that drops leaves the call waiting
 * {@link RESUME_WINDOW_MS} for `?resume=<callId>`.
 */
export class VoiceService {
  private active: VoiceCall | null = null;
  private resumeTimer: unknown = null;
  private balance: { at: number; key: string; value: ElevenLabsBalance | null } | null = null;
  private readonly clock: CallClock;
  private readonly stt: CallStt;
  private readonly earcons: CallEarcons | null;
  private readonly usageSources: CallUsageSources | null;

  constructor(
    private readonly config: Config,
    private readonly db: Database,
    private readonly deps: VoiceServiceDeps = {},
  ) {
    this.clock = deps.clock ?? systemClock;
    this.stt = deps.stt ?? new SttService(db, config);
    this.earcons = deps.earcons ?? (deps.tts === undefined ? providerEarcons(db, config) : null);
    this.usageSources = deps.usage ?? (deps.tts === undefined ? providerUsage(db, config) : null);
    deps.events?.subscribe((event) => {
      this.active?.postEvent(event);
    });
  }

  get activeCallId(): string | null {
    return this.active?.id ?? null;
  }

  /** The call itself, for tests and later stories (focus, events). */
  get activeCall(): VoiceCall | null {
    return this.active;
  }

  /** A socket that passed the gateway, Origin and configuration checks. */
  connect(socket: WebSocket, query: URLSearchParams): void {
    const active = this.active;
    let call: VoiceCall;
    let resumed = false;

    if (active !== null && query.get('resume') === active.id && active.started) {
      // The browser is back; a socket the server has not seen drop yet is
      // closed as replaced.
      this.clearResumeTimer();
      active.replaceTransport(WS_CLOSE_TAKEN_OVER, 'taken_over');
      call = active;
      resumed = true;
    } else if (active !== null && active.attached && query.get('takeover') !== '1') {
      socket.close(WS_CLOSE_CALL_IN_PROGRESS, 'call_in_progress');
      return;
    } else {
      if (active !== null) {
        // Taken over, or a dropped call nobody came back for.
        this.clearResumeTimer();
        active.endSoon(active.attached ? 'taken_over' : 'error', WS_CLOSE_TAKEN_OVER, 'taken_over');
      }
      call = this.newCall(parseFocus(query.get('focus')));
      this.active = call;
    }

    const transport = socketTransport(socket);
    call.attach(transport);
    let hello = false;

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (hello) {
        call.handleFrame(data, isBinary);
        return;
      }
      const message = isBinary ? null : parseClientMessage(data.toString('utf8'));
      if (message?.type !== 'hello') {
        transport.send({ type: 'error', code: 'hello_first', message: 'Send hello first.', fatal: false });
        return;
      }
      hello = true;
      if (resumed) {
        call.resume();
        return;
      }
      call.start(effectiveSttMode(this.db, message.sttMode)).catch((cause: unknown) => {
        logger.error('voice call could not start', { call: call.id, error: String(cause) });
        call.endSoon('error', 1011, 'start_failed');
      });
    });

    socket.on('close', () => {
      if (!call.detach(transport) || call.ended) return;
      if (!call.started) {
        call.endSoon('error');
        return;
      }
      this.clearResumeTimer();
      this.resumeTimer = this.clock.setTimeout(() => {
        this.resumeTimer = null;
        if (!call.attached) call.endSoon('error');
      }, RESUME_WINDOW_MS);
    });
  }

  async status(): Promise<VoiceStatus> {
    const readiness = voiceReadiness(this.db);
    const settings = getVoiceSettings(this.db);
    const elKey = getElevenLabsApiKey(this.db);
    const exhausted = getVoiceElExhaustedUntil(this.db);
    const elUsable =
      elKey !== null && settings.voiceId !== null && (exhausted === null || Date.parse(exhausted) <= this.clock.now());
    return {
      configured: readiness.ok,
      reason: readiness.ok ? null : readiness.reason,
      providers: {
        stt: settings.sttProvider,
        tts: elUsable ? 'elevenlabs' : 'openrouter',
        chiefModel: settings.chiefModel,
        openrouter: getOpenRouterApiKey(this.db) !== null,
        elevenlabs: elKey !== null,
      },
      elBalance: elKey === null ? null : await this.elBalance(elKey),
      activeCallId: this.activeCallId,
    };
  }

  /**
   * The planning terminal takes the session over (voice US-025, after the
   * operator confirmed): a call talking to its agent goes back to chief, and
   * the agent stops, so the terminal can resume its conversation.
   */
  async handOverToTerminal(sessionId: string): Promise<void> {
    const focus = this.active?.focus;
    if (focus?.kind === 'session' && focus.sessionId === sessionId) this.active?.switchFocus({ kind: 'chief' });
    await this.deps.sessionAgents?.stop(sessionId);
  }

  /** Ends the call, at shutdown, and the session agents with it. */
  async closeAll(): Promise<void> {
    this.clearResumeTimer();
    await this.active?.end('error');
    await this.deps.sessionAgents?.stopAll();
  }

  private newCall(focus: CallFocus): VoiceCall {
    const { db, config } = this;
    this.deps.sessionAgents?.callStarted();
    if (focus.kind === 'session') this.deps.sessionAgents?.focused(focus.sessionId);
    return new VoiceCall(this.deps.newCallId?.() ?? randomUUID(), focus, {
      db,
      config,
      stt: this.stt,
      tts: this.deps.tts ?? ((sink) => new TtsService(db, config, sink, { now: () => this.clock.now() })),
      agent: this.deps.agent ?? ((focus, call) => this.agentFor(focus, call)),
      clock: this.clock,
      ...(this.deps.planning === undefined ? {} : { planning: this.deps.planning }),
      ...(this.earcons === null ? {} : { earcons: this.earcons }),
      ...(this.usageSources === null ? {} : { usage: this.usageSources }),
      onSessionFocused: (sessionId) => this.deps.sessionAgents?.focused(sessionId),
      onEnded: (ended) => {
        if (this.active !== ended) return;
        this.active = null;
        this.deps.sessionAgents?.callEnded();
        this.clearResumeTimer();
      },
    });
  }

  private agentFor(focus: CallFocus, call: VoiceCall): VoiceAgent {
    const registry = this.deps.sessionAgents;
    if (focus.kind === 'chief' || registry === undefined) return this.chiefFor(call);
    return new SessionVoiceAgent({
      db: this.db,
      sessionId: focus.sessionId,
      registry,
      call: { setFocus: (next) => call.setFocus(next), spokenSoFar: () => call.state.spokenSoFar },
    });
  }

  private chiefFor(call: VoiceCall): VoiceAgent {
    const services = this.deps.chief;
    if (services === undefined) return new BasicChiefAgent(this.db, this.config);
    return new ChiefAgent({ db: this.db, config: this.config, services, call });
  }

  private async elBalance(key: string): Promise<ElevenLabsBalance | null> {
    const now = this.clock.now();
    if (this.balance !== null && this.balance.key === key && now - this.balance.at < EL_BALANCE_TTL_MS) {
      return this.balance.value;
    }
    let value: ElevenLabsBalance | null = null;
    try {
      const subscription = await fetchElevenLabsSubscription(this.config.elevenlabsApiUrl, key);
      value = { remaining: subscription.remaining, limit: subscription.characterLimit, resetsAt: subscription.resetsAt };
    } catch (cause) {
      logger.warn('could not read the ElevenLabs balance', { error: String(cause) });
    }
    this.balance = { at: now, key, value };
    return value;
  }

  private clearResumeTimer(): void {
    if (this.resumeTimer !== null) this.clock.clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }
}

/** The balance and generation costs, read with whatever keys are saved at the time. */
function providerUsage(db: Database, config: Config): CallUsageSources {
  return {
    subscription: async () => {
      const key = getElevenLabsApiKey(db);
      return key === null ? null : fetchElevenLabsSubscription(config.elevenlabsApiUrl, key);
    },
    generationCost: async (id) => {
      const key = getOpenRouterApiKey(db);
      return key === null ? null : fetchOpenRouterGenerationCost(config.openrouterApiUrl, key, id);
    },
  };
}

/** The earcons of whichever voice a call opens on, cached under `<DATA_DIR>/voice-cache`. */
function providerEarcons(db: Database, config: Config): CallEarcons {
  const cache = new EarconCache(path.join(config.dataDir, 'voice-cache'), providerRenderer(db, config));
  return {
    load: async (provider, signal) => {
      const voice = earconVoice(db, provider);
      return voice === null ? [] : cache.load(voice, signal);
    },
  };
}

function socketTransport(socket: WebSocket): CallTransport {
  return {
    send: (message) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    },
    sendAudio: (segmentId, chunk) => {
      if (socket.readyState === socket.OPEN) socket.send(encodeFrame(FRAME_KIND_AUDIO, segmentId, chunk), { binary: true });
    },
    close: (code, reason) => {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
    },
  };
}
