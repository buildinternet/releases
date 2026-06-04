import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createTestDb } from "./setup";
import { user, session, account, verification } from "../src/db/schema-auth.js";
import {
  buildSocialProviders,
  authTrustedOrigins,
  authCorsMiddleware,
  deriveCookieDomain,
} from "../src/auth/index.js";

// ── Pure helpers ──

describe("buildSocialProviders gating", () => {
  it("omits both providers when no creds are present", () => {
    expect(buildSocialProviders({})).toEqual({});
  });

  it("requires BOTH halves of a credential pair", () => {
    expect(buildSocialProviders({ googleClientId: "id" })).toEqual({});
    expect(buildSocialProviders({ googleClientSecret: "sec" })).toEqual({});
    expect(buildSocialProviders({ githubClientId: "gid" })).toEqual({});
  });

  it("includes google only when id + secret both resolve", () => {
    const p = buildSocialProviders({ googleClientId: "id", googleClientSecret: "sec" });
    expect(p.google).toEqual({ clientId: "id", clientSecret: "sec" });
    expect(p.github).toBeUndefined();
  });

  it("includes github independently of google", () => {
    const p = buildSocialProviders({ githubClientId: "gid", githubClientSecret: "gsec" });
    expect(Object.keys(p)).toEqual(["github"]);
  });

  it("treats empty strings as absent", () => {
    expect(buildSocialProviders({ googleClientId: "id", googleClientSecret: "" })).toEqual({});
  });
});

describe("deriveCookieDomain", () => {
  it("strips the leftmost host label from BETTER_AUTH_URL", () => {
    expect(deriveCookieDomain({ BETTER_AUTH_URL: "https://api.releases.sh" } as never)).toBe(
      ".releases.sh",
    );
    expect(deriveCookieDomain({ BETTER_AUTH_URL: "https://api.releases.localhost" } as never)).toBe(
      ".releases.localhost",
    );
  });

  it("prefers an explicit BETTER_AUTH_COOKIE_DOMAIN", () => {
    expect(
      deriveCookieDomain({
        BETTER_AUTH_URL: "https://api.releases.sh",
        BETTER_AUTH_COOKIE_DOMAIN: ".example.com",
      } as never),
    ).toBe(".example.com");
  });

  it("returns undefined when nothing is configured", () => {
    expect(deriveCookieDomain({} as never)).toBeUndefined();
  });
});

describe("authTrustedOrigins", () => {
  it("always includes the releases.sh/.localhost family", () => {
    const origins = authTrustedOrigins({} as never);
    expect(origins).toContain("https://releases.sh");
    expect(origins).toContain("https://releases.localhost");
  });

  it("merges comma-separated extras without duplicates", () => {
    const origins = authTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: "https://x.vercel.app, https://releases.sh",
    } as never);
    expect(origins).toContain("https://x.vercel.app");
    expect(origins.filter((o) => o === "https://releases.sh")).toHaveLength(1);
  });

  it("adds bare-loopback dev origins outside production", () => {
    const origins = authTrustedOrigins({} as never);
    expect(origins).toContain("http://localhost:3000");
    expect(origins).toContain("http://127.0.0.1:3000");
  });

  it("excludes loopback origins in production", () => {
    const origins = authTrustedOrigins({ ENVIRONMENT: "production" } as never);
    expect(origins).not.toContain("http://localhost:3000");
    expect(origins).toEqual(["https://releases.sh", "https://releases.localhost"]);
  });
});

