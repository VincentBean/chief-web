import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { WebSocket } from 'ws';

import { createAuthService } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { closeDatabase, IN_MEMORY, openDatabase } from '../db/index.js';
import { WebSocketGateway, WS_CLOSE_UNAUTHORIZED, WS_CLOSE_UNKNOWN_ROUTE } from './gateway.js';

interface Closed {
  code: number;
  reason: string;
}

describe('WebSocket gateway', () => {
  const db = openDatabase(IN_MEMORY);
  const auth = createAuthService(loadConfig({ CHIEF_WEB_PASSWORD: 'pw' }), db);
  const cookie = auth.sessionCookie().split(';')[0] ?? '';
  const gateway = new WebSocketGateway(auth);

  let httpServer: Server;
  let baseUrl: string;

  before(async () => {
    gateway.register({
      path: '/api/ws/echo',
      handle: (socket) => {
        socket.on('message', (data: Buffer) => socket.send(data));
      },
    });

    httpServer = createServer((_req, res) => res.end());
    gateway.attach(httpServer);
    httpServer.listen(0, '127.0.0.1');
    await new Promise((resolve) => httpServer.once('listening', resolve));
    baseUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  after(async () => {
    gateway.close();
    await new Promise((resolve) => httpServer.close(resolve));
    closeDatabase(db);
  });

  const connect = (path: string, headers: Record<string, string> = {}): WebSocket =>
    new WebSocket(`${baseUrl}${path}`, { headers });

  const closure = async (socket: WebSocket): Promise<Closed> =>
    new Promise((resolve) => {
      socket.on('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() }),
      );
    });

  it('closes handshakes without a session cookie with 4401', async () => {
    const closed = await closure(connect('/api/ws/echo'));

    assert.equal(closed.code, WS_CLOSE_UNAUTHORIZED);
    assert.equal(closed.reason, 'unauthorized');
  });

  it('closes handshakes with an invalid session cookie with 4401', async () => {
    const closed = await closure(connect('/api/ws/echo', { cookie: `${cookie}tampered` }));

    assert.equal(closed.code, WS_CLOSE_UNAUTHORIZED);
  });

  it('closes authenticated handshakes on unknown paths with 4404', async () => {
    const closed = await closure(connect('/api/ws/nope', { cookie }));

    assert.equal(closed.code, WS_CLOSE_UNKNOWN_ROUTE);
  });

  it('hands authenticated connections to the registered route', async () => {
    const socket = connect('/api/ws/echo', { cookie });
    await new Promise((resolve) => socket.once('open', resolve));

    const echoed = new Promise<string>((resolve) => {
      socket.once('message', (data: Buffer) => resolve(data.toString()));
    });
    socket.send('ping');

    assert.equal(await echoed, 'ping');
    socket.close();
  });

  it('refuses to register the same path twice', () => {
    assert.throws(
      () => gateway.register({ path: '/api/ws/echo', handle: () => undefined }),
      /already registered/,
    );
  });
});
