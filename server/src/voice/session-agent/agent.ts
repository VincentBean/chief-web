import { randomUUID } from 'node:crypto';

import type { Database } from '../../db/index.js';
import { logger } from '../../lib/logger.js';
import { CONTAINER_REPO_DIR } from '../../sessions/index.js';
import { getVoiceSettings } from '../../settings/index.js';
import type { AgentEvent, AgentInput, VoiceAgent } from '../call.js';
import type { CallFocus } from '../protocol.js';
import type { SessionAgentEvent } from './events.js';
import { interruptRequestLine, type SessionAgentProcess, userMessageLine } from './process.js';
import { voiceUtterance } from './prompt.js';
import { SessionAgentError, type SessionAgentRegistry } from './registry.js';

/** How long an interrupted turn may take to end before the process is sent SIGINT (plan §10.5). */
export const INTERRUPT_GRACE_MS = 5_000;

/** Said before the one restart of a call (plan §10.4). */
export const RESTARTING: Readonly<Record<string, string>> = {
  nl: 'De sessie-agent is gestopt, ik start hem opnieuw.',
  en: "The session agent stopped, I'm restarting it.",
};
/** Said when it stops a second time in the same call, before chief takes the call back. */
export const GIVING_UP: Readonly<Record<string, string>> = {
  nl: 'De sessie-agent is opnieuw gestopt, dus ik geef je terug aan chief. Je kunt het later nog eens proberen.',
  en: 'The session agent stopped again, so I am handing you back to chief. You can try again later.',
};

/** The call as a session agent needs it. */
export interface SessionAgentCallControls {
  setFocus(focus: CallFocus): void;
  /** What the operator heard of the current turn, for the next `[interrupted after: …]`. */
  spokenSoFar(): string;
}

export interface SessionVoiceAgentDeps {
  readonly db: Database;
  readonly sessionId: string;
  readonly registry: SessionAgentRegistry;
  readonly call: SessionAgentCallControls;
  readonly interruptGraceMs?: number;
}

/**
 * The focused session's Claude Code, as the call's {@link VoiceAgent}: one
 * per call and session (the call keeps it), over the one process the
 * registry keeps for the session. Every utterance is one stream-json turn;
 * the first one of a fresh conversation carries the planning prompt.
 */
export class SessionVoiceAgent implements VoiceAgent {
  readonly kind = 'session' as const;
  /** The process this call last talked to, to tell a crash from a planned stop. */
  private process: SessionAgentProcess | null = null;
  private crashes = 0;
  /** What the operator heard before interrupting the last turn. */
  private interruptedAfter: string | null = null;

  constructor(private readonly deps: SessionVoiceAgentDeps) {}

  async *run(input: AgentInput): AsyncGenerator<AgentEvent> {
    const { signal } = input;
    const utterance = voiceUtterance(input.text, this.interruptedAfter);
    this.interruptedAfter = null;

    for (;;) {
      if (this.process?.crashed === true) {
        this.process = null;
        this.crashes += 1;
        if (this.crashes >= 2) {
          yield { type: 'delta', text: this.say(GIVING_UP) };
          this.deps.call.setFocus({ kind: 'chief' });
          return;
        }
        yield { type: 'delta', text: `${this.say(RESTARTING)} ` };
      }

      let agent: SessionAgentProcess;
      try {
        // A boot takes seconds (plan §11 step 4): "one sec" covers it.
        if (!this.deps.registry.isAlive(this.deps.sessionId)) {
          this.deps.registry.check(this.deps.sessionId);
          yield { type: 'earcon', name: 'one_sec' };
        }
        agent = await this.deps.registry.acquire(this.deps.sessionId);
      } catch (cause) {
        if (signal.aborted) return;
        const message = cause instanceof SessionAgentError ? cause.message : 'The session agent could not start.';
        logger.warn('session voice agent did not start', { session: this.deps.sessionId, error: String(cause) });
        yield { type: 'delta', text: message };
        this.deps.call.setFocus({ kind: 'chief' });
        return;
      }
      this.process = agent;
      if (signal.aborted) return;

      // A greeting (the switch to this session, US-019) is only for a fresh
      // conversation; one that is already going waits for the operator.
      if (input.text === '' && agent.opened) return;
      agent.discardPending();
      if (agent.opened) {
        agent.write(userMessageLine(utterance));
      } else {
        agent.write(userMessageLine(this.deps.registry.openingPrompt(this.deps.sessionId, input.text === '' ? null : utterance)));
        agent.opened = true;
      }

      let ended = false;
      const tools = new Map<string, { name: string; summary: string }>();
      try {
        for (;;) {
          const event = await agent.next(signal);
          if (event === null) break;
          if (event.type === 'turnEnd') {
            ended = true;
            // One Claude turn on the subscription, for the call's usage (US-023).
            yield { type: 'usage', claudeTurns: 1 };
            break;
          }
          const out = toAgentEvent(event, tools);
          if (out !== null) yield out;
        }
      } finally {
        if (signal.aborted && !ended && !agent.exited) await this.interrupt(agent);
      }
      // A process that died mid-turn is restarted once and hears the same utterance again.
      if (ended || signal.aborted || !agent.crashed) return;
    }
  }

