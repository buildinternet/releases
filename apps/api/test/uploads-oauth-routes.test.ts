import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./setup.js";
import { user, authOrganization, authMember } from "../src/db/schema-auth.js";
import { workspaceIntegrations } from "../src/db/schema-integrations.js";
import { workspaceIntegrationHandlers } from "../src/routes/workspace-integrations.js";
import { decryptOAuthSecret } from "../src/lib/integrations/oauth-token-crypto.js";
import {
  ensureFreshUploadsAccessToken,
  refreshStoredUploadsGrant,
} from "../src/lib/integrations/uploads-oauth-tokens.js";
import {
  resolveUploadsOAuthConfig,
  uploadsWorkspaceFromAccessToken,
} from "../src/lib/integrations/uploads-oauth.js";
import type { Env } from "../src/index.js";

function encodeJwtSegment(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unsignedJwt(payload: Record<string, unknown>): string {
  return `${encodeJwtSegment({ alg: "none", typ: "JWT" })}.${encodeJwtSegment(payload)}.sig`;
}

let db: TestDb;

const ENCRYPTION_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function env(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "test",
    WEB_BASE_URL: "https://releases.sh",
    IDEMPOTENCY_ENCRYPTION_KEY: ENCRYPTION_KEY,
    DB: db,
    ...overrides,
  } as unknown as Env["Bindings"];
}

