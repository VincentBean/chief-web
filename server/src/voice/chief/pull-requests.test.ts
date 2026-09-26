import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../../config.js';
import { createPrRun, createRepository, enqueueBuild, IN_MEMORY, openDatabase, prRefId, setSetting, updatePrRun } from '../../db/index.js';
import { PrFeedbackError } from '../../prfeedback/index.js';
import { PrReviewError } from '../../prreview/index.js';
import { chiefWorld } from './__fixtures__/world.js';
import { GithubVoiceReviews, prNumberArg, voiceRequestBody } from './pull-requests.js';
import { type ChiefTool, createChiefTools, type ToolContext, type ToolResult } from './tools.js';

type World = ReturnType<typeof chiefWorld>;

const ctx: ToolContext = {
  signal: new AbortController().signal,
  turn: 1,
  focus: { kind: 'chief' },
  endCall: () => undefined,
};

/** Calls a tool once: an acting tool resolves its target and acts in the same call. */
async function act(name: string, args: Record<string, unknown>, w: World = chiefWorld()): Promise<{ w: World; result: ToolResult }> {
  const result = await (createChiefTools(w.services).get(name) as ChiefTool).handler(args, ctx);
  return { w, result };
}

/** Puts a pull request from a fork on shop-api's list. */
function withFork(w: World): World {
  const list = w.state.pullRequests;
  assert.ok(list !== null);
  const [shop, ...rest] = list.repositories;
  assert.ok(shop !== undefined);
  const fork = { ...(shop.pullRequests[0] as (typeof shop.pullRequests)[number]), number: 207, title: 'Typo', headRef: 'patch-1', fromFork: true, sessionId: null };
  w.state.pullRequests = { ...list, repositories: [{ ...shop, pullRequests: [...shop.pullRequests, fork] }, ...rest] };
  return w;
}

const FORK_REASON = `The head branch "patch-1" of #207 lives on another repository. chief-web pushes with shop-api's deploy key, which cannot write there.`;