describe("authCorsMiddleware origin allow-list", () => {
  // Drive a real CORS preflight through the middleware and read back the
  // reflected Access-Control-Allow-Origin (null when the origin is rejected).
  async function preflightOrigin(
    origin: string,
    env: { ENVIRONMENT?: string; BETTER_AUTH_TRUSTED_ORIGINS?: string } = {},
  ): Promise<string | null> {
    const app = new Hono();
    app.use("/api/auth/*", authCorsMiddleware());
    app.get("/api/auth/ok", (c) => c.text("ok"));
    const res = await app.request(
      "/api/auth/ok",
      { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } },
      env as never,
    );
    return res.headers.get("access-control-allow-origin");
  }

  it("reflects the releases.sh family in production", async () => {
    expect(await preflightOrigin("https://releases.sh", { ENVIRONMENT: "production" })).toBe(
      "https://releases.sh",
    );
    expect(await preflightOrigin("https://app.releases.sh", { ENVIRONMENT: "production" })).toBe(
      "https://app.releases.sh",
    );
  });

  it("rejects bare-loopback origins in production", async () => {
    expect(
      await preflightOrigin("http://localhost:3000", { ENVIRONMENT: "production" }),
    ).toBeNull();
    expect(
      await preflightOrigin("http://127.0.0.1:3000", { ENVIRONMENT: "production" }),
    ).toBeNull();
  });

  it("allows bare-loopback origins outside production", async () => {
    expect(await preflightOrigin("http://localhost:3000", { ENVIRONMENT: "development" })).toBe(
      "http://localhost:3000",
    );
    expect(await preflightOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  it("reflects a configured BETTER_AUTH_TRUSTED_ORIGINS host in any environment", async () => {
    const dev = "https://releases.local.buildinternet.dev";
    expect(
      await preflightOrigin(dev, { ENVIRONMENT: "development", BETTER_AUTH_TRUSTED_ORIGINS: dev }),
    ).toBe(dev);
    // A portless/preview host explicitly trusted in prod is honored by CORS too —
    // the allow-list stays in lockstep with authTrustedOrigins.
    const preview = "https://feat-x.vercel.app";
    expect(
      await preflightOrigin(preview, {
        ENVIRONMENT: "production",
        BETTER_AUTH_TRUSTED_ORIGINS: preview,
      }),
    ).toBe(preview);
  });

  it("rejects unknown origins regardless of environment", async () => {
    expect(
      await preflightOrigin("https://evil.example.com", { ENVIRONMENT: "development" }),
    ).toBeNull();
    expect(
      await preflightOrigin("https://evil.example.com", { ENVIRONMENT: "production" }),
    ).toBeNull();
  });
});

// ── Integration: real Better Auth handler over the migrated D1 schema ──
// createTestDb() applies every migration under workers/api/migrations/, so the
// user/session/account/verification tables exist. This exercises the actual
// column shapes through Better Auth's code paths — a mismatch would throw on
// insert and fail here.

function makeAuth() {
  const db = createTestDb();
  const auth = betterAuth({
    baseURL: "https://api.releases.localhost",
    secret: "test-secret-do-not-use-in-prod-0123456789",
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: true },
  });
  return { auth, db };
}

describe("email/password over the D1 schema", () => {
  it("signs up a user (writes user + credential account rows)", async () => {
    const { auth, db } = makeAuth();
    const res = await auth.api.signUpEmail({
      body: { email: "alice@example.com", password: "correct-horse-battery", name: "Alice" },
    });
    expect(res.user.email).toBe("alice@example.com");

    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
    // A credential account row carries the hashed password.
    const accounts = await db.select().from(account);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.password).toBeTruthy();
    expect(accounts[0]?.providerId).toBe("credential");
  });

  it("signs in with the right password and creates a session", async () => {
    const { auth, db } = makeAuth();
    await auth.api.signUpEmail({
      body: { email: "bob@example.com", password: "correct-horse-battery", name: "Bob" },
    });

    const signIn = await auth.api.signInEmail({
      body: { email: "bob@example.com", password: "correct-horse-battery" },
    });
    expect(signIn.user.email).toBe("bob@example.com");

    const sessions = await db.select().from(session);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a wrong password", async () => {
    const { auth } = makeAuth();
    await auth.api.signUpEmail({
      body: { email: "carol@example.com", password: "correct-horse-battery", name: "Carol" },
    });
    await expect(
      auth.api.signInEmail({ body: { email: "carol@example.com", password: "wrong-password" } }),
    ).rejects.toThrow();
  });
});
