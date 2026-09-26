import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type SessionAgentEvent, SessionAgentEventParser } from './events.js';
import { interruptRequestLine, userMessageLine } from './process.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const OUTPUT_FIXTURES = readdirSync(FIXTURES)
  .filter((file) => file.endsWith('.jsonl') && !file.endsWith('.stdin.jsonl'))
  .map((file) => file.slice(0, -'.jsonl'.length))
  .sort();

function raw(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8');
}

function jsonLines(name: string): Record<string, unknown>[] {
  return raw(name)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The fixture fed one line at a time. */
function parseByLine(name: string): SessionAgentEvent[] {
  const parser = new SessionAgentEventParser();
  return raw(name)
    .split('\n')
    .flatMap((line) => parser.line(line));
}

/** The fixture fed as a byte stream cut at awkward places, without its last newline. */
function parseChunked(name: string, size: number): SessionAgentEvent[] {
  const parser = new SessionAgentEventParser();
  const text = raw(name).replace(/\n$/, '');
  const events: SessionAgentEvent[] = [];
  for (let at = 0; at < text.length; at += size) events.push(...parser.push(text.slice(at, at + size)));
  return [...events, ...parser.flush()];
}

function spoken(events: SessionAgentEvent[]): string {
  return events.map((event) => (event.type === 'delta' ? event.text : '')).join('');
}

function ofType<T extends SessionAgentEvent['type']>(
  events: SessionAgentEvent[],
  type: T,
): Extract<SessionAgentEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionAgentEvent, { type: T }> => event.type === type);
}

/** Text of the complete `assistant` text blocks, in order. */
function assistantTexts(name: string): string[] {
  return jsonLines(name)
    .filter((line) => line['type'] === 'assistant')
    .flatMap((line) => (line['message'] as { content: { type: string; text?: string }[] }).content)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '');
}

function textDeltaCount(name: string): number {
  return jsonLines(name).filter(
    (line) =>
      line['type'] === 'stream_event' &&
      (line['event'] as { delta?: { type?: string } }).delta?.type === 'text_delta',
  ).length;
}

describe('SessionAgentEventParser over the recorded fixtures', () => {
  it('has the recordings the story asks for', () => {
    assert.deepEqual(OUTPUT_FIXTURES, ['interrupt', 'multi-turn', 'no-partials', 'text-reply', 'tool-use']);
  });

  for (const name of OUTPUT_FIXTURES) {
    it(`${name}: parses every line, whole or split across chunks`, () => {
      const byLine = parseByLine(name);
      assert.equal(ofType(byLine, 'unknown').filter((e) => e.kind === 'not_json').length, 0);
      for (const size of [1, 37, 4096]) assert.deepEqual(parseChunked(name, size), byLine, `chunk size ${String(size)}`);

      const lines = jsonLines(name);
      assert.equal(ofType(byLine, 'init').length, lines.filter((l) => l['subtype'] === 'init').length);
      assert.equal(ofType(byLine, 'turnEnd').length, lines.filter((l) => l['type'] === 'result').length);
      assert.equal(byLine.at(-1)?.type, 'turnEnd');
      for (const init of ofType(byLine, 'init')) assert.equal(init.claudeSessionId, lines[0]?.['session_id']);
    });
  }

  it('text-reply: streams the text once as deltas, never again from the assistant message', () => {
    const events = parseByLine('text-reply');
    const [text] = assistantTexts('text-reply');
    assert.ok(text !== undefined && text.length > 20);
    assert.equal(spoken(events), text);
    assert.equal(ofType(events, 'delta').length, textDeltaCount('text-reply'));

    assert.deepEqual(events[0], {
      type: 'init',
      claudeSessionId: jsonLines('text-reply')[0]?.['session_id'],
      model: 'claude-haiku-4-5-20251001',
    });
    const [end] = ofType(events, 'turnEnd');
    assert.equal(end?.ok, true);
    assert.equal(end?.interrupted, false);
    assert.equal(end?.subtype, 'success');
    assert.ok((end?.costUsd ?? 0) > 0);
    assert.ok((end?.durationMs ?? 0) > 0);
  });

  it('no-partials: speaks the complete text block exactly once', () => {
    const events = parseByLine('no-partials');
    assert.deepEqual(ofType(events, 'delta'), [{ type: 'delta', text: 'Planning sounds good.' }]);
  });

  it('tool-use: a Read card, its ok result, then the answer', () => {
    const events = parseByLine('tool-use').filter((e) => e.type !== 'unknown' && e.type !== 'delta');
    const [tool, result] = events.filter((e) => e.type === 'tool' || e.type === 'toolResult');
    assert.equal(tool?.type, 'tool');
    assert.equal(result?.type, 'toolResult');
    if (tool?.type !== 'tool' || result?.type !== 'toolResult') return;
    assert.equal(tool.name, 'Read');
    assert.match((tool.input as { file_path: string }).file_path, /\/math\.js$/);
    assert.equal(result.toolUseId, tool.toolUseId);
    assert.equal(result.ok, true);
    assert.equal(spoken(parseByLine('tool-use')), assistantTexts('tool-use').join(''));
  });

  it('multi-turn: one process, two turns, each with its init and its own text', () => {
    const events = parseByLine('multi-turn');
    assert.equal(ofType(events, 'turnEnd').length, 2);
    assert.equal(ofType(events, 'init').length, 2);

    const endAt = events.findIndex((e) => e.type === 'turnEnd');
    assert.equal(spoken(events.slice(0, endAt)), 'OK.');
    assert.equal(spoken(events.slice(endAt + 1)), 'Pelican.');
    // Tool results arrive interleaved with the next block's stream events; each still pairs with its call.
    const tools = ofType(events, 'tool').map((t) => t.toolUseId);
    const results = ofType(events, 'toolResult').map((r) => r.toolUseId);
    assert.deepEqual(results, tools);
  });

  it('interrupt: the stopped turn ends interrupted, its partial text is not repeated, the next turn runs', () => {
    const events = parseByLine('interrupt');
    const ends = ofType(events, 'turnEnd');
    assert.equal(ends.length, 2);
    assert.deepEqual(
      ends.map((e) => [e.ok, e.interrupted, e.subtype]),
      [
        [false, true, 'error_during_execution'],
        [true, false, 'success'],
      ],
    );
    const endAt = events.findIndex((e) => e.type === 'turnEnd');
    const [partial] = assistantTexts('interrupt');
    assert.equal(spoken(events.slice(0, endAt)), partial);
    assert.equal(spoken(events.slice(endAt + 1)), 'Understood.');
    // `[Request interrupted by user]` is a text block, not a tool result.
    assert.equal(ofType(events, 'toolResult').length, 0);
    assert.ok(ofType(events, 'unknown').some((e) => e.kind === 'control_response'));
  });
});

