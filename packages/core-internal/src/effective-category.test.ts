import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../../../tests/db-helper.js";
import { organizations, sources, releases, products } from "@buildinternet/releases-core/schema";
import {
  resolveEffectiveCategory,
  recomputeReleaseEffectiveCategoryForOrg,
  recomputeReleaseEffectiveCategoryForProduct,
  recomputeReleaseEffectiveCategoryForSource,
  fetchEffectiveCategoryBySourceIds,
} from "./effective-category.js";
import type { D1Db } from "../../../workers/api/src/db.js";

const asD1 = (db: TestDatabase["db"]): D1Db => db as unknown as D1Db;

/** Read denorm column via raw SQL so tests don't depend on workspace package resolution. */
async function loadCats(db: D1Db): Promise<Record<string, string | null>> {
  const rows = await db.all<{ id: string; cat: string | null }>(sql`
    SELECT id, effective_category AS cat FROM releases
  `);
  return Object.fromEntries(rows.map((r) => [r.id, r.cat]));
}

describe("resolveEffectiveCategory", () => {
  it("prefers product over org", () => {
    expect(resolveEffectiveCategory("framework", "cloud")).toBe("framework");
  });
  it("falls through to org when product is null", () => {
    expect(resolveEffectiveCategory(null, "ai")).toBe("ai");
    expect(resolveEffectiveCategory(undefined, "ai")).toBe("ai");
  });
  it("returns null when both absent", () => {
    expect(resolveEffectiveCategory(null, null)).toBeNull();
  });
});

describe("recomputeReleaseEffectiveCategory", () => {
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

  async function seed() {
    await tdb.db.insert(organizations).values({
      id: "org_1",
      name: "Org",
      slug: "org",
      category: "cloud",
      discovery: "curated",
    });
    await tdb.db.insert(products).values({
      id: "prod_1",
      name: "Prod",
      slug: "prod",
      orgId: "org_1",
      category: "framework",
    });
    await tdb.db.insert(sources).values([
      {
        id: "src_prod",
        name: "With product",
        slug: "with-prod",
        type: "github",
        url: "https://example.com/a",
        orgId: "org_1",
        productId: "prod_1",
        discovery: "curated",
      },
      {
        id: "src_org",
        name: "Org only",
        slug: "org-only",
        type: "github",
        url: "https://example.com/b",
        orgId: "org_1",
        discovery: "curated",
      },
    ]);
    await tdb.db.insert(releases).values([
      {
        id: "rel_prod",
        sourceId: "src_prod",
        title: "P",
        content: "",
        type: "feature",
        publishedAt: "2026-01-01T00:00:00Z",
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "rel_org",
        sourceId: "src_org",
        title: "O",
        content: "",
        type: "feature",
        publishedAt: "2026-01-02T00:00:00Z",
        fetchedAt: "2026-01-02T00:00:00Z",
      },
    ]);
  }

  it("fetchEffectiveCategoryBySourceIds returns COALESCE values", async () => {
    await seed();
    const map = await fetchEffectiveCategoryBySourceIds(asD1(tdb.db), ["src_prod", "src_org"]);
    expect(map.get("src_prod")).toBe("framework");
    expect(map.get("src_org")).toBe("cloud");
  });

  it("recompute for org stamps both product-override and org-fallback", async () => {
    await seed();
    await recomputeReleaseEffectiveCategoryForOrg(asD1(tdb.db), "org_1");
    const byId = await loadCats(asD1(tdb.db));
    expect(byId.rel_prod).toBe("framework");
    expect(byId.rel_org).toBe("cloud");
  });

  it("recompute for product updates product-bound releases when product category changes", async () => {
    await seed();
    await recomputeReleaseEffectiveCategoryForOrg(asD1(tdb.db), "org_1");
    await tdb.db.update(products).set({ category: "ai" }).where(eq(products.id, "prod_1"));
    await recomputeReleaseEffectiveCategoryForProduct(asD1(tdb.db), "prod_1");
    const byId = await loadCats(asD1(tdb.db));
    expect(byId.rel_prod).toBe("ai");
    // org-only source unchanged
    expect(byId.rel_org).toBe("cloud");
  });

  it("recompute for source after product re-parent", async () => {
    await seed();
    await recomputeReleaseEffectiveCategoryForOrg(asD1(tdb.db), "org_1");
    // Detach product → should fall back to org category
    await tdb.db.update(sources).set({ productId: null }).where(eq(sources.id, "src_prod"));
    await recomputeReleaseEffectiveCategoryForSource(asD1(tdb.db), "src_prod");
    const byId = await loadCats(asD1(tdb.db));
    expect(byId.rel_prod).toBe("cloud");
  });
});
