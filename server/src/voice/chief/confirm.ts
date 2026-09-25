import type { ConfirmationOutcome, ConfirmationView, ServerMessage } from '../protocol.js';
import type { ChiefTool, ToolContext, ToolResult } from './tools.js';

/**
 * Server-enforced confirmation (voice US-011; docs/voice-plan.md §9.4). A confirmable tool
 * never acts on its first call: it builds the prompt and the arguments that
 * will run from what the model asked for, parks them as the one pending
 * {@link Confirmation} and shows the operator a Confirm / Cancel pill. Only a
 * later turn (a new utterance, a bare "yes", or the pill's button) runs the
 * stored arguments, so a misheard sentence cannot start work.
 */

/** How long a confirmation waits for the operator. */
export const CONFIRMATION_TTL_MS = 60_000;

/** A pending confirmation: what will run, and what the operator was asked. */
export interface Confirmation extends ConfirmationView {
  readonly tool: string;
  /** The arguments the server built; `confirm` runs these, never the model's. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly createdAtTurn: number;
}

/** Where the call keeps its one pending confirmation (docs/voice-plan.md §5). */
export interface ConfirmationHolder {
  pendingConfirmation: Confirmation | null;
}

export interface ConfirmationGateDeps {
  readonly holder: ConfirmationHolder;
  now(): number;
  send(message: ServerMessage): void;
  newId(): string;
}

export type TakeResult =
  | { readonly kind: 'ok'; readonly confirmation: Confirmation }
  | { readonly kind: 'await_user'; readonly why: 'same_turn' | 'expired' | 'unknown' };

/** The one pending confirmation of a call. */
export class ConfirmationGate {
  constructor(private readonly deps: ConfirmationGateDeps) {}

  /** The pending confirmation, or null; an expired one is dropped here. */
  get pending(): Confirmation | null {
    const pending = this.deps.holder.pendingConfirmation;
    if (pending !== null && this.expired(pending)) {
      this.clear('expired');
      return null;
    }
    return pending;
  }

  /** Parks `tool(args)` for the operator; whatever was pending is replaced and its id dies. */
  request(input: { readonly tool: string; readonly args: Readonly<Record<string, unknown>>; readonly prompt: string }, turn: number): Confirmation {
    const confirmation: Confirmation = {
      id: this.deps.newId(),
      tool: input.tool,
      args: input.args,
      prompt: input.prompt,
      createdAtTurn: turn,
      expiresAt: new Date(this.deps.now() + CONFIRMATION_TTL_MS).toISOString(),
    };
    this.deps.holder.pendingConfirmation = confirmation;
    this.deps.send({ type: 'confirm', id: confirmation.id, prompt: confirmation.prompt, expiresAt: confirmation.expiresAt });
    return confirmation;
  }

  /**
   * Hands out the pending confirmation `id` to run, and clears it, only when
   * the operator has spoken since it was created (`turn > createdAtTurn`) and
   * it has not expired.
   */
  take(id: string, turn: number): TakeResult {
    const pending = this.deps.holder.pendingConfirmation;
    if (pending === null || pending.id !== id) return { kind: 'await_user', why: 'unknown' };
    if (this.expired(pending)) {
      this.clear('expired');
      return { kind: 'await_user', why: 'expired' };
    }
    if (turn <= pending.createdAtTurn) return { kind: 'await_user', why: 'same_turn' };
    this.clear('confirmed');
    return { kind: 'ok', confirmation: pending };
  }

  /** Drops the pending confirmation (a "no", a focus switch, the call ending). */
  cancel(): Confirmation | null {
    const pending = this.deps.holder.pendingConfirmation;
    if (pending !== null) this.clear('cancelled');
    return pending;
  }

  private expired(confirmation: Confirmation): boolean {
    return this.deps.now() >= Date.parse(confirmation.expiresAt);
  }

