import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_VOICE_PRONUNCIATIONS } from '../settings/index.js';
import { CODE_ON_SCREEN, SentenceChunker, TABLE_ON_SCREEN, toSpeakable } from './speakable.js';

/** Pushes each delta, flushes, and answers every emitted segment. */
function chunk(deltas: readonly string[], pronunciations = {}): string[] {
  const out: string[] = [];
  const chunker = new SentenceChunker((s) => out.push(s), pronunciations);
  for (const delta of deltas) chunker.push(delta);
  chunker.flush();
  return out;
}

/** Splits a text into deltas of `size` characters, as a model stream would. */
function deltas(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts;
}

describe('toSpeakable', () => {
  describe('rule 1: code fences', () => {
    it('replaces a fenced block with one sentence', () => {
      assert.equal(
        toSpeakable('Here is the fix:\n```ts\nconst a = 1;\nconsole.log(a);\n```\nRun the tests.'),
        `Here is the fix: ${CODE_ON_SCREEN} Run the tests.`,
      );
    });

    it('handles tilde fences and a fence that never closes', () => {
      assert.equal(toSpeakable('~~~\nls -la\n~~~'), CODE_ON_SCREEN);
      assert.equal(toSpeakable('Look:\n```py\nprint(1)'), `Look: ${CODE_ON_SCREEN}`);
    });

    it('does not close a fence on a shorter marker', () => {
      assert.equal(toSpeakable('````md\n```\ninner\n```\n````\nDone.'), `${CODE_ON_SCREEN} Done.`);
    });
  });

  describe('rule 2: inline code and paths', () => {
    it('keeps the content of inline code', () => {
      assert.equal(toSpeakable('Run `npm run check` first.'), 'Run npm run check first.');
    });

    it('shortens a path to the last segment without extension', () => {
      assert.equal(
        toSpeakable('I changed `server/src/sessions/service.ts` today.'),
        'I changed the sessions service today.',
      );
      assert.equal(toSpeakable('See `src/config.ts`.'), 'See config.');
      assert.equal(toSpeakable('Open `prd.md` now.'), 'Open prd now.');
      assert.equal(toSpeakable('The `server/src/voice/` folder.'), 'The voice folder.');
    });

    it('shortens a bare path in prose too', () => {
      assert.equal(
        toSpeakable('Tests live in server/src/voice/speakable.test.ts now.'),
        'Tests live in the voice speakable test now.',
      );
    });

    it('leaves a property access alone', () => {
      assert.equal(toSpeakable('Read `this.buf` first.'), 'Read this.buf first.');
    });
  });

  describe('rule 3: markdown', () => {
    it('strips emphasis, headings, quotes and list markers', () => {
      assert.equal(
        toSpeakable('## Plan\n> **Note** this is __important__\n- first item\n- second item\n1. third\n* [x] done'),
        'Plan. Note this is important. first item. second item. third. done',
      );
    });

    it('drops horizontal rules and strikethrough markers', () => {
      assert.equal(toSpeakable('Above.\n\n---\n\n~~Old~~ new.'), 'Above. Old new.');
    });

    it('replaces a table with one sentence', () => {
      assert.equal(
        toSpeakable('Results:\n| Test | Result |\n|---|---|\n| a | ok |\n| b | failed |\n\nAll good.'),
        `Results: ${TABLE_ON_SCREEN} All good.`,
      );
    });
  });

  describe('rule 4: URLs', () => {
    it('replaces a URL with a link on screen', () => {
      assert.equal(
        toSpeakable('Docs are at https://example.com/docs/voice?x=1. Read them.'),
        'Docs are at a link on screen. Read them.',
      );
      assert.equal(toSpeakable('See <https://example.com>.'), 'See a link on screen.');
    });

    it('keeps the text of a markdown link', () => {
      assert.equal(toSpeakable('Open [the pull request](https://github.com/a/b/pull/1).'), 'Open the pull request.');
    });
  });

  describe('rule 5: symbols and pronunciations', () => {
    it('spells out arrows, ampersands and abbreviations', () => {
      assert.equal(
        toSpeakable('Move draft -> ready & merge, e.g. today, i.e. now.'),
        'Move draft to ready and merge, for example today, that is now.',
      );
    });

    it('applies the pronunciation map to whole words only, case-sensitively', () => {
      const map = { PR: 'P R', PRD: 'P R D' };
      assert.equal(toSpeakable('The PR is open.', map), 'The P R is open.');
      assert.equal(toSpeakable('The PRD is ready.', map), 'The P R D is ready.');
      assert.equal(toSpeakable('Update PRs and prd.md, then print.', { PR: 'P R' }), 'Update PRs and prd.md, then print.');
      assert.equal(toSpeakable('the pr is open', map), 'the pr is open');
      assert.equal(toSpeakable('Edit PR.md or my-PR/x now.', map), 'Edit PR.md or my-PR/x now.');
    });

    it('uses the default map from settings', () => {
      assert.equal(
        toSpeakable('US-012 needs a PR and a PRD.', DEFAULT_VOICE_PRONUNCIATIONS),
        'user story 012 needs a P R and a P R D.',
      );
    });
  });

  describe('rule 6: numbers', () => {
    it('leaves numbers to the TTS engine', () => {
      assert.equal(
        toSpeakable('US-012 took 1.5 hours and 3,000 tokens on 2026-09-25.'),
        'US-012 took 1.5 hours and 3,000 tokens on 2026-09-25.',
      );
    });
  });
});

