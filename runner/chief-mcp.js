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
 * The tool waits for it for at most five minutes and deletes both files the
 * moment the answer has been read.
 *
 * Then it opens the URL itself (US-009), over the DevTools protocol on the same
 * page the page view and Playwright MCP use, and with a login it looks for a
 * visible password field and the text or email field before it, fills both,
 * submits, and waits for the navigation (at most ten seconds). The
 * credentials never leave this process: the tool result says only how it went.
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
const CDP_URL = process.env.CHIEF_MCP_CDP_URL || 'http://127.0.0.1:9222';
/** How long the page may take to appear, and to load. */
const PAGE_WAIT_MS = Number(process.env.CHIEF_MCP_PAGE_WAIT_MS) || 15_000;
/** How long to look for a login form after the load (a single-page app renders it later). */
const FORM_WAIT_MS = Number(process.env.CHIEF_MCP_FORM_WAIT_MS) || 5_000;
/** How long to wait for the navigation a submitted login starts. */
const LOGIN_WAIT_MS = Number(process.env.CHIEF_MCP_LOGIN_WAIT_MS) || 10_000;
const NOT_OPENED = 'The operator did not open a browser. Move on without it.';

const TOOL = {
  name: 'open_browser_with_operator',
  description:
    'Open a browser that you and the operator look at together. Before calling it, say one short sentence ' +
    'asking the operator to fill in the card, such as "Type the address in the panel and I\'ll open it"; ' +
    'never read a URL out. The operator types the URL (and optionally a login) into a card in the call ' +
    'panel. Once they have, it opens the URL in the shared browser and logs in with what they typed, and ' +
    'says how that went: tell the operator in one sentence, naming the page rather than reading the URL out. ' +
    'If it says they did not open a browser, move on.',
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

/**
 * The answer, or null once the call was cancelled or timed out. Both files are
 * deleted the moment the answer has been read: it can hold a password.
 */
function waitForAnswer(answerFile, requestFile, signal) {
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
        removeQuietly(answerFile);
        removeQuietly(requestFile);
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

/** The tool result for an answer that opens nothing. */
function notOpened(answer) {
  const reason = answer !== null && typeof answer.reason === 'string' ? ` (${answer.reason})` : '';
  return `${NOT_OPENED}${reason}`;
}

async function openBrowser(requestId, args) {
  const hint = typeof args.hint === 'string' ? args.hint.trim().slice(0, 200) : '';
  const id = crypto.randomUUID();
  const requestFile = writeRequest(id, hint);
  const answerFile = path.join(DIR, `${id}.answer`);
  const controller = new AbortController();
  running.set(requestId, controller);
  try {
    const answer = await waitForAnswer(answerFile, requestFile, controller.signal);
    if (answer === null || answer.cancelled !== false || typeof answer.url !== 'string') return notOpened(answer);
    const credentials = loginOf(answer.credentials);
    try {
      return await openPage(answer.url, credentials, controller.signal);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      return `could not open ${answer.url} (${reason}); try browser_navigate, or ask the operator to open it in the page view`;
    }
  } finally {
    running.delete(requestId);
    removeQuietly(answerFile);
    removeQuietly(requestFile);
  }
}

function loginOf(credentials) {
  if (typeof credentials !== 'object' || credentials === null) return null;
  const { username, password } = credentials;
  return typeof username === 'string' && typeof password === 'string' && password !== '' ? { username, password } : null;
}

/** Opens `url` on the browser's page, and logs in when there is a login. */
async function openPage(url, credentials, signal) {
  const cdp = await Cdp.connect(await pageSocketUrl(signal));
  try {
    await cdp.send('Page.enable');
    const loaded = cdp.waitFor(['Page.loadEventFired'], PAGE_WAIT_MS, signal);
    const navigation = await cdp.send('Page.navigate', { url });
    if (typeof navigation.errorText === 'string' && navigation.errorText !== '') throw new Error(navigation.errorText);
    await loaded;
    if (credentials === null) return `opened ${url}`;

    const deadline = Date.now() + FORM_WAIT_MS;
    for (;;) {
      if (signal.aborted) throw new Error('cancelled');
      // Armed before the submit, so a fast navigation is not missed.
      const navigated = cdp.waitFor(['Page.loadEventFired', 'Page.navigatedWithinDocument'], LOGIN_WAIT_MS, signal);
      const login = await fillLogin(cdp, credentials);
      if (login.found) {
        if (!login.submitted) {
          // No form to submit: Enter in the password field, as a person would.
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        }
        await navigated;
        return `opened ${url} and logged in`;
      }
      navigated.cancel();
      if (Date.now() >= deadline) {
        return `opened ${url}, could not find a login form; ask the operator to log in in the page view`;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    cdp.close();
  }
}

/** Runs {@link LOGIN_FORM} in the page with the login as arguments, never as source text. */
async function fillLogin(cdp, credentials) {
  const document = await cdp.send('Runtime.evaluate', { expression: 'document' });
  const objectId = document.result && document.result.objectId;
  if (typeof objectId !== 'string') return { found: false };
  const reply = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: LOGIN_FORM,
    arguments: [{ value: credentials.username }, { value: credentials.password }],
    returnByValue: true,
    userGesture: true,
  });
  const value = reply.result && reply.result.value;
  return typeof value === 'object' && value !== null ? value : { found: false };
}

/**
 * Called on `document`: the first visible password field and the nearest
 * visible text or email field before it, filled through the native value
 * setter (so React and friends see the input), then the form submitted.
 */
const LOGIN_FORM = `function (username, password) {
  const visible = (el) => {
    if (el.disabled || el.readOnly) return false;
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const inputs = Array.from(this.querySelectorAll('input'));
  const at = inputs.findIndex((el) => el.type === 'password' && visible(el));
  if (at < 0) return { found: false };
  const secret = inputs[at];
  const user = inputs.slice(0, at).reverse().find((el) => (el.type === 'text' || el.type === 'email') && visible(el));
  if (user === undefined) return { found: false };
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const fill = (el, value) => {
    el.focus();
    setValue.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  fill(user, username);
  fill(secret, password);
  const form = secret.form;
  if (form === null) {
    secret.focus();
    return { found: true, submitted: false };
  }
  const button = Array.from(form.querySelectorAll('button, input[type=submit], input[type=image]'))
    .find((el) => el.type === 'submit' || el.type === 'image');
  try {
    form.requestSubmit(button);
  } catch {
    form.submit();
  }
  return { found: true, submitted: true };
}`;

/** The browser's page target, as the relay picks it (`cdp-relay.js`); Chromium may still be starting. */
async function pageSocketUrl(signal) {
  const deadline = Date.now() + PAGE_WAIT_MS;
  for (;;) {
    if (signal.aborted) throw new Error('cancelled');
    try {
      const response = await fetch(`${CDP_URL}/json/list`);
      const targets = await response.json();
      const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page') : undefined;
      if (page !== undefined && typeof page.webSocketDebuggerUrl === 'string') return page.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) throw new Error('the browser is not running');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** One DevTools connection: commands by id, and waiting for an event. */
class Cdp {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('could not reach the browser')), { once: true });
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = new Set();
    socket.addEventListener('message', (event) => this.message(event.data));
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('the browser closed'));
      this.pending.clear();
      for (const waiter of this.waiters) waiter.done();
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Resolves on the first of `methods`, after `ms`, or on `signal`;
   * `cancel()` stops waiting.
   */
  waitFor(methods, ms, signal) {
    let waiter;
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => waiter.done(), ms);
      const onAbort = () => waiter.done();
      signal.addEventListener('abort', onAbort, { once: true });
      waiter = {
        methods,
        done: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      this.waiters.add(waiter);
    });
    promise.cancel = () => waiter.done();
    return promise;
  }

  message(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id);
      if (call === undefined) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error(String(message.error.message || 'browser error')));
      else call.resolve(message.result || {});
      return;
    }
    for (const waiter of [...this.waiters]) if (waiter.methods.includes(message.method)) waiter.done();
  }

  close() {
    for (const waiter of [...this.waiters]) waiter.done();
    this.socket.close();
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
