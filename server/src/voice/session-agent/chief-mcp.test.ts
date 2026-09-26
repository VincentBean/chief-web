import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

/** `runner/chief-mcp.js`, the `chief` MCP server of the session agent (voice feedback US-007). */
const SCRIPT = fileURLToPath(new URL('../../../../runner/chief-mcp.js', import.meta.url));
const PASSWORD = 'hunter2-s3cret!';

const until = async (condition: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The server over stdio, newline-delimited JSON-RPC as the CLI speaks it. */
class McpClient {
  readonly messages: Record<string, unknown>[] = [];
  private buffer = '';

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') this.messages.push(JSON.parse(line) as Record<string, unknown>);
    });
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  async reply(id: number): Promise<Record<string, unknown>> {
    await until(() => this.messages.some((m) => m['id'] === id));
    return this.messages.find((m) => m['id'] === id) as Record<string, unknown>;
  }
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/**
 * Chromium's DevTools endpoint as the script sees it: `/json/list` with one
 * page, and that page's socket. Commands are recorded; `login` is what the
 * login function "finds" in the page, and `navigates` whether a submit
 * navigates.
 */
class FakeCdp {
  readonly commands: CdpCommand[] = [];
  /** Checked when `Page.navigate` arrives. */
  onNavigate: () => void = () => undefined;
  login: { found: boolean; submitted?: boolean } = { found: true, submitted: true };
  navigates = true;
  navigateError: string | null = null;
  private readonly server = http.createServer((request, response) => {
    if (request.url !== '/json/list') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ id: 'page-1', type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${String(this.port)}/devtools/page/page-1` }]));
  });
  private readonly sockets = new WebSocketServer({ server: this.server });

  constructor() {
    this.sockets.on('connection', (socket) => {
      const event = (method: string, params: Record<string, unknown> = {}): void => {
        setTimeout(() => socket.send(JSON.stringify({ method, params })), 5);
      };
      socket.on('message', (data: Buffer) => {
        const command = JSON.parse(data.toString('utf8')) as CdpCommand;
        this.commands.push(command);
        let result: Record<string, unknown> = {};
        switch (command.method) {
          case 'Page.navigate':
            this.onNavigate();
            if (this.navigateError !== null) result = { frameId: 'f', errorText: this.navigateError };
            else {
              result = { frameId: 'f' };
              event('Page.loadEventFired', { timestamp: 1 });
            }
            break;
          case 'Runtime.evaluate':
            result = { result: { type: 'object', objectId: 'document-1' } };
            break;
          case 'Runtime.callFunctionOn':
            result = { result: { type: 'object', value: this.login } };
            if (this.login.found && this.login.submitted === true && this.navigates) event('Page.loadEventFired', { timestamp: 2 });
            break;
          case 'Input.dispatchKeyEvent':
            if (command.params['type'] === 'keyUp' && this.navigates) event('Page.navigatedWithinDocument', { frameId: 'f', url: 'x' });
            break;
        }
        socket.send(JSON.stringify({ id: command.id, result }));
      });
    });
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `http://127.0.0.1:${String(this.port)}`;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  methods(): string[] {
    return this.commands.map((command) => command.method);
  }

  close(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.sockets.close();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const textOf = (reply: Record<string, unknown>): string => {
  const result = reply['result'] as { content: { type: string; text: string }[] };
  return result.content.map((c) => c.text).join('');
};

describe('runner/chief-mcp.js (voice feedback US-007)', () => {
  const dirs: string[] = [];
  let dir: string;
  let client: McpClient;
  let cdp: FakeCdp;

  const start = (timeoutMs = 5_000, env: Record<string, string> = {}): void => {
    // Run from outside the repository, as in the image: the repo's package.json
    // says `"type": "module"`, and the script is CommonJS.
    const script = path.join(path.dirname(dir), 'chief-mcp.js');
    fs.copyFileSync(SCRIPT, script);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, CHIEF_MCP_BROWSER_DIR: dir, CHIEF_MCP_ANSWER_TIMEOUT_MS: String(timeoutMs), CHIEF_MCP_POLL_MS: '10',
        CHIEF_MCP_CDP_URL: cdp.url,
        CHIEF_MCP_FORM_WAIT_MS: '100',
        CHIEF_MCP_LOGIN_WAIT_MS: '2000',
        ...env,
      },
    });
    client = new McpClient(child);
  };

  const requestFiles = (): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.request')) : []);

  /** Calls the tool and returns the request the server wrote. */
  const call = async (id: number, args: Record<string, unknown> = { hint: 'the checkout page' }): Promise<Record<string, unknown>> => {
    client.send({ id, method: 'tools/call', params: { name: 'open_browser_with_operator', arguments: args } });
    await until(() => requestFiles().length === 1);
    return JSON.parse(fs.readFileSync(path.join(dir, requestFiles()[0] as string), 'utf8')) as Record<string, unknown>;
  };

  const answer = (requestId: string, content: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(dir, `${requestId}.answer`), JSON.stringify({ id: requestId, ...content }), { mode: 0o600 });
  };

  beforeEach(async () => {
    cdp = new FakeCdp();
    await cdp.listen();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-mcp-'));
    dirs.push(base);
    dir = path.join(base, 'browser');
  });

  afterEach(async () => {
    client.child.kill();
    await cdp.close();
  });

  after(() => {
    for (const base of dirs) fs.rmSync(base, { recursive: true, force: true });
  });

