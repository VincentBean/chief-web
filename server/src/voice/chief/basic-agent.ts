import type { Config } from '../../config.js';
import type { Database } from '../../db/index.js';
import { getOpenRouterApiKey, getVoiceSettings } from '../../settings/index.js';
import type { AgentEvent, VoiceAgent } from '../call.js';
import { type ChatMessage, streamChat } from './openrouter-client.js';

/** Messages kept in the model's window (plan §9.1). */
const WINDOW = 30;

const SYSTEM_PROMPT =
  'You are chief, the voice assistant of chief-web, on a phone call with the operator. ' +
  'Answer in short spoken sentences, without markdown. Reply in the language the operator speaks.';

/**
 * Chief without tools or a state snapshot: a plain streaming conversation on
 * the configured chief model. It keeps a call usable until the real agent of
 * voice US-008 (`chief/agent.ts`) replaces it in `createVoice`.
 */
export class BasicChiefAgent implements VoiceAgent {
  readonly kind = 'chief' as const;
  private readonly messages: ChatMessage[] = [];

  constructor(
    private readonly db: Database,
    private readonly config: Config,
  ) {}

  async *run(input: { readonly text: string; readonly signal: AbortSignal }): AsyncGenerator<AgentEvent> {
    this.messages.push({ role: 'user', content: input.text });
    const settings = getVoiceSettings(this.db);
    let reply = '';
    try {
      for await (const event of streamChat({
        baseUrl: this.config.openrouterApiUrl,
        apiKey: getOpenRouterApiKey(this.db) ?? '',
        model: settings.chiefModel,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.messages.slice(-WINDOW)],
        tools: [],
        maxTokens: 400,
        temperature: 0.4,
        signal: input.signal,
      })) {
        if (event.type === 'delta') {
          reply += event.text;
          yield { type: 'delta', text: event.text };
        } else if (event.type === 'usage') {
          yield { type: 'usage', costUsd: event.costUsd };
        }
      }
    } finally {
      // What was said stays said, even when the turn was cut off.
      if (reply !== '') this.messages.push({ role: 'assistant', content: reply });
    }
  }
}
