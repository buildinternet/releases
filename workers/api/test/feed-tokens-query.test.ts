import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import { user } from "../src/db/schema-auth.js";
import {
  upsertFeedToken,
  getFeedToken,
  deleteFeedToken,
  resolveFeedToken,
} from "../src/queries/feed-tokens.js";

let h: TestDatabase;

beforeEach(async () => {
  h = createTestDb();
  await h.db.insert(user).values({
    id: "u1",
    name: "T",
    email: "t@e.com",
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
afterEach(() => h.cleanup());

describe("feed-token queries", () => {
  it("mints, fetches, and resolves a token", async () => {
    const minted = await upsertFeedToken(h.db, "u1");
    expect(minted.token).toMatch(/^relf_/);

    const row = await getFeedToken(h.db, "u1");
    expect(row?.lookupId).toBe(minted.lookupId);

    const userId = await resolveFeedToken(h.db, minted.token);
    expect(userId).toBe("u1");
  });

  it("rotate (second upsert) invalidates the previous token", async () => {
    const first = await upsertFeedToken(h.db, "u1");
    const second = await upsertFeedToken(h.db, "u1");
    expect(second.token).not.toBe(first.token);
    expect(await resolveFeedToken(h.db, first.token)).toBeNull();
    expect(await resolveFeedToken(h.db, second.token)).toBe("u1");
    // Still exactly one row for the user.
    expect((await getFeedToken(h.db, "u1"))?.lookupId).toBe(second.lookupId);
  });

  it("revoke deletes the row and the token stops resolving", async () => {
    const minted = await upsertFeedToken(h.db, "u1");
    await deleteFeedToken(h.db, "u1");
    expect(await getFeedToken(h.db, "u1")).toBeNull();
    expect(await resolveFeedToken(h.db, minted.token)).toBeNull();
  });

  it("resolveFeedToken returns null for malformed or unknown tokens", async () => {
    expect(await resolveFeedToken(h.db, "garbage")).toBeNull();
    expect(
      await resolveFeedToken(h.db, "relf_" + "a".repeat(12) + "_" + "b".repeat(32)),
    ).toBeNull();
  });
});
