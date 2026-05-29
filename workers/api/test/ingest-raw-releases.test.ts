/**
 * Integration tests for the `ingestRawReleases` extracted helper.
 *
 * Verifies that:
 * - Two distinct RawRelease objects are inserted and returned with
 *   found/inserted/insertedIds/visiblePublishRows correctly populated.
 * - A second call with the same two releases is a pure no-op (dedup via
 *   onConflictDoNothing on UNIQUE(source_id, url)).
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";

// Import AFTER any mock.module registrations that other files may have
// registered. We do not stub any adapters here — `ingestRawReleases` does not
// call any feed-fetch path so no stubs are needed.
const { ingestRawReleases } = await import("../src/cron/poll-fetch.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

const rawA: RawRelease = {
  title: "Release A",
  content: "Content of release A.",
  url: "https://example.com/releases/a",
  isBreaking: false,
  media: [],
};

const rawB: RawRelease = {
  title: "Release B",
  content: "Content of release B.",
  url: "https://example.com/releases/b",
  version: "2.0.0",
  isBreaking: false,
  media: [],
};

describe("ingestRawReleases", () => {
  it("inserts two new raw releases and returns correct counts", async () => {
    const db = mkDb();

    await db
      .insert(organizations)
      .values({ id: "org_test", slug: "test-org", name: "Test Org", category: "cloud" });
    await db.insert(sources).values({
      id: "src_test",
      orgId: "org_test",
      slug: "test-source",
      name: "Test Source",
      type: "scrape",
      url: "https://example.com",
    });

    const { eq } = await import("drizzle-orm");
    const [source] = await db.select().from(sources).where(eq(sources.id, "src_test"));

    // env: minimal — RELEASE_HUB=undefined skips publishReleaseEvents,
    // INDEXNOW_ENABLED unset skips notifyIndexNowForSource, no R2/embed bindings.
    const env = {
      RELEASE_HUB: undefined,
      DB: undefined,
    } as never;

    const result = await ingestRawReleases(db as never, source!, [rawA, rawB], env);

    expect(result.found).toBe(2);
    expect(result.inserted).toBe(2);
    expect(result.insertedIds).toHaveLength(2);
    expect(result.visiblePublishRows).toHaveLength(2);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_test"));
    expect(rows).toHaveLength(2);
  });

  it("is idempotent — re-inserting the same releases produces inserted=0", async () => {
    const db = mkDb();
    const { eq } = await import("drizzle-orm");

    await db
      .insert(organizations)
      .values({ id: "org_idem", slug: "idem-org", name: "Idem Org", category: "cloud" });
    await db.insert(sources).values({
      id: "src_idem",
      orgId: "org_idem",
      slug: "idem-source",
      name: "Idem Source",
      type: "scrape",
      url: "https://idem.example.com",
    });

    const [source] = await db.select().from(sources).where(eq(sources.id, "src_idem"));

    const env = {
      RELEASE_HUB: undefined,
      DB: undefined,
    } as never;

    // First call inserts both.
    const first = await ingestRawReleases(db as never, source!, [rawA, rawB], env);
    expect(first.inserted).toBe(2);

    // Second call with the same releases must be a no-op.
    const second = await ingestRawReleases(db as never, source!, [rawA, rawB], env);
    expect(second.found).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.insertedIds).toHaveLength(0);
    expect(second.visiblePublishRows).toHaveLength(0);

    // DB still has exactly 2 rows (no duplicates).
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_idem"));
    expect(rows).toHaveLength(2);
  });
});