describe('chief pull request tools (voice US-013)', () => {
  it('list_pull_requests: compact rows with session, unresolved comments and conflicts, and opens the page', async () => {
    const w = chiefWorld();
    w.state.conflicts.set(`${w.ids['shop'] as string}#209`, true);
    w.state.prRuns.set(`${w.ids['shop'] as string}#212`, {
      threads: [
        { kind: 'thread', resolved: false },
        { kind: 'thread', resolved: true },
        { kind: 'review', resolved: false },
      ],
    } as never);
    const { result } = await act('list_pull_requests', {}, w);
    assert.equal(result.ok, true);
    assert.deepEqual(result.ui, [{ action: 'navigate', path: '/pull-requests' }]);
    const data = result.data as { pullRequests: unknown[]; total: number };
    assert.equal(data.total, 2);
    assert.deepEqual(data.pullRequests, [
      {
        repository: 'shop-api',
        number: 212,
        title: 'Nightly rector run',
        head: 'branch-212',
        draft: false,
        fromFork: false,
        session: 'nightly-rector-20260925-0200',
        unresolvedComments: 1,
        conflicted: null,
      },
      {
        repository: 'shop-api',
        number: 209,
        title: 'Speed up search',
        head: 'branch-209',
        draft: false,
        fromFork: false,
        session: null,
        unresolvedComments: null,
        conflicted: true,
      },
    ]);
    assert.equal(result.summary, '2 open pull requests');
  });

  it('list_pull_requests: filters by a spoken repository name, resolved like a session name', async () => {
    const shop = await act('list_pull_requests', { repository: 'the shop api', state: 'open' });
    assert.equal((shop.result.data as { total: number }).total, 2);
    const web = await act('list_pull_requests', { repository: 'chief web' });
    assert.equal((web.result.data as { total: number }).total, 0);
    const unknown = await act('list_pull_requests', { repository: 'billing' });
    assert.equal(unknown.result.ok, false);
    assert.equal((unknown.result.data as { error: string }).error, 'not_found');
  });

  it('list_pull_requests: falls back to the cached list and says so when there is none', async () => {
    const w = chiefWorld();
    w.state.pullRequests = null;
    const { result } = await act('list_pull_requests', {}, w);
    assert.equal(result.ok, false);
    assert.equal((result.data as { error: string }).error, 'pull_requests_unavailable');
  });

  it('review_pull_request: resolves the spoken target and calls PrReviewService.start once with its ids', async () => {
    const { w, result } = await act('review_pull_request', { repository: 'the shop api', number: 209 });
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(w.state.calls, [{ method: 'prReviews.start', arg: { repositoryId: w.ids['shop'], prNumber: 209 } }]);
    assert.equal(result.summary, 'Review: shop-api #209');
    assert.deepEqual(result.ui, [{ action: 'navigate', path: '/pull-requests' }]);
  });

  it('review_pull_request: a service refusal is spoken, not thrown', async () => {
    const w = chiefWorld();
    w.state.failures.set('prReviews.start', new PrReviewError(409, 'review_already_active', 'That pull request is already being reviewed.'));
    const { result } = await act('review_pull_request', { repository: 'shop-api', number: 212 }, w);
    assert.equal(result.ok, false);
    assert.equal(result.summary, 'That pull request is already being reviewed.');
  });

  it('review_pull_request: an unknown repository is refused before anything runs', async () => {
    const { w, result } = await act('review_pull_request', { repository: 'billing', number: 209 });
    assert.equal(result.ok, false);
    assert.equal((result.data as { error: string }).error, 'not_found');
    assert.deepEqual(w.state.calls, []);
  });

  it('address_pr_feedback: calls PrFeedbackService.start once with the resolved ids', async () => {
    const { w, result } = await act('address_pr_feedback', { repository: 'shop api', number: '212' });
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(w.state.calls, [{ method: 'prFeedback.start', arg: { repositoryId: w.ids['shop'], prNumber: 212 } }]);
  });

  it('only accepts a number as digits', async () => {
    assert.equal(prNumberArg({ number: 213 }), 213);
    assert.equal(prNumberArg({ number: '213' }), 213);
    assert.equal(prNumberArg({ number: 'two thirteen' }), null);
    assert.equal(prNumberArg({ number: 2.5 }), null);
    assert.equal(prNumberArg({ number: 0 }), null);
    const { w, result } = await act('address_pr_feedback', { repository: 'shop-api', number: 'two thirteen' });
    assert.equal(result.ok, false);
    assert.equal((result.data as { error: string }).error, 'invalid_number');
    assert.deepEqual(w.state.calls, []);
  });

  it('refuses a pull request from a fork for feedback, conflict fixes and change requests', async () => {
    for (const [name, extra] of [
      ['address_pr_feedback', {}],
      ['fix_pr_conflicts', {}],
      ['request_pr_change', { instruction: 'rename it' }],
    ] as const) {
      const w = withFork(chiefWorld());
      const { result } = await act(name, { repository: 'shop-api', number: 207, ...extra }, w);
      assert.equal(result.ok, false, name);
      assert.equal(result.summary, FORK_REASON, name);
      assert.equal((result.data as { error: string }).error, 'pull_request_from_fork');
      assert.deepEqual(w.state.calls, [], name);
    }
  });

  it('stop_pr_run: resolves the active run with findPrRun and stops it', async () => {
    const w = chiefWorld();
    const run = createPrRun(w.db, {
      repositoryId: w.ids['shop'] as string,
      prNumber: 212,
      prUrl: 'https://github.com/acme/shop-api/pull/212',
      prTitle: 'Nightly rector run',
      headBranch: 'branch-212',
      baseBranch: 'develop',
    });
    updatePrRun(w.db, run.id, { status: 'running' });
    const { result } = await act('stop_pr_run', { repository: 'shop-api', number: 212 }, w);
    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(w.state.calls, [{ method: 'prFeedback.stop', arg: run.id }]);
    assert.equal(result.summary, 'Stopped: shop-api #212');
  });

  it('stop_pr_run: a queued run counts as active; a finished one or none is { ok: false }', async () => {
    const w = chiefWorld();
    const shop = w.ids['shop'] as string;
    const none = await act('stop_pr_run', { repository: 'shop-api', number: 209 }, w);
    assert.equal(none.result.ok, false);
    assert.equal(none.result.summary, 'No run is active on shop-api #209');
    assert.deepEqual(w.state.calls, []);

    const run = createPrRun(w.db, { repositoryId: shop, prNumber: 209, prUrl: 'u', prTitle: 't', headBranch: 'b', baseBranch: 'develop' });
    updatePrRun(w.db, run.id, { status: 'finished' });
    assert.equal((await act('stop_pr_run', { repository: 'shop-api', number: 209 }, w)).result.ok, false);
    assert.deepEqual(w.state.calls, []);

    updatePrRun(w.db, run.id, { status: 'pending' });
    enqueueBuild(w.db, { kind: 'pr-feedback', refId: prRefId(shop, 209) });
    const { result } = await act('stop_pr_run', { repository: 'shop-api', number: 209 }, w);
    assert.equal(result.ok, true);
    assert.deepEqual(w.state.calls, [{ method: 'prFeedback.stop', arg: run.id }]);
  });

  it('fix_pr_conflicts: calls fixNow once; a clean pull request is { ok: false } with the reason', async () => {
    const { w, result } = await act('fix_pr_conflicts', { repository: 'shop-api', number: 209 });
    assert.equal(result.ok, true);
    assert.deepEqual(w.state.calls, [{ method: 'prConflicts.fixNow', arg: { repositoryId: w.ids['shop'], prNumber: 209 } }]);

    const clean = chiefWorld();
    clean.state.fixNow = { ok: false, code: 'no_conflicts', reason: '#209 has no merge conflicts.' };
    const refused = await act('fix_pr_conflicts', { repository: 'shop-api', number: 209 }, clean);
    assert.equal(refused.result.ok, false);
    assert.equal(refused.result.summary, '#209 has no merge conflicts.');
  });

  it('request_pr_change: posts a review with the voice body, then starts a feedback run', async () => {
    const instruction = 'rename the export button to Download';
    const { w, result } = await act('request_pr_change', { repository: 'shop-api', number: 212, instruction });
    assert.equal(result.ok, true, result.summary);
    const shop = w.ids['shop'];
    assert.deepEqual(w.state.calls, [
      { method: 'pullRequests.feedback', arg: { repositoryId: shop, number: 212 } },
      { method: 'github.postReview', arg: { repositoryId: shop, prNumber: 212, body: `Requested by voice: ${instruction}` } },
      { method: 'prFeedback.start', arg: { repositoryId: shop, prNumber: 212 } },
    ]);
    assert.equal(result.summary, 'Change requested: shop-api #212');
  });

  it('request_pr_change: a missing instruction is refused before anything runs', async () => {
    const { w, result } = await act('request_pr_change', { repository: 'shop-api', number: 212, instruction: '  ' });
    assert.equal(result.ok, false);
    assert.deepEqual(w.state.calls, []);
  });

  it('request_pr_change: a fork found on the fresh read posts nothing', async () => {
    const w = chiefWorld();
    w.state.feedback = { fromFork: true, headRef: 'patch-1' };
    const { result } = await act('request_pr_change', { repository: 'shop-api', number: 212, instruction: 'x' }, w);
    assert.equal(result.ok, false);
    assert.match(result.summary, /lives on another repository/);
    assert.deepEqual(w.state.calls.map((call) => call.method), ['pullRequests.feedback']);
  });

  it('request_pr_change: says the request was posted when the run cannot start', async () => {
    const w = chiefWorld();
    w.state.failures.set('prFeedback.start', new PrFeedbackError(409, 'run_already_active', 'That pull request is already running.'));
    const { result } = await act('request_pr_change', { repository: 'shop-api', number: 212, instruction: 'x' }, w);
    assert.equal(result.ok, false);
    assert.equal(result.summary, 'Posted the request on shop-api #212, but the run did not start: That pull request is already running.');
  });
});

