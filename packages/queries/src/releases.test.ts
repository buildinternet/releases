import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { organizations, products, releases, sources } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import {
  buildFeedCursor,
  parseFeedCursorKey,
  type FeedCursorKey,
} from "@releases/core-internal/feed-cursor";
import { findVisibleReleaseDetail, listLatestReleases } from "./releases.js";

const DELETED_AT = "2026-01-01T00:00:00Z";

describe("release reads", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = createTestDb();
    await tdb.db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme" },
      { id: "org_shy", name: "Shy", slug: "shy", isHidden: true },
      { id: "org_gone", name: "Gone", slug: "gone--org_gone", deletedAt: DELETED_AT },
    ]);
    await tdb.db.insert(products).values({
      id: "prod_old",
      name: "Old",
      slug: "old",
      orgId: "org_acme",
      deletedAt: DELETED_AT,
    });
    const feed = (id: string, orgId: string, extra = {}) => ({
      id,
      orgId,
      name: id,
      slug: id,
      type: "feed" as const,
      url: `https://example.com/${id}`,
      ...extra,
    });
    await tdb.db
      .insert(sources)
      .values([
        feed("src_a", "org_acme", { productId: "prod_old" }),
        feed("src_hidden", "org_acme", { isHidden: true }),
        feed("src_shy", "org_shy"),
        feed("src_gone", "org_gone"),
      ]);
    const rel = (id: string, sourceId: string, publishedAt: string) => ({
      id,
      sourceId,
      title: id,
      type: "feature" as const,
      content: "x",
      publishedAt,
    });
    await tdb.db
      .insert(releases)
      .values([
        rel("rel_a1", "src_a", "2026-05-01T00:00:00Z"),
        rel("rel_a2", "src_a", "2026-05-02T00:00:00Z"),
        rel("rel_cov", "src_a", "2026-05-03T00:00:00Z"),
        rel("rel_hidden", "src_hidden", "2026-05-01T00:00:00Z"),
        rel("rel_shy", "src_shy", "2026-05-01T00:00:00Z"),
        rel("rel_gone", "src_gone", "2026-05-01T00:00:00Z"),
      ]);
    await tdb.db
      .insert(releaseCoverage)
      .values({ coverageId: "rel_cov", canonicalId: "rel_a2", decidedBy: "test" });
  });
  afterAll(() => tdb.cleanup());

  describe("listLatestReleases", () => {
    it("drops hidden sources, hidden or deleted orgs, and coverage rows", async () => {
      const rows = await listLatestReleases(tdb.db, { limit: 50 });
      expect(rows.map((r) => r.id)).toEqual(["rel_a2", "rel_a1"]);
      // Deleted product: products_active leaves the name null.
      expect(rows[0].productName).toBeNull();
    });

    it("includeCoverage reads the base table", async () => {
      const rows = await listLatestReleases(tdb.db, { limit: 50, includeCoverage: true });
      expect(rows.map((r) => r.id)).toEqual(["rel_cov", "rel_a2", "rel_a1"]);
    });

    it("pages from a feed cursor key", async () => {
      const rows = await listLatestReleases(tdb.db, {
        limit: 50,
        after: { publishedAt: "2026-05-02T00:00:00Z", fetchedAt: null, id: "rel_a2" },
      });
      expect(rows.map((r) => r.id)).toEqual(["rel_a1"]);
    });

    it("leaves content null unless includeContent", async () => {
      expect((await listLatestReleases(tdb.db, { limit: 1 }))[0].content).toBeNull();
      const [row] = await listLatestReleases(tdb.db, { limit: 1, includeContent: true });
      expect(row.content).toBe("x");
    });

    it("counts coverage siblings and drops excluded source types", async () => {
      const [a2] = await listLatestReleases(tdb.db, { limit: 1 });
      expect(a2.coverageCount).toBe(1);
      const none = await listLatestReleases(tdb.db, { limit: 50, excludeSourceTypes: ["feed"] });
      expect(none).toEqual([]);
    });
  });

  describe("findVisibleReleaseDetail", () => {
    it("returns a visible release with nulled deleted parents", async () => {
      const row = await findVisibleReleaseDetail(tdb.db, "rel_gone");
      expect(row?.release.id).toBe("rel_gone");
      expect(row?.orgSlug).toBeNull();
      expect((await findVisibleReleaseDetail(tdb.db, "rel_a1"))?.productName).toBeNull();
    });

    it("keeps a hidden org's release readable", async () => {
      const row = await findVisibleReleaseDetail(tdb.db, "rel_shy");
      expect(row?.orgIsHidden).toBe(true);
    });

    it("returns null for coverage-side releases and hidden sources", async () => {
      expect(await findVisibleReleaseDetail(tdb.db, "rel_cov")).toBeNull();
      expect(await findVisibleReleaseDetail(tdb.db, "rel_hidden")).toBeNull();
    });
  });

  describe("listLatestReleases feed order", () => {
    let odb: TestDatabase;
    const P = "2026-06-01T00:00:00Z";

    beforeAll(async () => {
      odb = createTestDb();
      await odb.db.insert(organizations).values({ id: "org_o", name: "O", slug: "o" });
      await odb.db.insert(sources).values({
        id: "src_o",
        orgId: "org_o",
        name: "o",
        slug: "o",
        type: "feed",
        url: "https://example.com/o",
      });
      const row = (id: string, publishedAt: string | null, fetchedAt: string) => ({
        id,
        sourceId: "src_o",
        title: id,
        type: "feature" as const,
        content: "x",
        publishedAt,
        fetchedAt,
      });
      await odb.db
        .insert(releases)
        .values([
          row("rel_a", P, "2026-06-01T01:00:00Z"),
          row("rel_b", P, "2026-06-01T02:00:00Z"),
          row("rel_c", P, "2026-06-01T01:00:00Z"),
          row("rel_y", null, "2026-06-01T02:00:00Z"),
          row("rel_z", null, "2026-06-01T03:00:00Z"),
        ]);
    });

    afterAll(() => odb.cleanup());

    const ORDER = ["rel_b", "rel_c", "rel_a", "rel_z", "rel_y"];

    it("sorts dated first, then published_at, fetched_at, id descending", async () => {
      const rows = await listLatestReleases(odb.db, { limit: 50 });
      expect(rows.map((r) => r.id)).toEqual(ORDER);
    });

    it("walks every row once through buildFeedCursor pages, across the undated tail", async () => {
      const seen: string[] = [];
      let after: FeedCursorKey | null = null;
      for (let i = 0; i < 10; i++) {
        const page = await listLatestReleases(odb.db, { limit: 2, after });
        if (page.length === 0) break;
        seen.push(...page.map((r) => r.id));
        const last = page[page.length - 1];
        after = parseFeedCursorKey(
          buildFeedCursor({
            published_at: last.publishedAt,
            fetched_at: last.fetchedAt,
            id: last.id,
          }),
        );
      }
      expect(seen).toEqual(ORDER);
    });
  });
});
