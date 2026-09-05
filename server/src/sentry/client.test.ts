import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import {
  closeDatabase,
  type Database,
  deleteSetting,
  IN_MEMORY,
  openDatabase,
  setSetting,
} from '../db/index.js';

import {
  createSentryClient,
  nextPageUrl,
  SentryApiError,
  SentryClient,
  type SentryIssueSummary,
} from './client.js';

const BASE_URL = 'https://sentry.example.com/api/0/';
const TOKEN = 'sntrys_test_token';

/** One recorded call, so a test can assert on the request as well as the answer. */
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

/** How the stubbed `fetch` answers, keyed by `<method> <origin><pathname>`. */
interface Reply {
  readonly status?: number;
  /** JSON-encoded unless `raw` is given. */
  readonly body?: unknown;
  readonly raw?: string;
  readonly headers?: Record<string, string>;
  /** Thrown instead of answering — a DNS failure, a reset, a timeout. */
  readonly throws?: Error;
}

let calls: Call[] = [];
let replies: Record<string, Reply> = {};
const realFetch = globalThis.fetch;

/**
 * A stubbed `fetch`, the way US-004 asks for: the client's whole surface is the
 * request it builds and the body it parses, and both are visible here without
 * a server in the way.
 */
function stubFetch(): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === 'string' ? init.body : null,
    });

    const target = new URL(url);
    // An exact-URL key wins over the path key, so a paginated test can answer
    // the cursor request differently from the first page.
    const reply =
      replies[`${method} ${url}`] ?? replies[`${method} ${target.origin}${target.pathname}`];
    if (reply === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ detail: 'The requested resource does not exist' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    if (reply.throws !== undefined) return Promise.reject(reply.throws);

    return Promise.resolve(
      new Response(reply.raw ?? JSON.stringify(reply.body ?? null), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
      }),
    );
  }) as typeof fetch;
}

/** A list entry as Sentry sends it, `count` as a string included. */
function issue(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '4507',
    shortId: 'PROJ-123',
    title: 'TypeError: cannot read property x of undefined',
    culprit: 'app/handlers.ts in handle',
    permalink: 'https://sentry.example.com/organizations/acme/issues/4507/',
    level: 'error',
    status: 'unresolved',
    count: '1043',
    firstSeen: '2026-08-01T10:00:00.000Z',
    lastSeen: '2026-09-04T22:15:00.000Z',
    ...fields,
  };
}