describe('GithubVoiceReviews', () => {
  const posted: { url: string; body: unknown; auth: string | undefined }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      posted.push({ url: req.url ?? '', body: JSON.parse(raw), auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 7, html_url: 'https://github.com/acme/shop-api/pull/212#pullrequestreview-7' }));
    });
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it('posts a COMMENT review with no line comments, with the saved token', async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const db = openDatabase(IN_MEMORY);
    const repository = createRepository(db, { name: 'shop-api', sshUrl: 'git@github.com:acme/shop-api.git', githubSlug: 'acme/shop-api' });
    const config = loadConfig({ GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    const gateway = new GithubVoiceReviews(config, db);

    await assert.rejects(gateway.postReview(repository.id, 212, 'x'), { code: 'github_token_missing' });
    setSetting(db, 'github_token', 'ghp_voice');
    const review = await gateway.postReview(repository.id, 212, voiceRequestBody('add a test'));
    assert.deepEqual(review, { id: 7, url: 'https://github.com/acme/shop-api/pull/212#pullrequestreview-7' });
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.url, '/repos/acme/shop-api/pulls/212/reviews');
    assert.deepEqual(posted[0]?.body, { body: 'Requested by voice: add a test', event: 'COMMENT', comments: [] });
    assert.match(posted[0]?.auth ?? '', /ghp_voice/);
  });
});