function seed(role: "owner" | "admin" | "member" = "owner") {
  db.insert(user)
    .values({
      id: "user_1",
      name: "Ann",
      email: "ann@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  db.insert(authOrganization)
    .values({ id: "ws_1", name: "Ann's Workspace", slug: "ws-user_1" })
    .run();
  db.insert(authMember)
    .values({ id: "mem_1", organizationId: "ws_1", userId: "user_1", role })
    .run();
}

function appAs(userId: string | null) {
  const a = new Hono<Env>();
  a.use("*", async (c, next) => {
    if (userId) c.set("session", { user: { id: userId, email: "ann@example.com", name: "Ann" } });
    return next();
  });
  a.route("/", workspaceIntegrationHandlers);
  return a;
}

describe("uploads OAuth workspace routes", () => {
  it("requires sign-in on status", async () => {
    db = createTestDb();
    const res = await appAs(null).request(
      "/workspaces/ws_1/integrations/uploads",
      { method: "GET" },
      env(),
    );
    expect(res.status).toBe(401);
  });

  it("404s status for a workspace the user is not in", async () => {
    db = createTestDb();
    seed();
    const res = await appAs("user_1").request(
      "/workspaces/ws_missing/integrations/uploads",
      { method: "GET" },
      env(),
    );
    expect(res.status).toBe(404);
  });

  it("returns disconnected status for a member", async () => {
    db = createTestDb();
    seed("member");
    const res = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads",
      { method: "GET" },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      configured: boolean;
      uploadsWorkspace: string | null;
    };
    expect(body.connected).toBe(false);
    expect(body.configured).toBe(true);
    expect(body.uploadsWorkspace).toBeNull();
  });

  it("refuses connect when OAuth is not configured", async () => {
    db = createTestDb();
    seed();
    const res = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST" },
      env({ IDEMPOTENCY_ENCRYPTION_KEY: undefined }),
    );
    expect(res.status).toBe(503);
  });

  it("forbids a member from starting connect", async () => {
    db = createTestDb();
    seed("member");
    const res = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "https://releases.sh" } },
      env(),
    );
    expect(res.status).toBe(403);
  });

  it("starts connect with PKCE and persists pending state", async () => {
    db = createTestDb();
    seed();
    const res = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "https://releases.sh" } },
      env(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl: string; redirectUri: string };
    expect(body.redirectUri).toBe("https://releases.sh/integrations/uploads/callback");
    const url = new URL(body.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("releases-sh");
    expect(url.searchParams.get("scope")).toBe("files:read offline_access");
    expect(url.origin + url.pathname).toBe("https://uploads.sh/api/auth/oauth2/authorize");
    expect(url.searchParams.get("state")).toBeTruthy();

    const pending = await db.select().from(workspaceIntegrations);
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.oauthState).toBe(url.searchParams.get("state"));
    expect(pending[0]?.codeVerifierEnc).toBeTruthy();
    expect(pending[0]?.codeVerifierEnc).not.toContain("verifier");
  });

  it.each([
    ["http://localhost:3000", "http://localhost:3000/integrations/uploads/callback"],
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000/integrations/uploads/callback"],
    ["https://releases.localhost", "https://releases.localhost/integrations/uploads/callback"],
  ] as const)("uses trusted Origin %s as the redirect URI", async (origin, expected) => {
    db = createTestDb();
    seed();
    const res = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: origin } },
      env({ ENVIRONMENT: "development" }),
    );
    const body = (await res.json()) as { redirectUri: string };
    expect(body.redirectUri).toBe(expected);
  });

  it("does not use MCP preview Origin :8788 as the redirect URI", async () => {
    db = createTestDb();
    seed();
    const res = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "http://localhost:8788" } },
      env({ ENVIRONMENT: "development" }),
    );
    const body = (await res.json()) as { redirectUri: string };
    expect(body.redirectUri).toBe("https://releases.sh/integrations/uploads/callback");
  });

  it("rejects callback with an unknown state", async () => {
    db = createTestDb();
    seed();
    const res = await appAs("user_1").request(
      "/integrations/uploads/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "c", state: "nope" }),
      },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an expired pending state", async () => {
    db = createTestDb();
    seed();
    const start = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "https://releases.sh" } },
      env(),
    );
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    db.update(workspaceIntegrations)
      .set({ pendingExpiresAt: Date.now() - 1000 })
      .where(eq(workspaceIntegrations.oauthState, state))
      .run();

    const res = await appAs("user_1").request(
      "/integrations/uploads/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "c", state }),
      },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it("completes callback via mocked token exchange and encrypts tokens", async () => {
    db = createTestDb();
    seed();
    const start = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "https://releases.sh" } },
      env(),
    );
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.uploads.sh/api/auth/oauth2/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("client_id")).toBe("releases-sh");
      expect(body.get("client_secret")).toBeNull();
      expect(body.get("code_verifier")).toBeTruthy();
      const accessJwt = unsignedJwt({ workspace: "acme" });
      return new Response(
        JSON.stringify({
          access_token: accessJwt,
          refresh_token: "refresh-plain",
          token_type: "Bearer",
          scope: "files:read offline_access",
          expires_in: 3600,
        }),
      );
    }) as typeof fetch;

    try {
      const res = await appAs("user_1").request(
        "/integrations/uploads/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "auth-code", state }),
        },
        env(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        connected: boolean;
        workspaceId: string;
        scope: string;
        uploadsWorkspace: string | null;
      };
      expect(body.connected).toBe(true);
      expect(body.workspaceId).toBe("ws_1");
      expect(body.scope).toContain("files:read");
      expect(body.uploadsWorkspace).toBe("acme");

      const connected = await db.select().from(workspaceIntegrations);
      const row = connected[0];
      expect(row?.status).toBe("connected");
      expect(row?.oauthState).toBeNull();
      expect(row?.accessTokenEnc).toBeTruthy();
      expect(row?.providerWorkspace).toBe("acme");
      expect(row?.accessTokenEnc).not.toContain("acme");
      const access = await decryptOAuthSecret(row!.accessTokenEnc!, ENCRYPTION_KEY, {
        workspaceId: "ws_1",
        provider: "uploads",
        field: "access_token",
      });
      expect(uploadsWorkspaceFromAccessToken(access)).toBe("acme");

      const status = await appAs("user_1").request(
        "/workspaces/ws_1/integrations/uploads",
        { method: "GET" },
        env(),
      );
      expect(status.status).toBe(200);
      expect(((await status.json()) as { uploadsWorkspace: string }).uploadsWorkspace).toBe("acme");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("disconnects and attempts remote revoke", async () => {
    db = createTestDb();
    seed();
    const start = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "https://releases.sh" } },
      env(),
    );
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const realFetch = globalThis.fetch;
    const revokeCalls: Array<{ url: string; body: URLSearchParams }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: unsignedJwt({ workspace: "acme" }),
            refresh_token: "refresh-plain",
            token_type: "Bearer",
            scope: "files:read offline_access",
            expires_in: 3600,
          }),
        );
      }
      revokeCalls.push({ url, body: new URLSearchParams(String(init?.body)) });
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      await appAs("user_1").request(
        "/integrations/uploads/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "auth-code", state }),
        },
        env(),
      );
      const del = await appAs("user_1").request(
        "/workspaces/ws_1/integrations/uploads",
        { method: "DELETE" },
        env(),
      );
      expect(del.status).toBe(200);
      const revoked = (await del.json()) as {
        connected: boolean;
        uploadsWorkspace: string | null;
      };
      expect(revoked.connected).toBe(false);
      expect(revoked.uploadsWorkspace).toBeNull();
      expect(revokeCalls).toHaveLength(1);
      expect(revokeCalls[0]!.url).toBe("https://auth.uploads.sh/api/auth/oauth2/revoke");
      expect(revokeCalls[0]!.body.get("token")).toBe("refresh-plain");
      expect(revokeCalls[0]!.body.get("token_type_hint")).toBe("refresh_token");
      expect(revokeCalls[0]!.body.get("client_id")).toBe("releases-sh");
      expect(revokeCalls[0]!.body.get("client_secret")).toBeNull();
      const rows = await db.select().from(workspaceIntegrations);
      expect(rows).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("clears local tokens when remote revoke fails", async () => {
    db = createTestDb();
    seed();
    const start = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "https://releases.sh" } },
      env(),
    );
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({
            access_token: unsignedJwt({ workspace: "acme" }),
            refresh_token: "refresh-plain",
            token_type: "Bearer",
            scope: "files:read offline_access",
            expires_in: 3600,
          }),
        );
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;

    try {
      await appAs("user_1").request(
        "/integrations/uploads/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "auth-code", state }),
        },
        env(),
      );
      const del = await appAs("user_1").request(
        "/workspaces/ws_1/integrations/uploads",
        { method: "DELETE" },
        env(),
      );
      expect(del.status).toBe(200);
      expect(await db.select().from(workspaceIntegrations)).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refreshes via refresh_token and persists the rotated grant", async () => {
    db = createTestDb();
    seed();
    const start = await appAs("user_1").request(
      "/workspaces/ws_1/integrations/uploads/connect",
      { method: "POST", headers: { Origin: "https://releases.sh" } },
      env(),
    );
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state")!;

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/oauth2/token")) {
        return new Response("unexpected", { status: 500 });
      }
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "authorization_code") {
        return new Response(
          JSON.stringify({
            access_token: unsignedJwt({ workspace: "acme" }),
            refresh_token: "refresh-plain",
            token_type: "Bearer",
            scope: "files:read offline_access",
            expires_in: 1,
          }),
        );
      }
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("refresh-plain");
      expect(body.get("client_id")).toBe("releases-sh");
      expect(body.get("client_secret")).toBeNull();
      return new Response(
        JSON.stringify({
          access_token: unsignedJwt({ workspace: "acme-rotated" }),
          refresh_token: "refresh-rotated",
          token_type: "Bearer",
          scope: "files:read offline_access",
          expires_in: 3600,
        }),
      );
    }) as typeof fetch;

    try {
      await appAs("user_1").request(
        "/integrations/uploads/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "auth-code", state }),
        },
        env(),
      );
      const [row] = await db.select().from(workspaceIntegrations);
      expect(row).toBeTruthy();
      const cfg = await resolveUploadsOAuthConfig(env());
      expect(cfg).toBeTruthy();

      const refreshed = await refreshStoredUploadsGrant(db, row!, cfg!);
      expect(refreshed.uploadsWorkspace).toBe("acme-rotated");
      expect(refreshed.tokens.refreshToken).toBe("refresh-rotated");

      const [after] = await db.select().from(workspaceIntegrations);
      expect(after?.providerWorkspace).toBe("acme-rotated");
      const access = await decryptOAuthSecret(after!.accessTokenEnc!, ENCRYPTION_KEY, {
        workspaceId: "ws_1",
        provider: "uploads",
        field: "access_token",
      });
      expect(uploadsWorkspaceFromAccessToken(access)).toBe("acme-rotated");
      const refresh = await decryptOAuthSecret(after!.refreshTokenEnc!, ENCRYPTION_KEY, {
        workspaceId: "ws_1",
        provider: "uploads",
        field: "refresh_token",
      });
      expect(refresh).toBe("refresh-rotated");

      const fresh = await ensureFreshUploadsAccessToken(db, after!, cfg!);
      expect(fresh.accessToken).toBe(access);
      expect(fresh.uploadsWorkspace).toBe("acme-rotated");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
