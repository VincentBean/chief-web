import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { loadConfig } from '../config.js';
import {
  closeDatabase,
  type Database,
  deleteSetting,
  getSetting,
  IN_MEMORY,
  openDatabase,
  setSetting,
} from '../db/index.js';
import {
  getBuildModel,
  getCodeReviewDefault,
  getConflictFixEnabled,
  getPlanningModel,
  getPrConflictIntervalMs,
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

describe('code review default setting (US-004)', () => {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'correct horse battery staple' });
  const db: Database = openDatabase(IN_MEMORY);

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    updateAppSettings(db, config, { codeReviewDefault: false });
  });

  it('is off until it is turned on', () => {
    // Nothing stored at all is the state a fresh install starts in.
    assert.equal(getSetting(db, 'code_review_default'), '0');
    assert.equal(getCodeReviewDefault(db), false);
    assert.equal(readAppSettings(db, config).codeReviewDefault, false);
  });

  it('writes the row and reads it back', () => {
    const saved = updateAppSettings(db, config, { codeReviewDefault: true });

    assert.equal(saved.codeReviewDefault, true);
    assert.equal(getCodeReviewDefault(db), true);
    assert.equal(getSetting(db, 'code_review_default'), '1');
  });

  it('leaves the stored value alone when the field is omitted', () => {
    updateAppSettings(db, config, { codeReviewDefault: true });

    assert.equal(
      updateAppSettings(db, config, { maxConcurrentSessions: 4 }).codeReviewDefault,
      true,
    );
  });

  it('reads a hand-edited row that is not "1" as off', () => {
    setSetting(db, 'code_review_default', 'yes');

    assert.equal(getCodeReviewDefault(db), false);
  });
});

describe('merge conflict scan interval and switch (US-004)', () => {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'correct horse battery staple' });
  const db: Database = openDatabase(IN_MEMORY);

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    deleteSetting(db, 'pr_conflict_interval_minutes');
    deleteSetting(db, 'conflict_fix_enabled');
  });

  it('falls back to the thirty-minute default with nothing stored', () => {
    assert.equal(getPrConflictIntervalMs(db, config), 30 * 60_000);
    assert.equal(readAppSettings(db, config).prConflictIntervalMinutes, 30);
  });

  it('prefers a stored override over the environment default', () => {
    const saved = updateAppSettings(db, config, { prConflictIntervalMinutes: 10 });

    assert.equal(saved.prConflictIntervalMinutes, 10);
    assert.equal(getPrConflictIntervalMs(db, config), 10 * 60_000);
    assert.equal(getSetting(db, 'pr_conflict_interval_minutes'), '10');
  });

  it('clamps a hand-edited row to the bounds the route enforces', () => {
    // A row written straight into the database must not be able to poll
    // GitHub every second, nor stall the scan for a month.
    setSetting(db, 'pr_conflict_interval_minutes', '9999');
    assert.equal(getPrConflictIntervalMs(db, config), 1440 * 60_000);

    setSetting(db, 'pr_conflict_interval_minutes', '0');
    assert.equal(getPrConflictIntervalMs(db, config), 30 * 60_000, 'non-positive falls back');

    setSetting(db, 'pr_conflict_interval_minutes', 'not a number');
    assert.equal(getPrConflictIntervalMs(db, config), 30 * 60_000);
  });

  it('is enabled until the operator turns it off', () => {
    assert.equal(getSetting(db, 'conflict_fix_enabled'), null);
    assert.equal(getConflictFixEnabled(db), true);
    assert.equal(readAppSettings(db, config).conflictFixEnabled, true);
  });

  it('stores the disabled state and reads it back', () => {
    const saved = updateAppSettings(db, config, { conflictFixEnabled: false });

    assert.equal(saved.conflictFixEnabled, false);
    assert.equal(getConflictFixEnabled(db), false);
    assert.equal(getSetting(db, 'conflict_fix_enabled'), '0');

    const back = updateAppSettings(db, config, { conflictFixEnabled: true });
    assert.equal(back.conflictFixEnabled, true);
    assert.equal(getSetting(db, 'conflict_fix_enabled'), '1');
  });

  it('leaves both alone when the fields are omitted', () => {
    updateAppSettings(db, config, { prConflictIntervalMinutes: 45, conflictFixEnabled: false });

    const other = updateAppSettings(db, config, { maxConcurrentSessions: 4 });

    assert.equal(other.prConflictIntervalMinutes, 45);
    assert.equal(other.conflictFixEnabled, false);
  });

  it('reads any row that is not "0" as enabled, so only a deliberate off counts', () => {
    setSetting(db, 'conflict_fix_enabled', 'nonsense');

    assert.equal(getConflictFixEnabled(db), true);
  });
});