  private clear(outcome: ConfirmationOutcome): void {
    const pending = this.deps.holder.pendingConfirmation;
    if (pending === null) return;
    this.deps.holder.pendingConfirmation = null;
    this.deps.send({ type: 'confirm.resolved', id: pending.id, outcome });
  }
}

/* ------------------------------------------------------------------ tools */

/** What a confirmable tool's `prepare` hands back: the server's prompt and arguments. */
export interface PreparedAction {
  readonly prompt: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * A tool that needs confirmation. `prepare` resolves names, validates and
 * builds the prompt and the arguments to store (or returns a failed result);
 * `execute` runs later with exactly those stored arguments.
 */
export function confirmable(
  name: string,
  description: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
  steps: {
    prepare(args: Readonly<Record<string, unknown>>, ctx: ToolContext): PreparedAction | ToolResult | Promise<PreparedAction | ToolResult>;
    execute(args: Readonly<Record<string, unknown>>, ctx: ToolContext): ToolResult | Promise<ToolResult>;
  },
): ChiefTool {
  return {
    definition: {
      type: 'function',
      function: {
        name,
        description,
        parameters: { type: 'object', properties, ...(required.length === 0 ? {} : { required }) },
      },
    },
    handler: async (args, ctx) => {
      const prepared = await steps.prepare(args, ctx);
      if ('summary' in prepared) return prepared;
      const confirmation = ctx.confirmations.request({ tool: name, args: prepared.args, prompt: prepared.prompt }, ctx.turn);
      return {
        ok: true,
        data: { needs_confirmation: true, confirmation_id: confirmation.id, say: confirmation.prompt },
        summary: `Waiting for confirmation: ${confirmation.prompt}`,
      };
    },
    execute: steps.execute,
  };
}

/** The tool call chief makes, or the call makes for it, to run a confirmation. */
export const CONFIRM_TOOL = 'confirm';

/**
 * Runs pending confirmation `id` if the operator has answered in a new turn:
 * the stored tool's `execute` with the stored arguments.
 */
export async function runConfirmation(
  tools: ReadonlyMap<string, ChiefTool>,
  id: string,
  ctx: ToolContext,
): Promise<{ readonly tool: string | null; readonly result: ToolResult }> {
  const taken = ctx.confirmations.take(id, ctx.turn);
  if (taken.kind === 'await_user') {
    const summary =
      taken.why === 'same_turn'
        ? 'Waiting for the operator to answer'
        : taken.why === 'expired'
          ? 'The confirmation expired'
          : 'No such confirmation pending';
    return { tool: null, result: { ok: false, data: { reason: 'await_user', why: taken.why }, summary } };
  }
  const { confirmation } = taken;
  const execute = tools.get(confirmation.tool)?.execute;
  if (execute === undefined) {
    return { tool: confirmation.tool, result: { ok: false, data: { error: 'unknown_tool' }, summary: `Unknown tool ${confirmation.tool}` } };
  }
  return { tool: confirmation.tool, result: await execute(confirmation.args, ctx) };
}

/** What chief is told when the operator turned a confirmation down. */
export function cancelledResult(confirmation: Confirmation): ToolResult {
  return {
    ok: true,
    data: { cancelled: true, tool: confirmation.tool, prompt: confirmation.prompt },
    summary: `Cancelled: ${confirmation.prompt}`,
  };
}

/** The `confirm` tool (docs/voice-plan.md Appendix B) over the registry it runs confirmations from. */
export function confirmTool(tools: () => ReadonlyMap<string, ChiefTool>): ChiefTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: CONFIRM_TOOL,
        description:
          'Execute an action the operator confirmed in a new message after you asked. Never call it in the same reply that asked.',
        parameters: {
          type: 'object',
          properties: { confirmation_id: { type: 'string' } },
          required: ['confirmation_id'],
        },
      },
    },
    handler: async (args, ctx) => {
      const id = args['confirmation_id'];
      if (typeof id !== 'string' || id === '') {
        return { ok: false, data: { error: 'missing_argument', argument: 'confirmation_id' }, summary: 'Missing confirmation_id' };
      }
      return (await runConfirmation(tools(), id, ctx)).result;
    },
  };
}
