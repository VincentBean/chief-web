import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  abandonDecisions,
  askDecision,
  closeDatabase,
  closeDecision,
  createRepository,
  createSession,
  type Database,
  deleteSession,
  getDecision,
  getOpenDecision,
  IN_MEMORY,
  listDecisions,
  listOpenDecisions,
  MIGRATIONS,
  openDatabase,
  runMigrations,
  type Session,
  updateSession,
} from './index.js';

/** The rebuild that widens the session status CHECK to `deciding`. */
const DECIDING_MIGRATION = '0029_session_deciding_status';

const fresh = (): { db: Database; session: Session } => {
  const db = openDatabase(IN_MEMORY);
  const repositoryId = createRepository(db, {
    name: 'demo',
    sshUrl: 'git@github.com:acme/demo.git',
    githubSlug: 'acme/demo',
  }).id;
  const session = createSession(db, { repositoryId, name: 'refactor', baseBranch: 'main', prTargetBranch: 'main' });
  return { db, session };
};

const QUESTION = 'Keep the old sync API as a deprecated shim?';

describe('decisions (decisions US-001)', () => {
  it('records a question and reads it back as the session’s open one', () => {
    const { db, session } = fresh();
    const id = randomUUID();
    const decision = askDecision(db, {
      id,
      sessionId: session.id,
      storyId: 'US-002',
      iteration: 3,
      question: QUESTION,
      options: ['Keep it', 'Remove it'],
      context: 'Two call sites outside this repo use it.',
      recommendation: 'Keep it.',
    });

    assert.equal(decision.status, 'open');
    assert.equal(decision.answer, null);
    assert.equal(decision.closedAt, null);
    assert.deepEqual(decision.options, ['Keep it', 'Remove it']);
    assert.deepEqual(getOpenDecision(db, session.id), decision);
    assert.deepEqual(listOpenDecisions(db), [decision]);
    closeDatabase(db);
  });

  it('is idempotent on the request id: one tool call is one question', () => {
    const { db, session } = fresh();
    const id = randomUUID();
    const first = askDecision(db, { id, sessionId: session.id, question: QUESTION });
    const again = askDecision(db, { id, sessionId: session.id, question: 'something else entirely' });

    assert.deepEqual(again, first, 'the row that is already there, not a second question');
    assert.equal(listDecisions(db, session.id).length, 1);
    closeDatabase(db);
  });

  it('closes an open question once, and tells the second caller it was too late', () => {
    const { db, session } = fresh();
    const id = randomUUID();
    askDecision(db, { id, sessionId: session.id, question: QUESTION });

    const answered = closeDecision(db, id, 'answered', 'Keep it for one release.');
    assert.equal(answered?.status, 'answered');
    assert.equal(answered?.answer, 'Keep it for one release.');
    assert.notEqual(answered?.closedAt, null);
    assert.equal(getOpenDecision(db, session.id), null);

    // Two operators pressing Answer at once, or an answer that lands just
    // after the agent gave up: the second attempt changes nothing.
    assert.equal(closeDecision(db, id, 'answered', 'Remove it.'), null);
    assert.equal(getDecision(db, id)?.answer, 'Keep it for one release.');
    closeDatabase(db);
  });

  it('abandons every open question of a session and leaves the closed ones alone', () => {
    const { db, session } = fresh();
    const answered = randomUUID();
    const open = randomUUID();
    askDecision(db, { id: answered, sessionId: session.id, question: 'first?' });
    closeDecision(db, answered, 'answered', 'yes');
    askDecision(db, { id: open, sessionId: session.id, question: 'second?' });

    assert.equal(abandonDecisions(db, session.id), 1);
    assert.equal(abandonDecisions(db, session.id), 0, 'nothing open left to abandon');
    assert.equal(getDecision(db, open)?.status, 'abandoned');
    assert.equal(getDecision(db, answered)?.status, 'answered', 'history is not rewritten');
    assert.equal(getDecision(db, answered)?.answer, 'yes');
    closeDatabase(db);
  });

  it('goes with the session it belongs to', () => {
    const { db, session } = fresh();
    askDecision(db, { id: randomUUID(), sessionId: session.id, question: QUESTION });
    deleteSession(db, session.id);
    assert.deepEqual(listDecisions(db, session.id), []);
    closeDatabase(db);
  });

  it('accepts `deciding` as a session status', () => {
    const { db, session } = fresh();
    assert.equal(updateSession(db, session.id, { status: 'deciding' })?.status, 'deciding');
    closeDatabase(db);
  });
});