  it('answers initialize and lists one tool with an optional hint', async () => {
    start();
    client.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    const init = await client.reply(1);
    assert.deepEqual(init['result'], {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'chief', version: '1.0.0' },
    });
    client.send({ method: 'notifications/initialized' });
    client.send({ id: 2, method: 'tools/list' });
    const list = await client.reply(2);
    const tools = (list['result'] as { tools: { name: string; inputSchema: { properties: object; required?: unknown } }[] }).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['open_browser_with_operator']);
    assert.deepEqual(Object.keys(tools[0]?.inputSchema.properties ?? {}), ['hint']);
    assert.equal(tools[0]?.inputSchema.required, undefined);
    assert.equal(client.messages.length, 2, 'a notification gets no reply');
  });

  it('deletes both files as soon as the answer is read, opens the URL, logs in, and never echoes the login (US-009)', async () => {
    start();
    const request = await call(3);
    assert.equal(request['hint'], 'the checkout page');
    assert.match(String(request['id']), /^[0-9a-f-]{36}$/);
    assert.equal(fs.statSync(path.join(dir, `${String(request['id'])}.request`)).mode & 0o777, 0o600);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.messages.length, 0, 'the tool blocks until the answer');

    let filesAtNavigate: string[] | null = null;
    cdp.onNavigate = () => {
      filesAtNavigate = fs.readdirSync(dir);
    };
    const url = 'http://host.docker.internal:3000/checkout';
    answer(String(request['id']), { cancelled: false, url, credentials: { username: 'ann@example.com', password: PASSWORD } });
    const text = textOf(await client.reply(3));
    assert.equal(text, `opened ${url} and logged in`);
    assert.deepEqual(filesAtNavigate, [], 'request and answer are gone before the browser is touched');

    assert.deepEqual(cdp.methods(), ['Page.enable', 'Page.navigate', 'Runtime.evaluate', 'Runtime.callFunctionOn']);
    assert.deepEqual(cdp.commands[1]?.params, { url });
    const login = cdp.commands[3]?.params ?? {};
    assert.equal(login['objectId'], 'document-1');
    assert.deepEqual(login['arguments'], [{ value: 'ann@example.com' }, { value: PASSWORD }], 'the login goes in as arguments');
    const declaration = String(login['functionDeclaration']);
    assert.ok(!declaration.includes(PASSWORD), 'never as source text');
    assert.match(declaration, /type === 'password'/);
    assert.match(declaration, /el\.type === 'text' \|\| el\.type === 'email'/);
    assert.match(declaration, /requestSubmit/);
    assert.ok(!text.includes(PASSWORD) && !text.includes('ann@'), 'the credentials never reach the agent');
  });

  it('opens the URL without a login attempt when no login was supplied', async () => {
    start();
    const request = await call(4, {});
    assert.equal(request['hint'], '');
    answer(String(request['id']), { cancelled: false, url: 'https://example.com/' });
    assert.equal(textOf(await client.reply(4)), 'opened https://example.com/');
    assert.deepEqual(cdp.methods(), ['Page.enable', 'Page.navigate']);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('says so when the page has no login form, after looking for a while', async () => {
    cdp.login = { found: false };
    start();
    const request = await call(8);
    answer(String(request['id']), { cancelled: false, url: 'https://example.com/', credentials: { username: 'ann', password: PASSWORD } });
    assert.equal(
      textOf(await client.reply(8)),
      'opened https://example.com/, could not find a login form; ask the operator to log in in the page view',
    );
    assert.ok(cdp.methods().filter((method) => method === 'Runtime.callFunctionOn').length > 1, 'it looked more than once');
  });

  it('presses Enter in the password field when it is not in a form, and waits for the navigation', async () => {
    cdp.login = { found: true, submitted: false };
    start();
    const request = await call(9);
    answer(String(request['id']), { cancelled: false, url: 'https://example.com/', credentials: { username: 'ann', password: PASSWORD } });
    assert.equal(textOf(await client.reply(9)), 'opened https://example.com/ and logged in');
    const keys = cdp.commands.filter((command) => command.method === 'Input.dispatchKeyEvent').map((command) => command.params['type']);
    assert.deepEqual(keys, ['keyDown', 'keyUp']);
  });

  it('gives up waiting for the navigation after the login wait', async () => {
    cdp.navigates = false;
    start(5_000, { CHIEF_MCP_LOGIN_WAIT_MS: '200' });
    const request = await call(10);
    const started = Date.now();
    answer(String(request['id']), { cancelled: false, url: 'https://example.com/', credentials: { username: 'ann', password: PASSWORD } });
    assert.equal(textOf(await client.reply(10)), 'opened https://example.com/ and logged in');
    assert.ok(Date.now() - started >= 200);
  });

  it('says it could not open the page when the navigation fails, not that nobody opened a browser', async () => {
    cdp.navigateError = 'net::ERR_NAME_NOT_RESOLVED';
    start();
    const request = await call(11);
    answer(String(request['id']), { cancelled: false, url: 'https://nope.invalid/', credentials: { username: 'ann', password: PASSWORD } });
    const text = textOf(await client.reply(11));
    assert.match(text, /^could not open https:\/\/nope\.invalid\/ \(net::ERR_NAME_NOT_RESOLVED\)/);
    assert.ok(!text.includes(PASSWORD));
  });

  it('returns "the operator did not open a browser" on a cancelled answer', async () => {
    start();
    const request = await call(5);
    answer(String(request['id']), { cancelled: true });
    assert.match(textOf(await client.reply(5)), /^The operator did not open a browser/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it('gives up after the timeout', async () => {
    start(150);
    await call(6);
    assert.match(textOf(await client.reply(6)), /^The operator did not open a browser/);
    assert.deepEqual(requestFiles(), []);
  });

  it('stops waiting when the CLI cancels the call', async () => {
    start();
    await call(7);
    client.send({ method: 'notifications/cancelled', params: { requestId: 7, reason: 'interrupted' } });
    await client.reply(7);
    assert.deepEqual(requestFiles(), []);
  });
});
