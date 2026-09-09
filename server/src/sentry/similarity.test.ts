import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SentryIssue } from '../db/index.js';

import type { SentryIssueDetails, SentryStackFrame } from './client.js';
import {
  candidateSignature,
  DUPLICATE_SCORE_THRESHOLD,
  type IssueSignature,
  issueSignature,
  MAX_DUPLICATE_CANDIDATES,
  MAX_SIGNATURE_FRAMES,
  normalizeFramePath,
  parseSignature,
  rankCandidates,
  scoreSignatures,
  serializeSignature,
  signatureFromIssue,
  titleKey,
} from './similarity.js';

function frame(overrides: Partial<SentryStackFrame> = {}): SentryStackFrame {
  return {
    filename: '/app/src/handlers.ts',
    function: 'handle',
    module: null,
    absPath: null,
    lineNo: 12,
    colNo: 3,
    contextLine: null,
    inApp: true,
    ...overrides,
  };
}

function details(overrides: {
  title?: string;
  culprit?: string | null;
  exceptionType?: string | null;
  frames?: readonly SentryStackFrame[];
}): SentryIssueDetails {
  return {
    issue: {
      id: '4507',
      shortId: 'PROJ-123',
      title: overrides.title ?? 'TypeError: cannot read property x of undefined',
      culprit: overrides.culprit === undefined ? 'app/handlers.ts in handle' : overrides.culprit,
      permalink: 'https://sentry.io/organizations/acme/issues/4507/',
      level: 'error',
      status: 'unresolved',
      count: 3,
      firstSeen: '2026-08-01T10:00:00.000Z',
      lastSeen: '2026-09-04T22:15:00.000Z',
    },
    latestEvent: {
      id: 'abc',
      message: null,
      platform: 'node',
      dateCreated: '2026-09-04T22:15:00.000Z',
      exceptions: [
        {
          type: overrides.exceptionType === undefined ? 'TypeError' : overrides.exceptionType,
          value: 'boom',
          module: null,
          frames: overrides.frames ?? [frame()],
        },
      ],
      tags: [],
      breadcrumbs: [],
    },
  };
}

function issue(overrides: Partial<SentryIssue> = {}): SentryIssue {
  return {
    id: 'issue-1',
    repositoryId: 'repo-1',
    sentryIssueId: '4507',
    shortId: 'PROJ-123',
    title: 'Undefined array key "17"',
    culprit: 'app/handlers.php in handle',
    permalink: 'https://sentry.io/organizations/acme/issues/4507/',
    level: 'error',
    eventCount: 3,
    firstSeen: '2026-08-01T10:00:00.000Z',
    lastSeen: '2026-09-04T22:15:00.000Z',
    status: 'working',
    explanation: null,
    sessionId: null,
    resolvedInSentry: false,
    attempts: 0,
    duplicateOf: null,
    signature: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-09-04T22:15:00.000Z',
    ...overrides,
  };
}

const FULL: IssueSignature = {
  exceptionType: 'TypeError',
  culprit: 'app/handlers.ts in handle',
  titleKey: 'typeerror cannot read property x of undefined',
  frames: ['src/handlers.ts:handle', 'src/render.ts:render'],
};

