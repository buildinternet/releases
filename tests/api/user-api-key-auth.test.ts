import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { createAuth } from "../../workers/api/src/auth/index.js";
import {
  publicReadAuthMiddleware,
  resolveAuthIdentity,
} from "../../workers/api/src/middleware/auth.js";
import { user, apikey } from "../../workers/api/src/db/schema-auth.js";
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

// Seed the single owning user the keys are minted for.
function insertUser() {
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
}

// betterAuth's inferred api type omits the flag-gated apiKey endpoints; assert the
// shape under test with a precise (non-any) structural cast.
async function mintKey(scope: "read" | "write") {
  insertUser();
  const auth = await createAuth(env(), undefined, { db: h!.db });
  const api = auth.api as typeof auth.api & {
    createApiKey: (a: {
      body: { name: string; userId: string; permissions: Record<string, string[]> };
    }) => Promise<{ key: string; id: string }>;
  };
  const created = await api.createApiKey({
    body: { name: "k", userId: "user_1", permissions: scopeToPermissions(scope) },
  });
  return { key: created.key, id: created.id };
}

describe("relu_ user key auth on the public-read middleware", () => {
  it("a write-permissioned key is clamped to read → POST 403 (user keys are read-only)", async () => {
    h = createTestDb();
    // Minted directly with write permissions (bypassing the read-only mint cap)
    // to prove the auth resolver clamps every relu_ key to read regardless of
    // its stored permissions — write is unreachable for the user lane.
    const { key } = await mintKey("write");
    const res = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      env(),
    );
    expect(res.status).toBe(403);
  });

  it("a read key is rejected on a POST with 403 insufficient_scope", async () => {
    h = createTestDb();
    const { key } = await mintKey("read");
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

// Rate limiting only enforces when the plugin's master switch is on, which is
// `env.ENVIRONMENT === "production"` in createAuth. AUTH_RATE_LIMIT_DISABLED keeps
// the SEPARATE top-level betterAuth auth-endpoint limiter off (it's independent of
// the apiKey plugin limiter and irrelevant to /thing), so this stays isolated.
function prodEnv() {
  return {
    ENVIRONMENT: "production",
    AUTH_RATE_LIMIT_DISABLED: "true",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

describe("relu_ key rate limiting", () => {
  // User keys are read-only, so an unsafe POST is metered (verifyApiKey runs and
  // ticks the per-key budget) and THEN scope-denied with 403 — the metering
  // happens before the scope check. So the first request is 403, and once the
  // per-key budget is spent the second request short-circuits to 429.
  it("meters every unsafe request and returns 429 once the per-key budget is exhausted", async () => {
    h = createTestDb();
    insertUser();
    const auth = await createAuth(prodEnv(), undefined, { db: h.db });
    // betterAuth's inferred api type omits the flag-gated apiKey endpoints; assert
    // the create shape (incl. the server-only per-key rate-limit fields) precisely.
    const api = auth.api as typeof auth.api & {
      createApiKey: (a: {
        body: {
          name: string;
          userId: string;
          permissions: Record<string, string[]>;
          rateLimitEnabled: boolean;
          rateLimitMax: number;
          rateLimitTimeWindow: number;
        };
      }) => Promise<{ key: string }>;
    };
    // Per-key override: 1 request per hour. Read scope (the only thing a user key
    // can hold); the clamp still meters the request before denying the write.
    const created = await api.createApiKey({
      body: {
        name: "tight",
        userId: "user_1",
        permissions: scopeToPermissions("read"),
        rateLimitEnabled: true,
        rateLimitMax: 1,
        rateLimitTimeWindow: 1000 * 60 * 60,
      },
    });
    const key = created.key;

    // Metered, then scope-denied (read key on a write-required route).
    const once = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      prodEnv(),
    );
    expect(once.status).toBe(403);

    // deferUpdates floats the requestCount write; flush so it lands before the
    // second verify reads the key.
    await new Promise((r) => setTimeout(r, 0));

    // Budget spent → verify short-circuits to rate-limited before the scope check.
    const twice = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      prodEnv(),
    );
    expect(twice.status).toBe(429);
  });
});

// A GET route guarded by the public-read middleware (safe method → public).
function readApp() {
  const a = new Hono<Env>();
  a.use("/thing", publicReadAuthMiddleware);
  a.get("/thing", (c) => c.json({ ok: true }));
  return a;
}

describe("relu_ public-read metering exemption", () => {
  // The write path's metering is already proven by the existing "relu_ key rate
  // limiting" describe above (a 2nd POST → 429 once the per-key budget is spent).
  // This test proves the NEW behavior: a public GET never invokes verifyApiKey, so
  // the key row is never touched (lastRequest stays exactly null from minting).
  it("a public GET does NOT meter the key (lastRequest stays null)", async () => {
    h = createTestDb();
    const { key, id } = await mintKey("write");
    const res = await readApp().request(
      "/thing",
      { headers: { Authorization: `Bearer ${key}` } },
      env(),
    );
    expect(res.status).toBe(200); // public read succeeds regardless of the key
    await new Promise((r) => setTimeout(r, 0)); // flush any deferred writes (there are none)
    const row = h.db.select().from(apikey).where(eq(apikey.id, id)).get();
    expect(row?.lastRequest ?? null).toBeNull(); // never verified → never metered
  });

  it("resolveAuthIdentity returns null for a relu_ key (limiter never meters user keys)", async () => {
    h = createTestDb();
    const { key } = await mintKey("write");
    const a = new Hono<Env>();
    a.get("/p", async (c) => c.json({ id: await resolveAuthIdentity(c) }));
    const res = await a.request("/p", { headers: { Authorization: `Bearer ${key}` } }, env());
    const body = (await res.json()) as { id: unknown };
    expect(body.id).toBeNull();
  });
});
