import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import {
  askDecision,
  closeDatabase,
  createRepository,
  createSession,
  type Database,
  deleteSetting,
  featureBranchFor,
  getVoiceSessionAgent,
  IN_MEMORY,
  openDatabase,
  setSetting,
  type Session,
  updateSession,
  upsertVoiceSessionAgent,
} from '../db/index.js';
import { sessionRepoDir } from '../orchestrator/index.js';
import { prdPathFor } from '../prd/index.js';
import type { SessionContainers } from '../sessions/index.js';
import type { CreateTerminalInput, TerminalView } from '../terminal/index.js';
import {
  DEFAULT_CONTEXT,
  editPlanningPrompt,
  initPlanningPrompt,
  PlanningError,
  type PlanningTerminals,
  PlanningService,
  planningCommand,
  VOICE_HANDOVER_PROMPT,
} from './index.js';
import type { VoiceBusEvent } from '../voice/events.js';

const PROMPT_INPUT = {
  sessionName: 'add-login',
  featureBranch: 'chief/add-login',
  repositoryName: 'demo',
};

/** A terminal manager that records what was asked of it. */
class FakeTerminals implements PlanningTerminals {
  readonly created: CreateTerminalInput[] = [];
  readonly removed: string[] = [];
  private readonly views = new Map<string, TerminalView>();
  private counter = 0;

  create(input: CreateTerminalInput): Promise<TerminalView> {
    this.created.push(input);
    this.counter += 1;
    const view: TerminalView = {
      id: `terminal-${String(this.counter)}`,
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
    };
    this.views.set(view.id, view);
    return Promise.resolve(view);
  }

  get(id: string): { toView(): TerminalView } | undefined {
    const view = this.views.get(id);
    return view === undefined ? undefined : { toView: (): TerminalView => view };
  }

  remove(id: string): Promise<boolean> {
    this.removed.push(id);
    return Promise.resolve(this.views.delete(id));
  }

  /** Models the `claude` process ending while the terminal is still known. */
  exit(id: string, exitCode = 0): void {
    const view = this.views.get(id);
    if (view !== undefined) this.views.set(id, { ...view, status: 'exited', exitCode });
  }
}

