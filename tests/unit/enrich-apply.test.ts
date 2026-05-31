import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import {
  applyExtractedContent,
  selectEnrichCandidates,
  type EnrichCandidateRow,
} from "../../workers/api/src/lib/enrich-apply.js";

let tdb: TestDatabase;
beforeAll(() => {
  tdb = createTestDb();
});
beforeEach(() => clearAllTables(tdb.db));
afterAll(() => tdb.cleanup());

async function seedSource() {
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
}

async function insertThin(id: string, url: string, extra: Record<string, unknown> = {}) {
  await tdb.db.insert(releases).values({
    id,
    sourceId: "src_1",
    type: "feature",
    title: "T",
    content: "teaser",
    summary: "teaser",
    url,
    titleGenerated: "old gen",
    titleShort: "old short",
    embeddedAt: "2026-01-01",
    ...extra,
  });
}

/** Build the candidate-row shape the applier consumes, from a stored release. */
async function candidate(id: string): Promise<EnrichCandidateRow> {
  const [row] = await tdb.db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      title: releases.title,
      version: releases.version,
      publishedAt: releases.publishedAt,
      content: releases.content,
      url: releases.url,
      media: releases.media,
      metadata: releases.metadata,
    })
    .from(releases)
    .where(eq(releases.id, id));
  return row as EnrichCandidateRow;
}

describe("applyExtractedContent", () => {
  it("enriches a row above the improvement floor and nulls regen fields", async () => {
    await seedSource();
    await insertThin("rel_thin", "https://x.test/a");
    const cand = await candidate("rel_thin");

    const result = await applyExtractedContent(tdb.db as never, {
      candidates: [cand],
      extracted: new Map([["rel_thin", "X".repeat(800)]]),
      thinChars: 600,
    });

    expect(result).toEqual({ enriched: 1, skipped: 0, enrichedIds: ["rel_thin"] });
    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_thin"));
    expect(row.content.length).toBe(800);
    expect(row.summary).toBeNull();
    expect(row.titleGenerated).toBeNull();
    expect(row.titleShort).toBeNull();
    expect(row.embeddedAt).toBeNull();
    const meta = JSON.parse(row.metadata!);
    expect(meta.enrichment.succeeded).toBe(true);
    expect(meta.enrichment.via).toBe("render");
  });

  it("skips an empty <article> result (JS shell) with a failure marker, leaving content intact", async () => {
    await seedSource();
    await insertThin("rel_empty", "https://x.test/b");
    const cand = await candidate("rel_empty");

    const result = await applyExtractedContent(tdb.db as never, {
      candidates: [cand],
      extracted: new Map([["rel_empty", ""]]),
      thinChars: 600,
    });

    expect(result).toEqual({ enriched: 0, skipped: 1, enrichedIds: [] });
    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_empty"));
    expect(row.content).toBe("teaser"); // unchanged
    expect(row.titleGenerated).toBe("old gen"); // regen fields untouched
    expect(JSON.parse(row.metadata!).enrichment.succeeded).toBe(false);
  });

  it("skips content that does not clear the improvement floor", async () => {
    await seedSource();
    await insertThin("rel_short", "https://x.test/c");
    const cand = await candidate("rel_short");

    const result = await applyExtractedContent(tdb.db as never, {
      candidates: [cand],
      extracted: new Map([["rel_short", "still tiny"]]),
      thinChars: 600,
    });

    expect(result.enriched).toBe(0);
    expect(result.skipped).toBe(1);
    const [row] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_short"));
    expect(row.content).toBe("teaser");
  });

  it("treats a missing batch result (custom_id absent) as a skip", async () => {
    await seedSource();
    await insertThin("rel_missing", "https://x.test/d");
    const cand = await candidate("rel_missing");

    const result = await applyExtractedContent(tdb.db as never, {
      candidates: [cand],
      extracted: new Map(), // no entry for rel_missing
      thinChars: 600,
    });

    expect(result.skipped).toBe(1);
    expect(JSON.parse((await candidate("rel_missing")).metadata!).enrichment.succeeded).toBe(false);
  });

  it("backfills article media only when the row has none", async () => {
    await seedSource();
    const existing = JSON.stringify([{ type: "image", url: "https://x.test/feed.png" }]);
    await insertThin("rel_hasmedia", "https://x.test/e", { media: existing });
    await insertThin("rel_nomedia", "https://x.test/f");

    const body = "## Body\n\n![shot](https://x.test/article.png)\n\n" + "X".repeat(800);
    await applyExtractedContent(tdb.db as never, {
      candidates: [await candidate("rel_hasmedia"), await candidate("rel_nomedia")],
      extracted: new Map([
        ["rel_hasmedia", body],
        ["rel_nomedia", body],
      ]),
      thinChars: 600,
    });

    const [withMedia] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_hasmedia"));
    expect(withMedia.media).toBe(existing); // not clobbered

    const [noMedia] = await tdb.db.select().from(releases).where(eq(releases.id, "rel_nomedia"));
    expect(noMedia.media).toContain("https://x.test/article.png"); // article image attached
  });

  it("preserves unrelated metadata keys when writing the marker", async () => {
    await seedSource();
    await insertThin("rel_meta", "https://x.test/g", {
      metadata: JSON.stringify({ foo: "bar" }),
    });

    await applyExtractedContent(tdb.db as never, {
      candidates: [await candidate("rel_meta")],
      extracted: new Map([["rel_meta", "X".repeat(800)]]),
      thinChars: 600,
    });

    const meta = JSON.parse((await candidate("rel_meta")).metadata!);
    expect(meta.foo).toBe("bar");
    expect(meta.enrichment.succeeded).toBe(true);
  });
});

