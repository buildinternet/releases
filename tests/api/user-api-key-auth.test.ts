import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { createAuth } from "../../workers/api/src/auth/index.js";
import { publicReadAuthMiddleware } from "../../workers/api/src/middleware/auth.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import { scopeToPermissions } from "../../workers/api/src/auth/api-key-scope.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

function env() {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

// A tiny app guarding an unsafe (POST) route with the public-read middleware,
// which requires `write` for non-safe methods.
function app() {
  const a = new Hono<Env>();
  a.use("/thing", publicReadAuthMiddleware);
  a.post("/thing", (c) => c.json({ ok: true }));
  return a;
}

// betterAuth's inferred api type omits the flag-gated apiKey endpoints; assert the
// shape under test with a precise (non-any) structural cast.
async function mintKey(scope: "read" | "write") {
  h!.db
    .insert(user)
    .values({
      id: "user_1",
      name: "T",
      email: "t@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const auth = await createAuth(env(), undefined, { db: h!.db });
  const api = auth.api as typeof auth.api & {
    createApiKey: (a: {
      body: { name: string; userId: string; permissions: Record<string, string[]> };
    }) => Promise<{ key: string }>;
  };
  const created = await api.createApiKey({
    body: { name: "k", userId: "user_1", permissions: scopeToPermissions(scope) },
  });
  return created.key;
}

describe("relu_ user key auth on the public-read middleware", () => {
  it("a write key passes a POST (unsafe method requires write)", async () => {
    h = createTestDb();
    const key = await mintKey("write");
    const res = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      env(),
    );
    expect(res.status).toBe(200);
  });

  it("a read key is rejected on a POST with 403 insufficient_scope", async () => {
    h = createTestDb();
    const key = await mintKey("read");
    const res = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });

  it("a bogus relu_ key is rejected 401", async () => {
    h = createTestDb();
    const res = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: "Bearer relu_deadbeefdeadbeef" } },
      env(),
    );
    expect(res.status).toBe(401);
  });
});
