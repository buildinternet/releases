import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

describe("api_tokens schema", () => {
  it("inserts and reads back a token row", () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_test1",
        lookupId: "lookuptest12",
        tokenHash: "a".repeat(64),
        name: "test",
        scopes: JSON.stringify(["read"]),
      })
      .run();
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_test1")).get();
    expect(row?.lookupId).toBe("lookuptest12");
    expect(row?.principalType).toBe("internal"); // default
    expect(row?.active).toBe(true); // default
    expect(JSON.parse(row!.scopes)).toEqual(["read"]);
  });
});

import { verifyApiToken, touchLastUsed } from "../../workers/api/src/middleware/token-store.js";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

async function seedToken(
  db: TestDatabase["db"],
  overrides: Partial<typeof apiTokens.$inferInsert> = {},
) {
  const { token, lookupId, secret } = generateApiToken();
  const tokenHash = await hashSecret(secret);
  db.insert(apiTokens)
    .values({
      id: overrides.id ?? "tok_seed",
      lookupId,
      tokenHash,
      name: "seed",
      scopes: JSON.stringify(["read"]),
      ...overrides,
    })
    .run();
  return { token, lookupId, secret, tokenHash };
}

describe("verifyApiToken", () => {
  it("accepts a valid token and returns its scopes", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_ok",
      scopes: JSON.stringify(["read", "write"]),
    });
    const res = await verifyApiToken(h.db, token);
    expect(res).toEqual({
      ok: true,
      tokenId: "tok_ok",
      scopes: ["read", "write"],
      principalType: "internal",
    });
  });

  it("rejects a wrong/unknown token", async () => {
    h = createTestDb();
    await seedToken(h.db, { id: "tok_ws" });
    const other = generateApiToken();
    const res = await verifyApiToken(h.db, other.token); // unknown lookupId
    expect(res.ok).toBe(false);
  });

  it("rejects a malformed token", async () => {
    h = createTestDb();
    const res = await verifyApiToken(h.db, "relk_not_a_real_token");
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong secret on a known lookupId", async () => {
    h = createTestDb();
    const { lookupId } = await seedToken(h.db, { id: "tok_wrongsecret" });
    // Real lookupId, but a different secret — exercises the constantTimeEqual
    // false branch on an existing row. Byte-identical in shape to the
    // unknown-lookupId rejection.
    const probe = `relk_${lookupId}_${generateApiToken().secret}`;
    const res = await verifyApiToken(h.db, probe);
    expect(res.ok).toBe(false);
  });

  it("rejects a token whose stored scopes are empty or unparseable", async () => {
    h = createTestDb();
    // Malformed JSON, non-array, and an empty array all collapse to no scopes —
    // a healthy token never has that, so it must be denied (not admitted powerless).
    const bad = await seedToken(h.db, { id: "tok_badjson", scopes: "not-json" });
    expect((await verifyApiToken(h.db, bad.token)).ok).toBe(false);

    const nullScopes = await seedToken(h.db, { id: "tok_nullscopes", scopes: "null" });
    expect((await verifyApiToken(h.db, nullScopes.token)).ok).toBe(false);

    const emptyArr = await seedToken(h.db, { id: "tok_emptyscopes", scopes: "[]" });
    expect((await verifyApiToken(h.db, emptyArr.token)).ok).toBe(false);
  });

  it("rejects a revoked token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, { id: "tok_rev", active: false });
    const res = await verifyApiToken(h.db, token);
    expect(res.ok).toBe(false);
  });

  it("rejects a token with revoked_at set even if active is still true", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_revat",
      active: true,
      revokedAt: new Date().toISOString(),
    });
    const res = await verifyApiToken(h.db, token);
    expect(res.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_exp",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await verifyApiToken(h.db, token);
    expect(res.ok).toBe(false);
  });

  it("accepts a not-yet-expired token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_future",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await verifyApiToken(h.db, token);
    expect(res.ok).toBe(true);
  });
});

describe("touchLastUsed", () => {
  it("sets last_used_at when null", async () => {
    h = createTestDb();
    await seedToken(h.db, { id: "tok_touch" });
    await touchLastUsed(h.db, "tok_touch");
    const row = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_touch")).get();
    expect(row?.lastUsedAt).toBeTruthy();
  });

  it("does not update again within the 60s throttle window", async () => {
    h = createTestDb();
    await seedToken(h.db, {
      id: "tok_throttle",
      lastUsedAt: new Date(Date.now() - 5_000).toISOString(),
    });
    const before = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_throttle")).get();
    await touchLastUsed(h.db, "tok_throttle");
    const after = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_throttle")).get();
    expect(after?.lastUsedAt).toBe(before?.lastUsedAt);
  });

  it("updates again when the previous value is older than the 60s window", async () => {
    h = createTestDb();
    await seedToken(h.db, {
      id: "tok_stale",
      lastUsedAt: new Date(Date.now() - 70_000).toISOString(),
    });
    const before = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_stale")).get();
    await touchLastUsed(h.db, "tok_stale");
    const after = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_stale")).get();
    expect(after?.lastUsedAt).not.toBe(before?.lastUsedAt);
  });
});
