/**
 * Tests for overview-upsert.ts.
 *
 * Coverage:
 * 1. resolveReleaseIdsByUrl — exact + fragment-strip fallback (#1003)
 * 2. upsertOrgOverview — first-write insert, second-write update,
 *    citations replace-all, releaseId resolution at write time
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { eq, and } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
import {
  organizations,
  sources,
  releases,
  knowledgePages,
  knowledgePageCitations,
} from "@buildinternet/releases-core/schema";
import { resolveReleaseIdsByUrl, upsertOrgOverview } from "./overview-upsert.js";

// Cast bun-sqlite TestDb to the DrizzleD1Database shape our helpers accept.
const asDb = (db: TestDatabase["db"]): any => db as any;

function seedOrg(tdb: TestDatabase) {
  tdb.db
    .insert(organizations)
    .values({
      id: "org_cit_01",
      name: "Citation Test Org",
      slug: "citation-test",
      discovery: "curated" as const,
    })
    .run();
}

function seedSource(tdb: TestDatabase, overrides: Partial<typeof sources.$inferInsert> = {}) {
  tdb.db
    .insert(sources)
    .values({
      id: "src_cit_01",
      name: "Citation Source",
      slug: "citation-source",
      type: "scrape" as const,
      url: "https://example.com/changelog",
      orgId: "org_cit_01",
      discovery: "curated" as const,
      ...overrides,
    })
    .run();
}

function seedRelease(tdb: TestDatabase, overrides: Partial<typeof releases.$inferInsert> = {}) {
  tdb.db
    .insert(releases)
    .values({
      id: "rel_cit_01",
      sourceId: "src_cit_01",
      title: "Test Release",
      content: "body",
      publishedAt: "2026-05-01T00:00:00Z",
      fetchedAt: "2026-05-01T01:00:00Z",
      ...overrides,
    })
    .run();
}

describe("resolveReleaseIdsByUrl", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
    seedOrg(tdb);
    seedSource(tdb);
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("returns an empty map for an empty input", async () => {
    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), []);
    expect(out.size).toBe(0);
  });

  it("resolves an exact case-insensitive URL match", async () => {
    seedRelease(tdb, {
      id: "rel_exact",
      url: "https://example.com/changelog/v1.0",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), ["HTTPS://example.com/CHANGELOG/v1.0"]);
    expect(out.get("https://example.com/changelog/v1.0")).toBe("rel_exact");
  });

  it("falls back to fragment-stripped match when citation has a fragment", async () => {
    // Per-release-page source: release stored with bare URL, citation
    // gratuitously carries a `#anchor`. Exact match misses; strip-fallback
    // resolves to the same release.
    seedRelease(tdb, {
      id: "rel_bare",
      url: "https://example.com/changelog/v2.0",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog/v2.0#highlights",
    ]);
    expect(out.get("https://example.com/changelog/v2.0#highlights")).toBe("rel_bare");
  });

  it("prefers exact match over fragment-stripped fallback", async () => {
    // Two releases share a base URL but differ by fragment. The citation's
    // exact-match release wins over the fallback path, even if another
    // release happens to live at the same base URL with no fragment.
    seedRelease(tdb, {
      id: "rel_with_fragment",
      url: "https://example.com/changelog#v1.0",
    });
    seedRelease(tdb, {
      id: "rel_bare_match",
      sourceId: "src_cit_01",
      url: "https://example.com/changelog",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), ["https://example.com/changelog#v1.0"]);
    expect(out.get("https://example.com/changelog#v1.0")).toBe("rel_with_fragment");
  });

  it("returns no entry when fragments mismatch and no bare URL exists", async () => {
    // CHANGELOG-anchored source: every release shares a base URL with its
    // own fragment. A citation fragment that doesn't match any stored
    // release fragment still returns null — we intentionally do not fuzzy-
    // match against titles (see overview-upsert.ts header, #1003).
    seedRelease(tdb, {
      id: "rel_v1",
      url: "https://example.com/changelog#section-a",
    });
    seedRelease(tdb, {
      id: "rel_v2",
      sourceId: "src_cit_01",
      url: "https://example.com/changelog#section-b",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog#section-c-the-one-that-doesnt-exist",
    ]);
    expect(
      out.get("https://example.com/changelog#section-c-the-one-that-doesnt-exist"),
    ).toBeUndefined();
  });

  it("handles a mixed batch (exact + fallback in one call)", async () => {
    seedRelease(tdb, {
      id: "rel_exact_a",
      url: "https://example.com/changelog#feature-a",
    });
    seedRelease(tdb, {
      id: "rel_fallback_b",
      sourceId: "src_cit_01",
      url: "https://example.com/changelog/v3.0",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog#feature-a", // exact
      "https://example.com/changelog/v3.0#anything", // fallback
    ]);
    expect(out.get("https://example.com/changelog#feature-a")).toBe("rel_exact_a");
    expect(out.get("https://example.com/changelog/v3.0#anything")).toBe("rel_fallback_b");
  });

  it("deduplicates input URLs that differ only in case", async () => {
    seedRelease(tdb, {
      id: "rel_dedup",
      url: "https://example.com/changelog/dedup",
    });

    const out = await resolveReleaseIdsByUrl(asDb(tdb.db), [
      "https://example.com/changelog/dedup",
      "HTTPS://EXAMPLE.COM/CHANGELOG/DEDUP",
    ]);
    expect(out.size).toBe(1);
    expect(out.get("https://example.com/changelog/dedup")).toBe("rel_dedup");
  });
});

describe("upsertOrgOverview", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
    seedOrg(tdb);
    seedSource(tdb);
  });

  afterAll(() => {
    tdb.cleanup();
  });

  it("inserts a knowledge_pages row on first write", async () => {
    const result = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "First overview.",
      citations: [],
      releaseCount: 5,
      lastContributingReleaseAt: "2026-05-01T00:00:00Z",
    });

    expect(result.pageId).toMatch(/^kp_/);
    expect(result.citationsWritten).toBe(0);

    const [row] = await tdb.db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, "org_cit_01")));
    expect(row?.content).toBe("First overview.");
    expect(row?.releaseCount).toBe(5);
    expect(row?.lastContributingReleaseAt).toBe("2026-05-01T00:00:00Z");
    expect(row?.generatedAt).toBeTruthy();
    expect(row?.updatedAt).toBeTruthy();
  });

  it("updates the existing row on the second write (last-write-wins)", async () => {
    const first = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "First overview.",
      citations: [],
      releaseCount: 5,
      lastContributingReleaseAt: "2026-05-01T00:00:00Z",
    });

    const second = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "Second overview.",
      citations: [],
      releaseCount: 12,
      lastContributingReleaseAt: "2026-05-10T00:00:00Z",
    });

    // ON CONFLICT branch retains the original row id; the second call should
    // return that same id rather than minting a new one.
    expect(second.pageId).toBe(first.pageId);

    const rows = await tdb.db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, "org_cit_01")));
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe("Second overview.");
    expect(rows[0]!.releaseCount).toBe(12);
    expect(rows[0]!.lastContributingReleaseAt).toBe("2026-05-10T00:00:00Z");
  });

  it("writes citation rows and resolves releaseId by URL match", async () => {
    seedRelease(tdb, {
      id: "rel_cited",
      url: "https://example.com/changelog/feature-x",
    });

    const result = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "Mentions feature X.",
      citations: [
        {
          sourceUrl: "https://example.com/changelog/feature-x",
          title: "Feature X",
        },
      ],
      releaseCount: 1,
      lastContributingReleaseAt: "2026-05-01T00:00:00Z",
    });

    expect(result.citationsWritten).toBe(1);

    const citationRows = await tdb.db
      .select()
      .from(knowledgePageCitations)
      .where(eq(knowledgePageCitations.knowledgePageId, result.pageId));
    expect(citationRows.length).toBe(1);
    expect(citationRows[0]!.sourceUrl).toBe("https://example.com/changelog/feature-x");
    expect(citationRows[0]!.releaseId).toBe("rel_cited");
  });

  it("resolves releaseIds across the 90-bind URL-lookup chunk boundary", async () => {
    // URL_LOOKUP_CHUNK_SIZE = 90; 91 unique URLs forces a two-chunk SELECT in
    // resolveReleaseIdsByUrl. CITATIONS_CHUNK_SIZE = 10 also forces multi-chunk
    // citation inserts.
    const N = 91;
    const releaseRows = Array.from({ length: N }, (_, i) => ({
      id: `rel_chunk_${i}`,
      sourceId: "src_cit_01",
      title: `R${i}`,
      content: "body",
      publishedAt: "2026-05-01T00:00:00Z",
      fetchedAt: "2026-05-01T01:00:00Z",
      url: `https://example.com/r/${i}`,
    }));
    tdb.db.insert(releases).values(releaseRows).run();

    const citations = Array.from({ length: N }, (_, i) => ({
      // Alternate case to exercise lowercase normalization through chunking.
      sourceUrl: i % 2 === 0 ? `https://example.com/r/${i}` : `HTTPS://EXAMPLE.COM/r/${i}`,
      title: `R${i}`,
    }));

    const result = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "Many citations.",
      citations,
      releaseCount: N,
      lastContributingReleaseAt: "2026-05-01T00:00:00Z",
    });
    expect(result.citationsWritten).toBe(N);

    const rows = await tdb.db
      .select()
      .from(knowledgePageCitations)
      .where(eq(knowledgePageCitations.knowledgePageId, result.pageId));
    expect(rows.length).toBe(N);
    // Every citation must resolve a releaseId despite the chunked lookup.
    const resolved = rows.filter((r) => r.releaseId !== null);
    expect(resolved.length).toBe(N);
  });

  it("leaves releaseId null when no release matches the citation URL", async () => {
    const result = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "Mentions a missing release.",
      citations: [
        {
          sourceUrl: "https://example.com/changelog/no-such-release",
          title: null,
        },
      ],
      releaseCount: 0,
      lastContributingReleaseAt: null,
    });

    const [citation] = await tdb.db
      .select()
      .from(knowledgePageCitations)
      .where(eq(knowledgePageCitations.knowledgePageId, result.pageId));
    expect(citation?.releaseId).toBeNull();
  });

  it("replaces all citations on rewrite", async () => {
    seedRelease(tdb, { id: "rel_a", url: "https://example.com/a" });
    seedRelease(tdb, { id: "rel_b", url: "https://example.com/b" });

    const first = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "First.",
      citations: [
        {
          sourceUrl: "https://example.com/a",
          title: "A",
        },
        {
          sourceUrl: "https://example.com/a",
          title: "A again",
        },
      ],
      releaseCount: 1,
      lastContributingReleaseAt: "2026-05-01T00:00:00Z",
    });
    expect(first.citationsWritten).toBe(2);

    const second = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "Second.",
      citations: [
        {
          sourceUrl: "https://example.com/b",
          title: "B",
        },
      ],
      releaseCount: 2,
      lastContributingReleaseAt: "2026-05-02T00:00:00Z",
    });
    expect(second.citationsWritten).toBe(1);

    const citationRows = await tdb.db
      .select()
      .from(knowledgePageCitations)
      .where(eq(knowledgePageCitations.knowledgePageId, second.pageId));
    expect(citationRows.length).toBe(1);
    expect(citationRows[0]!.sourceUrl).toBe("https://example.com/b");
  });

  it("clears prior citations when the new write has zero citations", async () => {
    seedRelease(tdb, { id: "rel_a", url: "https://example.com/a" });

    const first = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "First.",
      citations: [
        {
          sourceUrl: "https://example.com/a",
          title: "A",
        },
      ],
      releaseCount: 1,
      lastContributingReleaseAt: "2026-05-01T00:00:00Z",
    });
    expect(first.citationsWritten).toBe(1);

    const second = await upsertOrgOverview(asDb(tdb.db), {
      orgId: "org_cit_01",
      content: "Second.",
      citations: [],
      releaseCount: 1,
      lastContributingReleaseAt: "2026-05-02T00:00:00Z",
    });
    expect(second.citationsWritten).toBe(0);

    const citationRows = await tdb.db
      .select()
      .from(knowledgePageCitations)
      .where(eq(knowledgePageCitations.knowledgePageId, second.pageId));
    expect(citationRows.length).toBe(0);
  });
});
