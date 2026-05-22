import { describe, it, expect, afterEach } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

const { tokensAuthMiddleware } =
  (await import("../../workers/api/src/middleware/auth.js")) as unknown as {
    tokensAuthMiddleware: MiddlewareHandler;
  };

function mockSecret(value: string) {
  return { get: () => Promise.resolve(value) };
}

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

async function seed(db: TestDatabase["db"], scopes: string[]) {
  const { token, lookupId, secret } = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "t",
      scopes: JSON.stringify(scopes),
    })
    .run();
  return token;
}

function app(db: TestDatabase["db"]) {
  const a = new Hono();
  a.use("*", tokensAuthMiddleware);
  // /tokens/me must be reachable by any valid identity (read+).
  a.get("/tokens/me", (c) => c.json({ ok: true }));
  // Any other token route is admin-only.
  a.get("/tokens/abc", (c) => c.json({ ok: true }));
  return (path: string, token?: string) =>
    a.request(path, token ? { headers: { Authorization: `Bearer ${token}` } } : {}, {
      DB: db,
      RELEASES_API_KEY: mockSecret("root-secret"),
    });
}

describe("tokensAuthMiddleware", () => {
  it("read-only token reaches GET /tokens/me", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    expect((await app(h.db)("/tokens/me", token)).status).toBe(200);
  });

  it("anonymous request to /tokens/me is 401", async () => {
    h = createTestDb();
    expect((await app(h.db)("/tokens/me")).status).toBe(401);
  });

  it("read-only token is 403 on a non-me token route (still admin)", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    expect((await app(h.db)("/tokens/abc", token)).status).toBe(403);
  });

  it("admin token reaches a non-me token route", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["admin"]);
    expect((await app(h.db)("/tokens/abc", token)).status).toBe(200);
  });

  it("static root key reaches /tokens/me", async () => {
    h = createTestDb();
    expect((await app(h.db)("/tokens/me", "root-secret")).status).toBe(200);
  });
});

// Mirrors the real index.ts wiring: tokensAuthMiddleware runs on the `v1`
// sub-app, which is mounted at `/v1`, so `c.req.path` is the FULL `/v1/tokens/me`
// here (not the bare `/tokens/me` the standalone tests above see). This guards
// the exact-path match against a regression to `=== "/tokens/me"`, which would
// silently admin-gate `/me` in production while leaving the standalone tests green.
function prodApp(db: TestDatabase["db"]) {
  const v1 = new Hono();
  v1.use("/tokens", tokensAuthMiddleware);
  v1.use("/tokens/*", tokensAuthMiddleware);
  v1.get("/tokens/me", (c) => c.json({ ok: true }));
  v1.get("/tokens/abc", (c) => c.json({ ok: true }));
  const root = new Hono();
  root.route("/v1", v1);
  return (path: string, token?: string) =>
    root.request(path, token ? { headers: { Authorization: `Bearer ${token}` } } : {}, {
      DB: db,
      RELEASES_API_KEY: mockSecret("root-secret"),
    });
}

describe("tokensAuthMiddleware under the /v1 mount (production path shape)", () => {
  it("read-only token reaches GET /v1/tokens/me", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    expect((await prodApp(h.db)("/v1/tokens/me", token)).status).toBe(200);
  });

  it("anonymous request to /v1/tokens/me is 401", async () => {
    h = createTestDb();
    expect((await prodApp(h.db)("/v1/tokens/me")).status).toBe(401);
  });

  it("read-only token is 403 on a non-me /v1/tokens route (still admin)", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    expect((await prodApp(h.db)("/v1/tokens/abc", token)).status).toBe(403);
  });
});
