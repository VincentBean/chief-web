import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { type Config, loadConfig } from '../../config.js';
import {
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  featureBranchFor,
  getVoiceSessionAgent,
  IN_MEMORY,
  openDatabase,
  type Session,
  updateSession,
  upsertVoiceSessionAgent,
} from '../../db/index.js';
import { DockerApi } from '../../docker/index.js';
import { FakeDockerDaemon, type FakeExec } from '../../docker/fake-daemon.js';
import { sessionRepoDir } from '../../orchestrator/index.js';
import { PlanningError, PlanningService, type PlanningTerminals } from '../../planning/index.js';
import type { CreateTerminalInput, TerminalView } from '../../terminal/index.js';
import { setSetting } from '../../db/index.js';
import type { AgentEvent } from '../call.js';
import { ConfirmationGate } from '../chief/confirm.js';
import { CLOSE_TERMINAL_PROMPT, focusSessionTool } from '../chief/focus.js';
import type { ChiefServices, ToolContext } from '../chief/tools.js';
import type { CallFocus } from '../protocol.js';
import { GIVING_UP, RESTARTING, SessionVoiceAgent, toolCardSummary } from './agent.js';
import { VOICE_PID_DIR, voicePidFile } from './process.js';
import { voiceUtterance } from './prompt.js';
import { SessionAgentError, SessionAgentRegistry } from './registry.js';
import { CLAUDE_SESSION, FakeClaude } from './__fixtures__/fake-claude.js';

/* ------------------------------------------------------------------ world */

