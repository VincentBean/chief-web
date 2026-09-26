import { guarded } from './actions.js';
import { type ChiefServices, type ChiefTool, isResult, SESSION_PARAM, sessionArg, type ToolContext, type ToolResult } from './tools.js';

/**
 * `focus_session` (docs/voice-plan.md §9.2, §11): hands the call to the session's own
 * Claude Code: it plans a `pending` session and answers questions about any
 * other (the registry's Q&A mode, voice US-025). Everything the registry
 * refuses on (no clone, the usage-limit hold, a container that does not
 * start) comes back as its message for chief to say. So does an open planning
 * terminal: closing it would end a conversation the operator may still want,
 * so the operator closes it in the browser.
 */

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
        const holdUntil = services.hold.until();
        if (holdUntil !== null) {
          return {
            ok: false,
            data: { error: 'usage_limit_hold', until: holdUntil },
            summary: `Claude is on a usage-limit hold until ${holdUntil}, so the session agent cannot start`,
          };
        }
        if (services.planning?.isTerminalRunning(session.id) === true) {
          return {
            ok: false,
            data: { error: 'session_in_planning_terminal' },
            summary: `The planning terminal is open for ${session.name}; close it in the browser first, then ask again.`,
          };
        }
        return switchTo(services, { id: session.id, name: session.name }, ctx);
      }),
  };
}

/** Starts the session agent (container first), then moves the call's focus to it. */
async function switchTo(services: ChiefServices, target: { id: string; name: string }, ctx: ToolContext): Promise<ToolResult> {
  const agents = services.sessionAgents;
  if (agents === undefined || ctx.setFocus === undefined) {
    return { ok: false, data: { error: 'unavailable' }, summary: 'Session agents are not available here' };
  }
  if (agents.isAlive?.(target.id) === false) ctx.earcon?.('one_sec');
  await agents.acquire(target.id);
  ctx.setFocus({ kind: 'session', sessionId: target.id });
  return {
    ok: true,
    data: { focus: target.id, name: target.name },
    // The call's switch opens the session's page (docs/voice-plan.md §11).
    summary: `Handed the call to ${target.name}`,
  };
}
