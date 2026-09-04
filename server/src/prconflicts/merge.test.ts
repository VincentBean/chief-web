import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNonFastForward, mergeExecSpec, mergeScript, unmergedPaths } from './merge.js';

describe('the git steps of a conflict fix', () => {
  it('passes file names as arguments, never into the script', () => {
    const spec = mergeExecSpec('stage', 'main', ['src/a.ts', '; rm -rf /']);

    assert.deepEqual(spec.cmd, [
      '/bin/sh',
      '-c',
      mergeScript('stage'),
      'sh',
      'src/a.ts',
      '; rm -rf /',
    ]);
    // A branch name goes the same way every other one in this codebase does.
    assert.ok(spec.env?.includes('CHIEF_BASE_BRANCH=main'));
    assert.ok(!mergeScript('stage').includes('main'));
  });

  it('looks for conflict markers only in the files it was given', () => {
    const script = mergeScript('markers');

    assert.match(script, /for file in "\$@"/);
    assert.match(script, /grep -qE/);
    // Nothing recursive, nothing repository-wide: a line of seven equals signs
    // in an unrelated file must not fail a run.
    assert.ok(!script.includes('grep -r'));
  });

  it('never pushes with force', () => {
    assert.ok(!mergeScript('commit').includes('--force'));
    assert.ok(!mergeScript('merge').includes('--force'));
  });

  it('reads the unmerged paths out of a porcelain status', () => {
    const status = ['UU src/one.ts', 'AA src/two.ts', ' M src/three.ts', '?? notes.md'].join('\n');

    assert.deepEqual(unmergedPaths(status), ['src/one.ts', 'src/two.ts']);
    assert.deepEqual(unmergedPaths(' M src/three.ts\n'), []);
    assert.deepEqual(unmergedPaths(''), []);
  });

  it('tells a branch that moved apart from a push that was refused', () => {
    assert.ok(isNonFastForward(' ! [rejected]  chief/x -> chief/x (fetch first)'));
    assert.ok(isNonFastForward(' ! [rejected]  chief/x -> chief/x (non-fast-forward)'));
    // A permission problem is the fix's failure; a moved branch is not.
    assert.ok(!isNonFastForward('ERROR: Permission to acme/demo.git denied to deploy key.'));
    assert.ok(!isNonFastForward(''));
  });
});
