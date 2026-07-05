import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createTestDb } from "./setup";
import {
  user,
  session,
  account,
  verification,
  deviceCode,
  passkey,
} from "../src/db/schema-auth.js";
import {
  buildSocialProviders,
  buildStripePlugin,
  mapDisplayEmail,
  syncDisplayEmailOnUpdate,
  emailFromGoogleIdToken,
  displayEmailBackfill,
  resolveLastLoginMethodOverride,
  authTrustedOrigins,
  authCorsMiddleware,
  AUTH_CORS_ALLOWED_HEADERS,
  deriveCookieDomain,
  derivePasskeyRp,
  createAuth,
  type BetterAuthInstance,
} from "../src/auth/index.js";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DEVICE_AUTH_CLIENT_ID } from "@buildinternet/releases-core/api-token";
import { magicLinkTemplate, type AuthEmailMessage } from "../src/auth/email.js";

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
    // Google carries overrideUserInfoOnSignIn so the imported avatar/name re-sync
    // from Google on every sign-in (there's no profile-edit surface to clobber), and
    // mapProfileToUser to capture the original-cased displayEmail.
    expect(p.google).toEqual({
      clientId: "id",
      clientSecret: "sec",
      overrideUserInfoOnSignIn: true,
      mapProfileToUser: mapDisplayEmail,
    });
    expect(p.github).toBeUndefined();
  });

  it("includes github independently of google (no re-sync flag, still maps displayEmail)", () => {
    const p = buildSocialProviders({ githubClientId: "gid", githubClientSecret: "gsec" });
    expect(Object.keys(p)).toEqual(["github"]);
    // GitHub keeps Better Auth's default import-on-signup; only Google opted into re-sync.
    // Both providers capture displayEmail from the profile.
    expect(p.github).toEqual({
      clientId: "gid",
      clientSecret: "gsec",
      mapProfileToUser: mapDisplayEmail,
    });
  });

  it("treats empty strings as absent", () => {
    expect(buildSocialProviders({ googleClientId: "id", googleClientSecret: "" })).toEqual({});
  });
});

describe("mapDisplayEmail", () => {
  it("captures the provider email verbatim (original casing/dots preserved)", () => {
    expect(mapDisplayEmail({ email: "Mixed.case@example.com" })).toEqual({
      displayEmail: "Mixed.case@example.com",
    });
  });

  it("yields no field when the profile has no usable email (read path falls back)", () => {
    expect(mapDisplayEmail({})).toEqual({});
    expect(mapDisplayEmail({ email: null })).toEqual({});
    expect(mapDisplayEmail({ email: "" })).toEqual({});
  });
});

describe("syncDisplayEmailOnUpdate", () => {
  it("refreshes displayEmail from a changed email so it never goes stale", () => {
    expect(syncDisplayEmailOnUpdate({ email: "New.Addr@gmail.com" })).toEqual({
      data: { email: "New.Addr@gmail.com", displayEmail: "New.Addr@gmail.com" },
    });
  });

  it("leaves an explicit displayEmail intact (Google override re-import path)", () => {
    // overrideUserInfoOnSignIn sends BOTH the lowercased email and the original-cased
    // displayEmail; we must not clobber the cased value with the lowercased email.
    expect(
      syncDisplayEmailOnUpdate({
        email: "mixedcase@example.com",
        displayEmail: "Mixed.case@example.com",
      }),
    ).toBeUndefined();
  });

  it("is a no-op when the update does not touch the email", () => {
    expect(syncDisplayEmailOnUpdate({ name: "Zach" })).toBeUndefined();
    expect(syncDisplayEmailOnUpdate({ email: "" })).toBeUndefined();
  });
});