describe('the Sentry client', () => {
  let client: SentryClient;

  beforeEach(() => {
    calls = [];
    replies = {};
    stubFetch();
    client = new SentryClient(TOKEN, BASE_URL);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe('listing unresolved issues', () => {
    it('returns the issues of the only page, with the bearer token', async () => {
      replies['GET https://sentry.example.com/api/0/projects/acme/web/issues/'] = {
        body: [issue(), issue({ id: '4508', shortId: 'PROJ-124', culprit: null, level: null })],
      };

      const issues = await client.listUnresolvedIssues('acme', 'web');

      assert.equal(issues.length, 2);
      assert.deepEqual(issues[0], {
        id: '4507',
        shortId: 'PROJ-123',
        title: 'TypeError: cannot read property x of undefined',
        culprit: 'app/handlers.ts in handle',
        permalink: 'https://sentry.example.com/organizations/acme/issues/4507/',
        level: 'error',
        status: 'unresolved',
        count: 1043,
        firstSeen: '2026-08-01T10:00:00.000Z',
        lastSeen: '2026-09-04T22:15:00.000Z',
      } satisfies SentryIssueSummary);
      // The nullable columns stay null rather than disqualifying the row.
      assert.equal(issues[1]?.culprit, null);
      assert.equal(issues[1]?.level, null);

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, 'GET');
      assert.equal(calls[0]?.headers['authorization'], `Bearer ${TOKEN}`);
      // Only unresolved issues are asked for; resolved and ignored never arrive.
      assert.equal(new URL(calls[0]?.url ?? '').searchParams.get('query'), 'is:unresolved');
    });

    it('follows the Link header until Sentry says there are no more results', async () => {
      const next = 'https://sentry.example.com/api/0/projects/acme/web/issues/?cursor=0:100:0';
      replies['GET https://sentry.example.com/api/0/projects/acme/web/issues/'] = {
        body: [issue()],
        headers: {
          link: `<https://sentry.example.com/api/0/projects/acme/web/issues/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <${next}>; rel="next"; results="true"; cursor="0:100:0"`,
        },
      };
      replies[`GET ${next}`] = {
        body: [issue({ id: '4600', shortId: 'PROJ-200' })],
        headers: { link: `<${next}>; rel="next"; results="false"; cursor="0:200:0"` },
      };

      const issues = await client.listUnresolvedIssues('acme', 'web');

      assert.deepEqual(
        issues.map((entry) => entry.id),
        ['4507', '4600'],
      );
      assert.equal(calls.length, 2);
      // The cursor URL is followed verbatim, not rebuilt.
      assert.equal(calls[1]?.url, next);
    });

    it('stops after one page when the next link has no results', async () => {
      replies['GET https://sentry.example.com/api/0/projects/acme/web/issues/'] = {
        body: [issue()],
        headers: {
          link: '<https://sentry.example.com/api/0/projects/acme/web/issues/?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"',
        },
      };

      const issues = await client.listUnresolvedIssues('acme', 'web');

      assert.equal(issues.length, 1);
      assert.equal(calls.length, 1);
    });

    it('rejects with sentry_error when the body is not a list', async () => {
      replies['GET https://sentry.example.com/api/0/projects/acme/web/issues/'] = {
        body: { detail: 'nope' },
      };

      await assert.rejects(client.listUnresolvedIssues('acme', 'web'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_error');
        return true;
      });
    });
  });

  describe('fetching issue details', () => {
    const issueUrl = 'GET https://sentry.example.com/api/0/organizations/acme/issues/4507/';
    const eventUrl =
      'GET https://sentry.example.com/api/0/organizations/acme/issues/4507/events/latest/';

    it('returns the issue with the stacktrace, message, tags and breadcrumbs', async () => {
      replies[issueUrl] = { body: issue() };
      replies[eventUrl] = {
        body: {
          eventID: 'ev-1',
          platform: 'node',
          dateCreated: '2026-09-04T22:15:00.000Z',
          tags: [
            { key: 'environment', value: 'production' },
            { key: 'release', value: '1.4.2' },
            { key: 'broken', value: null },
          ],
          entries: [
            {
              type: 'message',
              data: { formatted: 'cannot read property x of undefined' },
            },
            {
              type: 'exception',
              data: {
                values: [
                  {
                    type: 'TypeError',
                    value: 'cannot read property x of undefined',
                    module: null,
                    stacktrace: {
                      frames: [
                        {
                          filename: 'app/handlers.ts',
                          function: 'handle',
                          absPath: '/srv/app/handlers.ts',
                          lineNo: 42,
                          colNo: 7,
                          context_line: '  return payload.x;',
                          inApp: true,
                        },
                      ],
                    },
                  },
                ],
              },
            },
            {
              type: 'breadcrumbs',
              data: {
                values: [
                  {
                    timestamp: '2026-09-04T22:14:59.000Z',
                    type: 'http',
                    category: 'fetch',
                    level: 'info',
                    message: 'GET /api/orders',
                  },
                ],
              },
            },
          ],
        },
      };

      const details = await client.getIssueDetails('acme', '4507');

      assert.equal(details.issue.shortId, 'PROJ-123');
      assert.equal(details.latestEvent?.id, 'ev-1');
      assert.equal(details.latestEvent?.message, 'cannot read property x of undefined');
      assert.equal(details.latestEvent?.exceptions.length, 1);
      assert.equal(details.latestEvent?.exceptions[0]?.type, 'TypeError');
      assert.deepEqual(details.latestEvent?.exceptions[0]?.frames[0], {
        filename: 'app/handlers.ts',
        function: 'handle',
        module: null,
        absPath: '/srv/app/handlers.ts',
        lineNo: 42,
        colNo: 7,
        contextLine: '  return payload.x;',
        inApp: true,
      });
      // A tag without a usable value is dropped, not carried as null.
      assert.deepEqual(details.latestEvent?.tags, [
        { key: 'environment', value: 'production' },
        { key: 'release', value: '1.4.2' },
      ]);
      assert.equal(details.latestEvent?.breadcrumbs[0]?.message, 'GET /api/orders');
    });

    it('reads an event without entries as an event with nothing in it', async () => {
      replies[issueUrl] = { body: issue() };
      replies[eventUrl] = { body: { eventID: 'ev-2', message: 'boom' } };

      const details = await client.getIssueDetails('acme', '4507');

      assert.deepEqual(details.latestEvent?.exceptions, []);
      assert.deepEqual(details.latestEvent?.breadcrumbs, []);
      assert.deepEqual(details.latestEvent?.tags, []);
      assert.equal(details.latestEvent?.message, 'boom');
    });

    it('returns a null latest event when Sentry has none left for the issue', async () => {
      replies[issueUrl] = { body: issue() };
      replies[eventUrl] = { status: 404, body: { detail: 'Event not found' } };

      const details = await client.getIssueDetails('acme', '4507');

      assert.equal(details.issue.id, '4507');
      assert.equal(details.latestEvent, null);
    });

    it('surfaces a missing issue as sentry_not_found', async () => {
      await assert.rejects(client.getIssueDetails('acme', 'nope'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_not_found');
        assert.equal(error.status, 404);
        return true;
      });
    });
  });

  describe('resolving an issue', () => {
    it('PUTs status: resolved to the issue', async () => {
      replies['PUT https://sentry.example.com/api/0/organizations/acme/issues/4507/'] = {
        body: { status: 'resolved' },
      };

      await client.resolveIssue('acme', '4507');

      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, 'PUT');
      assert.equal(
        calls[0]?.url,
        'https://sentry.example.com/api/0/organizations/acme/issues/4507/',
      );
      assert.deepEqual(JSON.parse(calls[0]?.body ?? 'null'), { status: 'resolved' });
    });

    it('surfaces a rejected token as sentry_unauthorized', async () => {
      replies['PUT https://sentry.example.com/api/0/organizations/acme/issues/4507/'] = {
        status: 401,
        body: { detail: 'Invalid token' },
      };

      await assert.rejects(client.resolveIssue('acme', '4507'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_unauthorized');
        assert.equal(error.status, 401);
        assert.match(error.message, /Invalid token/);
        return true;
      });
    });
  });

  describe('error classes', () => {
    const listUrl = 'GET https://sentry.example.com/api/0/projects/acme/web/issues/';

    it('maps a 403 onto the auth class as well', async () => {
      replies[listUrl] = { status: 403, body: { detail: 'You do not have permission' } };

      await assert.rejects(client.listUnresolvedIssues('acme', 'web'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_unauthorized');
        assert.equal(error.status, 403);
        return true;
      });
    });

    it('maps a 429 onto sentry_rate_limited and keeps the Retry-After', async () => {
      replies[listUrl] = {
        status: 429,
        body: { detail: { message: 'Too many requests' } },
        headers: { 'retry-after': '42' },
      };

      await assert.rejects(client.listUnresolvedIssues('acme', 'web'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_rate_limited');
        assert.equal(error.retryAfterMs, 42_000);
        assert.match(error.message, /Too many requests/);
        return true;
      });
    });

    it('maps a network failure onto sentry_unreachable', async () => {
      replies[listUrl] = { throws: new TypeError('fetch failed') };

      await assert.rejects(client.listUnresolvedIssues('acme', 'web'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_unreachable');
        assert.equal(error.status, undefined);
        assert.match(error.message, /fetch failed/);
        return true;
      });
    });

    it('maps anything else onto sentry_error', async () => {
      replies[listUrl] = { status: 502, body: { detail: 'Bad gateway' } };

      await assert.rejects(client.listUnresolvedIssues('acme', 'web'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_error');
        assert.equal(error.status, 502);
        return true;
      });
    });

    it('reports a body that is not JSON as sentry_error rather than crashing', async () => {
      replies[listUrl] = { raw: '<html>gateway</html>' };

      await assert.rejects(client.listUnresolvedIssues('acme', 'web'), (error: unknown) => {
        assert.ok(error instanceof SentryApiError);
        assert.equal(error.code, 'sentry_error');
        return true;
      });
    });
  });
});

