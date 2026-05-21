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
    TOKEN_RATE_LIMIT_ENABLED?: string;
    TOKEN_RATE_LIMITER?: RateLimiter;
    RELEASED_API_KEY?: { get(): Promise<string> };
    RELEASES_PROXY_KEY?: { get(): Promise<string> };
    DB?: unknown;
  };
};

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

/** Seed a token with the given scopes and return both the secret and its tokenId. */
async function seedToken(db: TestDatabase["db"], scopes: string[]) {
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
  return { token, tokenId: `tok_${lookupId}` };
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
    const { token } = await seedToken(h.db, ["read"]);
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

describe("publicRateLimitMiddleware — per-token limiting", () => {
  it("limits a relk_ token by its tokenId when TOKEN_RATE_LIMIT_ENABLED", async () => {
    h = createTestDb();
    const { token, tokenId } = await seedToken(h.db, ["read"]);
    const app = createApp();
    const ipLimiter = mockLimiter([false]);
    const tokenLimiter = mockLimiter([true]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: `Bearer ${token}`, "cf-connecting-ip": "1.2.3.4" } },
      {
        PUBLIC_RATE_LIMITER: ipLimiter,
        RATE_LIMIT_ENABLED: "true",
        TOKEN_RATE_LIMITER: tokenLimiter,
        TOKEN_RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("root-secret"),
        DB: h.db,
      },
    );
    expect(res.status).toBe(200);
    // Keyed by the token's id, not the IP. IP limiter never consulted.
    expect(tokenLimiter.calls).toEqual([tokenId]);
    expect(ipLimiter.calls).toEqual([]);
  });

  it("returns 429 with a 'token' policy when a token is over quota", async () => {
    h = createTestDb();
    const { token, tokenId } = await seedToken(h.db, ["read"]);
    const app = createApp();
    const tokenLimiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: `Bearer ${token}`, "cf-connecting-ip": "1.2.3.4" } },
      {
        TOKEN_RATE_LIMITER: tokenLimiter,
        TOKEN_RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("root-secret"),
        DB: h.db,
      },
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("RateLimit-Policy")).toContain('"token"');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("rate_limited");
    expect(tokenLimiter.calls).toEqual([tokenId]);
  });

  it("exempts the static root key from the per-token limiter", async () => {
    const app = createApp();
    const tokenLimiter = mockLimiter([false]);
    const ipLimiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Bearer root-secret", "cf-connecting-ip": "1.2.3.4" } },
      {
        PUBLIC_RATE_LIMITER: ipLimiter,
        RATE_LIMIT_ENABLED: "true",
        TOKEN_RATE_LIMITER: tokenLimiter,
        TOKEN_RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("root-secret"),
      },
    );
    expect(res.status).toBe(200);
    expect(tokenLimiter.calls).toEqual([]);
    expect(ipLimiter.calls).toEqual([]);
  });

  it("exempts a trusted proxy even when it carries a token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, ["read"]);
    const app = createApp();
    const tokenLimiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Releases-Proxy-Key": "proxy-secret",
          "cf-connecting-ip": "1.2.3.4",
        },
      },
      {
        TOKEN_RATE_LIMITER: tokenLimiter,
        TOKEN_RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("root-secret"),
        RELEASES_PROXY_KEY: mockSecret("proxy-secret"),
        DB: h.db,
      },
    );
    expect(res.status).toBe(200);
    expect(tokenLimiter.calls).toEqual([]);
  });

  it("bypasses a token when TOKEN_RATE_LIMIT_ENABLED is unset (ships dark)", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, ["read"]);
    const app = createApp();
    const tokenLimiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: `Bearer ${token}`, "cf-connecting-ip": "1.2.3.4" } },
      {
        TOKEN_RATE_LIMITER: tokenLimiter,
        RELEASED_API_KEY: mockSecret("root-secret"),
        DB: h.db,
      },
    );
    expect(res.status).toBe(200);
    expect(tokenLimiter.calls).toEqual([]);
  });

  it("bypasses a token when the binding is missing even with the flag on", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, ["read"]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { Authorization: `Bearer ${token}`, "cf-connecting-ip": "1.2.3.4" } },
      {
        TOKEN_RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("root-secret"),
        DB: h.db,
      },
    );
    expect(res.status).toBe(200);
  });

  it("sends an invalid token to the per-IP limiter, never the token bucket", async () => {
    const app = createApp();
    const ipLimiter = mockLimiter([false]);
    const tokenLimiter = mockLimiter([false]);
    const res = await app.request(
      "/test",
      { headers: { Authorization: "Bearer wrong", "cf-connecting-ip": "9.9.9.9" } },
      {
        PUBLIC_RATE_LIMITER: ipLimiter,
        RATE_LIMIT_ENABLED: "true",
        TOKEN_RATE_LIMITER: tokenLimiter,
        TOKEN_RATE_LIMIT_ENABLED: "true",
        RELEASED_API_KEY: mockSecret("root-secret"),
      },
    );
    expect(res.status).toBe(429);
    expect(ipLimiter.calls).toEqual(["9.9.9.9"]);
    expect(tokenLimiter.calls).toEqual([]);
  });
});
