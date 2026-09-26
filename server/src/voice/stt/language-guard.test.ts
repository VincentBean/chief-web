import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inOtherLanguage } from './language-guard.js';

describe('inOtherLanguage', () => {
  const nlEn = ['nl', 'en'];

  it('keeps Dutch and English, loanwords and accents included', () => {
    for (const text of [
      'Dus maak daar voorscheen van met het gesprek. En ik wil ook dat hij dan op dat scherm de relevante informatie kan tonen.',
      'Welke sessies staan er open?',
      'Hello? Hey, what do you do?',
      'Maak één café-ideeën lijst, naïve of niet.',
      'Start een sessie voor de PR van Kristján',
      'no',
      '',
    ]) {
      assert.equal(inOtherLanguage(text, nlEn), false, text);
    }
  });

  it('flags letters and marks neither language writes', () => {
    assert.equal(inOtherLanguage('Men við dyrir að Kristján hefur...', nlEn), true);
    assert.equal(inOtherLanguage('¿Que no los hagan baúas?', nlEn), true);
    assert.equal(inOtherLanguage('Привет, как дела?', nlEn), true);
  });

  it('flags more common words of another language than of the operator’s', () => {
    assert.equal(inOtherLanguage('Que no los hagan', nlEn), true);
    assert.equal(inOtherLanguage('Ek sal nie gaan nie', nlEn), true);
    assert.equal(inOtherLanguage('Das ist nicht gut', nlEn), true);
  });

  it('judges against the languages given', () => {
    assert.equal(inOtherLanguage('Das ist nicht gut', ['de', 'en']), false);
    assert.equal(inOtherLanguage('¿Qué pasa?', ['es', 'en']), false);
  });

  it('trusts the model for a language it has no letters for', () => {
    assert.equal(inOtherLanguage('Привет, как дела?', ['ru', 'en']), false);
  });
});
