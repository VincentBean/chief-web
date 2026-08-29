import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from './app.js';
import { loadConfig } from './config.js';

describe('api', () => {
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;

  before(async () => {
    const app = createApp(loadConfig({}));
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('GET /api/health returns 200 {"status":"ok"}', async () => {
    const response = await fetch(`${baseUrl}/api/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  it('unknown API routes return a JSON 404', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  });
});