describe('planning prompts', () => {
  it('substitutes every placeholder in the init prompt', () => {
    const prompt = initPlanningPrompt({ ...PROMPT_INPUT, context: 'A login screen.' });

    assert.equal(prompt.includes('{{PRD_DIR}}'), false);
    assert.equal(prompt.includes('{{CONTEXT}}'), false);
    assert.match(prompt, /Chief PRD Generator/);
    assert.match(prompt, /\/workspace\/repo\/\.chief\/prds\/add-login\/prd\.md/);
    assert.match(prompt, /A login screen\./);
    assert.match(prompt, /chief\/add-login/);
  });

  it('falls back to chief’s own wording when no context is given', () => {
    const prompt = initPlanningPrompt(PROMPT_INPUT);

    assert.match(prompt, new RegExp(DEFAULT_CONTEXT.replaceAll('.', '\\.')));
  });

  it('spells out chief’s exact story format in both prompts', () => {
    for (const prompt of [initPlanningPrompt(PROMPT_INPUT), editPlanningPrompt('add-login')]) {
      assert.match(prompt, /### US-001: /);
      assert.match(prompt, /\*\*Status:\*\* todo/);
      assert.match(prompt, /\*\*Priority:\*\* 1/);
      assert.match(prompt, /\*\*Description:\*\*/);
      assert.match(prompt, /- \[ \] /);
    }
  });

  it('uses chief’s edit prompt for an existing PRD', () => {
    const prompt = editPlanningPrompt('add-login');

    assert.equal(prompt.includes('{{PRD_DIR}}'), false);
    assert.match(prompt, /Chief PRD Editor/);
    assert.match(prompt, /Preserve story IDs/);
  });

  it('passes the prompt as a single argument, so no shell can reparse it', () => {
    const command = planningCommand('two words; rm -rf /');

    assert.deepEqual(command, ['claude', 'two words; rm -rf /']);
  });

  it('passes the configured model, and no --model flag when there is none', () => {
    assert.deepEqual(planningCommand('go', 'haiku'), ['claude', '--model', 'haiku', 'go']);
    assert.deepEqual(planningCommand('go', null), ['claude', 'go']);
    assert.deepEqual(planningCommand('go'), ['claude', 'go']);
  });

  it('puts --resume and its id before the prompt (voice US-025)', () => {
    assert.deepEqual(planningCommand('go', 'haiku', 'abc'), ['claude', '--model', 'haiku', '--resume', 'abc', 'go']);
    assert.deepEqual(planningCommand('go', null, 'abc'), ['claude', '--resume', 'abc', 'go']);
    assert.deepEqual(planningCommand('go', null, null), ['claude', 'go']);
  });

  it('puts --effort after --model and before --resume (thinking effort US-004)', () => {
    assert.deepEqual(planningCommand('go', null, null, 'high'), ['claude', '--effort', 'high', 'go']);
    assert.deepEqual(planningCommand('go', 'haiku', null, 'low'), ['claude', '--model', 'haiku', '--effort', 'low', 'go']);
    assert.deepEqual(planningCommand('go', 'haiku', 'abc', 'max'), [
      'claude',
      '--model',
      'haiku',
      '--effort',
      'max',
      '--resume',
      'abc',
      'go',
    ]);
    assert.deepEqual(planningCommand('go', null, null, null), ['claude', 'go']);
    assert.deepEqual(planningCommand('go', 'haiku', 'abc', null), ['claude', '--model', 'haiku', '--resume', 'abc', 'go']);
  });

  it('targets .chief/prds/<session name>/prd.md', () => {
    assert.equal(prdPathFor('add-login'), '.chief/prds/add-login/prd.md');
  });
});

describe('planning service', () => {
  let config: Config;
  let dataDir: string;
  let db: Database;
  let session: Session;
  let terminals: FakeTerminals;
  let planning: PlanningService;
  let started: string[];
  /** Repository names are unique, so each case gets its own. */
  let seq = 0;

  const containers: SessionContainers = {
    start: (target: Session) => {
      started.push(target.id);
      return Promise.resolve({
        id: 'container-1',
        name: 'chief-web-add-login',
        running: true,
        state: 'running',
      });
    },
    remove: () => Promise.resolve(),
  };

  const clone = (): void => {
    fs.mkdirSync(path.join(sessionRepoDir(config, session.id), '.git'), { recursive: true });
  };

  const writePrd = (content: string): void => {
    const file = path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-planning-'));
    config = loadConfig({ DATA_DIR: dataDir });
    db = openDatabase(IN_MEMORY);
  });

  after(() => {
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(config.workspacesDir, { recursive: true, force: true });
    fs.mkdirSync(config.workspacesDir, { recursive: true });
    seq += 1;
    const repository = createRepository(db, {
      name: `demo-${String(seq)}`,
      sshUrl: 'git@github.com:acme/demo.git',
      githubSlug: 'acme/demo',
      defaultBaseBranch: 'main',
    });
    session = createSession(db, {
      repositoryId: repository.id,
      name: 'add-login',
      baseBranch: 'main',
      prTargetBranch: 'main',
      featureBranch: featureBranchFor('add-login'),
      status: 'pending',
      scheduledStartAt: null,
    });
    started = [];
    terminals = new FakeTerminals();
    planning = new PlanningService(config, db, terminals, containers);
  });

  it('reports an unknown session as 404', () => {
    assert.throws(
      () => planning.status('nope'),
      (error: unknown) => error instanceof PlanningError && error.status === 404,
    );
  });

  it('reports a session whose PRD has not been written yet', () => {
    const view = planning.status(session.id);

    assert.equal(view.terminalId, null);
    assert.equal(view.running, false);
    assert.equal(view.mode, null);
    assert.equal(view.nextMode, 'create');
    assert.equal(view.prd.exists, false);
    assert.equal(view.prd.path, '.chief/prds/add-login/prd.md');
    assert.equal(view.cwd, '/workspace/repo');
  });

  it('refuses to plan a session that has not been cloned', async () => {
    await assert.rejects(
      planning.start(session.id),
      (error: unknown) => error instanceof PlanningError && error.code === 'session_not_cloned',
    );
    assert.deepEqual(terminals.created, []);
  });

  it('refuses to plan a session that is no longer pending', async () => {
    clone();
    updateSession(db, session.id, { status: 'building' });

    await assert.rejects(
      planning.start(session.id),
      (error: unknown) => error instanceof PlanningError && error.code === 'session_not_pending',
    );
  });

  it('opens a read-only terminal on an open question, and nothing else (decisions US-009)', async () => {
    clone();
    updateSession(db, session.id, { status: 'deciding' });
    askDecision(db, {
      id: '7b1c2d3e-4a5b-4c6d-8e7f-0123456789ab',
      sessionId: session.id,
      storyId: 'US-002',
      question: 'Keep the old sync API as a deprecated shim?',
      options: ['Keep it', 'Remove it'],
      context: 'Two call sites outside this repo use it.',
      recommendation: 'Keep it.',
    });

    // The question is what makes this conversation possible: without the
    // intent, a session that is not pending is still refused.
    await assert.rejects(
      planning.start(session.id),
      (error: unknown) => error instanceof PlanningError && error.code === 'session_not_pending',
    );
    assert.equal(planning.status(session.id).canStart, 'decide');
    assert.equal(planning.status(session.id).nextMode, 'decide');

    const view = await planning.start(session.id, { intent: 'decide' });

    assert.equal(view.mode, 'decide');
    const command = terminals.created[0]?.command ?? [];
    const prompt = command.at(-1) ?? '';
    assert.match(prompt, /Keep the old sync API as a deprecated shim\?/);
    assert.match(prompt, /1\. Keep it/);
    assert.match(prompt, /Two call sites outside this repo use it\./);
    assert.match(prompt, /story US-002 half-built in this working tree/);
    // It must not write: a build agent owns this tree, mid-story.
    assert.match(prompt, /\*\*Change nothing\.\*\*/);
    assert.match(prompt, /You do not answer the question/);
    const refused = command[command.indexOf('--disallowedTools') + 1] ?? '';
    assert.deepEqual(refused.split(','), ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    // And it is not a planning conversation: no PRD prompt, no story format.
    assert.equal(prompt.includes('Chief PRD Generator'), false);
  });

  it('refuses to discuss a session with no open question (decisions US-009)', async () => {
    clone();
    updateSession(db, session.id, { status: 'deciding' });

    await assert.rejects(
      planning.start(session.id, { intent: 'decide' }),
      (error: unknown) => error instanceof PlanningError && error.code === 'session_not_deciding',
    );
    // And a session that is merely building has nothing to discuss either.
    updateSession(db, session.id, { status: 'building' });
    await assert.rejects(
      planning.start(session.id, { intent: 'decide' }),
      (error: unknown) => error instanceof PlanningError && error.code === 'session_not_deciding',
    );
    assert.equal(planning.status(session.id).canStart, null);
    assert.deepEqual(terminals.created, []);
  });

  it('starts an interactive claude with chief’s init prompt in the clone', async () => {
    clone();

    const view = await planning.start(session.id, { context: 'A login screen.' });

    assert.deepEqual(started, [session.id]);
    assert.equal(terminals.created.length, 1);
    const [input] = terminals.created;
    assert.equal(input?.container, 'container-1');
    assert.equal(input?.cwd, '/workspace/repo');
    assert.equal(input?.command?.[0], 'claude');
    assert.match(input?.command?.[1] ?? '', /Chief PRD Generator/);
    assert.match(input?.command?.[1] ?? '', /A login screen\./);
    assert.equal(view.mode, 'create');
    assert.equal(view.running, true);
    assert.equal(view.terminalId, 'terminal-1');
  });

  it('plans from the session’s feedback, as the voice agent does', async () => {
    clone();
    updateSession(db, session.id, { feedback: 'The login form forgets my email.' });

    await planning.start(session.id);

    const prompt = terminals.created[0]?.command?.[1] ?? '';
    assert.match(prompt, /<feedback>\nThe login form forgets my email\.\n<\/feedback>/);
    assert.equal(prompt.includes(DEFAULT_CONTEXT), false);
  });

  it('rejects a context longer than the prompt should carry', async () => {
    clone();

    await assert.rejects(
      planning.start(session.id, { context: 'x'.repeat(4001) }),
      (error: unknown) => error instanceof PlanningError && error.code === 'context_too_long',
    );
  });

  it('joins the running terminal instead of starting a second one', async () => {
    clone();
    const first = await planning.start(session.id);
    const second = await planning.start(session.id);

    assert.equal(terminals.created.length, 1);
    assert.equal(second.terminalId, first.terminalId);
  });

  it('resumes an exited conversation with chief’s edit prompt once a PRD exists', async () => {
    clone();
    const first = await planning.start(session.id);
    terminals.exit(first.terminalId ?? '');
    writePrd('# PRD: Login\n\n### US-001: Add the form\n**Status:** todo\n\n- [ ] Ships\n');

    const exited = planning.status(session.id);
    assert.equal(exited.running, false);
    assert.equal(exited.terminalId, first.terminalId);
    assert.equal(exited.nextMode, 'edit');
    assert.equal(exited.prd.exists, true);
    assert.equal(exited.prd.parses, true);
    assert.equal(exited.prd.storyCount, 1);

    const resumed = await planning.start(session.id);

    assert.equal(terminals.created.length, 2);
    assert.equal(resumed.mode, 'edit');
    assert.match(terminals.created[1]?.command?.[1] ?? '', /Chief PRD Editor/);
    // The exited terminal is dropped rather than left in the registry.
    assert.deepEqual(terminals.removed, [first.terminalId]);
  });

  it('reports a PRD that has just become valid to the voice bus, once per change (voice US-015)', () => {
    const seen: VoiceBusEvent[] = [];
    planning = new PlanningService(config, db, terminals, containers, { publish: (event) => seen.push(event) });
    clone();
    writePrd('# PRD: Login\n\nNothing but prose.\n');
    planning.status(session.id);
    planning.status(session.id);
    assert.deepEqual(seen, []);

    writePrd('# PRD: Login\n\n### US-001: Add the form\n**Status:** todo\n\n- [ ] Ships\n');
    const file = path.join(sessionRepoDir(config, session.id), prdPathFor(session.name));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    planning.status(session.id);
    planning.status(session.id);
    assert.deepEqual(seen, [{ kind: 'prd.valid', sessionId: session.id, name: 'add-login', stories: 1 }]);
  });

  it('only takes note of a PRD that was already valid at the first poll', () => {
    const seen: VoiceBusEvent[] = [];
    planning = new PlanningService(config, db, terminals, containers, { publish: (event) => seen.push(event) });
    clone();
    writePrd('# PRD: Login\n\n### US-001: Add the form\n**Status:** todo\n\n- [ ] Ships\n');
    planning.status(session.id);
    assert.deepEqual(seen, []);
  });

  it('shows a PRD that exists but does not parse', () => {
    clone();
    writePrd('# PRD: Login\n\nNothing but prose.\n');

    const view = planning.status(session.id);

    assert.equal(view.prd.exists, true);
    assert.equal(view.prd.parses, false);
    assert.equal(view.prd.errors.length, 1);
    assert.equal(view.nextMode, 'edit');
  });

  it('stops the conversation and forgets the terminal', async () => {
    clone();
    const opened = await planning.start(session.id);

    const view = await planning.stop(session.id);

    assert.deepEqual(terminals.removed, [opened.terminalId]);
    assert.equal(view.terminalId, null);
    assert.equal(view.running, false);
  });

  it('reads the thinking effort each time a terminal opens (thinking effort US-004)', async (t) => {
    clone();
    await planning.start(session.id);
    assert.equal((terminals.created[0]?.command ?? []).includes('--effort'), false);
    await planning.stop(session.id);

    setSetting(db, 'default_effort', 'medium');
    t.after(() => deleteSetting(db, 'default_effort'));
    await planning.start(session.id);
    assert.deepEqual((terminals.created[1]?.command ?? []).slice(0, 3), ['claude', '--effort', 'medium']);
    await planning.stop(session.id);

    updateSession(db, session.id, { effort: 'xhigh' });
    await planning.start(session.id);
    const command = terminals.created[2]?.command ?? [];
    assert.deepEqual(command.slice(0, 3), ['claude', '--effort', 'xhigh']);
    assert.match(command.at(-1) ?? '', /Chief PRD Generator/);
  });

  describe('handover from a voice call (voice US-025)', () => {
    const voiceId = (): string | null => getVoiceSessionAgent(db, session.id)?.claudeSessionId ?? null;

    it('resumes the voice planning conversation and keeps its id when the terminal ends in it', async () => {
      clone();
      upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: 'voice-conv', mode: 'plan' });

      const view = await planning.start(session.id, { context: 'ignored' });

      assert.deepEqual(terminals.created[0]?.command, ['claude', '--resume', 'voice-conv', VOICE_HANDOVER_PROMPT]);
      terminals.exit(view.terminalId ?? '', 0);
      planning.status(session.id);
      assert.equal(voiceId(), 'voice-conv');
      await planning.stop(session.id);
      assert.equal(voiceId(), 'voice-conv');
    });

    it('starts afresh over a Q&A conversation, and drops it when the terminal ends in its own', async () => {
      clone();
      upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: 'qa-conv', mode: 'qa' });

      const view = await planning.start(session.id);

      const command = terminals.created[0]?.command ?? [];
      assert.equal(command.includes('--resume'), false);
      assert.match(command[1] ?? '', /Chief PRD Generator/);
      assert.equal(voiceId(), 'qa-conv');
      terminals.exit(view.terminalId ?? '', 0);
      planning.status(session.id);
      assert.equal(voiceId(), null);
    });

    it('drops the id when the resumed conversation could not be opened', async () => {
      clone();
      upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: 'lost-conv', mode: 'plan' });
      const view = await planning.start(session.id);
      terminals.exit(view.terminalId ?? '', 1);
      planning.status(session.id);
      assert.equal(voiceId(), null);

      await planning.start(session.id);
      assert.equal(terminals.created[1]?.command?.includes('--resume'), false);
    });

    it('drops an id that changed while the terminal was closed by hand', async () => {
      clone();
      await planning.start(session.id);
      upsertVoiceSessionAgent(db, { sessionId: session.id, claudeSessionId: 'later-conv', mode: 'plan' });
      await planning.stop(session.id);
      assert.equal(voiceId(), null);
    });
  });

  it('forgets a terminal the manager no longer has', async () => {
    clone();
    const first = await planning.start(session.id);
    await terminals.remove(first.terminalId ?? '');

    assert.equal(planning.status(session.id).terminalId, null);
  });
});
