import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { apiTokens, organizations, sources } from "@buildinternet/releases-core/schema";
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

import { verifyApiToken, touchLastUsed } from "../src/middleware/token-store.js";
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
    const res = await verifyApiToken(h.db as never, token);
    expect(res).toEqual({
      ok: true,
      tokenId: "tok_ok",
      scopes: ["read", "write"],
      principalType: "internal",
      principalId: null,
      sourceId: null,
    });
  });

  it("rejects a wrong/unknown token", async () => {
    h = createTestDb();
    await seedToken(h.db, { id: "tok_ws" });
    const other = generateApiToken();
    const res = await verifyApiToken(h.db as never, other.token); // unknown lookupId
    expect(res.ok).toBe(false);
  });

  it("rejects a malformed token", async () => {
    h = createTestDb();
    const res = await verifyApiToken(h.db as never, "relk_not_a_real_token");
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong secret on a known lookupId", async () => {
    h = createTestDb();
    const { lookupId } = await seedToken(h.db, { id: "tok_wrongsecret" });
    // Real lookupId, but a different secret — exercises the constantTimeEqual
    // false branch on an existing row. Byte-identical in shape to the
    // unknown-lookupId rejection.
    const probe = `relk_${lookupId}_${generateApiToken().secret}`;
    const res = await verifyApiToken(h.db as never, probe);
    expect(res.ok).toBe(false);
  });

  it("rejects a token whose stored scopes are empty or unparseable", async () => {
    h = createTestDb();
    // Malformed JSON, non-array, and an empty array all collapse to no scopes —
    // a healthy token never has that, so it must be denied (not admitted powerless).
    const bad = await seedToken(h.db, { id: "tok_badjson", scopes: "not-json" });
    expect((await verifyApiToken(h.db as never, bad.token)).ok).toBe(false);

    const nullScopes = await seedToken(h.db, { id: "tok_nullscopes", scopes: "null" });
    expect((await verifyApiToken(h.db as never, nullScopes.token)).ok).toBe(false);

    const emptyArr = await seedToken(h.db, { id: "tok_emptyscopes", scopes: "[]" });
    expect((await verifyApiToken(h.db as never, emptyArr.token)).ok).toBe(false);
  });

  it("rejects a revoked token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, { id: "tok_rev", active: false });
    const res = await verifyApiToken(h.db as never, token);
    expect(res.ok).toBe(false);
  });

  it("rejects a token with revoked_at set even if active is still true", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_revat",
      active: true,
      revokedAt: new Date().toISOString(),
    });
    const res = await verifyApiToken(h.db as never, token);
    expect(res.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_exp",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await verifyApiToken(h.db as never, token);
    expect(res.ok).toBe(false);
  });

  it("accepts a not-yet-expired token", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_future",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const res = await verifyApiToken(h.db as never, token);
    expect(res.ok).toBe(true);
  });
});

describe("touchLastUsed", () => {
  it("sets last_used_at when null", async () => {
    h = createTestDb();
    await seedToken(h.db, { id: "tok_touch" });
    await touchLastUsed(h.db as never, "tok_touch");
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
    await touchLastUsed(h.db as never, "tok_throttle");
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
    await touchLastUsed(h.db as never, "tok_stale");
    const after = h.db.select().from(apiTokens).where(eq(apiTokens.id, "tok_stale")).get();
    expect(after?.lastUsedAt).not.toBe(before?.lastUsedAt);
  });
});

describe("verifyApiToken — publish tokens (#2373)", () => {
  function seedSource(db: TestDatabase["db"]) {
    db.insert(organizations).values({ id: "org_p", slug: "p", name: "P" }).run();
    db.insert(sources)
      .values({
        id: "src_p",
        slug: "p-src",
        name: "P",
        type: "feed",
        url: "https://p.test/changelog",
        orgId: "org_p",
      })
      .run();
  }

  it("returns the source binding and owning user for a well-formed publish token", async () => {
    h = createTestDb();
    seedSource(h.db);
    const { token } = await seedToken(h.db, {
      id: "tok_pub",
      scopes: JSON.stringify(["publish"]),
      principalType: "user",
      principalId: "user_1",
      sourceId: "src_p",
    });
    expect(await verifyApiToken(h.db as never, token)).toEqual({
      ok: true,
      tokenId: "tok_pub",
      scopes: ["publish"],
      principalType: "user",
      principalId: "user_1",
      sourceId: "src_p",
    });
  });

  it("denies a source-bound row whose scopes aren't exactly publish", async () => {
    h = createTestDb();
    seedSource(h.db);
    for (const [i, scopes] of [["write"], ["publish", "read"], ["admin"]].entries()) {
      const { token } = await seedToken(h.db, {
        id: `tok_bad${i}`,
        scopes: JSON.stringify(scopes),
        principalType: "user",
        principalId: "user_1",
        sourceId: "src_p",
      });
      expect((await verifyApiToken(h.db as never, token)).ok).toBe(false);
    }
  });

  it("denies a source-bound row without a user owner", async () => {
    h = createTestDb();
    seedSource(h.db);
    const internal = await seedToken(h.db, {
      id: "tok_int",
      scopes: JSON.stringify(["publish"]),
      principalType: "internal",
      sourceId: "src_p",
    });
    expect((await verifyApiToken(h.db as never, internal.token)).ok).toBe(false);
    const noId = await seedToken(h.db, {
      id: "tok_noid",
      scopes: JSON.stringify(["publish"]),
      principalType: "user",
      sourceId: "src_p",
    });
    expect((await verifyApiToken(h.db as never, noId.token)).ok).toBe(false);
  });

  it("denies a publish scope with no source binding", async () => {
    h = createTestDb();
    const { token } = await seedToken(h.db, {
      id: "tok_unbound",
      scopes: JSON.stringify(["publish"]),
      principalType: "user",
      principalId: "user_1",
    });
    expect((await verifyApiToken(h.db as never, token)).ok).toBe(false);
  });
});