describe('the Sentry Link header', () => {
  it('finds the next page', () => {
    assert.equal(
      nextPageUrl('<https://sentry.io/api/0/issues/?cursor=1:0:0>; rel="next"; results="true"'),
      'https://sentry.io/api/0/issues/?cursor=1:0:0',
    );
  });

  it('ignores a previous link that precedes the next one', () => {
    const header =
      '<https://sentry.io/api/0/a/?cursor=1:0:1>; rel="previous"; results="true", <https://sentry.io/api/0/b/?cursor=1:0:0>; rel="next"; results="true"';
    assert.equal(nextPageUrl(header), 'https://sentry.io/api/0/b/?cursor=1:0:0');
  });

  it('is null without a header, without a next link, and when there are no results', () => {
    assert.equal(nextPageUrl(null), null);
    assert.equal(nextPageUrl('<https://sentry.io/api/0/a/>; rel="previous"; results="true"'), null);
    assert.equal(nextPageUrl('<https://sentry.io/api/0/a/>; rel="next"; results="false"'), null);
  });

  it('refuses a next link that is not an absolute http(s) URL', () => {
    assert.equal(nextPageUrl('<file:///etc/passwd>; rel="next"; results="true"'), null);
    assert.equal(nextPageUrl('</relative/path>; rel="next"; results="true"'), null);
  });
});

