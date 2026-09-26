import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

const textOf = (reply: Record<string, unknown>): string => {
  const result = reply['result'] as { content: { type: string; text: string }[] };
  return result.content.map((c) => c.text).join('');
};

describe('runner/chief-mcp.js (voice feedback US-007)', () => {
  const dirs: string[] = [];
  let dir: string;
  let client: McpClient;

  const start = (timeoutMs = 5_000): void => {
    // Run from outside the repository, as in the image: the repo's package.json
    // says `"type": "module"`, and the script is CommonJS.
    const script = path.join(path.dirname(dir), 'chief-mcp.js');
    fs.copyFileSync(SCRIPT, script);
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, CHIEF_MCP_BROWSER_DIR: dir, CHIEF_MCP_ANSWER_TIMEOUT_MS: String(timeoutMs), CHIEF_MCP_POLL_MS: '10' },
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

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-mcp-'));
    dirs.push(base);
    dir = path.join(base, 'browser');
  });

  afterEach(() => {
    client.child.kill();
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

  it('writes a request, waits for the answer, returns the URL and whether there was a login, and deletes both files', async () => {
    start();
    const request = await call(3);
    assert.equal(request['hint'], 'the checkout page');
    assert.match(String(request['id']), /^[0-9a-f-]{36}$/);
    assert.equal(fs.statSync(path.join(dir, `${String(request['id'])}.request`)).mode & 0o777, 0o600);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.messages.length, 0, 'the tool blocks until the answer');

    answer(String(request['id']), { cancelled: false, url: 'http://host.docker.internal:3000/checkout', credentials: { username: 'ann', password: PASSWORD } });
    const reply = await client.reply(3);
    const text = textOf(reply);
    assert.match(text, /http:\/\/host\.docker\.internal:3000\/checkout/);
    assert.match(text, /supplied a username and password/);
    assert.ok(!text.includes(PASSWORD) && !text.includes('ann'), 'the credentials never reach the agent');
    assert.deepEqual(fs.readdirSync(dir), [], 'request and answer are gone');
  });

  it('says so when no login was supplied', async () => {
    start();
    const request = await call(4, {});
    assert.equal(request['hint'], '');
    answer(String(request['id']), { cancelled: false, url: 'https://example.com/' });
    assert.match(textOf(await client.reply(4)), /did not supply a login/);
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
