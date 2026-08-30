import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { GithubApiError, githubFetch } from './github.js';
import {
  fetchPullRequestFeedback,
  graphqlUrlFor,
  listOpenPullRequestsAcross,
  nextLink,
  paginate,
  PULL_REQUEST_FEEDBACK_QUERY,
} from './github-review.js';

const TOKEN = 'ghp_test_token';

/** How the stub is told to answer, keyed by `<method> <pathname>`. */
interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Held open this long before answering, for the concurrency assertions. */
  readonly delayMs?: number;
}

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
  readonly headers: http.IncomingHttpHeaders;
}

/**
 * The GitHub half, against a real HTTP server speaking both protocols — the
 * same approach the delivery tests take, so `fetch`, the headers, pagination
 * and the status mapping are all exercised for real rather than stubbed.
 */
describe('the review client', () => {
  let baseUrl: string;
  let server: http.Server;
  let replies: Record<string, Reply> = {};
  let requests: Recorded[] = [];
  /** Peak simultaneous in-flight requests, for the concurrency bound. */
  let inFlight = 0;
  let peakInFlight = 0;

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
          headers: req.headers,
        });

        const reply = replies[`${req.method ?? ''} ${target.pathname}`] ?? {
          status: 404,
          body: { message: 'Not Found' },
        };

        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        const answer = (): void => {
          inFlight -= 1;
          res.writeHead(reply.status, {
            'content-type': 'application/json',
            ...(reply.headers ?? {}),
          });
          res.end(JSON.stringify(reply.body));
        };
        if (reply.delayMs === undefined) answer();
        else setTimeout(answer, reply.delayMs);
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
    inFlight = 0;
    peakInFlight = 0;
  });

  describe('githubFetch', () => {
    it('merges the caller’s headers over the defaults without losing the token', async () => {
      // The regression this exists for: the body used to spread `init` and then
      // assign `headers`, so anything the caller passed was silently dropped —
      // which the GraphQL client, which must send `accept: application/json`,
      // would have hit on its first call.
      replies['GET /thing'] = { status: 200, body: {} };

      await githubFetch(TOKEN, `${baseUrl}/thing`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });

      const sent = requests.at(-1);
      assert.equal(sent?.headers.accept, 'application/json');
      assert.equal(sent?.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(sent?.headers['user-agent'], 'chief-web');
      assert.equal(sent?.headers['x-github-api-version'], '2022-11-28');
    });

    it('keeps the REST media type when the caller asks for nothing', async () => {
      replies['GET /thing'] = { status: 200, body: {} };

      await githubFetch(TOKEN, `${baseUrl}/thing`, { method: 'GET' });

      assert.equal(requests.at(-1)?.headers.accept, 'application/vnd.github+json');
    });
  });

  describe('pagination', () => {
    it('reads the rel="next" link and ignores the others', () => {
      const header =
        '<https://api.github.com/x?page=3>; rel="last", <https://api.github.com/x?page=2>; rel="next"';
      assert.equal(nextLink(header), 'https://api.github.com/x?page=2');
      assert.equal(nextLink('<https://api.github.com/x?page=3>; rel="last"'), null);
      assert.equal(nextLink(null), null);
    });

    it('follows every page and stops when there is no next', async () => {
      replies['GET /items'] = {
        status: 200,
        body: [1, 2],
        headers: { link: `<${baseUrl}/items2>; rel="next"` },
      };
      replies['GET /items2'] = { status: 200, body: [3] };

      const result = await paginate(TOKEN, `${baseUrl}/items`, (body) =>
        Array.isArray(body) ? (body as number[]) : [],
      );

      assert.deepEqual(result.items, [1, 2, 3]);
      assert.equal(result.truncated, false);
    });

    it('refuses a next link that points at another origin', async () => {
      // A redirect must never carry the token off the host it was issued for.
      replies['GET /items'] = {
        status: 200,
        body: [1],
        headers: { link: '<https://evil.example.com/items>; rel="next"' },
      };

      const result = await paginate(TOKEN, `${baseUrl}/items`, (body) =>
        Array.isArray(body) ? (body as number[]) : [],
      );

      assert.deepEqual(result.items, [1]);
      assert.equal(requests.length, 1);
    });

    it('gives up at the page cap and says so', async () => {
      // Every page points at itself, so only the cap can end this.
      replies['GET /loop'] = {
        status: 200,
        body: [1],
        headers: { link: `<${baseUrl}/loop>; rel="next"` },
      };

      const result = await paginate(TOKEN, `${baseUrl}/loop`, (body) =>
        Array.isArray(body) ? (body as number[]) : [],
      );

      assert.equal(result.truncated, true);
      assert.equal(requests.length, 5);
    });
  });

  describe('listing across repositories', () => {
    const pull = (number: number, slug: string) => ({
      number,
      title: `PR ${String(number)}`,
      html_url: `https://github.com/${slug}/pull/${String(number)}`,
      draft: false,
      updated_at: '2026-08-29T10:00:00Z',
      user: { login: 'vincentbean' },
      head: { ref: 'feature/x', sha: 'abc123', repo: { full_name: slug } },
      base: { ref: 'develop' },
    });

    it('keeps one repository’s failure to that repository', async () => {
      replies['GET /repos/acme/one/pulls'] = { status: 200, body: [pull(1, 'acme/one')] };
      replies['GET /repos/acme/two/pulls'] = {
        status: 403,
        body: { message: 'Resource not accessible by personal access token' },
      };
      replies['GET /repos/acme/three/pulls'] = { status: 200, body: [pull(3, 'acme/three')] };

      const groups = await listOpenPullRequestsAcross(TOKEN, baseUrl, [
        'acme/one',
        'acme/two',
        'acme/three',
      ]);

      assert.equal(groups.length, 3);
      assert.equal(groups[0]?.pullRequests.length, 1);
      assert.equal(groups[0]?.error, null);
      assert.equal(groups[1]?.error, 'github_forbidden');
      assert.match(groups[1]?.message ?? '', /not accessible/);
      assert.deepEqual(groups[1]?.pullRequests, []);
      // The one that failed must not cost the ones that did not.
      assert.equal(groups[2]?.pullRequests.length, 1);
    });

    it('answers in the order it was asked, whatever order the replies arrive', async () => {
      replies['GET /repos/acme/slow/pulls'] = {
        status: 200,
        body: [pull(1, 'acme/slow')],
        delayMs: 40,
      };
      replies['GET /repos/acme/fast/pulls'] = { status: 200, body: [pull(2, 'acme/fast')] };

      const groups = await listOpenPullRequestsAcross(TOKEN, baseUrl, ['acme/slow', 'acme/fast']);

      assert.equal(groups[0]?.slug, 'acme/slow');
      assert.equal(groups[1]?.slug, 'acme/fast');
    });

    it('never has more than LIST_CONCURRENCY requests in flight', async () => {
      const slugs = Array.from({ length: 9 }, (_, index) => `acme/repo${String(index)}`);
      for (const slug of slugs) {
        replies[`GET /repos/${slug}/pulls`] = { status: 200, body: [], delayMs: 15 };
      }

      await listOpenPullRequestsAcross(TOKEN, baseUrl, slugs);

      assert.equal(requests.length, 9);
      assert.ok(peakInFlight <= 4, `peak was ${String(peakInFlight)}`);
    });

    it('marks a pull request whose head is on another repository as a fork', async () => {
      replies['GET /repos/acme/one/pulls'] = {
        status: 200,
        body: [
          { ...pull(1, 'acme/one'), head: { ref: 'x', sha: 's', repo: { full_name: 'someone/one' } } },
          { ...pull(2, 'acme/one'), head: { ref: 'y', sha: 's', repo: null } },
        ],
      };

      const groups = await listOpenPullRequestsAcross(TOKEN, baseUrl, ['acme/one']);

      // A different owner, and a deleted fork, are both unpushable.
      assert.equal(groups[0]?.pullRequests[0]?.fromFork, true);
      assert.equal(groups[0]?.pullRequests[1]?.fromFork, true);
    });
  });

  describe('fetching feedback', () => {
    const feedbackBody = {
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            title: 'booking-proposal-fields',
            url: 'https://github.com/acme/one/pull/61',
            isCrossRepository: false,
            headRefName: 'chief/booking-proposal-fields',
            headRefOid: 'deadbeef',
            baseRefName: 'develop',
            headRepository: { nameWithOwner: 'acme/one' },
            reviewThreads: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'PRRT_kw1',
                  isResolved: false,
                  isOutdated: false,
                  viewerCanReply: true,
                  viewerCanResolve: true,
                  path: 'packages/leo/src/Livewire/BookingProposalReview.php',
                  line: 650,
                  originalLine: 640,
                  comments: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        databaseId: 99001,
                        body: 'The save path re-validates headerData…',
                        url: 'https://github.com/acme/one/pull/61#discussion_r99001',
                        author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' },
                      },
                    ],
                  },
                },
                {
                  id: 'PRRT_kw2',
                  isResolved: true,
                  isOutdated: true,
                  viewerCanReply: true,
                  viewerCanResolve: false,
                  path: 'a.php',
                  line: null,
                  originalLine: 12,
                  comments: { pageInfo: { hasNextPage: false }, nodes: [] },
                },
              ],
            },
            reviews: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  id: 'PRR_kw1',
                  state: 'COMMENTED',
                  body: '## Pull request overview',
                  url: 'https://github.com/acme/one/pull/61#pullrequestreview-1',
                  submittedAt: '2026-08-29T10:00:00Z',
                  author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' },
                },
                // A bare approval with no body: nothing to act on.
                { id: 'PRR_kw2', state: 'APPROVED', body: '', author: { login: 'a', __typename: 'User' } },
              ],
            },
          },
        },
      },
    };

    it('maps threads, keeping what reply and resolve depend on', async () => {
      replies['POST /graphql'] = { status: 200, body: feedbackBody };

      const feedback = await fetchPullRequestFeedback(TOKEN, `${baseUrl}/graphql`, 'acme/one', 61);

      assert.equal(feedback.headSha, 'deadbeef');
      assert.equal(feedback.fromFork, false);
      assert.equal(feedback.threads.length, 2);

      const first = feedback.threads[0];
      assert.equal(first?.id, 'PRRT_kw1');
      assert.equal(first?.isResolved, false);
      assert.equal(first?.viewerCanResolve, true);
      assert.equal(first?.line, 650);
      // The reply endpoint addresses comments by REST id, never by node id.
      assert.equal(first?.comments[0]?.databaseId, 99001);
      // Recorded, never filtered on — these are the threads worth acting on.
      assert.equal(first?.comments[0]?.authorType, 'Bot');

      // An outdated thread reports no `line`; the original is the fallback.
      assert.equal(feedback.threads[1]?.line, 12);
      assert.equal(feedback.threads[1]?.isResolved, true);
    });

    it('keeps review bodies and drops bodiless approvals', async () => {
      replies['POST /graphql'] = { status: 200, body: feedbackBody };

      const feedback = await fetchPullRequestFeedback(TOKEN, `${baseUrl}/graphql`, 'acme/one', 61);

      assert.equal(feedback.reviews.length, 1);
      assert.equal(feedback.reviews[0]?.id, 'PRR_kw1');
    });

    it('asks for the fields the write half cannot work without', () => {
      // Easy to drop while editing, and the result is a feature that silently
      // stops being able to reply or resolve.
      assert.match(PULL_REQUEST_FEEDBACK_QUERY, /databaseId/);
      assert.match(PULL_REQUEST_FEEDBACK_QUERY, /viewerCanReply/);
      assert.match(PULL_REQUEST_FEEDBACK_QUERY, /viewerCanResolve/);
      assert.match(PULL_REQUEST_FEEDBACK_QUERY, /isResolved/);
    });

    it('reports truncation when a page was left unread', async () => {
      replies['POST /graphql'] = {
        status: 200,
        body: {
          data: {
            repository: {
              pullRequest: {
                ...feedbackBody.data.repository.pullRequest,
                reviewThreads: {
                  pageInfo: { hasNextPage: true },
                  nodes: [],
                },
              },
            },
          },
        },
      };

      const feedback = await fetchPullRequestFeedback(TOKEN, `${baseUrl}/graphql`, 'acme/one', 61);

      assert.equal(feedback.truncated, true);
    });
  });

  describe('GraphQL error mapping', () => {
    const errorFor = async (type: string): Promise<GithubApiError> => {
      replies['POST /graphql'] = {
        status: 200,
        body: { data: null, errors: [{ type, message: 'nope' }] },
      };
      try {
        await fetchPullRequestFeedback(TOKEN, `${baseUrl}/graphql`, 'acme/one', 61);
      } catch (cause) {
        assert.ok(cause instanceof GithubApiError);
        return cause;
      }
      throw new Error('expected a failure');
    };

    it('treats a 200 carrying errors as the failure it is', async () => {
      // The trap this exists for: GraphQL answers 200 where REST answers 403,
      // so `response.ok` alone would report a permission failure as success.
      assert.equal((await errorFor('FORBIDDEN')).code, 'github_forbidden');
      assert.equal((await errorFor('NOT_FOUND')).code, 'github_not_found');
      assert.equal((await errorFor('RATE_LIMITED')).code, 'github_forbidden');
      assert.equal((await errorFor('SOMETHING_ELSE')).code, 'github_error');
    });
  });

  describe('the GraphQL endpoint', () => {
    it('appends /graphql, and rewrites an Enterprise /api/v3 base', () => {
      assert.equal(graphqlUrlFor('https://api.github.com'), 'https://api.github.com/graphql');
      assert.equal(graphqlUrlFor('https://api.github.com/'), 'https://api.github.com/graphql');
      // The one case appending would get wrong.
      assert.equal(graphqlUrlFor('https://ghe.example.com/api/v3'), 'https://ghe.example.com/api/graphql');
    });
  });
});
