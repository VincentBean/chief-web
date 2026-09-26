import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { getOpenRouterApiKey, getVoiceSettings } from '../../settings/index.js';
import type { AgentEvent, AgentInput, VoiceAgent } from '../call.js';
import { cutOffNote } from '../cut-off.js';
import type { EarconName } from '../earcons.js';
import type { CallFocus } from '../protocol.js';
import { type ChatEvent, type ChatMessage, type ChatToolCall, type StreamChatOptions, streamChat } from './openrouter-client.js';
import { cancelledResult, CONFIRM_TOOL, type ConfirmationGate, runConfirmation } from './confirm.js';
import { chiefSystemPrompt } from './prompt.js';
import { ChatPrefetch, sameUtterance } from './speculation.js';
import { buildSnapshot } from './snapshot.js';
import { type ChiefServices, type ChiefTool, createChiefTools, type ToolContext, type ToolResult } from './tools.js';

/** Messages of the conversation the model sees (docs/voice-plan.md §9.1). */
export const WINDOW_MESSAGES = 30;
export const CHIEF_TEMPERATURE = 0.4;
export const CHIEF_MAX_TOKENS = 400;
/** The summary of the turns that fell out of the window is short. */
const SUMMARY_MAX_TOKENS = 200;

/** The signal tool handlers get: only the model stream and the audio are cut on a barge-in. */
const NEVER_ABORTED = new AbortController().signal;

/** What chief says when OpenRouter is still failing after the client's retry. */
export const BRAIN_UNREACHABLE: Readonly<Record<string, string>> = {
  nl: 'Ik kan mijn brein nu even niet bereiken.',
  en: "I can't reach my brain right now.",
};

const SUMMARY_PROMPT =
  'You summarize the earlier part of a voice call between the operator and Chief, the voice of chief-web. ' +
  'Write one or two plain sentences with what was asked, decided and done, naming sessions and pull requests. ' +
  'No preamble.';

/** The call as chief's tools need it. */
export interface ChiefCallControls {
  readonly focus: CallFocus;
  /** Hangs up once the turn in progress has been spoken. */
  hangUpAfterTurn(): void;
  /** The call's one pending confirmation (US-011). */
  readonly confirmations: ConfirmationGate;
  /** Moves the call's focus (`focus_session`, voice US-018). */
  setFocus?(focus: CallFocus): void;
  /** Plays a cached earcon (US-021). */
  earcon?(name: EarconName): void;
  /** Hands the call to a session's agent once its setup is announced (voice feedback US-003). */
  handOffWhenReady?(sessionId: string): void;
  /** What the operator heard of the current turn (US-020), for the cut-off note. */
  spokenSoFar?(): string;
}

export type ChatFn = (opts: StreamChatOptions) => AsyncIterable<ChatEvent>;

export interface ChiefAgentDeps {
  readonly db: Database;
  readonly config: Config;
  readonly services: ChiefServices;
  readonly call: ChiefCallControls;
  readonly operatorName?: string | null;
  /** The streaming client; tests may pass another. */
  readonly chat?: ChatFn;
  readonly tools?: ReadonlyMap<string, ChiefTool>;
  readonly now?: () => Date;
}

/**
 * Chief (docs/voice-plan.md §9.1): an OpenRouter streaming loop with tools. Each model step
 * sees the system prompt with a fresh STATE block, the summary of whatever
 * fell out of the window, and the last {@link WINDOW_MESSAGES} messages. Text
 * is yielded as it streams in; tool calls are run between steps, up to
 * `VOICE_CHIEF_MAX_TOOL_HOPS` steps per utterance.
 */
export class ChiefAgent implements VoiceAgent {
  readonly kind = 'chief' as const;
  private readonly messages: ChatMessage[] = [];
  private summary: string | null = null;
  private summarizing: Promise<void> | null = null;
  /** What the summaries cost; reported with the next turn's usage. */
  private unreportedCostUsd = 0;
  /** What the operator heard of the reply they interrupted, for the next message's cut-off note. */
  private interruptedAfter: string | null = null;
  private readonly chat: ChatFn;
  private readonly tools: ReadonlyMap<string, ChiefTool>;
  private readonly now: () => Date;

  constructor(private readonly deps: ChiefAgentDeps) {
    this.chat = deps.chat ?? streamChat;
    this.tools = deps.tools ?? createChiefTools(deps.services);
    this.now = deps.now ?? (() => new Date());
  }

  /** The conversation as it stands, for tests. */
  get history(): readonly ChatMessage[] {
    return this.messages;
  }