describe('SessionAgentEventParser edge cases', () => {
  it('separates two text blocks of one turn with a paragraph break', () => {
    const parser = new SessionAgentEventParser();
    const assistant = (id: string, text: string): string =>
      JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text }] }, parent_tool_use_id: null });
    const events = [
      ...parser.line(assistant('msg_1', 'Let me look.')),
      ...parser.line(assistant('msg_2', 'It exports add.')),
    ];
    assert.equal(spoken(events), 'Let me look.\n\nIt exports add.');
  });

  it("drops a subagent's stream and reports non-JSON output as unknown", () => {
    const parser = new SessionAgentEventParser();
    const sub = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_x', content: [{ type: 'text', text: 'subagent says' }] },
      parent_tool_use_id: 'toolu_1',
    });
    assert.deepEqual(parser.line(sub), [{ type: 'unknown', kind: 'assistant' }]);
    assert.deepEqual(parser.line('Error: something on stderr'), [{ type: 'unknown', kind: 'not_json' }]);
  });
});

describe('stdin builders match what the recordings sent', () => {
  const inputs = readdirSync(FIXTURES).filter((file) => file.endsWith('.stdin.jsonl'));

  it('has an input recording for every output recording', () => {
    assert.deepEqual(inputs.map((file) => file.slice(0, -'.stdin.jsonl'.length)).sort(), OUTPUT_FIXTURES);
  });

  for (const file of inputs) {
    it(`${file}: every line is reproduced by a builder`, () => {
      for (const line of readFileSync(join(FIXTURES, file), 'utf8').split('\n').filter((l) => l !== '')) {
        const parsed = JSON.parse(line) as {
          type: string;
          request_id?: string;
          message?: { content: { text: string }[] };
        };
        if (parsed.type === 'user') {
          assert.equal(userMessageLine(parsed.message?.content[0]?.text ?? ''), `${line}\n`);
        } else {
          assert.equal(parsed.type, 'control_request');
          assert.equal(interruptRequestLine(parsed.request_id ?? ''), `${line}\n`);
        }
      }
    });
  }

  it('the CLI acknowledged the interrupt with the same request id', () => {
    const sent = readFileSync(join(FIXTURES, 'interrupt.stdin.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('control_request'))
      .map((l) => (JSON.parse(l) as { request_id: string }).request_id);
    const acked = jsonLines('interrupt')
      .filter((l) => l['type'] === 'control_response')
      .map((l) => (l['response'] as { request_id: string; subtype: string }).request_id);
    assert.equal(sent.length, 1);
    assert.deepEqual(acked, sent);
  });
});
