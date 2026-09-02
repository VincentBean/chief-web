import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import {
  closeDatabase,
  type Database,
  getSetting,
  IN_MEMORY,
  openDatabase,
  setSetting,
} from '../db/index.js';
import {
  getBuildModel,
  getPlanningModel,
  getReviewModel,
  readAppSettings,
  updateAppSettings,
} from './index.js';

describe('review model setting (US-001)', () => {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'correct horse battery staple' });
  const db: Database = openDatabase(IN_MEMORY);

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    updateAppSettings(db, config, { planningModel: null, buildModel: null, reviewModel: null });
  });

  it('reads as null until one is stored', () => {
    assert.equal(getReviewModel(db), null);
    assert.equal(readAppSettings(db, config).reviewModel, null);
  });

  it('writes the row and reads it back', () => {
    const saved = updateAppSettings(db, config, { reviewModel: 'haiku' });

    assert.equal(saved.reviewModel, 'haiku');
    assert.equal(getReviewModel(db), 'haiku');
    assert.equal(getSetting(db, 'review_model'), 'haiku');
  });

  it('clears the row on null, which is how "let the CLI choose" is stored', () => {
    updateAppSettings(db, config, { reviewModel: 'opus' });

    const cleared = updateAppSettings(db, config, { reviewModel: null });

    assert.equal(cleared.reviewModel, null);
    assert.equal(getSetting(db, 'review_model'), null);
  });

  it('leaves the stored value alone when the field is omitted', () => {
    updateAppSettings(db, config, { reviewModel: 'sonnet' });

    assert.equal(updateAppSettings(db, config, { maxConcurrentSessions: 4 }).reviewModel, 'sonnet');
  });

  it('reads a hand-edited unknown model name as null rather than passing it through', () => {
    setSetting(db, 'review_model', 'gpt-5');

    assert.equal(getReviewModel(db), null);
    assert.equal(readAppSettings(db, config).reviewModel, null);
  });

  it('is independent of the planning and build models', () => {
    updateAppSettings(db, config, {
      planningModel: 'opus',
      buildModel: 'sonnet',
      reviewModel: 'haiku',
    });

    updateAppSettings(db, config, { reviewModel: null });

    assert.equal(getPlanningModel(db), 'opus');
    assert.equal(getBuildModel(db), 'sonnet');
    assert.equal(getReviewModel(db), null);
  });
});
