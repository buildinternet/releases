import { describe, it, expect, afterEach } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

const { publicRateLimitMiddleware } =
  (await import("../../workers/api/src/middleware/rate-limit.js")) as unknown as {
    publicRateLimitMiddleware: MiddlewareHandler;
  };

type LimitResult = { success: boolean };
type RateLimiter = { limit(options: { key: string }): Promise<LimitResult> };
type Env = {
  Bindings: {
    RATE_LIMIT_ENABLED?: string;
    PUBLIC_RATE_LIMITER?: RateLimiter;
    RELEASED_API_KEY?: { get(): Promise<string> };
    DB?: unknown;
  };
};

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

async function seedReadToken(db: TestDatabase["db"]) {
  const { token, lookupId, secret } = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "read-token",
      scopes: JSON.stringify(["read"]),
    })
    .run();
  return token;
}

function mockSecret(value: string) {
  return { get: () => Promise.resolve(value) };
}

/** Limiter that records every key it was called with and returns the queued results in order. */
function mockLimiter(results: boolean[]): RateLimiter & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      const success = results[i] ?? true;
      i += 1;
      return { success };
    },
  };
}

function createApp() {
  const app = new Hono<Env>();
  app.use("*", publicRateLimitMiddleware);
  app.get("/test", (c) => c.json({ ok: true }));
  app.post("/test", (c) => c.json({ created: true }, 201));
  return app;
}

describe("publicRateLimitMiddleware", () => {
  it("is a no-op when RATE_LIMIT_ENABLED is not 'true'", async () => {
    const app = createApp();
    const limiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { "cf-connecting-ip": "1.2.3.4" } },
      { PUBLIC_RATE_LIMITER: limiter, RATE_LIMIT_ENABLED: "false" },
    );
    expect(res.status).toBe(200);
    expect(limiter.calls).toEqual([]);
  });

  it("is a no-op when the binding is missing (local dev)", async () => {
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { "cf-connecting-ip": "1.2.3.4" } },
      { RATE_LIMIT_ENABLED: "true" },
    );
    expect(res.status).toBe(200);
  });

  it("allows the request when the limiter returns success", async () => {
    const app = createApp();
    const limiter = mockLimiter([true]);
    const res = await app.request(
      "/test",
      { headers: { "cf-connecting-ip": "1.2.3.4" } },
      { PUBLIC_RATE_LIMITER: limiter, RATE_LIMIT_ENABLED: "true" },
    );
    expect(res.status).toBe(200);
    expect(limiter.calls).toEqual(["1.2.3.4"]);
  });

  it("returns 429 with Retry-After when the limiter rejects", async () => {
    const app = createApp();
    const limiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { "cf-connecting-ip": "9.9.9.9" } },
      { PUBLIC_RATE_LIMITER: limiter, RATE_LIMIT_ENABLED: "true" },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
    expect(limiter.calls).toEqual(["9.9.9.9"]);
  });

  it("keys the limiter by cf-connecting-ip", async () => {
    const app = createApp();
    const limiter = mockLimiter([true, true]);
    await app.request(
      "/test",
      { headers: { "cf-connecting-ip": "1.1.1.1" } },
      { PUBLIC_RATE_LIMITER: limiter, RATE_LIMIT_ENABLED: "true" },
    );
    await app.request(
      "/test",
      { headers: { "cf-connecting-ip": "2.2.2.2" } },
      { PUBLIC_RATE_LIMITER: limiter, RATE_LIMIT_ENABLED: "true" },
    );
    expect(limiter.calls).toEqual(["1.1.1.1", "2.2.2.2"]);
  });

  it("falls back to 'unknown' when cf-connecting-ip is absent", async () => {
    const app = createApp();
    const limiter = mockLimiter([true]);
    await app.request("/test", {}, { PUBLIC_RATE_LIMITER: limiter, RATE_LIMIT_ENABLED: "true" });
    expect(limiter.calls).toEqual(["unknown"]);
  });

  it("bypasses the limiter for a valid Bearer token", async () => {
    const app = createApp();
    const limiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Bearer secret", "cf-connecting-ip": "1.2.3.4" } },
      {
        PUBLIC_RATE_LIMITER: limiter,
        RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("secret"),
      },
    );
    expect(res.status).toBe(200);
    expect(limiter.calls).toEqual([]);
  });

  it("bypasses the limiter for a read-only DB token (any valid token skips rate limit)", async () => {
    h = createTestDb();
    const token = await seedReadToken(h.db);
    const app = createApp();
    const limiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: `Bearer ${token}`, "cf-connecting-ip": "1.2.3.4" } },
      {
        PUBLIC_RATE_LIMITER: limiter,
        RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("root-secret"),
        DB: h.db,
      },
    );
    // The limiter binding is never consulted for an authenticated caller.
    expect(limiter.calls).toEqual([]);
    // And the request is allowed through.
    expect(res.status).toBe(200);
  });

  it("still limits requests that present an invalid Bearer token", async () => {
    const app = createApp();
    const limiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Bearer wrong", "cf-connecting-ip": "1.2.3.4" } },
      {
        PUBLIC_RATE_LIMITER: limiter,
        RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("secret"),
      },
    );
    expect(res.status).toBe(429);
    expect(limiter.calls).toEqual(["1.2.3.4"]);
  });

  it("does not rate-limit non-safe methods (writes are already auth-gated)", async () => {
    const app = createApp();
    const limiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { method: "POST", headers: { "cf-connecting-ip": "1.2.3.4" } },
      { PUBLIC_RATE_LIMITER: limiter, RATE_LIMIT_ENABLED: "true" },
    );
    expect(res.status).toBe(201);
    expect(limiter.calls).toEqual([]);
  });
});
