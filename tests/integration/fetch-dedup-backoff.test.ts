import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { sources, releases, organizations } from "@releases/core-internal/schema";
import { contentHash } from "@releases/adapters/content-hash";
import type { RawRelease } from "../../src/adapters/types.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

async function seedSource(db: typeof testDb.db) {
  const [org] = await db
    .insert(organizations)
    .values({
      name: "Test Org",
      slug: "test-org",
    })
    .returning();

  const [source] = await db
    .insert(sources)
    .values({
      name: "Test Source",
      slug: "test-source",
      type: "feed",
      url: "https://example.com/feed.xml",
      orgId: org.id,
    })
    .returning();

  return { org, source };
}

function makeRawRelease(overrides?: Partial<RawRelease>): RawRelease {
  return {
    title: "v1.0.0 — Test Release",
    content: "Test content for release",
    url: "https://example.com/releases/v1-0-0",
    version: "1.0.0",
    publishedAt: new Date("2024-01-15T00:00:00Z"),
    ...overrides,
  };
}

describe("release dedup (UNIQUE constraints)", () => {
  it("inserts releases with unique URLs", async () => {
    const { source } = await seedSource(testDb.db);
    const raw1 = makeRawRelease({ url: "https://example.com/r/1", title: "Release 1" });
    const raw2 = makeRawRelease({ url: "https://example.com/r/2", title: "Release 2" });

    const rows = [raw1, raw2].map((r) => ({
      sourceId: source.id,
      version: r.version ?? null,
      title: r.title,
      content: r.content,
      url: r.url ?? null,
      contentHash: contentHash(r),
      publishedAt: r.publishedAt?.toISOString() ?? null,
    }));

    const result = await testDb.db.insert(releases).values(rows).returning();
    expect(result).toHaveLength(2);
  });

  it("rejects duplicate URL for same source (UNIQUE constraint)", async () => {
    const { source } = await seedSource(testDb.db);
    const raw = makeRawRelease();

    const row = {
      sourceId: source.id,
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: raw.url ?? null,
      contentHash: contentHash(raw),
      publishedAt: raw.publishedAt?.toISOString() ?? null,
    };

    await testDb.db.insert(releases).values(row);

    await expect(
      testDb.db
        .insert(releases)
        .values({
          ...row,
          contentHash: "different-hash",
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("allows duplicate contentHash with different URLs for same source", async () => {
    const { source } = await seedSource(testDb.db);
    const raw = makeRawRelease();
    const hash = contentHash(raw);

    const row = {
      sourceId: source.id,
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: "https://example.com/r/1",
      contentHash: hash,
      publishedAt: raw.publishedAt?.toISOString() ?? null,
    };

    await testDb.db.insert(releases).values(row);

    const result = await testDb.db
      .insert(releases)
      .values({ ...row, url: "https://example.com/r/2" })
      .returning();
    expect(result).toHaveLength(1);

    const allRows = await testDb.db.select().from(releases);
    expect(allRows).toHaveLength(2);
  });

  it("allows same URL across different sources", async () => {
    const { source } = await seedSource(testDb.db);

    const [source2] = await testDb.db
      .insert(sources)
      .values({
        name: "Other Source",
        slug: "other-source",
        type: "feed",
        url: "https://other.com/feed.xml",
      })
      .returning();

    const raw = makeRawRelease();
    const sharedRow = {
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: raw.url ?? null,
      contentHash: contentHash(raw),
      publishedAt: raw.publishedAt?.toISOString() ?? null,
    };

    await testDb.db.insert(releases).values({ sourceId: source.id, ...sharedRow });
    const result = await testDb.db
      .insert(releases)
      .values({ sourceId: source2.id, ...sharedRow })
      .returning();
    expect(result).toHaveLength(1);
  });
});

describe("contentHash consistency", () => {
  it("produces same hash for identical releases", () => {
    const raw1 = makeRawRelease();
    const raw2 = makeRawRelease();
    expect(contentHash(raw1)).toBe(contentHash(raw2));
  });

  it("produces different hash when title changes", () => {
    const raw1 = makeRawRelease({ title: "v1.0.0" });
    const raw2 = makeRawRelease({ title: "v1.0.1" });
    expect(contentHash(raw1)).not.toBe(contentHash(raw2));
  });

  it("produces different hash when content changes", () => {
    const raw1 = makeRawRelease({ content: "Original" });
    const raw2 = makeRawRelease({ content: "Updated" });
    expect(contentHash(raw1)).not.toBe(contentHash(raw2));
  });

  it("produces different hash when date changes", () => {
    const raw1 = makeRawRelease({ publishedAt: new Date("2024-01-01") });
    const raw2 = makeRawRelease({ publishedAt: new Date("2024-01-02") });
    expect(contentHash(raw1)).not.toBe(contentHash(raw2));
  });
});
