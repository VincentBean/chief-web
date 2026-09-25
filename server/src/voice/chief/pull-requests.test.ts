import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { loadConfig } from '../../config.js';
import { createPrRun, createRepository, enqueueBuild, IN_MEMORY, openDatabase, prRefId, setSetting, updatePrRun } from '../../db/index.js';
import { PrFeedbackError } from '../../prfeedback/index.js';
import { PrReviewError } from '../../prreview/index.js';
import { chiefWorld, testGate } from './__fixtures__/world.js';
import { GithubVoiceReviews, prNumberArg, voiceRequestBody } from './pull-requests.js';
import { type ChiefTool, createChiefTools, type ToolContext, type ToolResult } from './tools.js';

type World = ReturnType<typeof chiefWorld>;

const ctxAt = (gate: ToolContext['confirmations'], turn: number): ToolContext => ({
  signal: new AbortController().signal,
  turn,
  focus: { kind: 'chief' },
  endCall: () => undefined,
  confirmations: gate,
});

/** Asks in turn 1, checks nothing ran, confirms in turn 2. */
async function roundTrip(
  name: string,
  args: Record<string, unknown>,
  w: World = chiefWorld(),
): Promise<{ w: World; prompt: string; ran: ToolResult }> {
  const { gate, sent } = testGate();
  const tools = createChiefTools(w.services);
  const asked = await (tools.get(name) as ChiefTool).handler(args, ctxAt(gate, 1));
  assert.equal(asked.ok, true, asked.summary);
  const confirm = sent.find((message) => message.type === 'confirm');
  assert.ok(confirm !== undefined && confirm.type === 'confirm', 'asks for confirmation');
  assert.deepEqual(w.state.calls, [], 'nothing runs before the operator answers');
  const ran = await (tools.get('confirm') as ChiefTool).handler({ confirmation_id: confirm.id }, ctxAt(gate, 2));
  return { w, prompt: confirm.prompt, ran };
}

