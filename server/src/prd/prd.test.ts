import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parsePrd, prdPathFor, readPrdStatus, setStoryStatus, setStoryStatuses } from './index.js';

const VALID_PRD = `# PRD: Login

## Introduction

Adds a login screen.

## User Stories

### US-001: Add the form
**Status:** todo
**Priority:** 1
**Description:** As a user, I want a login form so that I can sign in.

**Acceptance Criteria:**
- [ ] The form has an email and a password field
- [x] Typecheck passes

### US-002: Rate limit it
**Status:** done
**Priority:** 2
**Description:** As an operator, I want brute force to be slow.

**Acceptance Criteria:**
- [x] Five attempts per minute

## Functional Requirements

- FR-1: The system must authenticate with email and password.
`;

describe('prd parser', () => {
  it('parses a valid PRD in chief format', () => {
    const parsed = parsePrd(VALID_PRD);

    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.project, 'Login');
    assert.equal(parsed.description, 'Adds a login screen.');
    assert.equal(parsed.stories.length, 2);

    const [first, second] = parsed.stories;
    assert.equal(first?.id, 'US-001');
    assert.equal(first?.title, 'Add the form');
    assert.equal(first?.status, 'todo');
    assert.equal(first?.priority, 1);
    assert.equal(first?.description, 'As a user, I want a login form so that I can sign in.');
    assert.equal(second?.status, 'done');
    assert.equal(second?.priority, 2);
  });

  it('records mixed checkbox states', () => {
    const [first] = parsePrd(VALID_PRD).stories;

    assert.deepEqual(
      first?.acceptanceCriteria.map((criterion) => criterion.done),
      [false, true],
    );
    assert.equal(first?.acceptanceCriteria[0]?.text, 'The form has an email and a password field');
  });

  it('defaults a missing status to todo and numbers unpriorit(is)ed stories in file order', () => {
    const parsed = parsePrd(
      `### US-001: First\n**Description:** One.\n\n- [ ] Ships\n\n### US-002: Second\n- [ ] Ships\n`,
    );

    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(
      parsed.stories.map((story) => [story.id, story.status, story.priority]),
      [
        ['US-001', 'todo', 1],
        ['US-002', 'todo', 2],
      ],
    );
  });

  it('reports a PRD with no stories', () => {
    const parsed = parsePrd('# PRD: Empty\n\nNothing here yet.\n');

    assert.equal(parsed.stories.length, 0);
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0]?.line, 0);
    assert.match(parsed.errors[0]?.message ?? '', /No user stories/);
  });

  it('reports a malformed status line with its line number, keeping the story', () => {
    const parsed = parsePrd(
      `### US-001: First\n**Status:** almost done\n**Priority:** 1\n\n- [ ] Ships\n`,
    );

    assert.equal(parsed.stories.length, 1);
    assert.equal(parsed.stories[0]?.status, 'todo');
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0]?.line, 2);
    assert.match(parsed.errors[0]?.message ?? '', /unknown status "almost done"/);
  });

  it('reports an invalid priority and a story without acceptance criteria', () => {
    const parsed = parsePrd(`### US-001: First\n**Priority:** soon\n**Description:** One.\n`);

    assert.equal(parsed.errors.length, 2);
    assert.match(parsed.errors[0]?.message ?? '', /invalid priority "soon"/);
    assert.match(parsed.errors[1]?.message ?? '', /no acceptance criteria/);
  });

  it('reports a duplicated story id', () => {
    const parsed = parsePrd(
      `### US-001: First\n- [ ] Ships\n\n### US-001: Again\n- [ ] Ships\n`,
    );

    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0]?.message ?? '', /US-001 is defined twice/);
  });

  it('takes prose before an explicit description as the description', () => {
    const parsed = parsePrd(`### US-001: First\nSome prose.\n\n- [ ] Ships\n`);

    assert.equal(parsed.stories[0]?.description, 'Some prose.');
  });

  it('ends a story block at the next section heading', () => {
    const parsed = parsePrd(
      `### US-001: First\n- [ ] Ships\n\n## Functional Requirements\n\n- [ ] Not a criterion\n`,
    );

    assert.equal(parsed.stories.length, 1);
    assert.equal(parsed.stories[0]?.acceptanceCriteria.length, 1);
  });
});

