/**
 * Tests for getCollectionReleasesFeed (#862).
 *
 * Key coverage:
 * 1. Large orgIds list (150 IDs) — previously exceeded D1's 100-bind-parameter
 *    ceiling; now chunked into batches of 90.
 * 2. Ordering is preserved across chunk boundaries (published_at DESC,
 *    fetched_at DESC, id DESC; null published_at sorted last).
 * 3. Cursor pagination remains stable across multiple pages.
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
   * Build N org + source + release rows. Returns the org IDs in insertion order.
   * Inserts are batched into groups of 50 to avoid any bind-cap issues in the
   * seed path itself while still being fast (no sequential await-in-loop).
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
      relRows.push({
        id: `rel_${String(i).padStart(5, "0")}`,
        sourceId: srcId,
        title: `Release ${i}`,
        content: `Content for release ${i}`,
        type: "feature",
        // Vary published_at so ordering is deterministic.
        publishedAt: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        fetchedAt: `2026-02-01T00:00:00Z`,
      });
    }

    // Insert in chunks of 50 to respect D1's 100-bind cap inside tests too.
    const SEED_CHUNK = 50;
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

  it("preserves published_at DESC ordering across chunk boundaries (150 orgs)", async () => {
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