describe('sentry similarity', () => {
  describe('titleKey', () => {
    it('gives two issues that differ only by a numeric literal the same key', () => {
      assert.equal(titleKey('Undefined array key "17"'), titleKey('Undefined array key "42"'));
      assert.equal(titleKey('Undefined array key "17"'), 'undefined array key ?');
    });

    it('flattens bare numbers, hex and uuid tokens, punctuation and whitespace', () => {
      assert.equal(titleKey('Timeout after 30 seconds'), 'timeout after 0 seconds');
      assert.equal(titleKey('Timeout after 30 seconds'), titleKey('Timeout after 5 seconds'));
      assert.equal(
        titleKey('Order 3f2a9c1b-1111-2222-3333-444455556666 not found'),
        'order ? not found',
      );
      assert.equal(titleKey('Bad pointer 0xdeadbeef!'), 'bad pointer ?');
      assert.equal(titleKey('  Mixed   —   spacing  '), 'mixed spacing');
    });
  });

  describe('normalizeFramePath', () => {
    it('strips every known deploy root so two layouts match', () => {
      assert.equal(normalizeFramePath('/app/src/Handler.php'), 'src/Handler.php');
      assert.equal(normalizeFramePath('/var/www/src/Handler.php'), 'src/Handler.php');
      assert.equal(normalizeFramePath('/usr/src/app/src/Handler.php'), 'src/Handler.php');
      assert.equal(normalizeFramePath('/workspace/src/Handler.php'), 'src/Handler.php');
      assert.equal(normalizeFramePath('src/Handler.php'), 'src/Handler.php');
    });
  });

  describe('issueSignature', () => {
    it('builds the four parts from details chief-web already fetched', () => {
      const signature = issueSignature(
        details({
          title: 'Undefined array key "17"',
          culprit: 'app/Handler.php in handle',
          exceptionType: 'ErrorException',
          frames: [
            frame({ filename: '/app/src/Controller.php', function: 'index' }),
            frame({ filename: '/app/src/Handler.php', function: 'handle' }),
          ],
        }),
      );

      assert.deepEqual(signature, {
        exceptionType: 'ErrorException',
        culprit: 'app/Handler.php in handle',
        titleKey: 'undefined array key ?',
        frames: ['src/Controller.php:index', 'src/Handler.php:handle'],
      });
    });

    it('keeps only in-app frames, at most MAX_SIGNATURE_FRAMES, crashing frame last', () => {
      const frames = [
        frame({ filename: '/app/a.ts', function: 'a' }),
        frame({ filename: '/app/b.ts', function: 'b' }),
        frame({ filename: '/vendor/lib.ts', function: 'lib', inApp: false }),
        frame({ filename: '/app/c.ts', function: 'c' }),
        frame({ filename: '/app/d.ts', function: 'd' }),
        frame({ filename: '/app/e.ts', function: 'e' }),
        frame({ filename: '/app/f.ts', function: 'f' }),
      ];

      const signature = issueSignature(details({ frames }));

      assert.equal(signature.frames.length, MAX_SIGNATURE_FRAMES);
      assert.deepEqual(signature.frames, ['b.ts:b', 'c.ts:c', 'd.ts:d', 'e.ts:e', 'f.ts:f']);
    });

    it('is empty-handed rather than broken when Sentry has no event left', () => {
      const signature = issueSignature({
        ...details({ title: 'Boom 1' }),
        latestEvent: null,
      });

      assert.deepEqual(signature, {
        exceptionType: null,
        culprit: 'app/handlers.ts in handle',
        titleKey: 'boom 0',
        frames: [],
      });
    });
  });

  describe('signatureFromIssue', () => {
    it('degrades a database row to title and culprit alone', () => {
      assert.deepEqual(signatureFromIssue(issue()), {
        exceptionType: null,
        culprit: 'app/handlers.php in handle',
        titleKey: 'undefined array key ?',
        frames: [],
      });
    });
  });

  describe('serializeSignature / parseSignature', () => {
    it('round-trips a signature through the stored JSON', () => {
      assert.deepEqual(parseSignature(serializeSignature(FULL)), FULL);
    });

    it('returns null for absent or malformed JSON rather than throwing', () => {
      assert.equal(parseSignature(null), null);
      assert.equal(parseSignature(undefined), null);
      assert.equal(parseSignature(''), null);
      assert.equal(parseSignature('{'), null);
      assert.equal(parseSignature('"a string"'), null);
      assert.equal(parseSignature('[]'), null);
      assert.equal(parseSignature('{"titleKey":7,"frames":[]}'), null);
      assert.equal(parseSignature('{"titleKey":"x","frames":[1,2]}'), null);
      assert.equal(parseSignature('{"titleKey":"x"}'), null);
    });

    it('reads a signature an older version wrote, filling the parts it lacks', () => {
      assert.deepEqual(parseSignature('{"titleKey":"boom","frames":[]}'), {
        exceptionType: null,
        culprit: null,
        titleKey: 'boom',
        frames: [],
      });
    });
  });

  describe('scoreSignatures', () => {
    it('scores identical signatures 100', () => {
      assert.equal(scoreSignatures(FULL, { ...FULL }), 100);
    });

    it('scores two unrelated issues below the threshold', () => {
      const other: IssueSignature = {
        exceptionType: 'QueryException',
        culprit: 'app/Billing/Invoice.php in totals',
        titleKey: 'sqlstate 0 connection refused',
        frames: ['src/Billing/Invoice.php:totals'],
      };

      assert.ok(scoreSignatures(FULL, other) < DUPLICATE_SCORE_THRESHOLD);
    });

    it('scores two issues differing only by a numeric literal in the title above it', () => {
      const a = issueSignature(details({ title: 'Undefined array key "17"' }));
      const b = issueSignature(details({ title: 'Undefined array key "42"' }));

      assert.equal(scoreSignatures(a, b), 100);
      assert.ok(scoreSignatures(a, b) >= DUPLICATE_SCORE_THRESHOLD);
    });

    it('scores a NULL-signature candidate on title and culprit alone', () => {
      const stored = issueSignature(
        details({ title: 'Undefined array key "17"', culprit: 'app/handlers.php in handle' }),
      );
      const degraded = candidateSignature(issue({ signature: null }));

      assert.deepEqual(degraded, signatureFromIssue(issue()));
      // 25 for the culprit, 10 for the title; the exception type and the frames
      // the row does not have score nothing.
      assert.equal(scoreSignatures(stored, degraded), 35);
      assert.ok(scoreSignatures(stored, degraded) >= DUPLICATE_SCORE_THRESHOLD);
    });

    it('scores two null parts as zero rather than as a match', () => {
      const bare: IssueSignature = {
        exceptionType: null,
        culprit: null,
        titleKey: 'boom',
        frames: [],
      };

      assert.equal(scoreSignatures(bare, { ...bare }), 10);
    });

    it('scales the frame part by how far the two lists overlap', () => {
      const shared: IssueSignature = { ...FULL, frames: ['src/handlers.ts:handle'] };

      // One shared frame out of two distinct ones: 40 + 25 + 25/2 + 10.
      assert.equal(scoreSignatures(FULL, shared), 88);
    });
  });

  describe('rankCandidates', () => {
    it('drops candidates below the threshold and returns the rest highest first', () => {
      const subject = FULL;
      const exact = issue({
        id: 'exact',
        title: 'TypeError: cannot read property x of undefined',
        culprit: 'app/handlers.ts in handle',
        signature: serializeSignature(FULL),
      });
      const partial = issue({
        id: 'partial',
        title: 'TypeError: cannot read property x of undefined',
        culprit: 'app/handlers.ts in handle',
        signature: null,
      });
      const unrelated = issue({
        id: 'unrelated',
        title: 'SQLSTATE[HY000]: connection refused',
        culprit: 'app/Billing/Invoice.php in totals',
        signature: null,
      });

      const ranked = rankCandidates(subject, [unrelated, partial, exact]);

      assert.deepEqual(
        ranked.map((candidate) => candidate.id),
        ['exact', 'partial'],
      );
    });

    it('caps the shortlist at MAX_DUPLICATE_CANDIDATES', () => {
      const candidates = [1, 2, 3, 4, 5].map((n) =>
        issue({
          id: `candidate-${String(n)}`,
          title: 'TypeError: cannot read property x of undefined',
          culprit: 'app/handlers.ts in handle',
          signature: null,
        }),
      );

      const ranked = rankCandidates(FULL, candidates);

      assert.equal(ranked.length, MAX_DUPLICATE_CANDIDATES);
      assert.deepEqual(
        ranked.map((candidate) => candidate.id),
        ['candidate-1', 'candidate-2', 'candidate-3'],
      );
    });

    it('returns nothing when no candidate reaches the threshold', () => {
      const unrelated = issue({
        id: 'unrelated',
        title: 'SQLSTATE[HY000]: connection refused',
        culprit: 'app/Billing/Invoice.php in totals',
      });

      assert.deepEqual(rankCandidates(FULL, [unrelated]), []);
    });

    it('falls back to the degraded signature when the stored one is unreadable', () => {
      const broken = issue({
        id: 'broken',
        title: 'TypeError: cannot read property x of undefined',
        culprit: 'app/handlers.ts in handle',
        signature: 'not json at all',
      });

      assert.deepEqual(
        rankCandidates(FULL, [broken]).map((candidate) => candidate.id),
        ['broken'],
      );
    });
  });
});