describe('prd status writer', () => {
  it('rewrites one status line and disturbs nothing else', () => {
    const { content, changed, missing } = setStoryStatus(VALID_PRD, 'US-001', 'done');

    assert.equal(changed, true);
    assert.deepEqual(missing, []);
    assert.equal(content.replace('**Status:** done', '**Status:** todo'), VALID_PRD);
  });

  it('round-trips: reparsing sees the new status and nothing else moved', () => {
    const before = parsePrd(VALID_PRD);
    const after = parsePrd(setStoryStatus(VALID_PRD, 'US-001', 'in-progress').content);

    assert.deepEqual(after.errors, []);
    assert.equal(after.stories[0]?.status, 'in-progress');
    assert.deepEqual(
      after.stories.map((story) => ({ ...story, status: 'todo' as const })),
      before.stories.map((story) => ({ ...story, status: 'todo' as const })),
    );
  });

  it('inserts a status line under the heading when the story has none', () => {
    const source = `### US-001: First\n**Priority:** 1\n\n- [ ] Ships\n`;

    const { content } = setStoryStatus(source, 'US-001', 'done');

    assert.equal(content, `### US-001: First\n**Status:** done\n**Priority:** 1\n\n- [ ] Ships\n`);
    assert.equal(parsePrd(content).stories[0]?.status, 'done');
  });

  it('writes several stories at once and reports ids the file does not have', () => {
    const { content, missing } = setStoryStatuses(VALID_PRD, [
      { storyId: 'US-001', status: 'done' },
      { storyId: 'US-002', status: 'todo' },
      { storyId: 'US-404', status: 'done' },
    ]);

    assert.deepEqual(
      parsePrd(content).stories.map((story) => [story.id, story.status]),
      [
        ['US-001', 'done'],
        ['US-002', 'todo'],
      ],
    );
    assert.deepEqual(missing, ['US-404']);
  });

  it('leaves the file byte-for-byte alone when the status already matches', () => {
    const result = setStoryStatus(VALID_PRD, 'US-001', 'todo');

    assert.equal(result.changed, false);
    assert.equal(result.content, VALID_PRD);
  });

  it('never touches a status line outside the story it was asked about', () => {
    const { content } = setStoryStatus(VALID_PRD, 'US-002', 'in-progress');
    const [first, second] = parsePrd(content).stories;

    assert.equal(first?.status, 'todo');
    assert.equal(second?.status, 'in-progress');
  });

  it('keeps CRLF line endings', () => {
    const source = `### US-001: First\r\n**Status:** todo\r\n\r\n- [ ] Ships\r\n`;

    const { content } = setStoryStatus(source, 'US-001', 'done');

    assert.equal(content, `### US-001: First\r\n**Status:** done\r\n\r\n- [ ] Ships\r\n`);
  });
});

describe('prd location', () => {
  it('names chief\u2019s PRD path', () => {
    assert.equal(prdPathFor('add-login'), '.chief/prds/add-login/prd.md');
  });
});

describe('prd file status', () => {
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-web-prd-'));
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing file without throwing', () => {
    const status = readPrdStatus(path.join(dir, 'missing.md'), '.chief/prds/demo/prd.md');

    assert.equal(status.exists, false);
    assert.equal(status.parses, false);
    assert.equal(status.storyCount, 0);
    assert.equal(status.updatedAt, null);
    assert.equal(status.path, '.chief/prds/demo/prd.md');
  });

  it('reports a valid file as parsing, with its story count', () => {
    const file = path.join(dir, 'prd.md');
    fs.writeFileSync(file, VALID_PRD);

    const status = readPrdStatus(file, '.chief/prds/demo/prd.md');

    assert.equal(status.exists, true);
    assert.equal(status.parses, true);
    assert.equal(status.storyCount, 2);
    assert.equal(status.bytes > 0, true);
    assert.notEqual(status.updatedAt, null);
  });

  it('reports a file that exists but does not parse', () => {
    const file = path.join(dir, 'broken.md');
    fs.writeFileSync(file, '# PRD: Broken\n\nNo stories at all.\n');

    const status = readPrdStatus(file, '.chief/prds/demo/prd.md');

    assert.equal(status.exists, true);
    assert.equal(status.parses, false);
    assert.equal(status.errors.length, 1);
  });
});
