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
  getSentryBaseUrl,
  getSentryModel,
  getSentryPollIntervalMinutes,
  getSentryPollIntervalMs,
  getSentryToken,
  isAgentModel,
  isValidSentryBaseUrl,
  isValidSentryPollIntervalMinutes,
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

describe('sentry settings (US-002)', () => {
  const config = loadConfig({ CHIEF_WEB_PASSWORD: 'correct horse battery staple' });
  const db: Database = openDatabase(IN_MEMORY);

  after(() => {
    closeDatabase(db);
  });

  beforeEach(() => {
    deleteSetting(db, 'sentry_token');
    deleteSetting(db, 'sentry_poll_interval_minutes');
    deleteSetting(db, 'sentry_model');
    deleteSetting(db, 'sentry_base_url');
  });

  it('reports no token until one is stored', () => {
    assert.deepEqual(readAppSettings(db, config).sentryToken, { configured: false, last4: null });
    assert.equal(getSentryToken(db), null);
  });

  it('masks a stored token to its last four characters', () => {
    const saved = updateAppSettings(db, config, { sentryToken: 'sntryu_exampleToken9876' });

    assert.deepEqual(saved.sentryToken, { configured: true, last4: '9876' });
    // Only the server ever sees the whole thing.
    assert.equal(getSentryToken(db), 'sntryu_exampleToken9876');
    assert.equal(readAppSettings(db, config).sentryToken.last4, '9876');
  });

  it('leaves the stored token alone when the field is omitted', () => {
    updateAppSettings(db, config, { sentryToken: 'sntryu_keepMe0001' });

    const other = updateAppSettings(db, config, { sentryPollIntervalMinutes: 30 });

    assert.equal(other.sentryToken.configured, true);
    assert.equal(getSentryToken(db), 'sntryu_keepMe0001');
  });

  it('deletes the token on null', () => {
    updateAppSettings(db, config, { sentryToken: 'sntryu_removeMe0002' });

    const cleared = updateAppSettings(db, config, { sentryToken: null });

    assert.deepEqual(cleared.sentryToken, { configured: false, last4: null });
    assert.equal(getSetting(db, 'sentry_token'), null);
  });

  it('is independent of the GitHub token', () => {
    updateAppSettings(db, config, { githubToken: 'ghp_stayPut1111', sentryToken: 'sntryu_2222' });

    const cleared = updateAppSettings(db, config, { sentryToken: null });

    assert.equal(cleared.sentryToken.configured, false);
    assert.equal(cleared.githubToken.last4, '1111');
  });

  it('polls every fifteen minutes until an interval is stored', () => {
    assert.equal(getSentryPollIntervalMinutes(db), 15);
    assert.equal(getSentryPollIntervalMs(db), 15 * 60_000);
    assert.equal(readAppSettings(db, config).sentryPollIntervalMinutes, 15);
  });

  it('stores an interval and reads it back', () => {
    const saved = updateAppSettings(db, config, { sentryPollIntervalMinutes: 5 });

    assert.equal(saved.sentryPollIntervalMinutes, 5);
    assert.equal(getSentryPollIntervalMs(db), 5 * 60_000);
    assert.equal(getSetting(db, 'sentry_poll_interval_minutes'), '5');
  });

  it('rejects an interval below one minute, and clamps a hand-edited row', () => {
    assert.equal(isValidSentryPollIntervalMinutes(0), false);
    assert.equal(isValidSentryPollIntervalMinutes(-5), false);
    assert.equal(isValidSentryPollIntervalMinutes(1.5), false);
    assert.equal(isValidSentryPollIntervalMinutes(1), true);
    assert.equal(isValidSentryPollIntervalMinutes(1441), false);

    setSetting(db, 'sentry_poll_interval_minutes', '0');
    assert.equal(getSentryPollIntervalMinutes(db), 15, 'non-positive falls back to the default');

    setSetting(db, 'sentry_poll_interval_minutes', '9999');
    assert.equal(getSentryPollIntervalMinutes(db), 1440);

    setSetting(db, 'sentry_poll_interval_minutes', 'not a number');
    assert.equal(getSentryPollIntervalMinutes(db), 15);
  });

  it('classifies on haiku until another model is chosen', () => {
    assert.equal(getSentryModel(db), 'haiku');
    assert.equal(readAppSettings(db, config).sentryModel, 'haiku');
  });

  it('stores a chosen model and reads it back', () => {
    const saved = updateAppSettings(db, config, { sentryModel: 'sonnet' });

    assert.equal(saved.sentryModel, 'sonnet');
    assert.equal(getSentryModel(db), 'sonnet');
    assert.equal(getSetting(db, 'sentry_model'), 'sonnet');
  });

  it('reads a hand-edited unknown model as the default rather than passing it through', () => {
    setSetting(db, 'sentry_model', 'gpt-5');

    assert.equal(isAgentModel('gpt-5'), false);
    assert.equal(getSentryModel(db), 'haiku');
    assert.equal(readAppSettings(db, config).sentryModel, 'haiku');
  });

  it('talks to the hosted API until a base URL is stored', () => {
    assert.equal(getSentryBaseUrl(db), 'https://sentry.io/api/0/');
    assert.equal(readAppSettings(db, config).sentryBaseUrl, 'https://sentry.io/api/0/');
  });

  it('stores a self-hosted base URL and reads it back', () => {
    const saved = updateAppSettings(db, config, {
      sentryBaseUrl: 'https://sentry.internal.example/api/0/',
    });

    assert.equal(saved.sentryBaseUrl, 'https://sentry.internal.example/api/0/');
    assert.equal(getSentryBaseUrl(db), 'https://sentry.internal.example/api/0/');
  });

  it('restores the hosted API on null', () => {
    updateAppSettings(db, config, { sentryBaseUrl: 'http://sentry.local:9000/api/0/' });

    const cleared = updateAppSettings(db, config, { sentryBaseUrl: null });

    assert.equal(cleared.sentryBaseUrl, 'https://sentry.io/api/0/');
    assert.equal(getSetting(db, 'sentry_base_url'), null);
  });

  it('accepts only http(s) URLs, so a self-hosted host is fine but a scheme is not', () => {
    assert.equal(isValidSentryBaseUrl('https://sentry.io/api/0/'), true);
    assert.equal(isValidSentryBaseUrl('http://sentry.local:9000/api/0/'), true);
    assert.equal(isValidSentryBaseUrl('ftp://sentry.local/api/0/'), false);
    assert.equal(isValidSentryBaseUrl('file:///etc/passwd'), false);
    assert.equal(isValidSentryBaseUrl('sentry.io/api/0/'), false);
    assert.equal(isValidSentryBaseUrl(''), false);
  });

  it('reads a hand-edited base URL that is not http(s) as the hosted API', () => {
    setSetting(db, 'sentry_base_url', 'javascript:alert(1)');

    assert.equal(getSentryBaseUrl(db), 'https://sentry.io/api/0/');
  });

  it('leaves interval, model and base URL alone when the fields are omitted', () => {
    updateAppSettings(db, config, {
      sentryPollIntervalMinutes: 45,
      sentryModel: 'opus',
      sentryBaseUrl: 'https://sentry.internal.example/api/0/',
    });

    const other = updateAppSettings(db, config, { maxConcurrentSessions: 4 });

    assert.equal(other.sentryPollIntervalMinutes, 45);
    assert.equal(other.sentryModel, 'opus');
    assert.equal(other.sentryBaseUrl, 'https://sentry.internal.example/api/0/');
  });
});