describe("selectEnrichCandidates", () => {
  async function seedTwoSources() {
    await tdb.db
      .insert(organizations)
      .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
    for (const id of ["src_1", "src_2", "src_other"]) {
      await tdb.db.insert(sources).values({
        id,
        slug: id,
        name: id,
        type: "feed",
        url: `https://${id}.test`,
        orgId: "org_1",
        discovery: "curated",
      });
    }
    const rows = [
      // thin, un-enriched, src_1 → candidate
      { id: "c_thin1", sourceId: "src_1", content: "teaser", summary: "teaser", url: "u1" },
      // thin, un-enriched, src_2 → candidate
      { id: "c_thin2", sourceId: "src_2", content: "teaser", summary: "teaser", url: "u2" },
      // prior failed attempt → still a candidate (retryable)
      {
        id: "c_failed",
        sourceId: "src_1",
        content: "teaser",
        summary: "teaser",
        url: "u3",
        metadata: JSON.stringify({ enrichment: { attemptedAt: "x", succeeded: false } }),
      },
      // already succeeded → excluded
      {
        id: "c_done",
        sourceId: "src_1",
        content: "teaser",
        summary: "teaser",
        url: "u4",
        metadata: JSON.stringify({ enrichment: { attemptedAt: "x", succeeded: true } }),
      },
      // full-body, summary-less → excluded (not thin)
      { id: "c_full", sourceId: "src_2", content: "x".repeat(2000), url: "u5" },
      // no URL → excluded
      { id: "c_nourl", sourceId: "src_1", content: "teaser", summary: "teaser", url: null },
      // belongs to an untargeted source → excluded
      { id: "c_other", sourceId: "src_other", content: "teaser", summary: "teaser", url: "u6" },
    ];
    for (const r of rows) {
      // oxlint-disable-next-line no-await-in-loop -- test seed
      await tdb.db.insert(releases).values({ type: "feature", title: "T", ...r } as never);
    }
  }

  it("selects thin, un-enriched (or failed) rows across the targeted sources only", async () => {
    await seedTwoSources();
    const rows = await selectEnrichCandidates(tdb.db as never, {
      sourceIds: ["src_1", "src_2"],
      limit: 50,
      thinChars: 600,
    });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["c_thin1", "c_thin2", "c_failed"]));
  });

  it("honors the limit", async () => {
    await seedTwoSources();
    const rows = await selectEnrichCandidates(tdb.db as never, {
      sourceIds: ["src_1", "src_2"],
      limit: 2,
      thinChars: 600,
    });
    expect(rows).toHaveLength(2);
  });
});