  /** The line older turns were folded into, or null. */
  get earlierSummary(): string | null {
    return this.summary;
  }

  /** Settles once a summary in flight has landed (tests). */
  async idle(): Promise<void> {
    await this.summarizing;
  }

  /**
   * Starts the first model step for `text` early (US-022), without touching
   * the history: `run` with `prefetched` set replays it as that step.
   * Null when the next message would not be `text` as it stands (a cut-off
   * note is owed) or a summary is being folded in.
   */
  speculate(text: string, signal: AbortSignal): ChatPrefetch | null {
    if (this.interruptedAfter !== null || this.summarizing !== null) return null;
    const settings = getVoiceSettings(this.deps.db);
    const messages: ChatMessage[] = [...this.messages, { role: 'user', content: text }];
    const source = this.chat({
      baseUrl: this.deps.config.openrouterApiUrl,
      apiKey: getOpenRouterApiKey(this.deps.db) ?? '',
      model: settings.chiefModel,
      messages: [{ role: 'system', content: this.systemPrompt(settings.language) }, ...this.summaryLine(), ...this.window(messages)],
      tools: [...this.tools.values()].map((entry) => entry.definition),
      maxTokens: CHIEF_MAX_TOKENS,
      temperature: CHIEF_TEMPERATURE,
      signal,
    });
    return new ChatPrefetch(text, this, source);
  }

  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    const { signal, turn } = input;
    const settings = getVoiceSettings(this.deps.db);
    if (this.unreportedCostUsd > 0) {
      yield { type: 'usage', costUsd: this.unreportedCostUsd };
      this.unreportedCostUsd = 0;
    }
    const note = this.interruptedAfter;
    this.interruptedAfter = null;
    // A speculative first step (US-022) stands in for hop 0 when it answered exactly this message.
    let prefetched =
      input.prefetched instanceof ChatPrefetch && input.prefetched.owner === this && note === null && sameUtterance(input.prefetched.text, input.text)
        ? input.prefetched
        : null;
    this.messages.push({ role: 'user', content: note === null ? input.text : `${cutOffNote(note)} ${input.text}` });
    const definitions = [...this.tools.values()].map((entry) => entry.definition);
    /** Tool calls of the last assistant message still owed a `tool` answer. */
    let owed: ChatToolCall[] = [];
    /** Text streamed in this step and not yet in the history. */
    let unsaid = '';
    /** Whether this turn had started to answer, so an interrupt cut it off. */
    let spoke = false;
    try {
      if (input.resolution !== undefined) {
        // The operator already answered the pending confirmation ("yes", or
        // the pill's button): no model decides, it only hears the outcome as
        // the result of a `confirm` call and speaks one line about it.
        const { confirmationId, accept } = input.resolution;
        const call: ChatToolCall = {
          id: `confirm-${String(turn)}`,
          type: 'function',
          function: { name: CONFIRM_TOOL, arguments: JSON.stringify({ confirmation_id: confirmationId }) },
        };
        this.messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        owed = [call];
        yield { type: 'tool', id: call.id, name: CONFIRM_TOOL, status: 'running', summary: '' };
        const { name, result } = await this.resolveConfirmation(confirmationId, accept, { signal, turn });
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, ...wrap(result.data) }) });
        owed = [];
        yield { type: 'tool', id: call.id, name, status: result.ok ? 'ok' : 'error', summary: result.summary };
        for (const ui of result.ui ?? []) yield { type: 'ui', ui };
      } else if (input.invoke !== undefined) {
        // An intent already named the tool ("switch to billing export"): it
        // runs as chief's own call, and the model speaks about its result —
        // which is how an ambiguous or unknown name makes chief ask.
        const call: ChatToolCall = {
          id: `intent-${String(turn)}`,
          type: 'function',
          function: { name: input.invoke.tool, arguments: JSON.stringify(input.invoke.args) },
        };
        this.messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        owed = [call];
        yield { type: 'tool', id: call.id, name: call.function.name, status: 'running', summary: '' };
        const result = await this.execute(call, { signal, turn });
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, ...wrap(result.data) }) });
        owed = [];
        yield { type: 'tool', id: call.id, name: call.function.name, status: result.ok ? 'ok' : 'error', summary: result.summary };
        for (const ui of result.ui ?? []) yield { type: 'ui', ui };
      }
      for (let hop = 0; hop < this.deps.config.voiceChiefMaxToolHops; hop++) {
        let text = '';
        const calls: ChatToolCall[] = [];
        try {
          const step = prefetched?.replay() ?? this.chat({
            baseUrl: this.deps.config.openrouterApiUrl,
            apiKey: getOpenRouterApiKey(this.deps.db) ?? '',
            model: settings.chiefModel,
            messages: [{ role: 'system', content: this.systemPrompt(settings.language) }, ...this.summaryLine(), ...this.window()],
            tools: definitions,
            maxTokens: CHIEF_MAX_TOKENS,
            temperature: CHIEF_TEMPERATURE,
            signal,
          });
          prefetched = null;
          for await (const event of step) {
            if (event.type === 'delta') {
              text += event.text;
              unsaid = text;
              spoke = true;
              yield { type: 'delta', text: event.text };
            } else if (event.type === 'tool_call') {
              calls.push({ id: event.id, type: 'function', function: { name: event.name, arguments: event.arguments } });
            } else if (event.type === 'usage') {
              yield { type: 'usage', costUsd: event.costUsd };
            }
          }
        } catch (cause) {
          if (signal.aborted) throw cause;
          logger.warn('chief could not reach OpenRouter', { error: String(cause) });
          const line = BRAIN_UNREACHABLE[settings.language] ?? (BRAIN_UNREACHABLE['en'] as string);
          const spoken = text === '' ? line : ` ${line}`;
          unsaid = text + spoken;
          yield { type: 'delta', text: spoken };
          return;
        }

        unsaid = '';
        this.messages.push({ role: 'assistant', content: text === '' ? null : text, ...(calls.length === 0 ? {} : { tool_calls: calls }) });
        if (calls.length === 0) return;
        owed = [...calls];
        for (const call of calls) {
          if (signal.aborted) throw signal.reason;
          const name = call.function.name;
          yield { type: 'tool', id: call.id, name, status: 'running', summary: '' };
          // A barge-in does not stop a handler that has started: its result
          // is in the history before the card goes out, whatever comes next.
          const result = await this.execute(call, { signal, turn });
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, ...wrap(result.data) }) });
          owed = owed.filter((entry) => entry !== call);
          yield { type: 'tool', id: call.id, name, status: result.ok ? 'ok' : 'error', summary: result.summary };
          for (const ui of result.ui ?? []) yield { type: 'ui', ui };
        }
      }
      logger.warn('chief ran out of tool hops', { hops: this.deps.config.voiceChiefMaxToolHops });
    } finally {
      // An interrupted turn must still leave a history the API accepts:
      // every tool call answered, and what was said kept.
      if (unsaid !== '') this.messages.push({ role: 'assistant', content: unsaid });
      // Talked over (US-020): the next message says how far the operator got.
      if (signal.aborted && spoke) this.interruptedAfter = this.deps.call.spokenSoFar?.() ?? '';
      for (const call of owed) {
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, error: 'interrupted' }) });
      }
      this.summarizeIfNeeded(settings.chiefModel);
    }
  }

  private async execute(call: ChatToolCall, ctx: { signal: AbortSignal; turn: number }): Promise<ToolResult> {
    const entry = this.tools.get(call.function.name);
    if (entry === undefined) {
      return { ok: false, data: { error: 'unknown_tool' }, summary: `Unknown tool ${call.function.name}` };
    }
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments === '' ? '{}' : call.function.arguments);
    } catch {
      return { ok: false, data: { error: 'bad_arguments', message: 'The arguments were not valid JSON.' }, summary: 'Bad arguments' };
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { ok: false, data: { error: 'bad_arguments', message: 'The arguments must be an object.' }, summary: 'Bad arguments' };
    }
    return guarded(call.function.name, () => entry.handler(args as Record<string, unknown>, this.toolContext(ctx)));
  }

  /** Runs or cancels confirmation `id` on the operator's word; `name` is the tool it was for. */
  private async resolveConfirmation(
    id: string,
    accept: boolean,
    ctx: { signal: AbortSignal; turn: number },
  ): Promise<{ name: string; result: ToolResult }> {
    const gate = this.deps.call.confirmations;
    if (accept) {
      let name = CONFIRM_TOOL;
      const result = await guarded(CONFIRM_TOOL, async () => {
        const ran = await runConfirmation(this.tools, id, this.toolContext(ctx));
        name = ran.tool ?? CONFIRM_TOOL;
        return ran.result;
      });
      return { name, result };
    }
    const pending = gate.pending;
    if (pending === null || pending.id !== id) {
      return { name: CONFIRM_TOOL, result: { ok: false, data: { reason: 'await_user', why: 'unknown' }, summary: 'No such confirmation pending' } };
    }
    gate.cancel();
    return { name: pending.tool, result: cancelledResult(pending) };
  }

  private toolContext(ctx: { signal: AbortSignal; turn: number }): ToolContext {
    return {
      ...ctx,
      // A handler is never aborted mid-write by a barge-in (US-020).
      signal: NEVER_ABORTED,
      focus: this.deps.call.focus,
      endCall: () => this.deps.call.hangUpAfterTurn(),
      confirmations: this.deps.call.confirmations,
      setFocus: (focus) => this.deps.call.setFocus?.(focus),
      earcon: (name) => this.deps.call.earcon?.(name),
      handOffWhenReady: (sessionId) => this.deps.call.handOffWhenReady?.(sessionId),
    };
  }

  private systemPrompt(language: string): string {
    let snapshot: string;
    try {
      snapshot = buildSnapshot(this.deps.services, { focus: this.deps.call.focus, now: this.now() });
    } catch (cause) {
      logger.warn('chief could not build the state snapshot', { error: String(cause) });
      snapshot = 'unavailable; use the tools';
    }
    return chiefSystemPrompt({ operatorName: this.deps.operatorName, language, snapshot });
  }

  private summaryLine(): ChatMessage[] {
    return this.summary === null ? [] : [{ role: 'system', content: `Earlier in this call: ${this.summary}` }];
  }

  /** The last {@link WINDOW_MESSAGES} messages, cut where a user message starts. */
  private window(messages: readonly ChatMessage[] = this.messages): ChatMessage[] {
    return messages.slice(this.windowStart(messages));
  }

  /**
   * Where the window starts: the first user message inside the last
   * {@link WINDOW_MESSAGES}, so an assistant's tool calls are never separated
   * from their answers. One turn longer than the window is kept whole.
   */
  private windowStart(messages: readonly ChatMessage[] = this.messages): number {
    const length = messages.length;
    if (length <= WINDOW_MESSAGES) return 0;
    for (let i = length - WINDOW_MESSAGES; i < length; i++) {
      if (messages[i]?.role === 'user') return i;
    }
    for (let i = length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') return i;
    }
    return 0;
  }

  /**
   * Folds the turns that fell out of the window into one system line, by
   * the same model, without holding up the turn. Messages are only ever
   * appended, so the cut taken now is still right when the summary lands.
   */
  private summarizeIfNeeded(model: string): void {
    const cut = this.windowStart();
    if (cut === 0 || this.summarizing !== null) return;
    const older = this.messages.slice(0, cut);
    const previous = this.summary;
    this.summarizing = this.summarize(model, previous, older)
      .then((summary) => {
        if (summary === '') return;
        this.summary = summary;
        this.messages.splice(0, cut);
      })
      .catch((cause: unknown) => {
        logger.warn('chief could not summarize the call so far', { error: String(cause) });
      })
      .finally(() => {
        this.summarizing = null;
      });
  }

  private async summarize(model: string, previous: string | null, older: readonly ChatMessage[]): Promise<string> {
    const transcript = [previous === null ? null : `Summary so far: ${previous}`, ...older.map(transcriptLine)]
      .filter((line): line is string => line !== null)
      .join('\n');
    let text = '';
    for await (const event of this.chat({
      baseUrl: this.deps.config.openrouterApiUrl,
      apiKey: getOpenRouterApiKey(this.deps.db) ?? '',
      model,
      messages: [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: transcript },
      ],
      tools: [],
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0,
    })) {
      if (event.type === 'delta') text += event.text;
      else if (event.type === 'usage') this.unreportedCostUsd += event.costUsd;
    }
    return text.replace(/\s+/g, ' ').trim();
  }
}

/** A handler's result, or a failed one: nothing throws out of a tool. */
async function guarded(name: string, run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await run();
  } catch (cause) {
    logger.warn('chief tool failed', { tool: name, error: String(cause) });
    return {
      ok: false,
      data: { error: 'failed', message: cause instanceof Error ? cause.message : String(cause) },
      summary: `${name} failed`,
    };
  }
}

function wrap(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : { data };
}

function transcriptLine(message: ChatMessage): string | null {
  switch (message.role) {
    case 'user':
      return `Operator: ${message.content}`;
    case 'assistant': {
      const tools = message.tool_calls?.map((call) => call.function.name).join(', ');
      const said = message.content === null ? '' : `Chief: ${message.content}`;
      return [said, tools === undefined ? '' : `(Chief used ${tools})`].filter((part) => part !== '').join(' ') || null;
    }
    case 'tool':
      return `Tool result: ${message.content.length > 200 ? `${message.content.slice(0, 199)}…` : message.content}`;
    case 'system':
      return null;
  }
}
