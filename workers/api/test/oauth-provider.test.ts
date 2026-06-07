import { describe, it, expect } from "bun:test";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { createTestDb } from "./setup";
import {
  user,
  session,
  account,
  verification,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  jwks,
} from "../src/db/schema-auth.js";
import { oauthValidAudiences, createAuth } from "../src/auth/index.js";

// createTestDb() applies every migration, so a missing table or column throws here.
describe("oauth provider schema", () => {
  it("oauth_client round-trips through drizzle", async () => {
    const db = createTestDb();
    await db.insert(oauthClient).values({
      id: "oc_1",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
      name: "Test Client",
      redirectUris: ["https://app.example.com/callback"],
      scopes: ["openid", "read"],
      public: false,
      requirePKCE: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const rows = await db.select().from(oauthClient);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe("client-abc");
    expect(rows[0]?.redirectUris).toEqual(["https://app.example.com/callback"]);
    expect(rows[0]?.scopes).toEqual(["openid", "read"]);
  });

  it("jwks round-trips through drizzle", async () => {
    const db = createTestDb();
    await db.insert(jwks).values({
      id: "jwk_1",
      publicKey: "PUB",
      privateKey: "PRIV",
      createdAt: new Date(),
    });
    const rows = await db.select().from(jwks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publicKey).toBe("PUB");
  });

  it("oauth_access_token / oauth_refresh_token / oauth_consent tables exist", async () => {
    const db = createTestDb();
    expect(await db.select().from(oauthAccessToken)).toEqual([]);
    expect(await db.select().from(oauthRefreshToken)).toEqual([]);
    expect(await db.select().from(oauthConsent)).toEqual([]);
  });
});

describe("oauthValidAudiences", () => {
  it("unions the BETTER_AUTH_URL origin with OAUTH_RESOURCE_AUDIENCES entries", () => {
    const auds = oauthValidAudiences({
      BETTER_AUTH_URL: "https://api.releases.sh",
      OAUTH_RESOURCE_AUDIENCES: "https://mcp.releases.sh, https://api.releases.sh",
    } as never);
    expect(auds).toEqual(["https://api.releases.sh", "https://mcp.releases.sh"]);
  });

  it("falls back to the api origin when nothing is configured", () => {
    expect(oauthValidAudiences({} as never)).toEqual(["https://api.releases.sh"]);
  });
});

const baseEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;

const pluginIds = (auth: { options: { plugins?: Array<{ id: string }> } }) =>
  (auth.options.plugins ?? []).map((p) => p.id);

describe("oauth provider wiring", () => {
  it("registers the jwt + oauth-provider plugins", async () => {
    const auth = await createAuth(baseEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const ids = pluginIds(auth);
    expect(ids.some((id) => /jwt/i.test(id))).toBe(true);
    expect(ids.some((id) => /oauth/i.test(id))).toBe(true);
  });

  it("serves authorization-server discovery metadata advertising the API scopes", async () => {
    const auth = await createAuth(baseEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const res = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/.well-known/oauth-authorization-server"),
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      token_endpoint?: string;
      authorization_endpoint?: string;
      jwks_uri?: string;
      scopes_supported?: string[];
    };
    expect(meta.token_endpoint).toContain("/oauth2/token");
    expect(meta.authorization_endpoint).toContain("/oauth2/authorize");
    expect(meta.jwks_uri).toContain("/jwks");
    expect(meta.scopes_supported).toEqual(expect.arrayContaining(["read", "write", "admin"]));
  });

  // Strongest adapter-mapping check: a real Better Auth write to oauth_client via
  // the dynamic-registration endpoint (enabled ONLY in this test instance; prod
  // keeps it OFF). Proves the plugin model name + field keys map to our columns.
  it("writes a registered client to oauth_client through the adapter", async () => {
    const db = createTestDb();
    const auth = betterAuth({
      baseURL: "https://api.releases.localhost",
      secret: "test-secret-do-not-use-in-prod-0123456789",
      database: drizzleAdapter(db, {
        provider: "sqlite",
        schema: {
          user,
          session,
          account,
          verification,
          jwks,
          oauthClient,
          oauthAccessToken,
          oauthRefreshToken,
          oauthConsent,
        },
      }),
      plugins: [
        jwt(),
        oauthProvider({
          loginPage: "/login",
          consentPage: "/oauth/consent",
          scopes: ["openid", "profile", "email", "read"],
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
        }),
      ],
    });
    const res = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["https://app.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(res.ok).toBe(true);
    const clients = await db.select().from(oauthClient);
    expect(clients).toHaveLength(1);
    // The adapter stores redirectUris as a JSON-encoded string in SQLite; parse
    // it if needed so the assertion is stable regardless of encoding depth.
    const rawUris = clients[0]?.redirectUris;
    const uris = typeof rawUris === "string" ? JSON.parse(rawUris) : rawUris;
    expect(uris).toEqual(["https://app.example.com/callback"]);
  });
});