describe(`${DECIDING_MIGRATION}`, () => {
  /**
   * The rebuild drops and recreates `sessions` while five tables reference it
   * — two that would cascade their rows away (`stories`,
   * `voice_session_agents`) and two that would quietly null their link
   * (`recurring_task_occurrences`, `sentry_issues`) — so what this walks is a
   * database with a row in every one of them, through the migration, and
   * checks that not one of them moved.
   */
  it('widens the status CHECK with every child row intact', () => {
    const db = new DatabaseSync(IN_MEMORY) as Database;
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');

    const index = MIGRATIONS.findIndex((migration) => migration.id === DECIDING_MIGRATION);
    assert.ok(index > 0, `${DECIDING_MIGRATION} is missing`);
    const at = '2026-10-03T00:00:00.000Z';
    for (const migration of MIGRATIONS.slice(0, index)) {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migration.id, at);
    }

    db.exec(`
      INSERT INTO repositories (id, name, ssh_url, github_slug, default_base_branch, created_at, updated_at)
        VALUES ('r1', 'demo', 'git@github.com:acme/demo.git', 'acme/demo', 'main', '${at}', '${at}');
      INSERT INTO sessions
        (id, repository_id, name, status, base_branch, feature_branch, pr_target_branch,
         code_review, open_pull_request, pushed_only, effort, claude_account_id, feedback,
         pr_description, created_at, updated_at)
        VALUES ('s1', 'r1', 'refactor', 'building', 'main', 'chief/refactor', 'main',
                1, 1, 0, 'high', 'acct-1', 'the save button is grey', 'what this does', '${at}', '${at}');
      INSERT INTO stories (session_id, story_id, title, priority, status, commit_sha, created_at, updated_at)
        VALUES ('s1', 'US-001', 'First', 1, 'in-progress', 'abc123', '${at}', '${at}');
      INSERT INTO voice_session_agents (session_id, claude_session_id, mode, updated_at)
        VALUES ('s1', 'claude-1', 'plan', '${at}');
      INSERT INTO recurring_tasks
        (id, repository_id, name, prompt, cron_expression, base_branch, pr_target, created_at, updated_at)
        VALUES ('t1', 'r1', 'nightly', 'check the logs', '0 2 * * *', 'main', 'main', '${at}', '${at}');
      INSERT INTO recurring_task_occurrences
        (recurring_task_id, occurred_at, outcome, session_id, created_at, updated_at)
        VALUES ('t1', '${at}', 'started', 's1', '${at}', '${at}');
      INSERT INTO sentry_issues
        (id, repository_id, sentry_issue_id, short_id, title, culprit, permalink, level, event_count,
         first_seen, last_seen, status, session_id, created_at, updated_at)
        VALUES ('i1', 'r1', '42', 'DEMO-1', 'Boom', 'handler', 'https://sentry.io/i/42', 'error', 3,
                '${at}', '${at}', 'working', 's1', '${at}', '${at}');
    `);

    const snapshot = (): Record<string, unknown[]> => ({
      sessions: db.prepare('SELECT * FROM sessions').all(),
      stories: db.prepare('SELECT * FROM stories').all(),
      voice: db.prepare('SELECT * FROM voice_session_agents').all(),
      occurrences: db.prepare('SELECT * FROM recurring_task_occurrences').all(),
      sentry: db.prepare('SELECT * FROM sentry_issues').all(),
    });
    const before = snapshot();

    assert.ok(runMigrations(db).includes(DECIDING_MIGRATION));

    assert.deepEqual(snapshot(), before, 'the rebuild moved nothing');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    // The point of the rebuild: the new status is accepted, and the CHECK
    // still refuses anything that is not a status.
    db.exec("UPDATE sessions SET status = 'deciding' WHERE id = 's1'");
    assert.throws(() => db.exec("UPDATE sessions SET status = 'nonsense' WHERE id = 's1'"));

    // And the keys the rebuild re-declared still behave: CASCADE cascades,
    // SET NULL nulls.
    db.exec("DELETE FROM sessions WHERE id = 's1'");
    assert.equal(db.prepare('SELECT count(*) AS c FROM stories').get()?.['c'], 0);
    assert.equal(db.prepare('SELECT count(*) AS c FROM voice_session_agents').get()?.['c'], 0);
    assert.equal(db.prepare('SELECT session_id FROM recurring_task_occurrences').get()?.['session_id'], null);
    assert.equal(db.prepare('SELECT session_id FROM sentry_issues').get()?.['session_id'], null);
    assert.equal(db.prepare('SELECT count(*) AS c FROM recurring_task_occurrences').get()?.['c'], 1);

    closeDatabase(db);
  });
});
