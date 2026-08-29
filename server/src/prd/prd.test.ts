import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { parsePrd, readPrdStatus } from './index.js';

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
