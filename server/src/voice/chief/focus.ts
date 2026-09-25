import { NOT_PENDING_REASON } from '../session-agent/registry.js';
import { guarded } from './actions.js';
import { type ChiefServices, type ChiefTool, isResult, SESSION_PARAM, sessionArg, sessionPath, type ToolContext, type ToolResult } from './tools.js';

/**
 * `focus_session` (plan §9.2, §11): hands the call to the session's own
 * Claude Code. Voice planning is for `pending` sessions until the Q&A mode
 * (voice US-025). Everything the registry refuses on (no clone, the
 * usage-limit hold, a container that does not start) comes back as its
 * message for chief to say. An open planning terminal is the one case that
 * asks first: closing it ends a conversation the operator may still want.
 */

/** What chief asks when the planning terminal is open for the session. */
export const CLOSE_TERMINAL_PROMPT = 'The planning terminal is open for this session. Should I close it and continue by voice?';

const NAME = 'focus_session';

export function focusSessionTool(services: ChiefServices): ChiefTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: NAME,
        description: "Hand the call to the session's own agent, which has the repository open, to plan or discuss it.",
        parameters: { type: 'object', properties: { session: SESSION_PARAM }, required: ['session'] },
      },
    },
    handler: (args, ctx) =>
      guarded('Could not switch to the session', async () => {
        const session = sessionArg(services, args);
        if (isResult(session)) return session;
        if (session.status !== 'pending') {
          return {
            ok: false,
            data: { error: 'session_not_pending', reason: NOT_PENDING_REASON, status: session.status },
            summary: `${session.name} is ${session.status}: ${NOT_PENDING_REASON}`,
          };
        }
        if (services.planning?.isTerminalRunning(session.id) === true) {
          const confirmation = ctx.confirmations.request(
            { tool: NAME, args: { sessionId: session.id, name: session.name }, prompt: CLOSE_TERMINAL_PROMPT },
            ctx.turn,
          );
          return {
            ok: true,
            data: { needs_confirmation: true, confirmation_id: confirmation.id, say: confirmation.prompt },
            summary: `Waiting for confirmation: ${confirmation.prompt}`,
          };
        }
        return switchTo(services, { id: session.id, name: session.name }, ctx);
      }),
    // Only reached through `confirm`, i.e. the terminal was open and the operator said yes.
    execute: (args, ctx) => {
      const target = { id: args['sessionId'] as string, name: args['name'] as string };
      return guarded(`Could not switch to ${target.name}`, async () => {
        await services.planning?.stop(target.id);
        return switchTo(services, target, ctx);
      });
    },
  };
}

/** Starts the session agent (container first), then moves the call's focus to it. */
async function switchTo(services: ChiefServices, target: { id: string; name: string }, ctx: ToolContext): Promise<ToolResult> {
  const agents = services.sessionAgents;
  if (agents === undefined || ctx.setFocus === undefined) {
    return { ok: false, data: { error: 'unavailable' }, summary: 'Session agents are not available here' };
  }
  await agents.acquire(target.id);
  ctx.setFocus({ kind: 'session', sessionId: target.id });
  return {
    ok: true,
    data: { focus: target.id, name: target.name },
    summary: `Handed the call to ${target.name}`,
    ui: [{ action: 'navigate', path: sessionPath(target.id) }],
  };
}
