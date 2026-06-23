import { describe, it, expect, afterEach, beforeAll, spyOn } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  createLocalJWKSet,
  type JWTVerifyGetKey,
  type CryptoKey,
} from "jose";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

type EdgeLimiter = { limit(o: { key: string }): Promise<{ success: boolean }> };
const { publicRateLimitMiddleware, selectAuthEdgeLimiter, edgeRateLimitIpKey } =
  (await import("../../workers/api/src/middleware/rate-limit.js")) as unknown as {
    publicRateLimitMiddleware: MiddlewareHandler;
    selectAuthEdgeLimiter: (
      method: string,
      enabledVar: string | undefined,
      limiter: EdgeLimiter | undefined,
    ) => EdgeLimiter | undefined;
    edgeRateLimitIpKey: (ip: string) => string;
  };

type LimitResult = { success: boolean };
type RateLimiter = { limit(options: { key: string }): Promise<LimitResult> };
type Env = {
  Bindings: {
    RATE_LIMIT_ENABLED?: string;
    PUBLIC_RATE_LIMITER?: RateLimiter;
    TOKEN_RATE_LIMIT_ENABLED?: string;
    TOKEN_RATE_LIMITER?: RateLimiter;
    USER_RATE_LIMITER?: RateLimiter;
    USER_API_KEYS_ENABLED?: string;
    API_TOKENS_DISABLED?: string;
    RELEASES_API_KEY?: { get(): Promise<string> };
    RELEASES_PROXY_KEY?: { get(): Promise<string> };
    BETTER_AUTH_URL?: string;
    DB?: unknown;
    // Test seams injected via the bindings dict (functions, not wire-safe, test-only).
    // The createApp seam middleware copies these from bindings to Hono context variables.
    oauthJwtKeyResolver?: JWTVerifyGetKey;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    betterAuth?: any;
    CREDENTIAL_CACHE?: undefined;
  };
};

// ---------------------------------------------------------------------------
// JWT fixtures for the OAuth-JWT account-tier test
// ---------------------------------------------------------------------------

// The AS issuer and audience used by oauthJwtConfig in auth.ts (requires BETTER_AUTH_URL).
const ISSUER = "https://api.releases.sh/api/auth";
const AUDIENCE = "https://api.releases.sh";

let jwtPrivateKey: CryptoKey;
let jwtKeyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  jwtPrivateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  jwtKeyResolver = createLocalJWKSet({ keys: [jwk] });
});

/**
 * Create a real signed JWT for the given subject. Must pass a valid keyResolver
 * via the oauthJwtKeyResolver seam so verifyPresentedJwt can verify it without
 * a live JWKS endpoint. BETTER_AUTH_URL must be set so oauthJwtConfig is non-null.
 */
async function signedJwt(sub: string, scope = "read"): Promise<string> {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(jwtPrivateKey);
}

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a minimal Hono app. A seam middleware runs BEFORE publicRateLimitMiddleware
 * to copy test-only bindings (oauthJwtKeyResolver, betterAuth) into Hono context
 * variables — the slots that verifyPresentedJwt and getOrCreateAuth read.
 */
