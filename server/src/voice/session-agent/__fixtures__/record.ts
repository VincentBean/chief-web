/**
 * Re-records the stream-json fixtures in this directory from the real
 * `claude` CLI (see README.md). Not part of the test suite: it spends Claude
 * usage and needs a logged-in CLI.
 *
 *   cd server && node --import tsx src/voice/session-agent/__fixtures__/record.ts [scenario…]
 *
 * Every scenario writes `<name>.jsonl` (the CLI's stdout, one JSON per line)
 * and `<name>.stdin.jsonl` (what was written to its stdin, produced by the
 * builders in `../process.ts`).
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { interruptRequestLine, userMessageLine } from '../process.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = process.env['RECORD_MODEL'] ?? 'haiku';

/** Flags of plan §10.1, minus the prompt. */
const STREAM_FLAGS = [
  '--dangerously-skip-permissions',
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
];

interface Run {
  send(line: string): void;
  /** Resolves with the first matching line after the one the previous wait matched. */
  waitFor(match: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  endStdin(): void;
}

interface Scenario {
  args: string[];
  steps(run: Run): Promise<void>;
}

const isResult = (event: Record<string, unknown>): boolean => event['type'] === 'result';

function textDelta(event: Record<string, unknown>): boolean {
  const inner = event['event'] as Record<string, unknown> | undefined;
  const delta = inner?.['delta'] as Record<string, unknown> | undefined;
  return event['type'] === 'stream_event' && delta?.['type'] === 'text_delta';
}

const SCENARIOS: Record<string, Scenario> = {
  // init, text deltas, the complete assistant message and the result line.
  'text-reply': {
    args: [...STREAM_FLAGS, '--include-partial-messages'],
    async steps(run) {
      run.send(userMessageLine('[voice] In two short sentences: what is a pull request?'));
      await run.waitFor(isResult);
      run.endStdin();
    },
  },
  // A Read tool_use, its tool_result as a `user` line, then the answer.
  'tool-use': {
    args: [...STREAM_FLAGS, '--include-partial-messages'],
    async steps(run) {
      run.send(userMessageLine('[voice] Read math.js with the Read tool and tell me in one sentence what it exports.'));
      await run.waitFor(isResult);
      run.endStdin();
    },
  },
  // Two turns on one process: stdin keeps being read after the first result.
  'multi-turn': {
    args: [...STREAM_FLAGS, '--include-partial-messages'],
    async steps(run) {
      run.send(userMessageLine('[voice] Remember the word "pelican". Reply with just: OK.'));
      await run.waitFor(isResult);
      run.send(userMessageLine('[voice] Which word did I ask you to remember? One word.'));
      await run.waitFor(isResult);
      run.endStdin();
    },
  },
  // Barge-in: an interrupt control_request after the first text delta, then a
  // next utterance on the same process.
  interrupt: {
    args: [...STREAM_FLAGS, '--include-partial-messages'],
    async steps(run) {
      run.send(userMessageLine('[voice] Tell me a long story of about 400 words about a lighthouse keeper.'));
      await run.waitFor(textDelta);
      run.send(interruptRequestLine(randomUUID()));
      await run.waitFor(isResult);
      run.send(userMessageLine('[voice][interrupted after: "Once"] Never mind. Say: understood.'));
      await run.waitFor(isResult);
      run.endStdin();
    },
  },
  // No --include-partial-messages: text only arrives in complete assistant messages.
  'no-partials': {
    args: STREAM_FLAGS,
    async steps(run) {
      run.send(userMessageLine('[voice] Reply with exactly: Planning sounds good.'));
      await run.waitFor(isResult);
      run.endStdin();
    },
  },
};

async function record(name: string, scenario: Scenario, cwd: string): Promise<void> {
  const child = spawn('claude', ['--model', MODEL, ...scenario.args], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: withoutParentSession(process.env),
  });
  const out: string[] = [];
  const sent: string[] = [];
  const waiters: { from: number; match: (e: Record<string, unknown>) => boolean; resolve: (e: Record<string, unknown>) => void }[] = [];
  let consumed = 0;
  let partial = '';

  const settle = (): void => {
    for (const waiter of [...waiters]) {
      for (let i = waiter.from; i < out.length; i++) {
        const event = JSON.parse(out[i] ?? '{}') as Record<string, unknown>;
        if (waiter.match(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          consumed = i + 1;
          waiter.resolve(event);
          break;
        }
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    out.push(...lines.filter((line) => line.trim() !== ''));
    settle();
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', resolve));

  const run: Run = {
    send(line) {
      sent.push(line.trimEnd());
      child.stdin.write(line);
    },
    waitFor(match) {
      return new Promise((resolve) => {
        waiters.push({ from: consumed, match, resolve });
        settle();
      });
    },
    endStdin() {
      child.stdin.end();
    },
  };
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
  await scenario.steps(run);
  const code = await exited;
  clearTimeout(timer);
  if (partial.trim() !== '') out.push(partial);

  writeFileSync(join(HERE, `${name}.jsonl`), `${out.join('\n')}\n`);
  writeFileSync(join(HERE, `${name}.stdin.jsonl`), `${sent.join('\n')}\n`);
  console.log(`${name}: ${String(out.length)} lines, exit ${String(code)}`);
}

/** Recording from inside another Claude Code session must not look like a child of it. */
function withoutParentSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key === 'CLAUDECODE' || (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CODE_OAUTH_TOKEN') || key === 'CLAUDE_PID') {
      delete copy[key];
    }
  }
  return copy;
}

const cwd = mkdtempSync(join(tmpdir(), 'chief-voice-record-'));
writeFileSync(join(cwd, 'README.md'), '# demo\n');
writeFileSync(join(cwd, 'math.js'), 'export const add = (a, b) => a + b;\nexport const PI = 3.14;\n');

const wanted = process.argv.slice(2);
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (wanted.length > 0 && !wanted.includes(name)) continue;
  await record(name, scenario, cwd);
}
