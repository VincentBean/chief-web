import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { GithubApiError } from '../lib/github.js';
import type { ReviewReport } from './findings.js';
import {
  commentableLines,
  GithubReviewPublisher,
  NOTHING_TO_FLAG,
  OTHER_FINDINGS_HEADING,
  publishReview,
  reviewBody,
} from './publish.js';

const TOKEN = 'ghp_test_token';
const TARGET = { slug: 'acme/widgets', number: 7 };

/** A patch whose new side has lines 10-13; anything else is outside the diff. */
const PATCH = ['@@ -8,3 +10,4 @@ function widget() {', ' const a = 1;', '+const b = 2;', ' const c = 3;', ' }'].join('\n');

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** The body a `POST /reviews` was sent, typed for the assertions. */
interface SentReview {
  readonly body: string;
  readonly event: string;
  readonly comments: readonly { path: string; line: number; side: string; body: string }[];
}

/**
 * The GitHub half, against a real HTTP server — the same stub the review
 * client's own tests use, so the headers, the JSON and the status mapping are
 * exercised rather than mocked away.
 */
describe('posting the review to the pull request', () => {
  let baseUrl: string;
  let server: http.Server;
  /** Answers keyed `<method> <pathname>`; a list is consumed one per call. */
  let replies: Record<string, Reply | Reply[]> = {};
  let requests: Recorded[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const target = new URL(req.url ?? '/', 'http://localhost');
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: raw === '' ? null : (JSON.parse(raw) as unknown),
        });

        const key = `${req.method ?? ''} ${target.pathname}`;
        const planned = replies[key];
        const reply = Array.isArray(planned)
          ? // The last answer repeats, so a test only lists what differs.
            (planned.length > 1 ? planned.shift() : planned[0]) ?? null
          : (planned ?? null);

        const answer = reply ?? { status: 404, body: { message: 'Not Found' } };
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.body));
      });
    });
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    replies = {};
    requests = [];
  });

  const FILES_PATH = '/repos/acme/widgets/pulls/7/files';
  const REVIEWS_PATH = '/repos/acme/widgets/pulls/7/reviews';

  function reviewsSent(): SentReview[] {
    return requests
      .filter((entry) => entry.method === 'POST' && entry.url.startsWith(REVIEWS_PATH))
      .map((entry) => entry.body as SentReview);
  }

  function report(findings: ReviewReport['findings']): ReviewReport {
    return { summary: 'Two small things, both in the new helper.', findings };
  }

  it('posts one comment review with the summary as its body and the findings inline', async () => {
    replies[`GET ${FILES_PATH}`] = {
      status: 200,
      body: [{ filename: 'src/widget.ts', patch: PATCH }],
    };
    replies[`POST ${REVIEWS_PATH}`] = {
      status: 200,
      body: { id: 42, html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-42' },
    };

    const published = await new GithubReviewPublisher({ githubApiUrl: baseUrl }).publish(
      TOKEN,
      TARGET,
      report([
        { path: 'src/widget.ts', line: 11, body: 'This shadows the outer `b`.' },
        { path: 'src/widget.ts', line: 12, body: 'Unused since the rewrite.' },
      ]),
    );

    assert.equal(published.url, 'https://github.com/acme/widgets/pull/7#pullrequestreview-42');
    assert.equal(published.inlineComments, 2);
    assert.equal(published.foldedFindings, 0);

    const sent = reviewsSent();
    assert.equal(sent.length, 1, 'exactly one review is posted');
    assert.equal(sent[0]?.event, 'COMMENT');
    assert.equal(sent[0]?.body, 'Two small things, both in the new helper.');
    assert.deepEqual(sent[0]?.comments, [
      { path: 'src/widget.ts', line: 11, side: 'RIGHT', body: 'This shadows the outer `b`.' },
      { path: 'src/widget.ts', line: 12, side: 'RIGHT', body: 'Unused since the rewrite.' },
    ]);
  });

  it('never names the model that produced it', async () => {
    replies[`GET ${FILES_PATH}`] = {
      status: 200,
      body: [{ filename: 'src/widget.ts', patch: PATCH }],
    };
    replies[`POST ${REVIEWS_PATH}`] = { status: 200, body: { id: 1, html_url: 'https://x/1' } };

    await publishReview(TOKEN, baseUrl, TARGET, {
      summary: 'One thing.',
      findings: [{ path: 'src/widget.ts', line: 11, body: 'Shadowed.' }],
    });

    const sent = reviewsSent()[0];
    const everything = `${sent?.body ?? ''}\n${(sent?.comments ?? []).map((c) => c.body).join('\n')}`;
    assert.doesNotMatch(everything, /claude|opus|sonnet|haiku|model|anthropic/i);
  });

  it('posts every finding — there is no cap on the inline comments', async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      path: 'src/widget.ts',
      line: 10 + (index % 4),
      body: `Finding ${String(index + 1)}.`,
    }));
    replies[`GET ${FILES_PATH}`] = {
      status: 200,
      body: [{ filename: 'src/widget.ts', patch: PATCH }],
    };
    replies[`POST ${REVIEWS_PATH}`] = { status: 200, body: { id: 2, html_url: 'https://x/2' } };

    const published = await publishReview(TOKEN, baseUrl, TARGET, report(many));

    assert.equal(published.inlineComments, 60);
    assert.equal(reviewsSent()[0]?.comments.length, 60);
  });

  it('folds a finding GitHub could not anchor into the body and still posts', async () => {
    replies[`GET ${FILES_PATH}`] = {
      status: 200,
      body: [
        { filename: 'src/widget.ts', patch: PATCH },
        // A binary file: in the pull request, but with nowhere to put a comment.
        { filename: 'assets/logo.png', patch: null },
      ],
    };
    replies[`POST ${REVIEWS_PATH}`] = { status: 200, body: { id: 3, html_url: 'https://x/3' } };

    const published = await publishReview(
      TOKEN,
      baseUrl,
      TARGET,
      report([
        { path: 'src/widget.ts', line: 11, body: 'This shadows the outer `b`.' },
        // Line 99 is in the file but not in the diff.
        { path: 'src/widget.ts', line: 99, body: 'The old branch is unreachable.' },
        // A file the pull request does not touch at all.
        { path: 'src/other.ts', line: 3, body: 'Stale import.' },
        { path: 'assets/logo.png', line: 1, body: 'Committed at 4 MB.' },
      ]),
    );

    assert.equal(published.inlineComments, 1);
    assert.equal(published.foldedFindings, 3);

    const sent = reviewsSent();
    assert.equal(sent.length, 1, 'the rejected anchors do not sink the review');
    assert.equal(sent[0]?.comments.length, 1);
    assert.equal(sent[0]?.comments[0]?.line, 11);

    const body = sent[0]?.body ?? '';
    assert.match(body, /Two small things/);
    assert.match(body, new RegExp(OTHER_FINDINGS_HEADING));
    assert.match(body, /`src\/widget\.ts:99`/);
    assert.match(body, /The old branch is unreachable\./);
    assert.match(body, /`src\/other\.ts:3`/);
    assert.match(body, /`assets\/logo\.png:1`/);
    assert.match(body, /Committed at 4 MB\./);
  });

  it('re-posts everything in the body when GitHub rejects the comments anyway', async () => {
    // The anchors looked good against the diff, and GitHub disagreed — a line
    // that moved under a force-push, say. The review still has to be posted.
    replies[`GET ${FILES_PATH}`] = {
      status: 200,
      body: [{ filename: 'src/widget.ts', patch: PATCH }],
    };
    replies[`POST ${REVIEWS_PATH}`] = [
      {
        status: 422,
        body: {
          message: 'Unprocessable Entity',
          errors: [{ message: 'pull_request_review_thread.line must be part of the diff' }],
        },
      },
      { status: 200, body: { id: 4, html_url: 'https://x/4' } },
    ];

    const published = await publishReview(
      TOKEN,
      baseUrl,
      TARGET,
      report([
        { path: 'src/widget.ts', line: 11, body: 'This shadows the outer `b`.' },
        { path: 'src/widget.ts', line: 12, body: 'Unused since the rewrite.' },
      ]),
    );

    assert.equal(published.url, 'https://x/4');
    assert.equal(published.inlineComments, 0);
    assert.equal(published.foldedFindings, 2);

    const sent = reviewsSent();
    assert.equal(sent.length, 2);
    assert.equal(sent[1]?.event, 'COMMENT');
    assert.equal(sent[1]?.comments.length, 0);
    assert.match(sent[1]?.body ?? '', /This shadows the outer `b`\./);
    assert.match(sent[1]?.body ?? '', /Unused since the rewrite\./);
  });

  it('gives up on a refusal that is not about the anchors', async () => {
    replies[`GET ${FILES_PATH}`] = {
      status: 200,
      body: [{ filename: 'src/widget.ts', patch: PATCH }],
    };
    replies[`POST ${REVIEWS_PATH}`] = { status: 401, body: { message: 'Bad credentials' } };

    const failure = await publishReview(
      TOKEN,
      baseUrl,
      TARGET,
      report([{ path: 'src/widget.ts', line: 11, body: 'Shadowed.' }]),
    ).catch((cause: unknown) => cause);

    assert.ok(failure instanceof GithubApiError);
    assert.equal(failure.code, 'github_unauthorized');
    assert.equal(reviewsSent().length, 1, 'a 401 is not retried');
  });

  it('posts a short comment review when the review found nothing', async () => {
    replies[`POST ${REVIEWS_PATH}`] = { status: 200, body: { id: 5, html_url: 'https://x/5' } };

    const published = await publishReview(TOKEN, baseUrl, TARGET, {
      summary: 'Nothing worth commenting on in this change.',
      findings: [],
    });

    assert.equal(published.inlineComments, 0);
    assert.equal(published.foldedFindings, 0);

    const sent = reviewsSent();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.event, 'COMMENT');
    assert.equal(sent[0]?.comments.length, 0);
    assert.match(sent[0]?.body ?? '', new RegExp(NOTHING_TO_FLAG));
    // Nothing to anchor means nothing to look up: the diff is never fetched.
    assert.equal(requests.filter((entry) => entry.url.startsWith(FILES_PATH)).length, 0);
  });

  it('anchors everything inline when the diff cannot be read', async () => {
    replies[`GET ${FILES_PATH}`] = { status: 500, body: { message: 'Server Error' } };
    replies[`POST ${REVIEWS_PATH}`] = { status: 200, body: { id: 6, html_url: 'https://x/6' } };

    const published = await publishReview(
      TOKEN,
      baseUrl,
      TARGET,
      report([{ path: 'src/widget.ts', line: 11, body: 'Shadowed.' }]),
    );

    assert.equal(published.inlineComments, 1);
    assert.equal(reviewsSent()[0]?.comments.length, 1);
  });
});

