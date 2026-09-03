import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { fetchPullRequestMergeability, GithubApiError } from './github.js';

const TOKEN = 'ghp_test_token';

/** How the stub is told to answer, keyed by `<method> <pathname>`. */
interface Reply {
  readonly status: number;
  /** Sent verbatim when a string, JSON-encoded otherwise. */
  readonly body: unknown;
  readonly raw?: string;
}

/**
 * Against a real HTTP server, like the review-client tests: the point of these
 * helpers is the request they send and the body they parse, and a stubbed
 * `fetch` would exercise neither.
 */
describe('the GitHub client', () => {
  let baseUrl: string;
  let server: http.Server;
  let replies: Record<string, Reply> = {};
  let requests: { method: string; url: string }[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const target = new URL(req.url ?? '/', 'http://localhost');
        requests.push({ method: req.method ?? '', url: req.url ?? '' });

        const reply = replies[`${req.method ?? ''} ${target.pathname}`] ?? {
          status: 404,
          body: { message: 'Not Found' },
        };
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.raw ?? JSON.stringify(reply.body));
      });
    });
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    replies = {};
    requests = [];
  });

  describe('fetching mergeability', () => {
    /** A pull request body, with `mergeable`/`mergeable_state` left to the test. */
    const pull = (fields: Record<string, unknown>): unknown => ({
      number: 61,
      state: 'open',
      head: { ref: 'chief/US-001', sha: 'head-sha', repo: { full_name: 'acme/one' } },
      base: { ref: 'main', sha: 'base-sha' },
      ...fields,
    });

    it('reports a conflicted pull request when GitHub says mergeable: false', async () => {
      replies['GET /repos/acme/one/pulls/61'] = {
        status: 200,
        body: pull({ mergeable: false, mergeable_state: 'dirty' }),
      };

      const result = await fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61);

      assert.equal(result.mergeable, 'conflicted');
      assert.equal(result.mergeableState, 'dirty');
      assert.equal(result.number, 61);
      assert.equal(result.headRef, 'chief/US-001');
      assert.equal(result.headSha, 'head-sha');
      assert.equal(result.baseRef, 'main');
      assert.equal(result.baseSha, 'base-sha');
      // The single-pull-request endpoint, not the listing: only that one
      // computes mergeability at all.
      assert.deepEqual(requests, [{ method: 'GET', url: '/repos/acme/one/pulls/61' }]);
    });

    it('reports a clean pull request when GitHub says mergeable: true', async () => {
      replies['GET /repos/acme/one/pulls/61'] = {
        status: 200,
        body: pull({ mergeable: true, mergeable_state: 'clean' }),
      };

      const result = await fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61);

      assert.equal(result.mergeable, 'clean');
      assert.equal(result.mergeableState, 'clean');
    });

    it('keeps mergeable: null apart from clean — GitHub is still computing', async () => {
      replies['GET /repos/acme/one/pulls/61'] = {
        status: 200,
        body: pull({ mergeable: null, mergeable_state: 'unknown' }),
      };

      const result = await fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61);

      // The distinction the fixer turns on: not clean, not conflicted.
      assert.equal(result.mergeable, 'unknown');
      assert.notEqual(result.mergeable, 'clean');
      assert.equal(result.mergeableState, 'unknown');
      // Still worth returning: a fix run needs these whichever way it lands.
      assert.equal(result.headSha, 'head-sha');
      assert.equal(result.baseSha, 'base-sha');
    });

    it('carries the pull request description, and copes with one that has none', async () => {
      replies['GET /repos/acme/one/pulls/61'] = {
        status: 200,
        body: pull({ mergeable: false, body: 'Why this pull request exists.' }),
      };

      const described = await fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61);

      // It is what a conflict-resolving agent is shown about the intent of the
      // change (US-005).
      assert.equal(described.body, 'Why this pull request exists.');

      replies['GET /repos/acme/one/pulls/61'] = { status: 200, body: pull({ body: null }) };

      const bare = await fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61);

      assert.equal(bare.body, '');
    });

    it('treats a missing mergeable field as unknown rather than clean', async () => {
      replies['GET /repos/acme/one/pulls/61'] = { status: 200, body: pull({}) };

      const result = await fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61);

      assert.equal(result.mergeable, 'unknown');
      assert.equal(result.mergeableState, 'unknown');
    });

    it('rejects a body that is missing the head and base it is supposed to describe', async () => {
      replies['GET /repos/acme/one/pulls/61'] = { status: 200, body: { number: 61, mergeable: false } };

      await assert.rejects(
        () => fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61),
        (error: unknown) => {
          assert.ok(error instanceof GithubApiError);
          assert.equal(error.code, 'github_error');
          assert.match(error.message, /unexpected pull request body/);
          return true;
        },
      );
    });

    it('rejects a body that is not JSON at all', async () => {
      replies['GET /repos/acme/one/pulls/61'] = { status: 200, body: null, raw: '<html>nope</html>' };

      await assert.rejects(
        () => fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61),
        (error: unknown) => error instanceof GithubApiError && error.code === 'github_error',
      );
    });

    it('maps a 404 onto the not-found code', async () => {
      replies['GET /repos/acme/one/pulls/61'] = { status: 404, body: { message: 'Not Found' } };

      await assert.rejects(
        () => fetchPullRequestMergeability(TOKEN, baseUrl, 'acme/one', 61),
        (error: unknown) => error instanceof GithubApiError && error.code === 'github_not_found',
      );
    });
  });
});
