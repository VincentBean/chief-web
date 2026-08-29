import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { type WebSocket, WebSocketServer } from 'ws';

import type { AuthService } from '../auth/index.js';
import { logger } from '../lib/logger.js';

/**
 * Close code sent to clients whose handshake carried no valid session cookie.
 * 4000-4999 is the range reserved for application-defined codes.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** Close code for an upgrade on a path no feature has registered. */
export const WS_CLOSE_UNKNOWN_ROUTE = 4404;

export interface WebSocketRoute {
  /** Exact pathname of the upgrade request, e.g. `/api/sessions/:id/terminal`. */
  readonly path: string;
  handle(socket: WebSocket, req: IncomingMessage): void;
}

/**
 * Single owner of the HTTP server's `upgrade` event.
 *
 * Every WebSocket feature (terminals in US-007, log streams in US-013)
 * registers a route here instead of attaching its own upgrade listener, so the
 * session-cookie check (FR-2) happens in exactly one place and cannot be
 * forgotten by a later story.
 */
export class WebSocketGateway {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly routes = new Map<string, WebSocketRoute>();

  constructor(private readonly auth: AuthService) {}

  register(route: WebSocketRoute): void {
    if (this.routes.has(route.path)) {
      throw new Error(`WebSocket route already registered: ${route.path}`);
    }
    this.routes.set(route.path, route);
  }

  /** Starts handling upgrades on `httpServer`. */
  attach(httpServer: HttpServer): void {
    httpServer.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  /** Closes the underlying `ws` server and every live connection. */
  close(): void {
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // The handshake is completed even for rejected connections: a close code is
    // only deliverable over an established WebSocket, and the story requires
    // clients to see *why* they were turned away.
    if (!this.auth.isAuthenticated(req)) {
      logger.warn('rejected unauthenticated WebSocket upgrade', { path: req.url });
      this.reject(req, socket, head, WS_CLOSE_UNAUTHORIZED, 'unauthorized');
      return;
    }

    const route = this.routes.get(pathnameOf(req));
    if (!route) {
      this.reject(req, socket, head, WS_CLOSE_UNKNOWN_ROUTE, 'unknown route');
      return;
    }

    this.server.handleUpgrade(req, socket, head, (ws) => {
      route.handle(ws, req);
    });
  }

  private reject(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    code: number,
    reason: string,
  ): void {
    this.server.handleUpgrade(req, socket, head, (ws) => {
      ws.close(code, reason);
    });
  }
}

/** The request path without its query string, resilient to relative URLs. */
export function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? '/', 'http://localhost').pathname;
}
