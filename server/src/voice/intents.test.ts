import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listSessions } from '../db/index.js';
import { resolveName } from './chief/tools.js';
import { chiefWorld } from './chief/__fixtures__/world.js';
import {
  HANGUP,
  matchCallIntent,
  matchConfirmIntent,
  MAX_INTENT_WORDS,
  MUTE,
  normalizeUtterance,
  REPEAT,
  STOP_TALKING,
  TO_CHIEF,
  TO_SESSION_PREFIXES,
  UNMUTE,
} from './intents.js';

describe('focus and control intents (voice US-019)', () => {
  it('matches every to_chief phrase', () => {
    for (const phrase of TO_CHIEF) assert.deepEqual(matchCallIntent(phrase), { kind: 'to_chief' }, phrase);
    for (const text of ['Back to chief.', 'Hey, chief!', 'Terug naar Chief', 'Chief?', 'switch to chief']) {
      assert.deepEqual(matchCallIntent(text), { kind: 'to_chief' }, text);
    }
  });

  it('matches every stop_talking phrase', () => {
    for (const phrase of STOP_TALKING) assert.deepEqual(matchCallIntent(phrase), { kind: 'stop_talking' }, phrase);
    for (const text of ['Stop!', 'Wait.', 'Hold on…', 'Wacht!', 'wacht even.']) {
      assert.deepEqual(matchCallIntent(text), { kind: 'stop_talking' }, text);
    }
  });

  it('matches every hangup phrase', () => {
    for (const phrase of HANGUP) assert.deepEqual(matchCallIntent(phrase), { kind: 'hangup' }, phrase);
    for (const text of ['Hang up.', "That's all!", 'That’s all', 'Ophangen.', 'Dat was het, doei']) {
      const expected = text === 'Dat was het, doei' ? null : { kind: 'hangup' };
      assert.deepEqual(matchCallIntent(text), expected, text);
    }
  });

  it('extracts the session name after every to_session prefix', () => {
    for (const prefix of TO_SESSION_PREFIXES) {
      assert.deepEqual(matchCallIntent(`${prefix} billing export`), { kind: 'to_session', name: 'billing export' }, prefix);
    }
    assert.deepEqual(matchCallIntent('Switch to csv-export-invoices.'), { kind: 'to_session', name: 'csv export invoices' });
    assert.deepEqual(matchCallIntent('Ga naar de billing export!'), { kind: 'to_session', name: 'de billing export' });
    assert.deepEqual(matchCallIntent('Switch over to billing'), { kind: 'to_session', name: 'billing' });
    assert.deepEqual(matchCallIntent('talk to the billing session'), { kind: 'to_session', name: 'the billing session' });
  });

  it('needs a name after the prefix', () => {
    for (const text of ['switch to', 'Ga naar.', 'talk to', 'switch']) assert.equal(matchCallIntent(text), null, text);
  });

  it('hands an extracted name to the shared resolver', () => {
    const w = chiefWorld();
    const sessions = listSessions(w.db);
    const target = sessions.find((session) => session.name.includes('-')) ?? sessions[0];
    assert.ok(target !== undefined);
    const intent = matchCallIntent(`switch to ${target.name}.`);
    assert.equal(intent?.kind, 'to_session');
    const resolution = resolveName(intent.kind === 'to_session' ? intent.name : '', sessions);
    assert.equal(resolution.kind, 'one');
    assert.equal(resolution.kind === 'one' ? resolution.item.id : null, target.id);
  });

  it('only matches utterances of at most eight words', () => {
    const eight = 'switch to one two three four five six';
    assert.equal(eight.split(' ').length, MAX_INTENT_WORDS);
    assert.deepEqual(matchCallIntent(eight), { kind: 'to_session', name: 'one two three four five six' });
    assert.equal(matchCallIntent(`${eight} seven`), null);
    assert.equal(matchCallIntent('stop stop stop stop stop stop stop stop stop'), null);
  });

  it('does not hijack a long sentence that contains stop, wait or chief', () => {
    for (const text of [
      'Can you stop the build of billing export for me please?',
      'I want to stop the recurring task that runs every night',
      'wait until the build of billing export has finished please',
      'ask chief to switch to the billing export session now please',
    ]) {
      assert.equal(matchCallIntent(text), null, text);
    }
    assert.equal(matchCallIntent('stop the build'), null);
    assert.equal(matchCallIntent('chief, what is building?'), null);
    assert.equal(matchCallIntent('hang up the phone after this one'), null);
  });

  it('keeps the confirm phrases separate', () => {
    for (const phrase of [...TO_CHIEF, ...STOP_TALKING, ...HANGUP]) assert.equal(matchConfirmIntent(phrase), null, phrase);
    assert.equal(matchCallIntent('yes'), null);
    assert.equal(matchCallIntent('go'), null);
  });
});

describe('repeat and mute intents (voice US-021)', () => {
  it('matches the repeat, mute and unmute phrases in both languages', () => {
    for (const phrase of REPEAT) assert.deepEqual(matchCallIntent(phrase), { kind: 'repeat' }, phrase);
    for (const phrase of MUTE) assert.deepEqual(matchCallIntent(phrase), { kind: 'mute' }, phrase);
    for (const phrase of UNMUTE) assert.deepEqual(matchCallIntent(phrase), { kind: 'unmute' }, phrase);
    assert.deepEqual(matchCallIntent('Say that again?'), { kind: 'repeat' });
    assert.deepEqual(matchCallIntent('Wat zei je?'), { kind: 'repeat' });
    assert.deepEqual(matchCallIntent('Stil.'), { kind: 'mute' });
    assert.deepEqual(matchCallIntent('Unmute!'), { kind: 'unmute' });
    // Longer sentences are for the agent.
    assert.equal(matchCallIntent('can you repeat the part about the migration'), null);
  });

  it('never lists one phrase under two intents (the later list would silently win)', () => {
    const lists = { TO_CHIEF, STOP_TALKING, HANGUP, REPEAT, MUTE, UNMUTE };
    const seen = new Map<string, string>();
    for (const [list, phrases] of Object.entries(lists)) {
      for (const phrase of phrases) {
        const key = normalizeUtterance(phrase);
        assert.equal(seen.get(key), undefined, `"${phrase}" is in ${seen.get(key) ?? ''} and ${list}`);
        seen.set(key, list);
      }
    }
  });
});
