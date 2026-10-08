import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeRemote } from './remote.js';

describe('normalizeRemote', () => {
  for (const url of [
    'git@github.com:Owner/Repo.git',
    'ssh://git@github.com/Owner/Repo.git',
    'ssh://git@github.com:22/Owner/Repo',
    'https://github.com/Owner/Repo.git',
    'https://user:pass@github.com/Owner/Repo/',
  ]) {
    it(`normalizes ${url}`, () => {
      assert.equal(normalizeRemote(url), 'github.com/owner/repo');
    });
  }

  it('keeps the host and nested groups of a non-GitHub remote', () => {
    assert.equal(normalizeRemote('git@GitLab.example.com:Group/Sub/Project.git'), 'gitlab.example.com/group/sub/project');
  });

  for (const url of [
    '',
    '   ',
    'not a remote',
    'Owner/Repo',
    '/srv/git/repo.git',
    'file:///srv/git/owner/repo.git',
    'git@github.com:Repo.git',
    'https://github.com/',
    'https://github.com/Repo',
    'https://',
  ]) {
    it(`returns null for ${JSON.stringify(url)}`, () => {
      assert.equal(normalizeRemote(url), null);
    });
  }
});
