import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `ask_operator` in `runner/chief-mcp.js`, over the real stdio protocol
 * (decisions US-002).
 *
 * The same shape as `voice/session-agent/chief-mcp.test.ts`, which covers the
 * other two tools of the same server: the script is spawned as the image runs
 * it, spoken to in newline-delimited JSON-RPC, and answered by writing the
 * file chief-web would write. What is worth proving here is the contract the
 * server half depends on — the request file's fields, that the call blocks
 * until an answer appears, and that *every* way of not getting one still ends
 * with the agent being told to carry on rather than left hanging.
 */

const SCRIPT = fileURLToPath(new URL('../../../runner/chief-mcp.js', import.meta.url));

const until = async (condition: () => boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

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
    await until(() => this.messages.some((message) => message['id'] === id));
    return this.messages.find((message) => message['id'] === id) as Record<string, unknown>;
  }
}

/** The text of a tool result, and whether the server flagged it as an error. */
const resultOf = (reply: Record<string, unknown>): { text: string; isError: boolean } => {
  const result = reply['result'] as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((part) => part.text).join(''), isError: result.isError === true };
};

describe('runner/chief-mcp.js ask_operator (decisions US-002)', () => {
  const bases: string[] = [];
  let askDir: string;
  let client: McpClient;

  const start = (env: Record<string, string> = {}): void => {
    // Outside the repository, as in the image: the repo is ESM and the script
    // is CommonJS.
    const script = path.join(path.dirname(askDir), 'chief-mcp.js');
    fs.copyFileSync(SCRIPT, script);
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        CHIEF_MCP_ASK_OPERATOR: '1',
        CHIEF_MCP_ASK_DIR: askDir,
        CHIEF_MCP_ASK_TIMEOUT_MS: '5000',
        CHIEF_MCP_POLL_MS: '10',
        ...env,
      },
    });
    client = new McpClient(child);
  };

  const requestFiles = (): string[] =>
    fs.existsSync(askDir) ? fs.readdirSync(askDir).filter((file) => file.endsWith('.request')) : [];

  /** Calls the tool and returns the request file the server wrote. */
  const ask = async (id: number, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    client.send({ id, method: 'tools/call', params: { name: 'ask_operator', arguments: args } });
    await until(() => requestFiles().length === 1);
    return JSON.parse(fs.readFileSync(path.join(askDir, requestFiles()[0] as string), 'utf8')) as Record<string, unknown>;
  };

  const answer = (requestId: string, content: Record<string, unknown>): void => {
    fs.writeFileSync(path.join(askDir, `${requestId}.answer`), JSON.stringify({ id: requestId, ...content }), {
      mode: 0o600,
    });
  };

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-ask-'));
    bases.push(base);
    askDir = path.join(base, 'ask');
  });

  afterEach(() => {
    client.child.kill();
  });

  after(() => {
    for (const base of bases) fs.rmSync(base, { recursive: true, force: true });
  });

  it('offers only ask_operator to a build iteration: no browser, nothing to build', async () => {
    start();
    client.send({ id: 1, method: 'tools/list' });
    const tools = (await client.reply(1))['result'] as {
      tools: { name: string; description: string; inputSchema: { properties: object; required: string[] } }[];
    };
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['ask_operator'],
    );
    assert.deepEqual(Object.keys(tools.tools[0]?.inputSchema.properties ?? {}), [
      'question',
      'options',
      'context',
      'recommendation',
    ]);
    assert.deepEqual(tools.tools[0]?.inputSchema.required, ['question']);

    // The browser tool is not merely unlisted: calling it by name is refused.
    client.send({ id: 2, method: 'tools/call', params: { name: 'open_browser_with_operator', arguments: {} } });
    const refused = await client.reply(2);
    assert.match(String((refused['error'] as { message: string }).message), /Unknown tool/);
  });

  it('writes the question with its options and blocks until the answer arrives', async () => {
    start();
    const request = await ask(3, {
      question: 'Keep the old sync API as a deprecated shim?',
      options: ['Keep it for one release', 'Remove it now'],
      context: 'Two call sites outside this repo use it.',
      recommendation: 'Keep it: removing it is not reversible in a later story.',
    });

    assert.match(String(request['id']), /^[0-9a-f-]{36}$/);
    assert.equal(request['question'], 'Keep the old sync API as a deprecated shim?');
    assert.deepEqual(request['options'], ['Keep it for one release', 'Remove it now']);
    assert.equal(request['context'], 'Two call sites outside this repo use it.');
    assert.match(String(request['createdAt']), /^\d{4}-/);
    assert.equal(fs.statSync(path.join(askDir, `${String(request['id'])}.request`)).mode & 0o777, 0o600);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(client.messages.length, 0, 'the tool blocks until the answer');

    answer(String(request['id']), { answered: true, answer: 'Keep it for one release, and say so in the PRD.' });
    const { text, isError } = resultOf(await client.reply(3));
    assert.equal(isError, false);
    assert.match(text, /The operator answered:/);
    assert.match(text, /Keep it for one release, and say so in the PRD\./);
    // The agent is told what to do with it, not only what it was.
    assert.match(text, /record it in your progress\.md entry/);

    // Both files go the moment the answer has been read.
    await until(() => !fs.existsSync(path.join(askDir, `${String(request['id'])}.answer`)));
    assert.deepEqual(requestFiles(), []);
  });

  it('tells the agent to carry on when nobody answers in time', async () => {
    start({ CHIEF_MCP_ASK_TIMEOUT_MS: '120' });
    await ask(4, { question: 'Which database?' });
    const { text, isError } = resultOf(await client.reply(4));
    assert.equal(isError, true, 'an unanswered question is an error, so it cannot read as a decision');
    assert.match(text, /Nobody answered/);
    assert.match(text, /most conservative/);
    assert.match(text, /## Open Questions/);
  });

  it('passes on chief-web’s reason when it declined to ask, and still says what to do', async () => {
    start();
    const request = await ask(5, { question: 'Which database?' });
    answer(String(request['id']), { answered: false, reason: 'the build was stopped' });
    const { text, isError } = resultOf(await client.reply(5));
    assert.equal(isError, true);
    assert.match(text, /the build was stopped/);
    assert.match(text, /most conservative/);
  });

  it('refuses a call with no question rather than writing an empty one', async () => {
    start();
    client.send({ id: 6, method: 'tools/call', params: { name: 'ask_operator', arguments: { options: ['a', 'b'] } } });
    const { text, isError } = resultOf(await client.reply(6));
    assert.equal(isError, true);
    assert.match(text, /needs a `question`/);
    assert.deepEqual(requestFiles(), [], 'nothing is left behind for chief-web to find');
  });

  it('bounds what it passes through: eight options, and no unbounded strings', async () => {
    start();
    const request = await ask(7, {
      question: 'x'.repeat(5_000),
      options: Array.from({ length: 20 }, (_, index) => `option ${String(index)}`),
      recommendation: 'y'.repeat(2_000),
    });
    assert.equal(String(request['question']).length, 2_000);
    assert.equal((request['options'] as string[]).length, 8);
    assert.equal(String(request['recommendation']).length, 600);
  });

  it('is not offered at all without CHIEF_MCP_ASK_OPERATOR=1: a voice agent keeps its own tools', async () => {
    start({ CHIEF_MCP_ASK_OPERATOR: '0' });
    client.send({ id: 8, method: 'tools/list' });
    const tools = (await client.reply(8))['result'] as { tools: { name: string }[] };
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['open_browser_with_operator', 'start_build'],
    );
  });
});