class StubTerminals implements PlanningTerminals {
  running = true;
  create(input: CreateTerminalInput): Promise<TerminalView> {
    return Promise.resolve({
      id: 'terminal-1',
      container: input.container,
      containerName: input.container,
      command: input.command ?? [],
      status: 'running',
      exitCode: null,
      cols: 80,
      rows: 24,
      clients: 0,
      scrollbackBytes: 0,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    });
  }
  get(): { toView(): TerminalView } | undefined {
    return undefined;
  }
  remove(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const spoken = (events: readonly AgentEvent[]): string =>
  events.map((event) => (event.type === 'delta' ? event.text : '')).join('');

describe('session voice agents', () => {
  let daemon: FakeDockerDaemon;
  let docker: DockerApi;
  let claude: FakeClaude;
  let dataDir: string;
  let config: Config;
  let db: Database;
  let registry: SessionAgentRegistry;
  let holdActive: boolean;
  let terminalRunning: Set<string>;
  let seq = 0;

  const containers = {
    start: (session: Session) =>
      Promise.resolve({ id: `c-${session.id}`, name: `chief-web-${session.name}`, running: true, state: 'running' as const }),
    remove: () => Promise.resolve(),
  };

  const newSession = (name: string, status: Session['status'] = 'pending'): Session => {
    seq += 1;
    const repository = createRepository(db, {
      name: `demo-${String(seq)}`,
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'main',
    });
    const session = createSession(db, {
      repositoryId: repository.id,
      name,
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor(name),
      status: 'pending',
      scheduledStartAt: null,
    });
    if (status !== 'pending') updateSession(db, session.id, { status });
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
    daemon.addContainer({ id: `c-${session.id}`, name: `chief-web-${name}` });
    return { ...session, status };
  };

  const makeRegistry = (): SessionAgentRegistry =>
    new SessionAgentRegistry({
      config,
      db,
      docker,
      containers,
      hold: { active: () => holdActive, until: () => (holdActive ? '2026-09-25T20:00:00.000Z' : null) },
      planning: () => ({ isTerminalRunning: (id) => terminalRunning.has(id) }),
    });

  const controls = (): { focus: CallFocus[]; heard: string; setFocus(focus: CallFocus): void; spokenSoFar(): string } => {
    const state = {
      focus: [] as CallFocus[],
      heard: '',
      setFocus(focus: CallFocus): void {
        state.focus.push(focus);
      },
      spokenSoFar: (): string => state.heard,
    };
    return state;
  };

  const turn = (agent: SessionVoiceAgent, text: string, signal = new AbortController().signal): Promise<AgentEvent[]> =>
    collect(agent.run({ text, turn: 1, signal }));

  before(async () => {
    daemon = await FakeDockerDaemon.start();
    docker = new DockerApi(daemon.socketPath);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-voice-agents-'));
    config = loadConfig({ DATA_DIR: dataDir, VOICE_MAX_SESSION_AGENTS: '2', VOICE_KEEP_AGENTS_MS: '50' });
    db = openDatabase(IN_MEMORY);
  });

  after(async () => {
    closeDatabase(db);
    await daemon.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    claude = new FakeClaude(daemon);
    holdActive = false;
    terminalRunning = new Set();
    registry = makeRegistry();
    setSetting(db, 'voice_session_model', 'haiku');
  });

  afterEach(async () => {
    await registry.stopAll();
  });

  it('boots claude as uid 1000 in the clone with the §10.1 flags under the pid-file wrapper', async () => {
    const session = newSession('boot-it');
    const agent = await registry.acquire(session.id);
    const exec = daemon.exec(agent.execId);
    assert.ok(exec);
    assert.equal(exec.user, '1000');
    assert.equal(exec.workingDir, '/workspace/repo');
    assert.equal(exec.containerId, `c-${session.id}`);
    assert.deepEqual(exec.cmd.slice(0, 4), [
      '/bin/sh',
      '-c',
      `mkdir -p ${VOICE_PID_DIR} 2>/dev/null; echo $$ > ${voicePidFile(session.id)}; exec "$@"`,
      'chief-voice',
    ]);
    const argv = exec.cmd.slice(4);
    assert.deepEqual(argv.slice(0, -1), [
      'claude',
      '--model',
      'haiku',
      '--dangerously-skip-permissions',
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--append-system-prompt',
    ]);
    assert.match(argv.at(-1) as string, /You are on a live voice call/);
    assert.match(argv.at(-1) as string, /Speak Dutch unless/);
    assert.equal(registry.isAlive(session.id), true);
  });

  it('holds a conversation over two turns: planning prompt first, then [voice] lines, cards and the persisted id', async () => {
    const session = newSession('two-turns');
    const call = controls();
    const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call });

    const first = await turn(agent, 'I want a CSV export');
    assert.equal(spoken(first), 'Heard you. What next?');
    assert.equal(getVoiceSessionAgent(db, session.id)?.claudeSessionId, CLAUDE_SESSION);

    const second = await turn(agent, 'please #read the auth service');
    assert.deepEqual(
      second.filter((event) => event.type === 'tool').map((event) => (event.type === 'tool' ? [event.status, event.summary] : [])),
      [
        ['running', 'Reading server/src/auth/service.ts'],
        ['ok', 'Reading server/src/auth/service.ts'],
      ],
    );

    const [exec] = claude.agentExecs().filter((entry) => entry.containerId === `c-${session.id}`);
    assert.ok(exec);
    const [opening, next] = claude.userTexts(exec.id);
    assert.match(opening as string, /Chief PRD Generator/);
    assert.match(opening as string, /VOICE MODE OVERRIDES/);
    assert.match(opening as string, /\/workspace\/repo\/\.chief\/prds\/two-turns\/prd\.md/);
    assert.match(opening as string, /they said: "\[voice\] I want a CSV export"/);
    assert.equal(next, '[voice] please #read the auth service');
    // One process for both turns.
    assert.equal(claude.agentExecs().filter((entry) => entry.containerId === `c-${session.id}`).length, 1);
  });

  describe('Q&A mode (voice US-025)', () => {
    const argvOf = (execId: string): string[] => daemon.exec(execId)?.cmd.slice(4) ?? [];
    const flag = (argv: readonly string[], name: string): string | null =>
      argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? null) : null;

    it('plans a pending session: the planning prompt, no disallowed tools, mode plan', async () => {
      const session = newSession('plan-mode');
      const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call: controls() });
      await turn(agent, 'hi');
      const exec = claude.agentExecs().find((entry) => entry.containerId === `c-${session.id}`);
      assert.ok(exec);
      assert.equal(flag(argvOf(exec.id), '--disallowedTools'), null);
      assert.match(claude.userTexts(exec.id)[0] as string, /VOICE MODE OVERRIDES/);
      assert.equal(getVoiceSessionAgent(db, session.id)?.mode, 'plan');
    });

