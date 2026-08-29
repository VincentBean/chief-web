import { type Response, Router } from 'express';

import {
  MAX_TERMINAL_DIMENSION,
  MIN_TERMINAL_DIMENSION,
  type CreateTerminalInput,
  TerminalError,
  type TerminalManager,
} from '../terminal/index.js';

/** A rejected request body: an error code plus something to show the operator. */
interface Invalid {
  readonly error: string;
  readonly message: string;
}

const MAX_COMMAND_PARTS = 64;

/**
 * Terminal lifecycle (US-007). The bytes themselves never travel over HTTP —
 * a terminal is created here, then attached to over the WebSocket route at
 * `/api/terminals/:id/stream`, which is what lets a reload rejoin the same PTY.
 */
export function createTerminalsRouter(terminals: TerminalManager): Router {
  const router = Router();

  // Lets the UI offer a target for a new terminal before US-009 owns sessions.
  router.get('/containers', (_req, res) => {
    terminals
      .listContainers()
      .then((containers) => res.status(200).json({ containers }))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.get('/terminals', (_req, res) => {
    res.status(200).json({ terminals: terminals.list() });
  });

  router.get('/terminals/:id', (req, res) => {
    const terminal = terminals.get(req.params.id);
    if (terminal === undefined) {
      res.status(404).json({ error: 'terminal_not_found', message: 'No such terminal.' });
      return;
    }
    res.status(200).json(terminal.toView());
  });

  router.post('/terminals', (req, res) => {
    const parsed = parseCreate(req.body);
    if ('error' in parsed) {
      res.status(400).json(parsed);
      return;
    }

    terminals
      .create(parsed)
      .then((view) => res.status(201).json(view))
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  router.delete('/terminals/:id', (req, res) => {
    terminals
      .remove(req.params.id)
      .then((removed) => {
        if (!removed) {
          res.status(404).json({ error: 'terminal_not_found', message: 'No such terminal.' });
          return;
        }
        res.status(204).end();
      })
      .catch((cause: unknown) => respondWithFailure(res, cause));
  });

  return router;
}

function respondWithFailure(res: Response, cause: unknown): void {
  if (cause instanceof TerminalError) {
    res.status(cause.status).json({ error: cause.code, message: cause.message });
    return;
  }
  res.status(500).json({ error: 'terminal_request_failed', message: String(cause) });
}

function parseCreate(body: unknown): CreateTerminalInput | Invalid {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'invalid_body', message: 'Expected a JSON object.' };
  }
  const input = body as Record<string, unknown>;

  const container = input['container'];
  if (typeof container !== 'string' || container.trim() === '') {
    return { error: 'invalid_container', message: 'A container id or name is required.' };
  }

  const command = parseCommand(input['command']);
  if (command !== undefined && 'error' in command) return command;

  const cwd = input['cwd'];
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim() === '')) {
    return { error: 'invalid_cwd', message: 'cwd must be a non-empty string when given.' };
  }

  const size = parseSize(input);
  if (size !== undefined && 'error' in size) return size;

  return {
    container: container.trim(),
    ...(command === undefined ? {} : { command: command.command }),
    ...(cwd === undefined ? {} : { cwd: cwd as string }),
    ...(size === undefined ? {} : { size }),
  };
}

/** `undefined` when absent, so the manager's default shell is used. */
function parseCommand(value: unknown): { command: string[] } | Invalid | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_COMMAND_PARTS ||
    !value.every((part) => typeof part === 'string')
  ) {
    return {
      error: 'invalid_command',
      message: `command must be a non-empty array of at most ${MAX_COMMAND_PARTS} strings.`,
    };
  }
  return { command: value as string[] };
}

function parseSize(
  input: Record<string, unknown>,
): { cols: number; rows: number } | Invalid | undefined {
  if (input['cols'] === undefined && input['rows'] === undefined) return undefined;
  const cols = input['cols'];
  const rows = input['rows'];
  if (!isDimension(cols) || !isDimension(rows)) {
    return {
      error: 'invalid_size',
      message: `cols and rows must both be integers between ${MIN_TERMINAL_DIMENSION} and ${MAX_TERMINAL_DIMENSION}.`,
    };
  }
  return { cols, rows };
}

function isDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_TERMINAL_DIMENSION &&
    value <= MAX_TERMINAL_DIMENSION
  );
}
