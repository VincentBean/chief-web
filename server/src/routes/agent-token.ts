import { Router } from "express";

import { generateToken, revokeToken, tokenStatus } from "../agentapi/index.js";
import type { Database } from "../db/index.js";

/**
 * The Settings page's view of the agent API token (send-to-chief US-002).
 *
 * Mounted behind the cookie guard only: the bearer token itself is never
 * accepted here, so a leaked token cannot rotate or revoke itself.
 */
export function createAgentTokenRouter(db: Database): Router {
  const router = Router();

  router.get("/settings/agent-token", (_req, res) => {
    res.status(200).json(tokenStatus(db));
  });

  // The only response that ever carries the plaintext; regenerating replaces
  // the old token, which stops verifying at once.
  router.post("/settings/agent-token", (_req, res) => {
    const token = generateToken(db);
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({ token, createdAt: tokenStatus(db).createdAt });
  });

  // Idempotent: revoking when nothing is configured is still a 204.
  router.delete("/settings/agent-token", (_req, res) => {
    revokeToken(db);
    res.status(204).end();
  });

  return router;
}
