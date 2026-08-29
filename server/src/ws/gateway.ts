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
  /**
   * Pathname pattern of the upgrade request. Segments starting with `:` are
   * captured, e.g. `/api/terminals/:id/stream`.
   */
  readonly path: string;
  handle(socket: WebSocket, req: IncomingMessage, params: Readonly<Record<string, string>>): void;
}

/** A registered pattern, split once at registration time. */
interface CompiledRoute {
  readonly route: WebSocketRoute;
  readonly segments: readonly string[];
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
  private readonly exact = new Map<string, WebSocketRoute>();
  private readonly patterns: CompiledRoute[] = [];
  private readonly registered = new Set<string>();

  constructor(private readonly auth: AuthService) {}

  register(route: WebSocketRoute): void {
    if (this.registered.has(route.path)) {
      throw new Error(`WebSocket route already registered: ${route.path}`);
    }
    this.registered.add(route.path);
    if (route.path.includes('/:')) {
      this.patterns.push({ route, segments: route.path.split('/') });
    } else {
      this.exact.set(route.path, route);
    }
  }

  /** The route handling `pathname`, with its captured parameters. */
  private match(pathname: string): { route: WebSocketRoute; params: Record<string, string> } | null {
    const exact = this.exact.get(pathname);
    if (exact !== undefined) return { route: exact, params: {} };

    const actual = pathname.split('/');
    for (const { route, segments } of this.patterns) {
      if (segments.length !== actual.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < segments.length; i += 1) {
        const expected = segments[i] as string;
        const value = actual[i] as string;
        if (expected.startsWith(':')) {
          if (value === '') {
            matched = false;
            break;
          }
          params[expected.slice(1)] = decodeURIComponent(value);
        } else if (expected !== value) {
          matched = false;
          break;
        }
      }
      if (matched) return { route, params };
    }
    return null;
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

    const matched = this.match(pathnameOf(req));
    if (matched === null) {
      this.reject(req, socket, head, WS_CLOSE_UNKNOWN_ROUTE, 'unknown route');
      return;
    }

    this.server.handleUpgrade(req, socket, head, (ws) => {
      matched.route.handle(ws, req, matched.params);
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
