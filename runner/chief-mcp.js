#!/usr/bin/env node
'use strict';

/**
 * The `chief` MCP server of the session voice agent (voice feedback US-006,
 * US-007): a stdio server with one tool, `open_browser_with_operator`.
 *
 * Calling it writes `<dir>/<requestId>.request` (`{ id, hint, createdAt }`);
 * chief-web sees the tool call on the agent's stream, reads the request, and
 * shows the operator the "watch with me" card. Its answer comes back as
 * `<dir>/<requestId>.answer`, written atomically by chief-web (mode 600):
 * `{ id, cancelled: false, url, credentials? }` or `{ id, cancelled: true }`.
 * The tool waits for it for at most five minutes, then deletes both files.
 * The credentials never leave this process: the tool result says only whether
 * there were any.
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout, no dependencies; the image
 * installs no npm packages for runner scripts.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const DIR = process.env.CHIEF_MCP_BROWSER_DIR || '/tmp/.chief-voice/browser';
const ANSWER_TIMEOUT_MS = Number(process.env.CHIEF_MCP_ANSWER_TIMEOUT_MS) || 5 * 60_000;
const POLL_MS = Number(process.env.CHIEF_MCP_POLL_MS) || 250;
const NOT_OPENED = 'The operator did not open a browser. Move on without it.';

const TOOL = {
  name: 'open_browser_with_operator',
  description:
    'Open a browser that you and the operator look at together. Before calling it, say one short sentence ' +
    'asking the operator to fill in the card, such as "Type the address in the panel and I\'ll open it"; ' +
    'never read a URL out. The operator types the URL (and optionally a login) into a card in the call ' +
    'panel. Returns the URL once they have, or says they did not open a browser, in which case move on.',
  inputSchema: {
    type: 'object',
    properties: {
      hint: {
        type: 'string',
        description: 'What you want to look at, in a few words, shown on the card ("the checkout page").',
      },
    },
    additionalProperties: false,
  },
};

/** In-flight tool calls by JSON-RPC id, so `notifications/cancelled` can stop one. */
const running = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function removeQuietly(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone.
  }
}

function writeRequest(id, hint) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, `${id}.request`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, hint, createdAt: new Date().toISOString() }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** The answer, or null once the call was cancelled or timed out. */
function waitForAnswer(answerFile, signal) {
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  return new Promise((resolve) => {
    const tick = () => {
      if (signal.aborted) return resolve(null);
      let raw = null;
      try {
        raw = fs.readFileSync(answerFile, 'utf8');
      } catch {
        // Not there yet.
      }
      if (raw !== null) {
        try {
          return resolve(JSON.parse(raw));
        } catch {
          return resolve({ cancelled: true });
        }
      }
      if (Date.now() >= deadline) return resolve(null);
      setTimeout(tick, POLL_MS);
    };
    tick();
  });
}

/** The tool result's text: the URL and whether there was a login, never the login itself. */
function describe(answer) {
  if (answer === null || answer.cancelled !== false || typeof answer.url !== 'string') {
    const reason = answer !== null && typeof answer.reason === 'string' ? ` (${answer.reason})` : '';
    return `${NOT_OPENED}${reason}`;
  }
  const credentials = answer.credentials !== undefined && answer.credentials !== null;
  return (
    `The operator opened ${answer.url} in the shared browser. ` +
    (credentials
      ? 'They supplied a username and password for it (not shown to you). '
      : 'They did not supply a login. ') +
    'Use the browser tools to look at the page; the operator sees it too.'
  );
}

async function openBrowser(requestId, args) {
  const hint = typeof args.hint === 'string' ? args.hint.trim().slice(0, 200) : '';
  const id = crypto.randomUUID();
  const requestFile = writeRequest(id, hint);
  const answerFile = path.join(DIR, `${id}.answer`);
  const controller = new AbortController();
  running.set(requestId, controller);
  try {
    const answer = await waitForAnswer(answerFile, controller.signal);
    return describe(answer);
  } finally {
    running.delete(requestId);
    // The answer can hold a password: it lives only as long as it takes to read it.
    removeQuietly(answerFile);
    removeQuietly(requestFile);
  }
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'chief', version: '1.0.0' },
        },
      });
      return;
    case 'ping':
      if (isRequest) send({ id, result: {} });
      return;
    case 'tools/list':
      send({ id, result: { tools: [TOOL] } });
      return;
    case 'tools/call': {
      if (params?.name !== TOOL.name) {
        send({ id, error: { code: -32602, message: `Unknown tool: ${String(params?.name)}` } });
        return;
      }
      try {
        const text = await openBrowser(id, params.arguments ?? {});
        send({ id, result: { content: [{ type: 'text', text }] } });
      } catch (cause) {
        const text = `${NOT_OPENED} (${cause instanceof Error ? cause.message : String(cause)})`;
        send({ id, result: { content: [{ type: 'text', text }], isError: true } });
      }
      return;
    }
    case 'notifications/cancelled':
      running.get(params?.requestId)?.abort();
      return;
    default:
      // Notifications get no answer; unknown requests get "method not found".
      if (isRequest) send({ id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === '') return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(message).catch((cause) => {
    process.stderr.write(`chief-mcp: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  });
});
input.on('close', () => {
  for (const controller of running.values()) controller.abort();
});