describe('the review body', () => {
  it('reads the new-side lines a comment may be anchored to out of a patch', () => {
    const lines = commentableLines(PATCH);
    assert.deepEqual([...lines].sort((a, b) => a - b), [10, 11, 12, 13]);
  });

  it('has no anchors for a file GitHub did not diff', () => {
    assert.equal(commentableLines(null).size, 0);
  });

  it('follows every hunk of a multi-hunk patch', () => {
    const patch = ['@@ -1,2 +1,2 @@', '-old', '+new', ' kept', '@@ -40,2 +50,2 @@', ' context', '+added'].join('\n');
    assert.deepEqual([...commentableLines(patch)].sort((a, b) => a - b), [1, 2, 50, 51]);
  });

  it('is just the summary when every finding was anchored', () => {
    assert.equal(reviewBody('  All good.  ', []), 'All good.');
  });

  it('lists the folded findings under their own heading', () => {
    const body = reviewBody('A summary.', [{ path: 'a/b.ts', line: 4, body: 'Wrong.' }]);
    assert.equal(
      body,
      `A summary.\n\n${OTHER_FINDINGS_HEADING}\n\nThese could not be attached to a line of ` +
        'this pull request\'s diff.\n\n**`a/b.ts:4`**\n\nWrong.',
    );
  });
});
