import type { TerminalView } from './session.js';

/**
 * Wire protocol between the browser terminal and the server.
 *
 * Frame type carries the meaning, so no envelope or base64 is needed for the
 * hot path:
 *
 * - **binary** frames are raw PTY bytes — output downstream, keystrokes
 *   upstream. Escape sequences and partial UTF-8 pass through untouched.
 * - **text** frames are JSON control messages, defined below.
 */

/** Server → client. */
export type ServerMessage =
  /** First message on every connection, before the scrollback replay. */
  | { readonly type: 'attached'; readonly terminal: TerminalView; readonly replayBytes: number }
  /** The process ended; the socket stays open so the final output is readable. */
  | { readonly type: 'exit'; readonly exitCode: number | null }
  | { readonly type: 'error'; readonly message: string };

/** Client → server. */
export type ClientMessage = {
  readonly type: 'resize';
  readonly cols: number;
  readonly rows: number;
};

/** `null` when the payload is not a control message this server understands. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const message = parsed as Record<string, unknown>;
  if (message['type'] !== 'resize') return null;

  const cols = message['cols'];
  const rows = message['rows'];
  if (!isDimension(cols) || !isDimension(rows)) return null;
  return { type: 'resize', cols, rows };
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1000;
}