    for (const status of ['ready', 'building', 'finished'] as const) {
      it(`answers questions about a ${status} session: the A.3 prompt, edit tools disallowed, mode qa`, async () => {
        const session = newSession(`qa-${status}`, status);
        const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call: controls() });
        const events = await turn(agent, 'what did the build do');
        assert.equal(spoken(events), 'Heard you. What next?');

        const exec = claude.agentExecs().find((entry) => entry.containerId === `c-${session.id}`);
        assert.ok(exec);
        const argv = argvOf(exec.id);
        assert.equal(flag(argv, '--disallowedTools'), 'Edit,Write,MultiEdit,NotebookEdit');
        // The variadic flag is never last: another flag always ends its values.
        assert.equal(argv[argv.indexOf('--disallowedTools') + 2], '--append-system-prompt');
        assert.match(argv.at(-1) as string, /You are on a live voice call/);
        const [opening] = claude.userTexts(exec.id);
        assert.match(
          opening as string,
          new RegExp(
            `^You are answering questions about session qa-${status} \\(${status}\\)\\. Read the code, \`\\.chief/\` progress files and git log as needed\\. Do not modify any files\\.`,
          ),
        );
        assert.match(opening as string, /The operator opened the conversation by voice: "\[voice\] what did the build do"/);
        assert.doesNotMatch(opening as string, /Chief PRD|VOICE MODE OVERRIDES/);
        assert.equal(getVoiceSessionAgent(db, session.id)?.mode, 'qa');
      });
    }

    it('greets with a question when a Q&A conversation starts without words', () => {
      const session = newSession('qa-greet', 'ready');
      assert.match(registry.openingPrompt(session.id, null), /asking what they want to know\.$/);
    });

    it('never resumes a planning conversation as Q&A, nor the reverse', async () => {
      const session = newSession('mode-swap', 'ready');
      upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: 'planned-by-voice', mode: 'plan' });
      const first = await registry.acquire(session.id);
      assert.equal(flag(argvOf(first.execId), '--resume'), null);
      assert.equal(first.opened, false);

      // Back to planning while the Q&A agent is alive: it is replaced by a planning one.
      updateSession(db, session.id, { status: 'pending' });
      upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: 'asked-by-voice', mode: 'qa' });
      const second = await registry.acquire(session.id);
      assert.notEqual(second.execId, first.execId);
      assert.equal(first.exited, true);
      const argv = argvOf(second.execId);
      assert.equal(flag(argv, '--resume'), null);
      assert.equal(flag(argv, '--disallowedTools'), null);
      assert.equal(await registry.acquire(session.id), second);
    });
  });

  it('uses the edit prompt once prd.md exists and resumes a known conversation without re-sending it', async () => {
    const session = newSession('has-prd');
    const prd = path.join(sessionRepoDir(config, session.id), '.chief/prds/has-prd/prd.md');
    fs.mkdirSync(path.dirname(prd), { recursive: true });
    fs.writeFileSync(prd, '# PRD\n');
    assert.match(registry.openingPrompt(session.id, null), /Chief PRD Editor/);

    upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: 'earlier', mode: 'plan' });
    const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call: controls() });
    await turn(agent, 'where were we');
    const exec = claude.agentExecs().find((entry) => entry.containerId === `c-${session.id}`);
    assert.ok(exec);
    assert.deepEqual(exec.cmd.slice(exec.cmd.indexOf('--resume'), exec.cmd.indexOf('--resume') + 2), ['--resume', 'earlier']);
    assert.deepEqual(claude.userTexts(exec.id), ['[voice] where were we']);
  });

  it('interrupts with a control request and quotes what was heard in the next utterance', async () => {
    const session = newSession('interrupt-it');
    const call = controls();
    const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call });
    await turn(agent, 'hello');

    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of agent.run({ text: '#hang on this one', turn: 2, signal: controller.signal })) {
      events.push(event);
      call.heard = 'Heard you.';
      controller.abort(new Error('interrupted'));
    }
    await turn(agent, 'shorter please');

    const exec = claude.agentExecs().find((entry) => entry.containerId === `c-${session.id}`);
    assert.ok(exec);
    const lines = claude.stdin.get(exec.id) ?? [];
    assert.equal(lines.filter((entry) => entry['type'] === 'control_request').length, 1);
    assert.equal(claude.userTexts(exec.id).at(-1), '[voice] [You were interrupted after saying: "Heard you."] shorter please');
    assert.equal(voiceUtterance('x', null), '[voice] x');
  });

  it('SIGINTs an agent that ignores the interrupt after the grace period, and resumes it on the next utterance', async () => {
    const session = newSession('deaf-to-it');
    const call = controls();
    const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call, interruptGraceMs: 50 });
    await turn(agent, 'hello');

    const controller = new AbortController();
    for await (const event of agent.run({ text: '#deaf go on', turn: 2, signal: controller.signal })) {
      if (event.type === 'delta') controller.abort(new Error('barge-in'));
    }
    const execs = (): FakeExec[] => claude.agentExecs().filter((entry) => entry.containerId === `c-${session.id}`);
    const first = execs()[0] as FakeExec;
    await waitUntil(() => !first.running);
    assert.ok(daemon.execs().some((exec) => exec.cmd.join(' ').includes('kill -INT')));

    const events = await turn(agent, 'still there?');
    assert.equal(spoken(events), 'Heard you. What next?');
    const resumed = execs()[1] as FakeExec;
    assert.deepEqual(resumed.cmd.slice(resumed.cmd.indexOf('--resume'), resumed.cmd.indexOf('--resume') + 2), ['--resume', CLAUDE_SESSION]);
  });

  it('restarts a crashed agent once with --resume after telling the operator, then hands back to chief', async () => {
    const session = newSession('crashy');
    const call = controls();
    const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call });
    await turn(agent, 'hello');

    // Dies mid-turn: the operator hears why, and the same utterance goes to a resumed process.
    const crashed = await turn(agent, '#crash now');
    const execs = (): FakeExec[] => claude.agentExecs().filter((entry) => entry.containerId === `c-${session.id}`);
    assert.equal(spoken(crashed).startsWith(RESTARTING['nl'] as string), true);
    assert.equal(execs().length, 2);
    const restarted = execs()[1] as FakeExec;
    assert.deepEqual(restarted.cmd.slice(restarted.cmd.indexOf('--resume'), restarted.cmd.indexOf('--resume') + 2), ['--resume', CLAUDE_SESSION]);
    assert.deepEqual(claude.userTexts(restarted.id), ['[voice] #crash now']);
    // The second crash of the call: focus goes back to chief, with an explanation.
    assert.equal(spoken(crashed).includes(GIVING_UP['nl'] as string), true);
    assert.deepEqual(call.focus, [{ kind: 'chief' }]);
  });

  it('restarts a crash between turns and speaks normally after it', async () => {
    const session = newSession('crash-idle');
    const call = controls();
    const agent = new SessionVoiceAgent({ db, sessionId: session.id, registry, call });
    const first = await registry.acquire(session.id);
    await turn(agent, 'hello');
    daemon.finish(first.execId, 137);
    await first.finished;

    const after = await turn(agent, 'still there?');
    assert.equal(spoken(after), `${RESTARTING['nl'] as string} Heard you. What next?`);
    assert.deepEqual(call.focus, []);
  });

  it('stops the least recently used agent with TERM through its pid file beyond VOICE_MAX_SESSION_AGENTS', async () => {
    const [a, b, c] = [newSession('lru-a'), newSession('lru-b'), newSession('lru-c')];
    const first = await registry.acquire(a.id);
    first.lastUsedAt = 1;
    const second = await registry.acquire(b.id);
    second.lastUsedAt = 2;
    await registry.acquire(c.id);
    await first.finished;

    assert.equal(registry.isAlive(a.id), false);
    assert.deepEqual(registry.aliveSessions().sort(), [b.id, c.id].sort());
    assert.equal(daemon.exec(first.execId)?.exitCode, 143);
    const signal = daemon.execs().find((exec) => !exec.attachStdin && exec.cmd.join(' ').includes(voicePidFile(a.id)));
    assert.ok(signal);
    assert.match(signal.cmd.join(' '), /kill -TERM/);
  });

  it('keeps agents VOICE_KEEP_AGENTS_MS after a call ends, unless a call starts again', async () => {
    const session = newSession('keep-me');
    const agent = await registry.acquire(session.id);
    registry.callEnded();
    registry.callStarted();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(registry.isAlive(session.id), true);

    registry.callEnded();
    await agent.finished;
    assert.equal(registry.isAlive(session.id), false);
  });

  it('refuses unready, held and terminal-locked sessions, but not a session past planning', async () => {
    const ready = newSession('is-ready', 'ready');
    assert.equal(registry.check(ready.id).id, ready.id);

    const uncloned = newSession('no-clone');
    fs.rmSync(path.join(sessionRepoDir(config, uncloned.id), '.git'), { recursive: true });
    assert.throws(() => registry.check(uncloned.id), /no clone yet/);

    const held = newSession('held');
    holdActive = true;
    await assert.rejects(registry.acquire(held.id), /usage-limit hold/);
    holdActive = false;

    const locked = newSession('terminal-open');
    terminalRunning.add(locked.id);
    await assert.rejects(registry.acquire(locked.id), (error: unknown) => error instanceof SessionAgentError && error.status === 409 && error.code === 'session_in_planning_terminal');
    assert.equal(claude.agentExecs().some((exec) => exec.containerId === `c-${locked.id}`), false);
  });

  it('keeps the planning terminal shut with 409 session_in_voice_call while an agent is alive', async () => {
    const session = newSession('voice-lock');
    const terminals = new StubTerminals();
    const planning = new PlanningService(config, db, terminals, containers, null, registry);
    await registry.acquire(session.id);
    await assert.rejects(
      planning.start(session.id),
      (error: unknown) => error instanceof PlanningError && error.status === 409 && error.code === 'session_in_voice_call',
    );
    await registry.stop(session.id);
    await planning.start(session.id);
    assert.equal(registry.isAlive(session.id), false);
  });

  it('stops the voice agent for the terminal once the operator said yes (stopVoiceAgent)', async () => {
    const session = newSession('voice-to-terminal');
    const planning = new PlanningService(config, db, new StubTerminals(), containers, null, {
      isAlive: (id) => registry.isAlive(id),
      stop: (id) => registry.stop(id),
    });
    await registry.acquire(session.id);
    await planning.start(session.id, { stopVoiceAgent: true });
    assert.equal(registry.isAlive(session.id), false);
  });

  describe('focus_session', () => {
    const context = (gate: ConfirmationGate, focus: CallFocus[], turnNo = 1): ToolContext => ({
      signal: new AbortController().signal,
      turn: turnNo,
      focus: { kind: 'chief' },
      endCall: () => undefined,
      confirmations: gate,
      setFocus: (next) => focus.push(next),
    });
    const newGate = (): ConfirmationGate => {
      const holder = { pendingConfirmation: null };
      let id = 0;
      return new ConfirmationGate({ holder, now: () => Date.now(), send: () => undefined, newId: () => `confirm-${String(++id)}` });
    };

    it('hands a finished session to its Q&A agent (voice US-025)', async () => {
      const session = newSession('done-already', 'finished');
      const focus: CallFocus[] = [];
      const tool = focusSessionTool({ db, sessionAgents: registry, hold: { until: () => null } } as unknown as ChiefServices);
      const result = await tool.handler({ session: session.name }, context(newGate(), focus));
      assert.equal(result.ok, true);
      assert.deepEqual(focus, [{ kind: 'session', sessionId: session.id }]);
      assert.equal(registry.isAlive(session.id), true);
    });

    it('starts the agent and moves the focus', async () => {
      const session = newSession('talk-it-through');
      const focus: CallFocus[] = [];
      const tool = focusSessionTool({ db, sessionAgents: registry, hold: { until: () => null } } as unknown as ChiefServices);
      const result = await tool.handler({ session: 'talk it through' }, context(newGate(), focus));
      assert.equal(result.ok, true);
      assert.deepEqual(focus, [{ kind: 'session', sessionId: session.id }]);
      assert.equal(registry.isAlive(session.id), true);
    });

    it('asks before closing an open planning terminal, then closes it through PlanningService.stop', async () => {
      const session = newSession('terminal-first');
      terminalRunning.add(session.id);
      const stopped: string[] = [];
      const planning = {
        isTerminalRunning: (id: string) => terminalRunning.has(id),
        stop: (id: string) => {
          stopped.push(id);
          terminalRunning.delete(id);
          return Promise.resolve();
        },
      };
      const focus: CallFocus[] = [];
      const gate = newGate();
      const tool = focusSessionTool({ db, sessionAgents: registry, planning, hold: { until: () => null } } as unknown as ChiefServices);
      const asked = await tool.handler({ session: session.name }, context(gate, focus));
      assert.equal((asked.data as { say: string }).say, CLOSE_TERMINAL_PROMPT);
      assert.deepEqual(focus, []);

      const confirmation = gate.take((asked.data as { confirmation_id: string }).confirmation_id, 2);
      assert.equal(confirmation.kind, 'ok');
      const done = await tool.execute?.(confirmation.kind === 'ok' ? confirmation.confirmation.args : {}, context(gate, focus, 2));
      assert.equal(done?.ok, true);
      assert.deepEqual(stopped, [session.id]);
      assert.deepEqual(focus, [{ kind: 'session', sessionId: session.id }]);
    });
  });

  it('describes tool uses for their cards', () => {
    assert.equal(toolCardSummary('Read', { file_path: '/workspace/repo/server/src/auth/service.ts' }), 'Reading server/src/auth/service.ts');
    assert.equal(toolCardSummary('Grep', { pattern: 'invoice' }), 'Searching for "invoice"');
    assert.equal(toolCardSummary('Mystery', {}), 'Using Mystery');
  });
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition never became true');
}
