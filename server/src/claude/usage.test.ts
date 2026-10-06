import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { type Config, loadConfig } from '../config.js';
import { closeDatabase, type Database, IN_MEMORY, openDatabase } from '../db/index.js';
import { HostPaths } from '../orchestrator/index.js';
import type { CommandResult, CommandRunner } from '../ssh/index.js';
import { addClaudeAccount } from './accounts.js';
import {
  CLAUDE_REFRESH_LABEL,
  CLAUDE_REFRESH_MODEL,
  CLAUDE_SIGN_IN_AGAIN,
  CLAUDE_USAGE_BETA,
  claudeCredentialsPath,
  ClaudeUsageService,
  fetchClaudeUsage,
  readClaudeCredentials,
} from './usage.js';

const HOUR = 3_600_000;

interface Answer {
  status: number;
  body: unknown;
}

describe('claude usage', () => {
  let dataDir: string;
  let config: Config;
  let db: Database;
  let server: http.Server;
  let baseUrl: string;
  /** What the fake usage endpoint answers, by bearer token. */
  let answers: Map<string, Answer>;
  /** The headers of every request the fake endpoint saw. */
  let requests: http.IncomingHttpHeaders[];
  /** Every refresh-probe container, as its CLI arguments. */
  let probes: string[][];
  /** What a refresh probe does to the credentials file. */
  let onProbe: (account: string, cli: string[]) => void;

  const run: CommandRunner = (_command, args): Promise<CommandResult> => {
    const bind = args[args.indexOf('--volume') + 1] ?? '';
    const account = path.basename(bind.split(':')[0] ?? '');
    const cli = args.slice(args.indexOf(config.runnerImage) + 1);
    probes.push(cli);
    onProbe(account, cli);
    return Promise.resolve({ code: 0, stdout: '{}', stderr: '', timedOut: false });
  };

  const service = (): ClaudeUsageService => {
    const paths = new HostPaths(config, {
      inspectVolume: (name) => Promise.resolve({ name, mountpoint: dataDir }),
    });
    return new ClaudeUsageService(config, db, paths, run);
  };

  const writeCredentials = (accountId: string, oauth: Record<string, unknown> | null): void => {
    fs.writeFileSync(
      claudeCredentialsPath(config, accountId),
      JSON.stringify(oauth === null ? {} : { claudeAiOauth: oauth }),
    );
  };

  const account = (): string => addClaudeAccount(config, db).id;

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push(req.headers);
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const answer = req.url === '/api/oauth/usage' ? answers.get(token) : undefined;
      res.writeHead(answer?.status ?? 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer?.body ?? { error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chief-usage-'));
    config = loadConfig({ DATA_DIR: dataDir, CLAUDE_USAGE_URL: baseUrl });
    db = openDatabase(IN_MEMORY);
    answers = new Map();
    requests = [];
    probes = [];
    onProbe = () => undefined;
  });

  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('maps both windows on the happy path, with the bearer token and beta header', async () => {
    const id = account();
    writeCredentials(id, { accessToken: 'tok-1', expiresAt: Date.now() + HOUR });
    answers.set('tok-1', {
      status: 200,
      body: {
        five_hour: { utilization: 42.5, resets_at: '2026-10-01T15:00:00+00:00' },
        seven_day: { utilization: 130, resets_at: '2026-10-05T09:00:00Z' },
        seven_day_opus: null,
      },
    });

    const usage = await service().refresh(id);

    assert.equal(usage.error, null);
    assert.deepEqual(usage.fiveHour, { utilization: 42.5, resetsAt: '2026-10-01T15:00:00.000Z' });
    // Clamped to 0–100.
    assert.deepEqual(usage.sevenDay, { utilization: 100, resetsAt: '2026-10-05T09:00:00.000Z' });
    assert.equal(requests[0]?.authorization, 'Bearer tok-1');
    assert.equal(requests[0]?.['anthropic-beta'], CLAUDE_USAGE_BETA);
    assert.equal(probes.length, 0);
  });

  it('reports a window the API leaves out as null', async () => {
    const id = account();
    writeCredentials(id, { accessToken: 'tok-2', expiresAt: Date.now() + HOUR });
    answers.set('tok-2', {
      status: 200,
      body: { five_hour: { utilization: 0, resets_at: null }, seven_day: null },
    });

    const usage = await service().refresh(id);

    assert.equal(usage.error, null);
    assert.deepEqual(usage.fiveHour, { utilization: 0, resetsAt: null });
    assert.equal(usage.sevenDay, null);
  });

  it('turns a 401 into error text with no windows', async () => {
    const id = account();
    writeCredentials(id, { accessToken: 'tok-3', expiresAt: Date.now() + HOUR });
    answers.set('tok-3', { status: 401, body: { error: 'invalid token' } });

    const usage = await service().refresh(id);

    assert.match(usage.error ?? '', /401/);
    assert.equal(usage.fiveHour, null);
    assert.equal(usage.sevenDay, null);
  });

  it('answers a missing file, a non-OAuth login and a network error with error text', async () => {
    const missing = account();
    const apiKey = account();
    writeCredentials(apiKey, null);
    const usages = service();

    assert.match((await usages.refresh(missing)).error ?? '', /no credentials file/);
    assert.match((await usages.refresh(apiKey)).error ?? '', /not signed in with a Claude\.ai login/);

    const down = await fetchClaudeUsage('http://127.0.0.1:1', 'tok', () =>
      Promise.reject(new Error('connect ECONNREFUSED')),
    );
    assert.match(down.error ?? '', /ECONNREFUSED/);
    assert.equal(down.fiveHour, null);
  });

  it('refreshes an expired token through the CLI and then reads the usage', async () => {
    const id = account();
    writeCredentials(id, { accessToken: 'old', expiresAt: Date.now() - 1000 });
    answers.set('new', { status: 200, body: { five_hour: { utilization: 10, resets_at: null } } });
    // `claude auth status` leaves it alone; the `claude -p` refreshes it.
    onProbe = (accountId, cli) => {
      if (cli[0] === '-p') {
        writeCredentials(accountId, { accessToken: 'new', expiresAt: Date.now() + HOUR });
      }
    };

    const usage = await service().refresh(id);

    assert.equal(usage.error, null);
    assert.equal(usage.fiveHour?.utilization, 10);
    assert.deepEqual(probes, [
      ['auth', 'status', '--json'],
      ['-p', 'ok', '--max-turns', '1', '--model', CLAUDE_REFRESH_MODEL],
    ]);
  });

  it('says "sign in again" when the refresh leaves the token expired, and cools down', async () => {
    const id = account();
    writeCredentials(id, { accessToken: 'old', expiresAt: Date.now() - 1000 });
    const usages = service();

    const usage = await usages.refresh(id);

    assert.equal(usage.error, CLAUDE_SIGN_IN_AGAIN);
    assert.equal(usage.fiveHour, null);
    assert.equal(probes.length, 2);
    // A second read within the cooldown does not start another container.
    assert.equal((await usages.refresh(id)).error, CLAUDE_SIGN_IN_AGAIN);
    assert.equal(probes.length, 2);
  });

  it('says "sign in again" without a probe once the refresh token has expired', async () => {
    const id = account();
    writeCredentials(id, {
      accessToken: 'old',
      expiresAt: Date.now() - 1000,
      refreshTokenExpiresAt: Date.now() - 1000,
    });

    assert.equal((await service().refresh(id)).error, CLAUDE_SIGN_IN_AGAIN);
    assert.equal(probes.length, 0);
  });

  it('the tick refreshes a token about to expire and caches every account', async () => {
    const soon = account();
    const later = account();
    writeCredentials(soon, { accessToken: 'soon', expiresAt: Date.now() + 5 * 60_000 });
    writeCredentials(later, { accessToken: 'later', expiresAt: Date.now() + HOUR });
    answers.set('fresh', { status: 200, body: { five_hour: { utilization: 1, resets_at: null } } });
    answers.set('later', { status: 200, body: { seven_day: { utilization: 2, resets_at: null } } });
    onProbe = (accountId) => {
      writeCredentials(accountId, { accessToken: 'fresh', expiresAt: Date.now() + 8 * HOUR });
    };
    const usages = service();
    assert.equal(usages.usage(soon), null);

    await usages.tick();

    // `claude auth status` was enough; no `-p`.
    assert.deepEqual(probes, [['auth', 'status', '--json']]);
    const credentials = readClaudeCredentials(claudeCredentialsPath(config, soon));
    assert.equal(credentials.kind === 'oauth' && credentials.accessToken, 'fresh');
    assert.equal(usages.usage(soon)?.fiveHour?.utilization, 1);
    assert.equal(usages.usage(later)?.sevenDay?.utilization, 2);

    // Cached: a second tick asks nothing.
    const asked = requests.length;
    await usages.tick();
    assert.equal(requests.length, asked);
  });

  it('a sweep that left a near-expiry token unchanged does not block the refresh once it expires', async () => {
    let clock = Date.now();
    const id = account();
    writeCredentials(id, { accessToken: 'old', expiresAt: clock + 5 * 60_000 });
    answers.set('new', { status: 200, body: { five_hour: { utilization: 3, resets_at: null } } });
    const paths = new HostPaths(config, {
      inspectVolume: (name) => Promise.resolve({ name, mountpoint: dataDir }),
    });
    const usages = new ClaudeUsageService(config, db, paths, run, fetch, () => clock);
    // Not expired yet: the CLI leaves the token alone, no `-p`.
    await usages.tick();
    assert.deepEqual(probes, [['auth', 'status', '--json']]);

    clock += 6 * 60_000;
    onProbe = (accountId, cli) => {
      if (cli[0] === '-p') {
        writeCredentials(accountId, { accessToken: 'new', expiresAt: clock + HOUR });
      }
    };
    const usage = await usages.refresh(id);

    assert.equal(usage.error, null);
    assert.equal(usage.fiveHour?.utilization, 3);
    assert.deepEqual(probes.at(-1), ['-p', 'ok', '--max-turns', '1', '--model', CLAUDE_REFRESH_MODEL]);
  });

  it('runs the refresh probe in a --rm runner container mounting the account', async () => {
    const id = account();
    writeCredentials(id, { accessToken: 'old', expiresAt: Date.now() - 1000 });
    let seen: readonly string[] = [];
    const paths = new HostPaths(config, {
      inspectVolume: (name) => Promise.resolve({ name, mountpoint: dataDir }),
    });
    const usages = new ClaudeUsageService(config, db, paths, (_command, args) => {
      seen = args;
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
    });

    await usages.refresh(id);

    assert.deepEqual(seen.slice(0, 4), ['run', '--rm', '--label', CLAUDE_REFRESH_LABEL]);
    assert.equal(seen[seen.indexOf('--entrypoint') + 1], 'claude');
    assert.match(seen[seen.indexOf('--volume') + 1] ?? '', new RegExp(`${id}:/home/node/\\.claude$`));
  });
});