function createApp() {
  const app = new Hono<Env>();
  // Seam: promote test-only bindings into Hono Variables before the middleware runs.
  app.use("*", async (c, next) => {
    if ((c.env as Env["Bindings"]).oauthJwtKeyResolver) {
      (c as any).set("oauthJwtKeyResolver", (c.env as Env["Bindings"]).oauthJwtKeyResolver);
    }
    if ((c.env as Env["Bindings"]).betterAuth) {
      (c as any).set("betterAuth", (c.env as Env["Bindings"]).betterAuth);
    }
    await next();
  });
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
        RELEASES_API_KEY: mockSecret("secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
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
        RELEASES_API_KEY: mockSecret("secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
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
        RELEASES_API_KEY: mockSecret("root-secret"),
      },
    );
    expect(res.status).toBe(429);
    expect(ipLimiter.calls).toEqual(["9.9.9.9"]);
    expect(tokenLimiter.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateAccountCredential — flag-gated relu_ tier validation
// ---------------------------------------------------------------------------

const { validateAccountCredential } =
  (await import("../../workers/api/src/middleware/auth.js")) as unknown as {
    validateAccountCredential: (
      c: any,
      presented: string,
    ) => Promise<{ valid: boolean; userId?: string }>;
  };

const fakeBetterAuth = (result: {
  valid: boolean;
  userId?: string | null;
  permissions?: Record<string, string[]> | null;
}) => ({
  api: {
    verifyApiKey: async () => ({
      valid: result.valid,
      key: result.valid
        ? {
            id: "key_1",
            userId: result.userId ?? null,
            permissions: result.permissions ?? { api: ["read"] },
          }
        : null,
    }),
  },
});

/**
 * Build a minimal Hono app for validateAccountCredential tests.
 * The seam middleware MUST be registered before the /probe route handler so
 * Hono executes it first and c.get("betterAuth") is populated when the handler
 * calls getOrCreateAuth(). Accepts the seam as an argument so registration order
 * is deterministic (middleware → route, never route → middleware).
 */
function authApp(seamMiddleware: (c: any, next: any) => Promise<void>) {
  const app = new Hono<any>();
  app.use("*", seamMiddleware);
  app.get("/probe", async (c) => {
    const presented = (c.req.header("authorization") ?? "").replace("Bearer ", "");
    return c.json(await validateAccountCredential(c as any, presented));
  });
  return app;
}

describe("validateAccountCredential", () => {
  it("resolves a valid relu_ key to {valid:true,userId} when the flag is on", async () => {
    const app = authApp(async (c, next) => {
      c.set("betterAuth", fakeBetterAuth({ valid: true, userId: "user_42" }));
      await next();
    });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer relu_abc" } },
      { USER_API_KEYS_ENABLED: "true", API_TOKENS_DISABLED: "false" },
    );
    expect(await res.json()).toEqual({ valid: true, userId: "user_42" });
  });

  it("resolves to {valid:false} when the user-keys flag is off (relu_ dark)", async () => {
    const app = authApp(async (c, next) => {
      c.set("betterAuth", fakeBetterAuth({ valid: true, userId: "user_42" }));
      await next();
    });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer relu_abc" } },
      { USER_API_KEYS_ENABLED: "false", API_TOKENS_DISABLED: "false" },
    );
    expect(await res.json()).toEqual({ valid: false });
  });

  it("resolves a junk relu_-shaped string to {valid:false}", async () => {
    const app = authApp(async (c, next) => {
      c.set("betterAuth", fakeBetterAuth({ valid: false }));
      await next();
    });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer relu_junk" } },
      { USER_API_KEYS_ENABLED: "true", API_TOKENS_DISABLED: "false" },
    );
    expect(await res.json()).toEqual({ valid: false });
  });

  // Task 4 review: API_TOKENS_DISABLED kill switch must refuse even with a
  // Better-Auth-valid key and the user-keys flag on — fail closed.
  it("resolves to {valid:false} when API_TOKENS_DISABLED kill switch is on", async () => {
    const app = authApp(async (c, next) => {
      // Better Auth would return valid, but the kill switch gates first.
      c.set("betterAuth", fakeBetterAuth({ valid: true, userId: "user_99" }));
      await next();
    });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer relu_abc" } },
      { USER_API_KEYS_ENABLED: "true", API_TOKENS_DISABLED: "true" },
    );
    expect(await res.json()).toEqual({ valid: false });
  });
});

// ---------------------------------------------------------------------------
// account tier — OAuth-JWT and relu_ users hit the account limiter (300/min)
// ---------------------------------------------------------------------------

describe("account tier", () => {
  it("buckets an OAuth-JWT user at the account limiter keyed on the user id", async () => {
    // resolveAuthIdentity → verifyPresentedJwt uses the injected oauthJwtKeyResolver.
    // BETTER_AUTH_URL must be set so oauthJwtConfig() returns a non-null config.
    // The JWT subject "user_9" → tokenId "oauth_user_9" → account bucket keyed on
    // the userId "user_9" (oauth_ prefix stripped) so it shares the per-account budget.
    const token = await signedJwt("user_9");
    const account = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "9.9.9.9" } },
      {
        RATE_LIMIT_ENABLED: "true",
        BETTER_AUTH_URL: "https://api.releases.sh",
        USER_RATE_LIMITER: account,
        oauthJwtKeyResolver: jwtKeyResolver,
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual(["user_9"]);
  });

  it("buckets a valid relu_ key at the account limiter keyed on userId (via cache)", async () => {
    // resolveAuthIdentity resolves relu_ to anonymous (no meter), so classifyPrincipal
    // calls validateAccountCredential directly — exercised via the betterAuth seam.
    const account = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: "Bearer relu_live", "cf-connecting-ip": "9.9.9.9" } },
      {
        RATE_LIMIT_ENABLED: "true",
        USER_API_KEYS_ENABLED: "true",
        API_TOKENS_DISABLED: "false",
        USER_RATE_LIMITER: account,
        CREDENTIAL_CACHE: undefined, // no-cache path → validateAccountCredential directly
        betterAuth: fakeBetterAuth({ valid: true, userId: "user_77" }),
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual(["user_77"]);
  });

  it("BYPASS GUARD: a junk relu_ string falls to the per-IP anonymous limiter, never account", async () => {
    // The account tier for relu_ keys goes through validateAccountCredential behind
    // the cache. A junk key fails validation → falls to anonymous IP bucket.
    const account = mockLimiter([true]);
    const ip = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: "Bearer relu_junk", "cf-connecting-ip": "5.5.5.5" } },
      {
        RATE_LIMIT_ENABLED: "true",
        USER_API_KEYS_ENABLED: "true",
        API_TOKENS_DISABLED: "false",
        USER_RATE_LIMITER: account,
        PUBLIC_RATE_LIMITER: ip,
        betterAuth: fakeBetterAuth({ valid: false }),
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual([]); // never reached the account bucket
    expect(ip.calls).toEqual(["5.5.5.5"]); // capped by IP instead
  });

  it("keeps relk_ machine tokens on the 600 token limiter, not the account limiter", async () => {
    // A seeded relk_ token resolves via DB lookup to a tokenId → machine rung.
    h = createTestDb();
    const { token, tokenId } = await seedToken(h.db, ["read"]);
    const tokenLimiter = mockLimiter([true]);
    const account = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": "9.9.9.9" } },
      {
        TOKEN_RATE_LIMIT_ENABLED: "true",
        TOKEN_RATE_LIMITER: tokenLimiter,
        USER_RATE_LIMITER: account,
        RELEASES_API_KEY: mockSecret("root-secret"),
        DB: h.db,
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual([]);
    expect(tokenLimiter.calls).toEqual([tokenId]);
  });
});

