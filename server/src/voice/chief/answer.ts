import { prdPathFor } from '../../prd/index.js';
import { answerPrompt } from '../session-agent/prompt.js';
import { type ChiefServices, type ChiefTool, isResult, missing, SESSION_PARAM, sessionArg, stringArg, tool, type ToolResult } from './tools.js';

/**
 * `answer_planning_question` (voice multi-planning US-012): "tell csv-export the
 * export should be CSV only" passes the operator's answer to a planning
 * session without moving the call. The session agent takes it in a detached
 * turn, updates its PRD and drops the answered question; the end of that turn
 * is announced like any finished draft (`planning.drafted`, US-008).
 * Chief reads back what it passed on, and returns at once.
 */
export function answerPlanningQuestionTool(services: ChiefServices): ChiefTool {
  return tool(
    'answer_planning_question',
    "Pass the operator's answer to an open question of a planning session, without moving the call. The session updates its PRD on its own.",
    {
      session: SESSION_PARAM,
      question: {
        type: 'integer',
        description: '1-based number of the open question answered, as get_session lists them; omit when the answer covers all of them',
      },
      answer: { type: 'string', description: "The operator's answer, in their words" },
    },
    ['session', 'answer'],
    (args) => {
      const session = sessionArg(services, args);
      if (isResult(session)) return session;
      const answer = stringArg(args, 'answer');
      if (answer === null) return missing('answer');
      const detached = services.detachedTurns;
      const planning = services.planningStates?.planningState(session.id) ?? null;
      if (planning === null) {
        return refuse('not_planning', `${session.name} is not a planning session, so there is no question to answer`);
      }
      if (detached === undefined) return refuse('unavailable', `I cannot pass answers to ${session.name} here`);
      if (planning.state === 'drafting') {
        return refuse('drafting', `${session.name} is still drafting; give it the answer once it is done`);
      }
      const open = planning.openQuestions;
      if (open.length === 0) return refuse('no_open_questions', `${session.name} has no open questions`);
      // As in `focus_session`: the session agent could not start, so say so now rather than "working on it".
      const holdUntil = services.hold.until();
      if (holdUntil !== null) {
        return refuse('usage_limit_hold', `Claude is on a usage-limit hold until ${holdUntil}, so ${session.name} cannot take the answer now`);
      }
      if (services.planning?.isTerminalRunning(session.id) === true) {
        return refuse('terminal_open', `The planning terminal is open for ${session.name}; answer it there`);
      }
      let questions: readonly string[] = open;
      const index = args['question'];
      if (index !== undefined && index !== null) {
        const number = typeof index === 'string' ? Number(index) : index;
        const question = typeof number === 'number' && Number.isInteger(number) ? open[number - 1] : undefined;
        if (question === undefined) {
          return refuse(
            'unknown_question',
            `${session.name} has ${open.length} open question${open.length === 1 ? '' : 's'}; there is no question ${String(index)}`,
          );
        }
        questions = [question];
      }
      detached.start(session.id, answerPrompt(prdPathFor(session.name), questions, answer));
      return {
        ok: true,
        data: { id: session.id, name: session.name, questions, answer },
        summary: `Passed the answer to ${session.name}; it is working on it`,
      };
    },
  );
}

function refuse(error: string, summary: string): ToolResult {
  return { ok: false, data: { error }, summary };
}
