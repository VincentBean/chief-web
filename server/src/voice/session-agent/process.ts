/**
 * What chief-web writes to a session agent's stdin (plan §10.2, §10.5).
 *
 * The session agent is `claude -p --input-format stream-json`: every line on
 * its stdin is one JSON message. These builders are the only place the shapes
 * are spelled out, and `__fixtures__/record.ts` writes exactly their output to
 * the real CLI, so the recordings next to it prove the CLI accepts them.
 *
 * The recordings confirm plan §10's framing on Claude Code 2.1.280: one
 * process reads user messages from stdin turn after turn, and the interrupt
 * stops the current turn without ending the process. So one long-lived process
 * per session is the design; the fallback of one `-p` process per turn with
 * `--resume` (`VOICE_SESSION_AGENT_MODE=per-turn`) is not needed and not
 * built. See `events.ts` for the output details the plan left out.
 */

/** One user turn: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}`. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })}\n`;
}

/**
 * Stops the turn in progress: `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}`.
 *
 * The CLI answers with a `control_response` carrying the same `request_id`,
 * then ends the turn with a `result` line.
 */
export function interruptRequestLine(requestId: string): string {
  return `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'interrupt' },
  })}\n`;
}
