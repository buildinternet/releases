/**
 * Tests for getCollectionReleasesFeed (#862).
 *
 * Key coverage:
 * 1. Large orgIds list (150 IDs) — previously exceeded D1's 100-bind-parameter
 *    ceiling; now chunked into batches of 90.
 * 2. Ordering is preserved across chunk boundaries (published_at DESC,
 *    fetched_at DESC, id DESC; null published_at sorted last).
 * 3. Cursor pagination remains stable across multiple pages.
 * 4. Null published_at rows sort after all dated rows (null-tail branch).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { getCollectionReleasesFeed, buildFeedCursor } from "./collection-feed.js";
import type { D1Db } from "../../../workers/api/src/db.js";

// Cast the Drizzle bun-sqlite db to the D1Db interface used by collection-feed.
const asD1 = (db: TestDatabase["db"]): D1Db => db as unknown as D1Db;

describe("getCollectionReleasesFeed — large orgIds (>90, fixes #862)", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });

  beforeEach(() => {
    clearAllTables(tdb.db);
  });

  afterAll(() => {
    tdb.cleanup();
  });

  /**
   * D1 caps prepared-statement parameters at 100. Chunk sizes are derived
   * from the number of columns each insert actually binds:
   *   organizations: 4 cols (id, name, slug, discovery)       → floor(100/4) = 25
   *   sources:       7 cols (id, name, slug, type, url,
   *                          orgId, discovery)                 → floor(100/7) = 14
   *   releases:      7 cols (id, sourceId, title, content,
   *                          type, publishedAt, fetchedAt)     → floor(100/7) = 14
   *
   * Use the strictest value (14) across all three tables so a single constant
   * is safe regardless of insert order.
   */
  const SEED_CHUNK = 14;

  /**
   * Build N org + source + release rows. Returns the org IDs in insertion order.
   * Every 20th release has publishedAt = null to exercise the null-tail sort
   * branch in getCollectionReleasesFeed.
   */
  async function seedOrgs(db: TestDatabase["db"], count: number): Promise<string[]> {
    const orgIds: string[] = [];
    const orgRows: (typeof organizations.$inferInsert)[] = [];
    const srcRows: (typeof sources.$inferInsert)[] = [];
    const relRows: (typeof releases.$inferInsert)[] = [];

    for (let i = 0; i < count; i++) {
      const orgId = `org_${String(i).padStart(5, "0")}`;
      const srcId = `src_${String(i).padStart(5, "0")}`;
      orgIds.push(orgId);
      orgRows.push({ id: orgId, name: `Org ${i}`, slug: `org-${i}`, discovery: "curated" });
      srcRows.push({
        id: srcId,
        name: `Source ${i}`,
        slug: `src-${i}`,
        type: "github",
        url: `https://github.com/example/repo-${i}`,
        orgId,
        discovery: "curated",
      });
      // Every 20th release has null publishedAt to exercise the null-tail branch.
      // fetchedAt is unique-per-row (encodes i) so null-tail ordering is stable.
      const isNullPublished = i % 20 === 0;
      relRows.push({
        id: `rel_${String(i).padStart(5, "0")}`,
        sourceId: srcId,
        title: `Release ${i}`,
        content: `Content for release ${i}`,
        type: "feature",
        publishedAt: isNullPublished
          ? null
          : `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        fetchedAt: `2026-02-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`,
      });
    }

    // Insert in per-table chunks that respect D1's 100-bind-parameter cap.
    for (let i = 0; i < orgRows.length; i += SEED_CHUNK) {
      await db.insert(organizations).values(orgRows.slice(i, i + SEED_CHUNK)); // eslint-disable-line no-await-in-loop
      await db.insert(sources).values(srcRows.slice(i, i + SEED_CHUNK)); // eslint-disable-line no-await-in-loop
      await db.insert(releases).values(relRows.slice(i, i + SEED_CHUNK)); // eslint-disable-line no-await-in-loop
    }

    return orgIds;
  }

  it("returns rows when orgIds has 150 elements (previously exceeded D1 100-bind cap)", async () => {
    const orgIds = await seedOrgs(tdb.db, 150);

    // This would throw "too many SQL variables" (D1-equivalent) before the fix.
    const rows = await getCollectionReleasesFeed(asD1(tdb.db), orgIds, null, 200);

    // We seeded one release per org, so we should get all 150 back.
    expect(rows.length).toBe(150);
  });

  it("returns an empty array for an empty orgIds list", async () => {
    const rows = await getCollectionReleasesFeed(asD1(tdb.db), [], null, 10);
    expect(rows).toEqual([]);
  });

  it("preserves published_at DESC ordering with null-tail across chunk boundaries (150 orgs)", async () => {
    const orgIds = await seedOrgs(tdb.db, 150);
    const rows = await getCollectionReleasesFeed(asD1(tdb.db), orgIds, null, 200);

    // Verify every dated row comes before any null-published row,
    // and within dated rows, descending order is maintained.
    let prevPublishedAt: string | null | undefined;
    let hitNull = false;

    for (const row of rows) {
      if (row.published_at === null) {
        hitNull = true;
      } else {
        // Once we have hit null rows we should not see dated rows again.
        expect(hitNull).toBe(false);
        if (prevPublishedAt !== undefined && prevPublishedAt !== null) {
          expect(row.published_at <= prevPublishedAt).toBe(true);
        }
        prevPublishedAt = row.published_at;
      }
    }

    // The seed puts every 20th row (i=0,20,40,...) as null-published.
    // With 150 orgs that is 8 null rows (i=0,20,40,60,80,100,120,140).
    // Assert the null-tail branch was actually exercised.
    expect(hitNull).toBe(true);
  });

  describe("sourceTypes filter", () => {
    /**
     * Seed two orgs, each with one github + one feed source + one release per
     * source. Used by the source-type filter tests below.
     */
    async function seedMixedTypes() {
      await tdb.db.insert(organizations).values([
        { id: "org_a", name: "A", slug: "a", discovery: "curated" },
        { id: "org_b", name: "B", slug: "b", discovery: "curated" },
      ]);
      await tdb.db.insert(sources).values([
        {
          id: "src_a_gh",
          name: "A GH",
          slug: "a-gh",
          type: "github",
          url: "https://github.com/example/a",
          orgId: "org_a",
          discovery: "curated",
        },
        {
          id: "src_a_feed",
          name: "A Feed",
          slug: "a-feed",
          type: "feed",
          url: "https://a.example/feed",
          orgId: "org_a",
          discovery: "curated",
        },
        {
          id: "src_b_gh",
          name: "B GH",
          slug: "b-gh",
          type: "github",
          url: "https://github.com/example/b",
          orgId: "org_b",
          discovery: "curated",
        },
      ]);
      await tdb.db.insert(releases).values([
        {
          id: "rel_a_gh",
          sourceId: "src_a_gh",
          title: "A GH",
          content: "",
          type: "feature",
          publishedAt: "2026-01-01T00:00:00Z",
          fetchedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "rel_a_feed",
          sourceId: "src_a_feed",
          title: "A Feed",
          content: "",
          type: "feature",
          publishedAt: "2026-01-02T00:00:00Z",
          fetchedAt: "2026-01-02T00:00:00Z",
        },
        {
          id: "rel_b_gh",
          sourceId: "src_b_gh",
          title: "B GH",
          content: "",
          type: "feature",
          publishedAt: "2026-01-03T00:00:00Z",
          fetchedAt: "2026-01-03T00:00:00Z",
        },
      ]);
    }

    it("returns all rows when sourceTypes is omitted", async () => {
      await seedMixedTypes();
      const rows = await getCollectionReleasesFeed(asD1(tdb.db), ["org_a", "org_b"], null, 50);
      expect(rows.map((r) => r.id).toSorted()).toEqual(["rel_a_feed", "rel_a_gh", "rel_b_gh"]);
    });

    it("narrows to the named source types", async () => {
      await seedMixedTypes();
      const onlyFeed = await getCollectionReleasesFeed(asD1(tdb.db), ["org_a", "org_b"], null, 50, {
        sourceTypes: ["feed"],
      });
      expect(onlyFeed.map((r) => r.id)).toEqual(["rel_a_feed"]);

      const onlyGithub = await getCollectionReleasesFeed(
        asD1(tdb.db),
        ["org_a", "org_b"],
        null,
        50,
        { sourceTypes: ["github"] },
      );
      expect(onlyGithub.map((r) => r.id).toSorted()).toEqual(["rel_a_gh", "rel_b_gh"]);
    });

    it("returns nothing when sourceTypes is an empty array", async () => {
      await seedMixedTypes();
      const rows = await getCollectionReleasesFeed(asD1(tdb.db), ["org_a", "org_b"], null, 50, {
        sourceTypes: [],
      });
      expect(rows).toEqual([]);
    });

    it("stays under D1's 100-bind cap at the chunk boundary with all source-type slots used", async () => {
      // Worst-case bind count for a single chunk:
      //   ORG_ID_CHUNK_SIZE org IDs (89) + full SOURCE_TYPES enum (4)
      //   + cursor predicate (6) + LIMIT (1) = 100.
      // Seed exactly that many orgs so we exercise the single-chunk path at
      // its widest, with sourceTypes and a cursor both engaged. A regression
      // that re-raises the chunk size (or adds bind slots without trimming)
      // would tip this over D1's 100-variable ceiling.
      const orgIds = await seedOrgs(tdb.db, 89);
      // Drive a cursor predicate too (6 binds) so the bind count is at its
      // documented worst case for this code path.
      const firstPage = await getCollectionReleasesFeed(asD1(tdb.db), orgIds, null, 1, {
        sourceTypes: ["github", "feed", "scrape", "agent"],
      });
      expect(firstPage.length).toBe(1);
      const cursor = buildFeedCursor(firstPage[0]!);

      const rows = await getCollectionReleasesFeed(asD1(tdb.db), orgIds, cursor, 200, {
        sourceTypes: ["github", "feed", "scrape", "agent"],
      });
      // 88 remaining github releases (one per org, one consumed by page 1).
      expect(rows.length).toBe(88);
    });
  });

  it("cursor pagination is stable across pages with 150 orgs", async () => {
    const orgIds = await seedOrgs(tdb.db, 150);

    // Collect pages sequentially — pagination is inherently sequential since
    // each page cursor depends on the previous page's last row.
    const pageSize = 40;
    const pages: string[][] = [];
    let cursor: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Pages are fetched sequentially by design (cursor depends on prev page).
      // eslint-disable-next-line no-await-in-loop
      const rows = await getCollectionReleasesFeed(asD1(tdb.db), orgIds, cursor, pageSize);
      if (rows.length === 0) break;
      pages.push(rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      cursor = buildFeedCursor(last);
      if (rows.length < pageSize) break;
    }

    const allIds = pages.flat();
    const uniqueIds = new Set(allIds);

    // All 150 releases should be returned with no duplicates.
    expect(uniqueIds.size).toBe(150);
    expect(allIds.length).toBe(150);
  });
});