/** Asks only: the result, and whether a confirmation was parked. */
async function ask(name: string, args: Record<string, unknown>, w: World = chiefWorld()): Promise<{ result: ToolResult; parked: boolean }> {
  const { gate, sent } = testGate();
  const result = await (createChiefTools(w.services).get(name) as ChiefTool).handler(args, ctxAt(gate, 1));
  return { result, parked: sent.some((message) => message.type === 'confirm') };
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
    const { result } = await ask('list_pull_requests', {}, w);
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
    const shop = await ask('list_pull_requests', { repository: 'the shop api', state: 'open' });
    assert.equal((shop.result.data as { total: number }).total, 2);
    const web = await ask('list_pull_requests', { repository: 'chief web' });
    assert.equal((web.result.data as { total: number }).total, 0);
    const unknown = await ask('list_pull_requests', { repository: 'billing' });
    assert.equal(unknown.result.ok, false);
    assert.equal((unknown.result.data as { error: string }).error, 'not_found');
  });

  it('list_pull_requests: falls back to the cached list and says so when there is none', async () => {
    const w = chiefWorld();
    w.state.pullRequests = null;
    const { result } = await ask('list_pull_requests', {}, w);
    assert.equal(result.ok, false);
    assert.equal((result.data as { error: string }).error, 'pull_requests_unavailable');
  });

  it('review_pull_request: confirms, then calls PrReviewService.start', async () => {
    const { w, prompt, ran } = await roundTrip('review_pull_request', { repository: 'shop-api', number: 209 });
    assert.equal(prompt, 'Review shop-api #209, "Speed up search"?');
    assert.equal(ran.ok, true, ran.summary);
    assert.deepEqual(w.state.calls, [{ method: 'prReviews.start', arg: { repositoryId: w.ids['shop'], prNumber: 209 } }]);
    assert.equal(ran.summary, 'Review: shop-api #209');
    assert.deepEqual(ran.ui, [{ action: 'navigate', path: '/pull-requests' }]);
  });

  it('review_pull_request: a service refusal is spoken, not thrown', async () => {
    const w = chiefWorld();
    w.state.failures.set('prReviews.start', new PrReviewError(409, 'review_already_active', 'That pull request is already being reviewed.'));
    const { ran } = await roundTrip('review_pull_request', { repository: 'shop-api', number: 212 }, w);
    assert.equal(ran.ok, false);
    assert.equal(ran.summary, 'That pull request is already being reviewed.');
  });

  it('address_pr_feedback: confirms, then calls PrFeedbackService.start', async () => {
    const { w, prompt, ran } = await roundTrip('address_pr_feedback', { repository: 'shop api', number: '212' });
    assert.match(prompt, /Address the review feedback on shop-api #212/);
    assert.equal(ran.ok, true, ran.summary);
    assert.deepEqual(w.state.calls, [{ method: 'prFeedback.start', arg: { repositoryId: w.ids['shop'], prNumber: 212 } }]);
  });

  it('only accepts a number as digits', async () => {
    assert.equal(prNumberArg({ number: 213 }), 213);
    assert.equal(prNumberArg({ number: '213' }), 213);
    assert.equal(prNumberArg({ number: 'two thirteen' }), null);
    assert.equal(prNumberArg({ number: 2.5 }), null);
    assert.equal(prNumberArg({ number: 0 }), null);
    const { result, parked } = await ask('address_pr_feedback', { repository: 'shop-api', number: 'two thirteen' });
    assert.equal(result.ok, false);
    assert.equal(parked, false);
    assert.equal((result.data as { error: string }).error, 'invalid_number');
  });

  it('refuses a pull request from a fork for feedback, conflict fixes and change requests', async () => {
    for (const [name, extra] of [
      ['address_pr_feedback', {}],
      ['fix_pr_conflicts', {}],
      ['request_pr_change', { instruction: 'rename it' }],
    ] as const) {
      const w = withFork(chiefWorld());
      const { result, parked } = await ask(name, { repository: 'shop-api', number: 207, ...extra }, w);
      assert.equal(result.ok, false, name);
      assert.equal(parked, false, name);
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
    const { prompt, ran } = await roundTrip('stop_pr_run', { repository: 'shop-api', number: 212 }, w);
    assert.match(prompt, /Stop the run on shop-api #212/);
    assert.equal(ran.ok, true, ran.summary);
    assert.deepEqual(w.state.calls, [{ method: 'prFeedback.stop', arg: run.id }]);
    assert.equal(ran.summary, 'Stopped: shop-api #212');
  });

  it('stop_pr_run: a queued run counts as active; a finished one or none is { ok: false }', async () => {
    const w = chiefWorld();
    const shop = w.ids['shop'] as string;
    const none = await ask('stop_pr_run', { repository: 'shop-api', number: 209 }, w);
    assert.equal(none.result.ok, false);
    assert.equal(none.parked, false);
    assert.equal(none.result.summary, 'No run is active on shop-api #209');

    const run = createPrRun(w.db, { repositoryId: shop, prNumber: 209, prUrl: 'u', prTitle: 't', headBranch: 'b', baseBranch: 'develop' });
    updatePrRun(w.db, run.id, { status: 'finished' });
    assert.equal((await ask('stop_pr_run', { repository: 'shop-api', number: 209 }, w)).result.ok, false);

    updatePrRun(w.db, run.id, { status: 'pending' });
    enqueueBuild(w.db, { kind: 'pr-feedback', refId: prRefId(shop, 209) });
    const { ran } = await roundTrip('stop_pr_run', { repository: 'shop-api', number: 209 }, w);
    assert.equal(ran.ok, true);
    assert.deepEqual(w.state.calls, [{ method: 'prFeedback.stop', arg: run.id }]);
  });

  it('fix_pr_conflicts: confirms, then calls fixNow; a clean pull request is { ok: false } with the reason', async () => {
    const { w, prompt, ran } = await roundTrip('fix_pr_conflicts', { repository: 'shop-api', number: 209 });
    assert.match(prompt, /Fix the merge conflicts on shop-api #209/);
    assert.equal(ran.ok, true);
    assert.deepEqual(w.state.calls, [{ method: 'prConflicts.fixNow', arg: { repositoryId: w.ids['shop'], prNumber: 209 } }]);

    const clean = chiefWorld();
    clean.state.fixNow = { ok: false, code: 'no_conflicts', reason: '#209 has no merge conflicts.' };
    const refused = await roundTrip('fix_pr_conflicts', { repository: 'shop-api', number: 209 }, clean);
    assert.equal(refused.ran.ok, false);
    assert.equal(refused.ran.summary, '#209 has no merge conflicts.');
  });

  it('request_pr_change: reads the instruction back, posts a review with the voice body, then starts a feedback run', async () => {
    const instruction = 'rename the export button to Download';
    const { w, prompt, ran } = await roundTrip('request_pr_change', { repository: 'shop-api', number: 212, instruction });
    assert.equal(prompt, `On shop-api #212, "Nightly rector run", ask for: "${instruction}"?`);
    assert.equal(ran.ok, true, ran.summary);
    const shop = w.ids['shop'];
    assert.deepEqual(w.state.calls, [
      { method: 'pullRequests.feedback', arg: { repositoryId: shop, number: 212 } },
      { method: 'github.postReview', arg: { repositoryId: shop, prNumber: 212, body: `Requested by voice: ${instruction}` } },
      { method: 'prFeedback.start', arg: { repositoryId: shop, prNumber: 212 } },
    ]);
    assert.equal(ran.summary, 'Change requested: shop-api #212');
  });

  it('request_pr_change: a fork found on the fresh read posts nothing', async () => {
    const w = chiefWorld();
    w.state.feedback = { fromFork: true, headRef: 'patch-1' };
    const { ran } = await roundTrip('request_pr_change', { repository: 'shop-api', number: 212, instruction: 'x' }, w);
    assert.equal(ran.ok, false);
    assert.match(ran.summary, /lives on another repository/);
    assert.deepEqual(w.state.calls.map((call) => call.method), ['pullRequests.feedback']);
  });

  it('request_pr_change: says the request was posted when the run cannot start', async () => {
    const w = chiefWorld();
    w.state.failures.set('prFeedback.start', new PrFeedbackError(409, 'run_already_active', 'That pull request is already running.'));
    const { ran } = await roundTrip('request_pr_change', { repository: 'shop-api', number: 212, instruction: 'x' }, w);
    assert.equal(ran.ok, false);
    assert.equal(ran.summary, 'Posted the request on shop-api #212, but the run did not start: That pull request is already running.');
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
