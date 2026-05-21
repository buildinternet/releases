import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { runEnrichBackfill } from "../../workers/api/src/routes/workflows.js";

let tdb: TestDatabase;
beforeAll(() => {
  tdb = createTestDb();
});
beforeEach(() => clearAllTables(tdb.db));
afterAll(() => tdb.cleanup());

async function seed() {
  await tdb.db
    .insert(organizations)
    .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
  await tdb.db.insert(sources).values({
    id: "src_1",
    slug: "f",
    name: "F",
    type: "feed",
    url: "https://x.test",
    orgId: "org_1",
    discovery: "curated",
  });
  // thin (content == summary) un-enriched
  await tdb.db.insert(releases).values({
    id: "rel_thin",
    sourceId: "src_1",
    type: "feature",
    title: "T",
    content: "teaser",
    summary: "teaser",
    url: "https://x.test/a",
    titleGenerated: "old gen",
    embeddedAt: "2026-01-01",
  });
  // already enriched (marker present) — must be skipped
  await tdb.db.insert(releases).values({
    id: "rel_done",
    sourceId: "src_1",
    type: "feature",
    title: "T2",
    content: "big body ".repeat(200),
    url: "https://x.test/b",
    metadata: JSON.stringify({ enrichment: { attemptedAt: "x", succeeded: true } }),
  });
}

describe("runEnrichBackfill", () => {
  it("dryRun reports candidates without writing", async () => {
    await seed();
    const report = await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: true, thinChars: 600 },
      {
        enrichFn: async () => ({ status: "enriched", content: "X".repeat(800), media: [] }),
        regenerate: async () => {},
      },
    );
    expect(report.scanned).toBe(1);
    expect(report.enriched).toBe(0);
    const [row] = await tdb.db
      .select({ content: releases.content })
      .from(releases)
      .where(eq(releases.id, "rel_thin"));
    expect(row.content).toBe("teaser"); // unchanged
  });

  it("real run updates content, nulls summary/embeddedAt, and regenerates", async () => {
    await seed();
    let regenIds: string[] = [];
    const report = await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: false, thinChars: 600 },
      {
        enrichFn: async () => ({
          status: "enriched",
          via: "fetch",
          content: "X".repeat(800),
          media: [],
        }),
        regenerate: async (ids) => {
          regenIds = ids;
        },
      },
    );
    expect(report.enriched).toBe(1);
    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_thin"));
    expect(row.content.length).toBe(800);
    expect(row.summary).toBeNull();
    expect(row.titleGenerated).toBeNull();
    expect(row.embeddedAt).toBeNull();
    expect(JSON.parse(row.metadata!).enrichment.succeeded).toBe(true);
    expect(regenIds).toEqual(["rel_thin"]);
  });

  it("preserves existing metadata keys when writing the enrichment marker", async () => {
    await tdb.db
      .insert(organizations)
      .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
    await tdb.db.insert(sources).values({
      id: "src_1",
      slug: "f",
      name: "F",
      type: "feed",
      url: "https://x.test",
      orgId: "org_1",
      discovery: "curated",
    });
    await tdb.db.insert(releases).values({
      id: "rel_meta",
      sourceId: "src_1",
      type: "feature",
      title: "T",
      content: "teaser",
      summary: "teaser",
      url: "https://x.test/c",
      metadata: JSON.stringify({ foo: "bar" }),
    });

    await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: false, thinChars: 600 },
      {
        enrichFn: async () => ({ status: "enriched", via: "fetch", content: "X".repeat(800) }),
        regenerate: async () => {},
      },
    );

    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_meta"));
    const meta = JSON.parse(row.metadata!);
    expect(meta.foo).toBe("bar"); // pre-existing key preserved
    expect(meta.enrichment.succeeded).toBe(true);
  });

  it("does not select full-body releases that merely lack a summary", async () => {
    await tdb.db
      .insert(organizations)
      .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
    await tdb.db.insert(sources).values({
      id: "src_1",
      slug: "f",
      name: "F",
      type: "feed",
      url: "https://x.test",
      orgId: "org_1",
      discovery: "curated",
    });
    // No summary, but a long body (> thinChars) — a real article, not a teaser.
    await tdb.db.insert(releases).values({
      id: "rel_full",
      sourceId: "src_1",
      type: "feature",
      title: "Full",
      content: "x".repeat(2000),
      url: "https://x.test/full",
    });

    const report = await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: true, thinChars: 600 },
      {
        enrichFn: async () => ({ status: "enriched", content: "X".repeat(800) }),
        regenerate: async () => {},
      },
    );
    expect(report.scanned).toBe(0); // full-body summary-less row excluded
  });

  it("retries a previously-failed enrichment attempt", async () => {
    await seed();
    // rel_thin has no marker; add a thin row whose prior attempt failed.
    await tdb.db.insert(releases).values({
      id: "rel_failed",
      sourceId: "src_1",
      type: "feature",
      title: "T3",
      content: "teaser",
      summary: "teaser",
      url: "https://x.test/d",
      metadata: JSON.stringify({ enrichment: { attemptedAt: "x", succeeded: false } }),
    });

    const report = await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: false, thinChars: 600 },
      {
        enrichFn: async () => ({ status: "enriched", via: "fetch", content: "X".repeat(800) }),
        regenerate: async () => {},
      },
    );
    // rel_thin (no marker) + rel_failed (succeeded:false) both enriched; rel_done skipped.
    expect(report.enriched).toBe(2);
    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_failed"));
    expect(row.content.length).toBe(800);
  });

  it("does not clobber existing media when backfilling", async () => {
    await tdb.db
      .insert(organizations)
      .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
    await tdb.db.insert(sources).values({
      id: "src_1",
      slug: "f",
      name: "F",
      type: "feed",
      url: "https://x.test",
      orgId: "org_1",
      discovery: "curated",
    });
    const existing = JSON.stringify([{ type: "image", url: "https://x.test/feed.png" }]);
    await tdb.db.insert(releases).values({
      id: "rel_media",
      sourceId: "src_1",
      type: "feature",
      title: "T",
      content: "teaser",
      summary: "teaser",
      url: "https://x.test/e",
      media: existing,
    });

    await runEnrichBackfill(
      tdb.db as any,
      "src_1",
      { limit: 10, dryRun: false, thinChars: 600 },
      {
        enrichFn: async () => ({
          status: "enriched",
          via: "fetch",
          content: "X".repeat(800),
          media: [{ type: "image", url: "https://x.test/article.png" }],
        }),
        regenerate: async () => {},
      },
    );
    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_media"));
    expect(row.media).toBe(existing); // feed media preserved, not overwritten
  });
});
