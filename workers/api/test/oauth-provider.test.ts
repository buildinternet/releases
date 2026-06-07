import { describe, it, expect } from "bun:test";
import { createTestDb } from "./setup";
import {
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  jwks,
} from "../src/db/schema-auth.js";

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