describe('the client built from settings', () => {
  const db: Database = openDatabase(IN_MEMORY);

  beforeEach(() => {
    deleteSetting(db, 'sentry_token');
    deleteSetting(db, 'sentry_base_url');
    calls = [];
    replies = {};
    stubFetch();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(() => {
    closeDatabase(db);
  });

  it('is null while no token has been configured', () => {
    assert.equal(createSentryClient(db), null);
  });

  it('calls Sentry’s hosted API by default', async () => {
    setSetting(db, 'sentry_token', 'sntrys_configured');
    replies['GET https://sentry.io/api/0/projects/acme/web/issues/'] = { body: [] };

    const client = createSentryClient(db);
    assert.ok(client !== null);
    await client.listUnresolvedIssues('acme', 'web');

    assert.match(calls[0]?.url ?? '', /^https:\/\/sentry\.io\/api\/0\/projects\/acme\/web\/issues\//);
    assert.equal(calls[0]?.headers['authorization'], 'Bearer sntrys_configured');
  });

  it('calls a self-hosted install when sentry_base_url is set', async () => {
    setSetting(db, 'sentry_token', 'sntrys_self_hosted');
    setSetting(db, 'sentry_base_url', 'https://sentry.internal.example/api/0/');
    replies['GET https://sentry.internal.example/api/0/projects/acme/web/issues/'] = { body: [] };

    const client = createSentryClient(db);
    assert.ok(client !== null);
    await client.listUnresolvedIssues('acme', 'web');

    assert.match(calls[0]?.url ?? '', /^https:\/\/sentry\.internal\.example\/api\/0\//);
  });
});