// Build a Google-style ID token (`header.payload.signature`) whose payload is base64url.
const b64url = (obj: unknown) =>
  Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fakeIdToken = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: "RS256" })}.${b64url(payload)}.sig`;

describe("emailFromGoogleIdToken (recovers the original-cased One Tap email)", () => {
  it("reads the original-cased email claim from a token payload", () => {
    // One Tap discards the verbatim email, so we re-read it from the same
    // (already-verified) token to drive the display_email backfill.
    expect(emailFromGoogleIdToken(fakeIdToken({ email: "Mixed.Case@example.com" }))).toBe(
      "Mixed.Case@example.com",
    );
  });

  it("handles payloads with extra (incl. non-ASCII) claims", () => {
    expect(
      emailFromGoogleIdToken(fakeIdToken({ name: "José Núñez", email: "Jose.Nunez@gmail.com" })),
    ).toBe("Jose.Nunez@gmail.com");
  });

  it("returns undefined for a non-string, structurally-malformed, or emailless token", () => {
    expect(emailFromGoogleIdToken(undefined)).toBeUndefined();
    expect(emailFromGoogleIdToken(42)).toBeUndefined();
    expect(emailFromGoogleIdToken("not-a-jwt")).toBeUndefined();
    expect(emailFromGoogleIdToken("header.%%%notbase64%%%.sig")).toBeUndefined();
    expect(emailFromGoogleIdToken(fakeIdToken({ sub: "123" }))).toBeUndefined();
    expect(emailFromGoogleIdToken(fakeIdToken({ email: "" }))).toBeUndefined();
  });
});

describe("displayEmailBackfill (fills a One-Tap user's empty displayEmail)", () => {
  it("returns the original-cased email when the row's displayEmail is empty", () => {
    // A One-Tap user's row never got displayEmail (the flow bypasses
    // mapProfileToUser), so it's NULL/"" and the app falls back to the dot-stripped
    // canonical — backfill recovers the nicely-cased form.
    expect(displayEmailBackfill({ displayEmail: null }, "Mixed.Case@example.com")).toBe(
      "Mixed.Case@example.com",
    );
    expect(displayEmailBackfill({ displayEmail: "" }, "Mixed.Case@example.com")).toBe(
      "Mixed.Case@example.com",
    );
  });

  it("never clobbers an already-set displayEmail", () => {
    // A value set by mapDisplayEmail (standard-flow create) or a change-email must survive.
    expect(
      displayEmailBackfill({ displayEmail: "Mixed.case@example.com" }, "MIXED.CASE@example.com"),
    ).toBeUndefined();
  });

  it("is a no-op when there's no matching row (a new user takes the create path)", () => {
    expect(displayEmailBackfill(undefined, "Mixed.Case@example.com")).toBeUndefined();
  });

  it("is a no-op when the provider gave no email", () => {
    expect(displayEmailBackfill({ displayEmail: null }, "")).toBeUndefined();
  });
});

describe("buildStripePlugin gating", () => {
  const db = createTestDb();

  it("returns null when neither secret is present", () => {
    expect(buildStripePlugin({}, db)).toBeNull();
  });

  it("requires BOTH the secret key and the webhook secret", () => {
    expect(buildStripePlugin({ secretKey: "sk_test_x" }, db)).toBeNull();
    expect(buildStripePlugin({ webhookSecret: "whsec_x" }, db)).toBeNull();
  });

  it("treats empty strings as absent", () => {
    expect(buildStripePlugin({ secretKey: "sk_test_x", webhookSecret: "" }, db)).toBeNull();
    expect(buildStripePlugin({ secretKey: "", webhookSecret: "whsec_x" }, db)).toBeNull();
  });

  it("mounts the stripe plugin with the inert subscription seam when both secrets resolve", () => {
    const plugin = buildStripePlugin({ secretKey: "sk_test_x", webhookSecret: "whsec_x" }, db) as {
      id?: string;
      endpoints?: Record<string, unknown>;
    } | null;
    expect(plugin?.id).toBe("stripe");
    // subscription.enabled wires the subscription endpoints (inert with plans: []),
    // keyed to the workspace via authorizeReference (owner/admin gate).
    expect(plugin?.endpoints).toHaveProperty("upgradeSubscription");
  });
});

describe("resolveLastLoginMethodOverride", () => {
  it("maps the One Tap callback path to google (the default resolver misses it)", () => {
    expect(resolveLastLoginMethodOverride("/one-tap/callback")).toBe("google");
  });

  it("returns null for paths the plugin's default resolver already handles", () => {
    // These fall through to Better Auth's built-in resolution, so the override
    // must NOT shadow them: /callback/google → "google", /sign-in/email → "email",
    // /magic-link/verify → "magic-link".
    expect(resolveLastLoginMethodOverride("/callback/google")).toBeNull();
    expect(resolveLastLoginMethodOverride("/sign-in/email")).toBeNull();
    expect(resolveLastLoginMethodOverride("/magic-link/verify")).toBeNull();
  });

  it("returns null for unknown, empty, or absent paths", () => {
    expect(resolveLastLoginMethodOverride("/some/other/path")).toBeNull();
    expect(resolveLastLoginMethodOverride("")).toBeNull();
    expect(resolveLastLoginMethodOverride(null)).toBeNull();
    expect(resolveLastLoginMethodOverride(undefined)).toBeNull();
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

  it("returns undefined for a loopback IP host (no bogus `.0.0.1` domain)", () => {
    // 127.0.0.1 has no registrable parent — must not enable cross-subdomain cookies.
    expect(
      deriveCookieDomain({ BETTER_AUTH_URL: "http://127.0.0.1:8787" } as never),
    ).toBeUndefined();
    expect(deriveCookieDomain({ BETTER_AUTH_URL: "http://[::1]:8787" } as never)).toBeUndefined();
    // `localhost` (single label) stays host-only too.
    expect(
      deriveCookieDomain({ BETTER_AUTH_URL: "http://localhost:8787" } as never),
    ).toBeUndefined();
  });
});

describe("derivePasskeyRp", () => {
  it("derives rpID (host) + origin from the WEB origin, NOT the API origin", () => {
    // The crux: the ceremony runs on the web origin, so rpID/origin must point
    // there — never at api.releases.sh (the plugin's baseURL-derived default).
    expect(derivePasskeyRp({ WEB_BASE_URL: "https://releases.sh" })).toEqual({
      rpID: "releases.sh",
      rpName: "Releases",
      origin: "https://releases.sh",
    });
  });

  it("uses the portless web host locally (rpID releases.localhost)", () => {
    expect(derivePasskeyRp({ WEB_BASE_URL: "https://releases.localhost" })).toEqual({
      rpID: "releases.localhost",
      rpName: "Releases",
      origin: "https://releases.localhost",
    });
  });

  it("drops a path/port to the bare origin and never includes a trailing slash", () => {
    expect(derivePasskeyRp({ WEB_BASE_URL: "http://localhost:3000/login" })).toEqual({
      rpID: "localhost",
      rpName: "Releases",
      origin: "http://localhost:3000",
    });
  });

  it("falls back to the prod web origin when WEB_BASE_URL is unset/unparseable", () => {
    const expected = { rpID: "releases.sh", rpName: "Releases", origin: "https://releases.sh" };
    expect(derivePasskeyRp({})).toEqual(expected);
    expect(derivePasskeyRp({ WEB_BASE_URL: "not a url" })).toEqual(expected);
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

  it("mirrors the CORS family with subdomain wildcards", () => {
    const origins = authTrustedOrigins({} as never);
    expect(origins).toContain("*.releases.sh");
    expect(origins).toContain("*.releases.localhost");
  });

  it("adds any-port bare-loopback wildcards outside production", () => {
    const origins = authTrustedOrigins({} as never);
    expect(origins).toContain("http://localhost:*");
    expect(origins).toContain("http://127.0.0.1:*");
  });

  it("passes wildcard BETTER_AUTH_TRUSTED_ORIGINS entries through verbatim", () => {
    // The dev origin lives in config, not in code. A `*.` entry reaches Better Auth's
    // trustedOrigins (which wildcard-matches it) AND the CORS layer (matchesTrustedOrigin).
    const origins = authTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS:
        "https://releases.local.buildinternet.dev, *.releases.local.buildinternet.dev",
    } as never);
    expect(origins).toContain("https://releases.local.buildinternet.dev");
    expect(origins).toContain("*.releases.local.buildinternet.dev");
  });

  it("excludes loopback origins in production (family only)", () => {
    const origins = authTrustedOrigins({ ENVIRONMENT: "production" } as never);
    expect(origins).not.toContain("http://localhost:*");
    expect(origins).toEqual([
      "https://releases.sh",
      "*.releases.sh",
      "https://releases.localhost",
      "*.releases.localhost",
    ]);
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

  // Read back the methods the preflight advertises. The session-authed self-serve
  // surface (/v1/me/*) shares this middleware and includes PUT (/v1/me/digest sets
  // cadence), so the cross-origin preflight must allow it or the browser blocks the
  // toggle as a CORS violation.
  async function preflightMethods(requestMethod: string): Promise<string[]> {
    const app = new Hono();
    app.use("/api/auth/*", authCorsMiddleware());
    app.get("/api/auth/ok", (c) => c.text("ok"));
    const res = await app.request(
      "/api/auth/ok",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": requestMethod,
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    return (res.headers.get("access-control-allow-methods") ?? "")
      .split(",")
      .map((m) => m.trim().toUpperCase())
      .filter(Boolean);
  }

  // Read back the request headers the preflight advertises as allowed. The Sentinel
  // client (#1544) stamps every /api/auth/* call with X-Visitor-Id / X-Request-Id (and
  // X-PoW-Solution on a challenge retry); if any are missing from Access-Control-Allow-
  // Headers the browser blocks the cross-origin preflight for EVERY auth request —
  // get-session, Google One Tap, and the regular SSO callback alike.
  async function preflightAllowedHeaders(requestHeaders: string): Promise<string[]> {
    const app = new Hono();
    app.use("/api/auth/*", authCorsMiddleware());
    app.get("/api/auth/ok", (c) => c.text("ok"));
    const res = await app.request(
      "/api/auth/ok",
      {
        method: "OPTIONS",
        headers: {
          Origin: "https://releases.sh",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": requestHeaders,
        },
      },
      { ENVIRONMENT: "production" } as never,
    );
    return (res.headers.get("access-control-allow-headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  it("allows PUT so /v1/me/digest cadence writes clear the preflight", async () => {
    expect(await preflightMethods("PUT")).toContain("PUT");
  });

  it("allows PATCH so /v1/me/webhooks updates clear the preflight", async () => {
    expect(await preflightMethods("PATCH")).toContain("PATCH");
  });

  it("allows the Sentinel fingerprint headers so auth requests clear the preflight", async () => {
    const allowed = await preflightAllowedHeaders("x-visitor-id, x-request-id, x-pow-solution");
    expect(allowed).toContain("x-visitor-id");
    expect(allowed).toContain("x-request-id");
    expect(allowed).toContain("x-pow-solution");
  });

  // Drift guard: the regression in #1544 was the auth CORS allow-list falling behind the
  // headers the sentinel client sends. Rather than re-hardcode "the three headers we know
  // about today", read the headers the INSTALLED @better-auth/infra client actually stamps
  // onto outgoing requests (`.set("X-…")` in its browser bundle) and assert every one is in
  // AUTH_CORS_ALLOWED_HEADERS. A package bump that introduces a new custom header now fails
  // here instead of silently breaking sign-in in production.
  it("CORS allow-list covers every custom header the sentinel client sends", () => {
    const require = createRequire(import.meta.url);
    const clientBundle = readFileSync(require.resolve("@better-auth/infra/client"), "utf8");
    const sentHeaders = new Set<string>();
    for (const m of clientBundle.matchAll(/\.set\(\s*["'](X-[A-Za-z0-9-]+)["']/g)) {
      sentHeaders.add(m[1].toLowerCase());
    }
    // Sanity: the scan must find the known fingerprint headers, or the bundle shape changed
    // and the regex needs revisiting (a silently-empty match set would make this test inert).
    expect(sentHeaders.has("x-request-id")).toBe(true);
    expect(sentHeaders.has("x-visitor-id")).toBe(true);

    const allowed = new Set(AUTH_CORS_ALLOWED_HEADERS.map((h) => h.toLowerCase()));
    const missing = [...sentHeaders].filter((h) => !allowed.has(h));
    expect(missing).toEqual([]);
  });

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

  it("reflects an exact configured BETTER_AUTH_TRUSTED_ORIGINS host in any environment", async () => {
    // A one-off dev/preview host trusted by exact match.
    const custom = "https://custom-dev.example.com";
    expect(
      await preflightOrigin(custom, {
        ENVIRONMENT: "development",
        BETTER_AUTH_TRUSTED_ORIGINS: custom,
      }),
    ).toBe(custom);
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

  it("matches a wildcard BETTER_AUTH_TRUSTED_ORIGINS entry against subdomains (incl. worktree hosts)", async () => {
    // This is the case an exact-match list can't cover: a single `*.` entry trusts
    // every subdomain, so worktree-prefixed dev hosts clear CORS with no per-host config.
    const wild = "*.releases.local.buildinternet.dev";
    expect(
      await preflightOrigin("https://feat-x.releases.local.buildinternet.dev", {
        ENVIRONMENT: "development",
        BETTER_AUTH_TRUSTED_ORIGINS: wild,
      }),
    ).toBe("https://feat-x.releases.local.buildinternet.dev");
    // Honored in any environment — extras are operator-configured, so prod-safety is
    // "don't list dev domains in prod's env", consistent with the exact-match path above.
    expect(
      await preflightOrigin("https://deep.nested.releases.local.buildinternet.dev", {
        ENVIRONMENT: "production",
        BETTER_AUTH_TRUSTED_ORIGINS: wild,
      }),
    ).toBe("https://deep.nested.releases.local.buildinternet.dev");
    // The wildcard does NOT match the apex (no leading-dot segment) — list it
    // separately, exactly as Better Auth requires.
    expect(
      await preflightOrigin("https://releases.local.buildinternet.dev", {
        ENVIRONMENT: "development",
        BETTER_AUTH_TRUSTED_ORIGINS: wild,
      }),
    ).toBeNull();
    // A wildcard must not leak across the dot boundary it anchors on.
    expect(
      await preflightOrigin("https://evil-buildinternet.dev", {
        ENVIRONMENT: "development",
        BETTER_AUTH_TRUSTED_ORIGINS: wild,
      }),
    ).toBeNull();
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

describe("public CORS skips /api/auth/* (no wildcard clobbering of credentialed auth CORS)", () => {
  // Mirrors the middleware wiring in src/index.ts: authCorsMiddleware owns the
  // credentialed CORS on /api/auth/*, and the wildcard public cors() runs on every
  // OTHER path (guarded by a path check). Without that guard the wildcard cors
  // overwrites Access-Control-Allow-Origin with "*" on the ACTUAL (non-preflight)
  // auth response — which a browser rejects for `credentials: "include"` requests.
  // The preflight stays fine (authCorsMiddleware short-circuits OPTIONS), so only
  // a real browser catches it; this locks the behavior in.
  function makeApp() {
    const app = new Hono();
    app.use("/api/auth/*", authCorsMiddleware());
    const publicReadCors = cors();
    app.use("*", (c, next) =>
      c.req.path.startsWith("/api/auth/") ? next() : publicReadCors(c, next),
    );
    app.get("/api/auth/ok", (c) => c.text("ok"));
    app.get("/v1/ping", (c) => c.text("pong"));
    return app;
  }

  it("reflects the origin (not '*') with credentials on an actual GET to /api/auth/*", async () => {
    const res = await makeApp().request(
      "/api/auth/ok",
      { headers: { Origin: "https://releases.sh" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("keeps wildcard CORS on non-auth public routes", async () => {
    const res = await makeApp().request(
      "/v1/ping",
      { headers: { Origin: "https://anything.example" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
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

// ── Integration: the email-verification gate ──
// Builds the REAL createAuth() over the migrated test DB with an injected
// capturing email sender (no network). Proves requireEmailVerification blocks
// the session at sign-up and fires the verification email, and that an
// unverified sign-in is rejected.

describe("email verification gate", () => {
  const env = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  } as never;

  it("sign-up creates NO session and fires a verification email", async () => {
    const db = createTestDb();
    const captured: AuthEmailMessage[] = [];
    const auth = await createAuth(env, undefined, {
      db,
      sendEmail: (m) => {
        captured.push(m);
      },
    });

    await auth.api.signUpEmail({
      body: { email: "dora@example.com", password: "correct-horse-battery", name: "Dora" },
    });

    // requireEmailVerification → no session row at sign-up.
    const sessions = await db.select().from(session);
    expect(sessions).toHaveLength(0);
    // user row exists but unverified.
    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
    expect(users[0]?.emailVerified).toBeFalsy();
    // a verification email was scheduled to the new address with a token link.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.to).toBe("dora@example.com");
    expect(captured[0]?.text).toMatch(/\/verify-email\?token=[\w-]+/);
  });

  it("rejects sign-in while unverified and re-sends the verification email", async () => {
    const db = createTestDb();
    const captured: AuthEmailMessage[] = [];
    const auth = await createAuth(env, undefined, {
      db,
      sendEmail: (m) => {
        captured.push(m);
      },
    });
    await auth.api.signUpEmail({
      body: { email: "evan@example.com", password: "correct-horse-battery", name: "Evan" },
    });
    expect(captured).toHaveLength(1); // verification sent on sign-up
    await expect(
      auth.api.signInEmail({
        body: { email: "evan@example.com", password: "correct-horse-battery" },
      }),
    ).rejects.toThrow();
    // sendOnSignIn: a fresh verification email is sent on the unverified sign-in.
    expect(captured.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Integration: self-serve email change ──
// `user.changeEmail.enabled` is on, so a verified user can request a new address
// and a confirmation link is mailed to their CURRENT address (the change lands
// only on click). These run the real createAuth() over the migrated test DB with a
// capturing sender, authenticating the change-email call with the session cookie
// minted by auto-sign-in-after-verification.

describe("change email", () => {
  const env = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  } as never;

  /** Build a `cookie` request header from every Set-Cookie the response carried. */
  function cookieHeader(headers: Headers): string {
    return headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  /** Sign up + verify an account, returning the auth-cookie header for its session. */
  async function verifiedSession(
    auth: BetterAuthInstance,
    captured: AuthEmailMessage[],
    email: string,
  ): Promise<string> {
    await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: "User" },
    });
    const link = captured[0]?.text.match(/https?:\/\/\S*verify-email\S*/)?.[0];
    if (!link) throw new Error("no verify-email link in sign-up email");
    const token = new URL(link).searchParams.get("token")!;
    // autoSignInAfterVerification → verifying mints a session; grab its cookie.
    const { headers } = await auth.api.verifyEmail({
      query: { token },
      returnHeaders: true,
    });
    return cookieHeader(headers);
  }

  it("enables change-email and confirms to the CURRENT address", async () => {
    const db = createTestDb();
    const captured: AuthEmailMessage[] = [];
    const auth = await createAuth(env, undefined, {
      db,
      sendEmail: (m) => {
        captured.push(m);
      },
    });

    const cookie = await verifiedSession(auth, captured, "old@example.com");
    captured.length = 0; // drop the sign-up verification email

    const res = await auth.api.changeEmail({
      body: { newEmail: "new@example.com" },
      headers: { cookie },
    });
    expect(res.status).toBe(true);

    // The confirmation goes to the OLD address (the security property), names the
    // new address, and carries a verify token. The user row is unchanged until the
    // link is clicked.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.to).toBe("old@example.com");
    expect(captured[0]?.text).toContain("new@example.com");
    expect(captured[0]?.text).toMatch(/\/verify-email\?token=[\w-]+/);
    const users = await db.select().from(user);
    expect(users[0]?.email).toBe("old@example.com");
  });

  it("rejects an unauthenticated change-email request", async () => {
    const auth = await createAuth(env, undefined, { db: createTestDb(), sendEmail: () => {} });
    await expect(
      auth.api.changeEmail({ body: { newEmail: "x@example.com" }, headers: {} }),
    ).rejects.toThrow();
  });
});

// ── One Tap plugin gating ──
// The Google One Tap endpoint verifies a Google ID token, so it's meaningless
// without a configured Google client id. createAuth registers oneTap() ONLY when
// Google's credential pair resolves — same fail-safe seam as buildSocialProviders.

// The built Better Auth instance exposes its resolved plugin list on `.options`.
const pluginIds = (auth: { options: { plugins?: Array<{ id: string }> } }) =>
  (auth.options.plugins ?? []).map((p) => p.id);

describe("one-tap plugin gating", () => {
  const baseEnv = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  };

  it("registers one-tap when Google is configured", async () => {
    const auth = await createAuth(
      {
        ...baseEnv,
        GOOGLE_CLIENT_ID: "gid",
        GOOGLE_CLIENT_SECRET: "gsec",
      } as never,
      undefined,
      { db: createTestDb(), sendEmail: () => {} },
    );
    expect(pluginIds(auth)).toContain("one-tap");
  });

  it("omits one-tap when Google is absent", async () => {
    const auth = await createAuth(baseEnv as never, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    expect(pluginIds(auth)).not.toContain("one-tap");
  });
});

// ── Magic link ──
// Passwordless sign-in. Unlike social/one-tap the plugin needs no credential pair,
// so it's ALWAYS registered (it leans only on the AUTH_EMAIL binding, same as
// verify/reset). The token rides Better Auth's existing `verification` table, so
// these exercise the real createAuth() over the migrated test DB with a capturing
// sender (no network).

describe("magic link", () => {
  const env = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  } as never;

  /** Pull the verify-link token out of a captured email's plain-text body. */
  function tokenFromEmail(msg: AuthEmailMessage): string {
    const link = msg.text.match(/https?:\/\/\S*\/magic-link\/verify\S*/)?.[0];
    if (!link) throw new Error("no magic-link verify URL in email body");
    const token = new URL(link).searchParams.get("token");
    if (!token) throw new Error("no token in magic-link verify URL");
    return token;
  }

  it("always registers the magic-link plugin (no credential gating)", async () => {
    const auth = await createAuth(env, undefined, { db: createTestDb(), sendEmail: () => {} });
    expect(pluginIds(auth)).toContain("magic-link");
  });

  it("emails a single sign-in link to the address, carrying the verify token", async () => {
    const db = createTestDb();
    const captured: AuthEmailMessage[] = [];
    const auth = await createAuth(env, undefined, {
      db,
      sendEmail: (m) => {
        captured.push(m);
      },
    });

    await auth.api.signInMagicLink({ body: { email: "mira@example.com" }, headers: {} });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.to).toBe("mira@example.com");
    expect(captured[0]?.text).toMatch(/\/magic-link\/verify\?token=[\w-]+/);
    // No account is created at request time — only a pending verification token.
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it("verifying the link auto-creates a verified user (blank name) + a session", async () => {
    const db = createTestDb();
    const captured: AuthEmailMessage[] = [];
    const auth = await createAuth(env, undefined, {
      db,
      sendEmail: (m) => {
        captured.push(m);
      },
    });

    await auth.api.signInMagicLink({ body: { email: "nadia@example.com" }, headers: {} });
    const res = await auth.api.magicLinkVerify({
      query: { token: tokenFromEmail(captured[0]!) },
      headers: {},
    });
    expect(res.user.email).toBe("nadia@example.com");

    // disableSignUp is off → an unknown email lands a verified user. No name was
    // supplied, so Better Auth writes "" (satisfies the NOT NULL user.name column).
    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe("nadia@example.com");
    expect(users[0]?.name).toBe("");
    expect(users[0]?.emailVerified).toBeTruthy();
    // A session row now exists.
    expect((await db.select().from(session)).length).toBeGreaterThanOrEqual(1);
  });

  it("consumes the token on first verify — a replay is rejected (single-use)", async () => {
    const db = createTestDb();
    const captured: AuthEmailMessage[] = [];
    const auth = await createAuth(env, undefined, {
      db,
      sendEmail: (m) => {
        captured.push(m);
      },
    });

    await auth.api.signInMagicLink({ body: { email: "omar@example.com" }, headers: {} });
    const token = tokenFromEmail(captured[0]!);
    await auth.api.magicLinkVerify({ query: { token }, headers: {} });
    // Second use of the same token must fail (atomic single-use consume).
    await expect(auth.api.magicLinkVerify({ query: { token }, headers: {} })).rejects.toThrow();
  });
});

// ── Passkeys (WebAuthn / FIDO2) ──
// Like magic link, the passkey plugin needs no credential pair, so it's ALWAYS
// registered. The relying-party config is pinned to the WEB origin (derivePasskeyRp).
// These run the real createAuth() over the migrated test DB (createTestDb applies
// the passkey migration), so a schema/model mismatch would surface here.

describe("passkey plugin", () => {
  const env = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    WEB_BASE_URL: "https://releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  } as never;

  it("always registers the passkey plugin (no credential gating)", async () => {
    const auth = await createAuth(env, undefined, { db: createTestDb(), sendEmail: () => {} });
    expect(pluginIds(auth)).toContain("passkey");
  });

  it("the paired migration creates a queryable `passkey` table", async () => {
    // Proves the 20260613000000_add_passkey migration applied: a select against the
    // table the drizzleAdapter schema map references resolves (empty), rather than
    // throwing "no such table". A schema↔migration drift would fail here on insert.
    const db = createTestDb();
    await createAuth(env, undefined, { db, sendEmail: () => {} });
    expect(await db.select().from(passkey)).toEqual([]);
  });
});

// ── Device authorization (RFC 8628) ──
// The OAuth 2.0 Device Authorization Grant backing `releases login`. createAuth
// always registers both the deviceAuthorization() plugin AND bearer() (the CLI
// carries the device-flow session token as `Authorization: Bearer` to the
// /v1/api-keys create route, and bearer() is what makes getSession honor that
// header). These exercise the real createAuth() over the migrated test DB
// (createTestDb applies the device_code migration), so a schema mismatch would
// throw on insert and fail here.

describe("device-authorization plugin", () => {
  // WEB_BASE_URL is deliberately a DIFFERENT host than BETTER_AUTH_URL so the
  // verification_uri assertion below proves the approval URL lands on the web
  // origin (where /device is served), not the API origin (where it 404s).
  const baseEnv = {
    BETTER_AUTH_URL: "https://api.releases.localhost",
    WEB_BASE_URL: "https://app.releases.localhost",
    BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  };

  it("registers device-authorization + bearer", async () => {
    const auth = await createAuth(baseEnv as never, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const ids = pluginIds(auth);
    expect(ids).toContain("device-authorization");
    expect(ids).toContain("bearer");
  });

  it("issues a device + user code and writes a pending row for the known client id", async () => {
    const db = createTestDb();
    const auth = await createAuth(baseEnv as never, undefined, { db, sendEmail: () => {} });

    const res = await auth.api.deviceCode({ body: { client_id: DEVICE_AUTH_CLIENT_ID } });
    expect(res.user_code).toBeTruthy();
    expect(res.device_code).toBeTruthy();
    // The approval URL must resolve to the WEB origin (where /device lives), NOT the
    // API origin — a relative "/device" would resolve against BETTER_AUTH_URL and 404.
    expect(res.verification_uri).toBe("https://app.releases.localhost/device");
    expect(res.verification_uri).not.toContain("api.releases.localhost");

    // A pending row landed through the real device_code column shape.
    const rows = await db.select().from(deviceCode);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.clientId).toBe(DEVICE_AUTH_CLIENT_ID);
    expect(rows[0]?.userId).toBeNull(); // not approved yet
  });

  it("rejects an unknown client id (validateClient fail-closed)", async () => {
    const auth = await createAuth(baseEnv as never, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    await expect(auth.api.deviceCode({ body: { client_id: "evil-client" } })).rejects.toThrow();
  });
});

describe("magicLinkTemplate", () => {
  it("renders the URL into both bodies and escapes the attribute-breakout quote", () => {
    const url = 'https://api.releases.localhost/api/auth/magic-link/verify?token=abc"x';
    const t = magicLinkTemplate({ url });
    expect(t.subject).toMatch(/sign-in/i);
    // Plain-text body keeps the raw URL (no escaping).
    expect(t.text).toContain('token=abc"x');
    // HTML href escapes only the breakout char so the attribute can't be broken out of.
    expect(t.html).toContain("token=abc%22x");
    expect(t.html).not.toContain('token=abc"x');
  });
});
