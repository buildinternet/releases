import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { organizations, products, releases, sources } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
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

    it("pages by (published_at, id) keyset", async () => {
      const rows = await listLatestReleases(tdb.db, {
        limit: 50,
        after: { lastPublishedAt: "2026-05-02T00:00:00Z", lastId: "rel_a2" },
      });
      expect(rows.map((r) => r.id)).toEqual(["rel_a1"]);
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
});
