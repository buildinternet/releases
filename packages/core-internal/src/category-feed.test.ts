import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, sources, releases, products } from "@buildinternet/releases-core/schema";
import { getCategoryReleasesFeed } from "./category-feed.js";
import { buildFeedCursor } from "./collection-feed.js";
import type { D1Db } from "../../../workers/api/src/db.js";

const asD1 = (db: TestDatabase["db"]): D1Db => db as unknown as D1Db;

describe("getCategoryReleasesFeed", () => {
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
   * Seed three orgs:
   *   - ai-org (category=ai)   : 3 releases via src-ai-org
   *   - mixed-org (category=cloud) with product:
   *       prod-fw (category=framework) → 2 releases
   *       another source on mixed-org with no product → 1 release (cloud)
   *   - design-org (category=design) : 1 release (excluded from ai+framework)
   */
  async function seed() {
    await tdb.db.insert(organizations).values([
      { id: "org_ai", name: "AI Org", slug: "ai-org", category: "ai", discovery: "curated" },
      {
        id: "org_mx",
        name: "Mixed Org",
        slug: "mixed-org",
        category: "cloud",
        discovery: "curated",
      },
      {
        id: "org_ds",
        name: "Design Org",
        slug: "design-org",
        category: "design",
        discovery: "curated",
      },
    ]);
    await tdb.db.insert(products).values([
      {
        id: "prod_fw",
        name: "Framework",
        slug: "framework",
        orgId: "org_mx",
        category: "framework",
      },
    ]);
    await tdb.db.insert(sources).values([
      {
        id: "src_ai",
        name: "AI Src",
        slug: "ai-src",
        type: "github",
        url: "https://github.com/example/ai",
        orgId: "org_ai",
        discovery: "curated",
      },
      {
        id: "src_mx_fw",
        name: "Framework Src",
        slug: "framework-src",
        type: "github",
        url: "https://github.com/example/fw",
        orgId: "org_mx",
        productId: "prod_fw",
        discovery: "curated",
      },
      {
        id: "src_mx_cloud",
        name: "Mixed Cloud Src",
        slug: "mixed-cloud-src",
        type: "github",
        url: "https://github.com/example/mx",
        orgId: "org_mx",
        discovery: "curated",
      },
      {
        id: "src_ds",
        name: "Design Src",
        slug: "design-src",
        type: "github",
        url: "https://github.com/example/ds",
        orgId: "org_ds",
        discovery: "curated",
      },
    ]);
    await tdb.db.insert(releases).values([
      // ai org — 3 releases
      {
        id: "rel_ai_1",
        sourceId: "src_ai",
        title: "AI 1",
        content: "",
        type: "feature",
        publishedAt: "2026-01-01T00:00:00Z",
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "rel_ai_2",
        sourceId: "src_ai",
        title: "AI 2",
        content: "",
        type: "feature",
        publishedAt: "2026-01-02T00:00:00Z",
        fetchedAt: "2026-01-02T00:00:00Z",
      },
      {
        id: "rel_ai_3",
        sourceId: "src_ai",
        title: "AI 3 prerelease",
        content: "",
        type: "feature",
        publishedAt: "2026-01-03T00:00:00Z",
        fetchedAt: "2026-01-03T00:00:00Z",
        prerelease: true,
      },
      // mixed/framework product — 2 releases
      {
        id: "rel_fw_1",
        sourceId: "src_mx_fw",
        title: "FW 1",
        content: "",
        type: "feature",
        publishedAt: "2026-01-04T00:00:00Z",
        fetchedAt: "2026-01-04T00:00:00Z",
      },
      {
        id: "rel_fw_2",
        sourceId: "src_mx_fw",
        title: "FW 2",
        content: "",
        type: "feature",
        publishedAt: "2026-01-05T00:00:00Z",
        fetchedAt: "2026-01-05T00:00:00Z",
      },
      // mixed/no-product → org category=cloud
      {
        id: "rel_cloud_1",
        sourceId: "src_mx_cloud",
        title: "Cloud 1",
        content: "",
        type: "feature",
        publishedAt: "2026-01-06T00:00:00Z",
        fetchedAt: "2026-01-06T00:00:00Z",
      },
      // design
      {
        id: "rel_ds_1",
        sourceId: "src_ds",
        title: "Design 1",
        content: "",
        type: "feature",
        publishedAt: "2026-01-07T00:00:00Z",
        fetchedAt: "2026-01-07T00:00:00Z",
      },
    ]);
  }

  it("includes only org-category sources without a product-category override", async () => {
    await seed();
    const rows = await getCategoryReleasesFeed(asD1(tdb.db), "ai", null, 50, {
      includePrereleases: true,
    });
    expect(rows.map((r) => r.id).toSorted()).toEqual(["rel_ai_1", "rel_ai_2", "rel_ai_3"]);
  });

  it("matches product category, not parent org category", async () => {
    await seed();
    const rows = await getCategoryReleasesFeed(asD1(tdb.db), "framework", null, 50);
    expect(rows.map((r) => r.id).toSorted()).toEqual(["rel_fw_1", "rel_fw_2"]);
  });

  it("falls back to org category when a source has no product", async () => {
    await seed();
    // The framework product's releases should NOT appear in cloud, since
    // COALESCE prefers the product's own category.
    const rows = await getCategoryReleasesFeed(asD1(tdb.db), "cloud", null, 50);
    expect(rows.map((r) => r.id)).toEqual(["rel_cloud_1"]);
  });

  it("excludes prereleases by default and includes them when asked", async () => {
    await seed();
    const without = await getCategoryReleasesFeed(asD1(tdb.db), "ai", null, 50);
    expect(without.map((r) => r.id).toSorted()).toEqual(["rel_ai_1", "rel_ai_2"]);

    const withPre = await getCategoryReleasesFeed(asD1(tdb.db), "ai", null, 50, {
      includePrereleases: true,
    });
    expect(withPre.map((r) => r.id).toSorted()).toEqual(["rel_ai_1", "rel_ai_2", "rel_ai_3"]);
  });

  it("paginates stably via buildFeedCursor across pages", async () => {
    await seed();
    const page1 = await getCategoryReleasesFeed(asD1(tdb.db), "ai", null, 1, {
      includePrereleases: true,
    });
    expect(page1.length).toBe(1);
    expect(page1[0].id).toBe("rel_ai_3");

    const cursor = buildFeedCursor(page1[0]);
    const page2 = await getCategoryReleasesFeed(asD1(tdb.db), "ai", cursor, 50, {
      includePrereleases: true,
    });
    expect(page2.map((r) => r.id)).toEqual(["rel_ai_2", "rel_ai_1"]);
  });
});
