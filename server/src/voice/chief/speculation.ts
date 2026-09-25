/**
 * Speculative chief (voice US-022; plan §3 item 4). In Scribe mode a partial
 * transcript unchanged for 300 ms is usually what the operator ends up
 * saying, so chief's first model step starts on it before the commit.
 *
 * Only that one streamed request runs early, buffered here: nothing reaches
 * the history, no tool runs and nothing is spoken until the committed
 * transcript adopts it. A discard is one abort. See `ChiefAgent.speculate`.
 */
import type { ChatEvent } from './openrouter-client.js';

export class ChatPrefetch {
  private readonly events: ChatEvent[] = [];
  private finished = false;
  private failure: { readonly cause: unknown } | null = null;
  private wake: (() => void) | null = null;

  constructor(
    /** The user message the step answers, exactly as it went to the model. */
    readonly text: string,
    /** The agent that started it; another agent must not replay it. */
    readonly owner: object,
    source: AsyncIterable<ChatEvent>,
  ) {
    void this.pump(source);
  }

  private async pump(source: AsyncIterable<ChatEvent>): Promise<void> {
    try {
      for await (const event of source) {
        this.events.push(event);
        this.notify();
      }
    } catch (cause) {
      this.failure = { cause };
    } finally {
      this.finished = true;
      this.notify();
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** What arrived so far, then the rest as it streams; rethrows the stream's failure. */
  async *replay(): AsyncGenerator<ChatEvent> {
    let next = 0;
    for (;;) {
      while (next < this.events.length) yield this.events[next++] as ChatEvent;
      if (this.finished) {
        if (this.failure !== null) throw this.failure.cause;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** Same words, ignoring case, punctuation and spacing, as a partial and its commit usually are. */
export function sameUtterance(a: string, b: string): boolean {
  const norm = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[\p{P}\p{S}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  return norm(a) === norm(b);
}