  /**
   * Barge-in (plan §10.5): the interrupt request, then the rest of the turn is
   * read and dropped until its `result`. A turn that does not end within the
   * grace period gets SIGINT; the next utterance starts a new process with
   * `--resume`.
   */
  private async interrupt(agent: SessionAgentProcess): Promise<void> {
    this.interruptedAfter = this.deps.call.spokenSoFar();
    agent.write(interruptRequestLine(randomUUID()));
    const grace = AbortSignal.timeout(this.deps.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    for (;;) {
      const event = await agent.next(grace);
      if (event?.type === 'turnEnd') return;
      if (event === null) break;
    }
    if (agent.exited) return;
    logger.warn('session voice agent ignored the interrupt', { session: this.deps.sessionId });
    // Out of the registry now, so the next utterance starts afresh with `--resume`.
    this.deps.registry.stop(this.deps.sessionId, 'INT').catch(() => undefined);
  }

  private say(lines: Readonly<Record<string, string>>): string {
    return lines[getVoiceSettings(this.deps.db).language] ?? (lines['en'] as string);
  }
}

/** A parser event as the call shows it; `tools` remembers each card's summary for its result. */
function toAgentEvent(event: SessionAgentEvent, tools: Map<string, { name: string; summary: string }>): AgentEvent | null {
  switch (event.type) {
    case 'delta':
      return { type: 'delta', text: event.text };
    case 'tool': {
      const id = event.toolUseId ?? randomUUID();
      const summary = toolCardSummary(event.name, event.input);
      tools.set(id, { name: event.name, summary });
      return { type: 'tool', id, name: event.name, status: 'running', summary };
    }
    case 'toolResult': {
      if (event.toolUseId === null) return null;
      const card = tools.get(event.toolUseId);
      if (card === undefined) return null;
      return { type: 'tool', id: event.toolUseId, name: card.name, status: event.ok ? 'ok' : 'error', summary: card.summary };
    }
    default:
      return null;
  }
}

/** The tool card's line: "Reading server/src/auth/service.ts". */
export function toolCardSummary(name: string, input: unknown): string {
  const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const text = (key: string): string | null => {
    const value = args[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const path = relative(text('file_path') ?? text('notebook_path') ?? text('path'));
  switch (name) {
    case 'Read':
      return path === null ? 'Reading a file' : `Reading ${path}`;
    case 'Write':
      return path === null ? 'Writing a file' : `Writing ${path}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path === null ? 'Editing a file' : `Editing ${path}`;
    case 'Grep': {
      const pattern = text('pattern');
      return pattern === null ? 'Searching the code' : `Searching for "${clip(pattern, 60)}"${path === null ? '' : ` in ${path}`}`;
    }
    case 'Glob': {
      const pattern = text('pattern');
      return pattern === null ? 'Listing files' : `Looking for ${clip(pattern, 60)}`;
    }
    case 'Bash': {
      const description = text('description');
      const command = text('command');
      return description !== null ? clip(description, 80) : command === null ? 'Running a command' : `Running ${clip(command, 60)}`;
    }
    case 'Task':
    case 'Agent': {
      const description = text('description');
      return description === null ? 'Delegating a task' : `Delegating: ${clip(description, 60)}`;
    }
    case 'TodoWrite':
      return 'Updating its to-do list';
    case 'WebFetch':
    case 'WebSearch': {
      const target = text('url') ?? text('query');
      return target === null ? 'Looking on the web' : `Looking up ${clip(target, 60)}`;
    }
    default:
      return `Using ${name}`;
  }
}

function relative(path: string | null): string | null {
  if (path === null) return null;
  const prefix = `${CONTAINER_REPO_DIR}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