describe('SentenceChunker', () => {
  it('emits the first chunk on the first pause after 40 characters', () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((s) => out.push(s));
    chunker.push('Yes, sure. I will look at the session builds, ');
    assert.deepEqual(out, ['Yes, sure. I will look at the session builds,']);
  });

  it('treats a spaced em dash as a first pause, but not one inside a word', () => {
    assert.deepEqual(chunk(['Two of the builds are red again today, sadly — the typecheck fails.']), [
      'Two of the builds are red again today, sadly —',
      'the typecheck fails.',
    ]);
    assert.deepEqual(chunk(['Two of the builds are red again today sadly—the typecheck fails.']), [
      'Two of the builds are red again today sadly—the typecheck fails.',
    ]);
  });

  it('then waits for a full sentence of 60 characters', () => {
    const text =
      'Okay, let me check the builds for you right away. ' +
      'Two are running. One failed on the typecheck step, sadly, again. ' +
      'The third one is still queued behind the others and waits.';
    assert.deepEqual(chunk(deltas(text, 7)), [
      'Okay, let me check the builds for you right away.',
      'Two are running. One failed on the typecheck step, sadly, again.',
      'The third one is still queued behind the others and waits.',
    ]);
  });

  it('holds a sentence that ends before the minimum', () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((s) => out.push(s));
    chunker.push('Short one. Another short. ');
    assert.deepEqual(out, []);
    chunker.flush();
    assert.deepEqual(out, ['Short one. Another short.']);
  });

  it('force-emits a runaway sentence at 280 characters, on a space', () => {
    const text = 'word '.repeat(80);
    const out: string[] = [];
    const chunker = new SentenceChunker((s) => out.push(s));
    for (const d of deltas(text, 9)) chunker.push(d);
    assert.equal(out.length, 1);
    assert.ok((out[0] ?? '').length <= 280);
    assert.ok((out[0] ?? '').endsWith('word'));
    chunker.flush();
    assert.equal(out.join(' '), text.trim());
  });

  it('force-emits at 280 characters when there is no space at all', () => {
    const out = chunk(['x'.repeat(300)]);
    assert.deepEqual(out.map((s) => s.length), [280, 20]);
  });

  it('does not split on an abbreviation, a decimal or a file name', () => {
    const text =
      'This change touches the voice pipeline in several places e.g. the chunker and the settings. ' +
      'The response time dropped from 2.5 seconds to 1.5 seconds overall for most calls. ' +
      'I wrote the plan to the file prd.md in the session repository for you.';
    for (const size of [1, 3, 11, 1000]) {
      assert.deepEqual(chunk(deltas(text, size)), [
        'This change touches the voice pipeline in several places for example the chunker and the settings.',
        'The response time dropped from 2.5 seconds to 1.5 seconds overall for most calls.',
        'I wrote the plan to the file prd.md in the session repository for you.',
      ]);
    }
  });

  it('does not split on a dot followed by a lowercase letter or digit after spaces', () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((s) => out.push(s));
    chunker.push('The first sentence is long enough to be spoken right away. ');
    chunker.push('The version number of this release is v. 2 and the other one is v. ');
    chunker.push('3 which comes out soon.');
    assert.equal(out.length, 1);
    chunker.flush();
    assert.equal(out.length, 2);
    assert.ok((out[1] ?? '').includes('v. 2 and the other one is v. 3'));
  });

  it('turns a code fence spanning many deltas into exactly one sentence', () => {
    const text =
      'Here is the new helper you asked for:\n```ts\nexport function add(a: number, b: number): number {\n' +
      '  // Sums two numbers. Really.\n  return a + b;\n}\n```\nShall I commit it?';
    for (const size of [1, 2, 5, 16]) {
      const out = chunk(deltas(text, size));
      assert.deepEqual(out, ['Here is the new helper you asked for:', CODE_ON_SCREEN, 'Shall I commit it?']);
    }
  });

  it('turns a table spanning many deltas into exactly one sentence', () => {
    const text = 'Build status:\n| Build | State |\n| --- | --- |\n| one | green |\n| two | red |\nTwo is red.';
    for (const size of [1, 4, 1000]) {
      assert.deepEqual(chunk(deltas(text, size)), ['Build status:', TABLE_ON_SCREEN, 'Two is red.']);
    }
  });

  it('never mutates its input', () => {
    const text = '**Done.** See `server/src/voice/speakable.ts` and https://example.com for the details, e.g. the tests.';
    const input = deltas(text, 6);
    const copy = [...input];
    chunk(input, { PR: 'P R' });
    assert.deepEqual(input, copy);
    assert.equal(input.join(''), text);
  });

  it('starts over after a flush', () => {
    const out: string[] = [];
    const chunker = new SentenceChunker((s) => out.push(s));
    chunker.push('```\ncode');
    chunker.flush();
    chunker.push('Next turn, and this one is long enough to go out early, right?');
    assert.deepEqual(out, [CODE_ON_SCREEN, 'Next turn, and this one is long enough to go out early,']);
  });
});
