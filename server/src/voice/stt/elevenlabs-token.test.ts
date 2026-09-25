import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

import { VoiceProviderError } from '../providers.js';
import { MintLimit, mintScribeToken, SCRIBE_TOKEN_TTL_MS } from './elevenlabs-token.js';

/** The body ElevenLabs answered `POST /v1/single-use-token/realtime_scribe` with. */
const RECORDED = readFileSync(new URL('./__fixtures__/scribe-token.json', import.meta.url), 'utf8');

let reply: { status: number; body: string } = { status: 200, body: RECORDED };
let seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

describe('Scribe single-use token (voice US-022)', () => {
  let provider: http.Server;
  let baseUrl: string;

  before(async () => {
    provider = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    provider.listen(0, '127.0.0.1');
    await new Promise((resolve) => provider.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  after(async () => {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  });

  beforeEach(() => {
    reply = { status: 200, body: RECORDED };
    seen = [];
  });

  it('mints a realtime_scribe token with the stored key and no body', async () => {
    const now = new Date('2026-09-25T10:00:00Z');
    const minted = await mintScribeToken(baseUrl, 'el-key', now);

    assert.equal(minted.token, (JSON.parse(RECORDED) as { token: string }).token);
    assert.equal(minted.expiresAt, new Date(now.getTime() + SCRIBE_TOKEN_TTL_MS).toISOString());
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.url, '/v1/single-use-token/realtime_scribe');
    assert.equal(seen[0]?.headers['xi-api-key'], 'el-key');
    assert.equal(seen[0]?.body, '');
  });

  it('turns a refused key into an unauthorized provider error with ElevenLabs’ words', async () => {
    reply = { status: 401, body: JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }) };
    await assert.rejects(mintScribeToken(baseUrl, 'bad'), (error: unknown) => {
      assert.ok(error instanceof VoiceProviderError);
      assert.equal(error.kind, 'unauthorized');
      assert.match(error.message, /Invalid API key/);
      return true;
    });
  });

  it('rejects an answer without a token', async () => {
    reply = { status: 200, body: '{}' };
    await assert.rejects(mintScribeToken(baseUrl, 'el-key'), /without a token/);
  });

  it('reports an unreachable provider', async () => {
    await assert.rejects(mintScribeToken('http://127.0.0.1:1', 'el-key'), (error: unknown) => {
      assert.ok(error instanceof VoiceProviderError);
      assert.equal(error.kind, 'unreachable');
      return true;
    });
  });

  it('caps mints per sliding window and says when the next one is allowed', () => {
    const limit = new MintLimit(10, 60 * 60_000);
    for (let i = 0; i < 10; i++) assert.equal(limit.take(i * 1000), 0);
    assert.equal(limit.take(10_000), 3590);
    // The first mint ages out an hour after it was made.
    assert.equal(limit.take(60 * 60_000), 0);
    assert.equal(limit.take(60 * 60_000), 1);
    // A mint the provider refused is given back.
    limit.release();
    assert.equal(limit.take(60 * 60_000), 0);
  });
});