describe("consumption decision event", () => {
  it("emits a decision event for an allowed account request with tier + hashed consumerRef", async () => {
    const logs: any[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: string) => {
      try {
        logs.push(JSON.parse(line));
      } catch {
        /* non-JSON line */
      }
    });
    const account = mockLimiter([true]);
    const app = createApp();
    try {
      await app.request(
        "/test",
        { headers: { authorization: "Bearer relu_live", "cf-connecting-ip": "9.9.9.9" } },
        {
          RATE_LIMIT_ENABLED: "true",
          USER_API_KEYS_ENABLED: "true",
          USER_RATE_LIMITER: account,
          betterAuth: fakeBetterAuth({ valid: true, userId: "user_77" }),
        },
      );
    } finally {
      spy.mockRestore();
    }
    const decision = logs.find((l) => l.component === "rate-limit" && l.event === "decision");
    expect(decision).toBeDefined();
    expect(decision.tier).toBe("account");
    expect(decision.rateLimited).toBe(false);
    expect(decision.surface).toBe("api");
    expect(decision.consumerRef).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(decision)).not.toContain("user_77"); // hashed, not raw
  });

  it("always emits a decision event when a request is throttled", async () => {
    const logs: any[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: string) => {
      try {
        logs.push(JSON.parse(line));
      } catch {
        /* non-JSON line */
      }
    });
    const account = mockLimiter([false]); // over quota
    const app = createApp();
    try {
      await app.request(
        "/test",
        { headers: { authorization: "Bearer relu_live", "cf-connecting-ip": "9.9.9.9" } },
        {
          RATE_LIMIT_ENABLED: "true",
          USER_API_KEYS_ENABLED: "true",
          USER_RATE_LIMITER: account,
          betterAuth: fakeBetterAuth({ valid: true, userId: "user_77" }),
        },
      );
    } finally {
      spy.mockRestore();
    }
    const decision = logs.find((l) => l.component === "rate-limit" && l.event === "decision");
    expect(decision).toBeDefined();
    expect(decision.rateLimited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge auth limiter selection (#1728) — gating in front of /api/auth/*
// ---------------------------------------------------------------------------

describe("selectAuthEdgeLimiter", () => {
  const limiter: EdgeLimiter = { limit: async () => ({ success: true }) };

  it("returns the limiter for a POST when enabled (default-on) and bound", () => {
    expect(selectAuthEdgeLimiter("POST", undefined, limiter)).toBe(limiter);
    expect(selectAuthEdgeLimiter("POST", "true", limiter)).toBe(limiter);
  });

  it("exempts GET session reads", () => {
    expect(selectAuthEdgeLimiter("GET", "true", limiter)).toBeUndefined();
  });

  it("honors the explicit 'false' kill switch", () => {
    expect(selectAuthEdgeLimiter("POST", "false", limiter)).toBeUndefined();
  });

  it("is a no-op when the binding is unbound (e.g. staging)", () => {
    expect(selectAuthEdgeLimiter("POST", "true", undefined)).toBeUndefined();
  });
});

describe("edgeRateLimitIpKey", () => {
  it("passes IPv4 and the unknown sentinel through unchanged", () => {
    expect(edgeRateLimitIpKey("1.2.3.4")).toBe("1.2.3.4");
    expect(edgeRateLimitIpKey("unknown")).toBe("unknown");
  });

  it("collapses IPv6 to its /64 prefix", () => {
    expect(edgeRateLimitIpKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(edgeRateLimitIpKey("2001:db8:0:0:0:0:0:abcd")).toBe("2001:db8:0:0::/64");
  });

  it("gives the same /64 key for the compressed and expanded forms", () => {
    expect(edgeRateLimitIpKey("2001:db8:1:2::ff")).toBe(
      edgeRateLimitIpKey("2001:db8:1:2:0:0:0:ff"),
    );
  });

  it("buckets two addresses in the same /64 together but a different /64 apart", () => {
    const a = edgeRateLimitIpKey("2001:db8:aaaa:bbbb::1");
    const b = edgeRateLimitIpKey("2001:db8:aaaa:bbbb::2");
    const c = edgeRateLimitIpKey("2001:db8:aaaa:cccc::1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("strips a zone id and handles loopback", () => {
    expect(edgeRateLimitIpKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(edgeRateLimitIpKey("::1")).toBe("0:0:0:0::/64");
  });
});
