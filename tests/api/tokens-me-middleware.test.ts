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
      RELEASED_API_KEY: mockSecret("root-secret"),
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
