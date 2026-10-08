import assert from "node:assert/strict";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { generateToken, revokeToken, verifyToken } from "../agentapi/index.js";
import { createApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { loadConfig } from "../config.js";
import {
  closeDatabase,
  type Database,
  getSetting,
  IN_MEMORY,
  openDatabase,
} from "../db/index.js";

const PASSWORD = "correct horse battery staple";
const URL_PATH = "/api/settings/agent-token";

describe("agent token api", () => {
  let baseUrl: string;
  let cookie: string;
  let db: Database;
  let server: http.Server;

  before(async () => {
    const config = loadConfig({ CHIEF_WEB_PASSWORD: PASSWORD });
    db = openDatabase(IN_MEMORY);
    const app = createApp(config, createAuthService(config, db), db);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    assert.ok(cookie !== "", "logged in");
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase(db);
  });

  beforeEach(() => {
    revokeToken(db);
  });

  const call = async (
    method: string,
    headers: Record<string, string> = { cookie },
  ): Promise<Response> => fetch(`${baseUrl}${URL_PATH}`, { method, headers });

  it("reports an unconfigured token", async () => {
    const res = await call("GET");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      configured: false,
      createdAt: null,
      lastUsedAt: null,
    });
  });

  it("generates a token, returns its plaintext once, and never again", async () => {
    const res = await call("POST");
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as {
      token: string;
      createdAt: string;
      publicUrl: string;
    };
    assert.deepEqual(Object.keys(body).sort(), [
      "createdAt",
      "publicUrl",
      "token",
    ]);
    assert.equal(body.publicUrl, "");
    assert.match(body.token, /^chief_[A-Za-z0-9_-]{43}$/);
    assert.equal(body.createdAt, getSetting(db, "agent_api_token_created_at"));
    assert.ok(verifyToken(db, body.token));

    const status = await call("GET");
    assert.equal(status.status, 200);
    const text = await status.text();
    assert.ok(!text.includes(body.token), "GET never returns the plaintext");
    const parsed = JSON.parse(text) as {
      configured: boolean;
      createdAt: string;
      lastUsedAt: string | null;
    };
    assert.equal(parsed.configured, true);
    assert.equal(parsed.createdAt, body.createdAt);
    assert.notEqual(
      parsed.lastUsedAt,
      null,
      "the verify above stamped last use",
    );
    assert.deepEqual(Object.keys(parsed).sort(), [
      "configured",
      "createdAt",
      "lastUsedAt",
    ]);
  });

  it("regenerates: the old token stops verifying", async () => {
    const first = ((await (await call("POST")).json()) as { token: string })
      .token;
    const res = await call("POST");
    assert.equal(res.status, 201);
    const second = ((await res.json()) as { token: string }).token;
    assert.notEqual(first, second);
    assert.equal(verifyToken(db, first), false);
    assert.equal(verifyToken(db, second), true);
  });

  it("revokes the token with 204", async () => {
    const token = generateToken(db);
    const res = await call("DELETE");
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
    assert.equal(verifyToken(db, token), false);
    const status = await call("GET");
    assert.deepEqual(await status.json(), {
      configured: false,
      createdAt: null,
      lastUsedAt: null,
    });
  });

  it("answers 204 when revoking with no token configured", async () => {
    const res = await call("DELETE");
    assert.equal(res.status, 204);
  });

  for (const method of ["GET", "POST", "DELETE"]) {
    it(`${method} answers 401 without a login cookie`, async () => {
      const token = generateToken(db);
      const res = await call(method, {});
      assert.equal(res.status, 401);
      assert.equal(verifyToken(db, token), true, "the token is untouched");
    });

    it(`${method} answers 401 with only the bearer token`, async () => {
      const token = generateToken(db);
      const res = await call(method, { authorization: `Bearer ${token}` });
      assert.equal(res.status, 401);
      assert.equal(
        verifyToken(db, token),
        true,
        "the token cannot rotate or revoke itself",
      );
    });
  }
});

describe("agent token api with PUBLIC_URL", () => {
  it("returns the configured public URL with a generated token", async () => {
    const config = loadConfig({
      CHIEF_WEB_PASSWORD: PASSWORD,
      PUBLIC_URL: "https://chief.example/",
    });
    const db = openDatabase(IN_MEMORY);
    const server = createApp(config, createAuthService(config, db), db).listen(
      0,
      "127.0.0.1",
    );
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD }),
      });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

      const res = await fetch(`${baseUrl}${URL_PATH}`, {
        method: "POST",
        headers: { cookie },
      });
      assert.equal(res.status, 201);
      const body = (await res.json()) as { publicUrl: string };
      assert.equal(body.publicUrl, "https://chief.example");
    } finally {
      await new Promise((resolve) => server.close(resolve));
      closeDatabase(db);
    }
  });
});
