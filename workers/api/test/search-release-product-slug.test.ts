/**
 * `productSlug` on release search hits (#product-pages-default-unit Phase 2).
 * The lexical release query selects the owning product's slug, and
 * `hydrateReleaseHit` forwards it to the wire shape so the web search byline
 * can link to the product page instead of the source.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import { asD1 } from "../../../tests/mcp-test-helpers";
import { searchReleasesFromMatchedEntities } from "../src/queries/search.js";
import { hydrateReleaseHit } from "../src/routes/search.js";

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await testDb.db
    .insert(products)
    .values({ id: "prod_x", slug: "x", name: "Product X", orgId: "org_a" });
  await testDb.db.insert(sources).values([
    {
      id: "src_x",
      slug: "x-feed",
      name: "X Feed",
      type: "feed",
      url: "https://acme.test/x",
      orgId: "org_a",
      productId: "prod_x",
    },
    {
      id: "src_orphan",
      slug: "blog",
      name: "Blog",
      type: "feed",
      url: "https://acme.test/blog",
      orgId: "org_a",
    },
  ]);
  await testDb.db.insert(releases).values([
    {
      id: "rel_x",
      sourceId: "src_x",
      title: "X 1.0",
      content: "x",
      url: "https://acme.test/x/1",
      publishedAt: "2026-04-20T00:00:00Z",
    },
    {
      id: "rel_orphan",
      sourceId: "src_orphan",
      title: "Blog post",
      content: "b",
      url: "https://acme.test/blog/1",
      publishedAt: "2026-04-21T00:00:00Z",
    },
  ]);
});

describe("release-hit productSlug", () => {
  it("selects productSlug for a release whose source belongs to a product", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 50);
    expect(rows.find((r) => r.id === "rel_x")?.productSlug).toBe("x");
  });

  it("leaves productSlug null for an orphan source's release", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 50);
    expect(rows.find((r) => r.id === "rel_orphan")?.productSlug ?? null).toBeNull();
  });

  it("hydrateReleaseHit forwards productSlug to the wire shape", async () => {
    const rows = await searchReleasesFromMatchedEntities(asD1(testDb.db), ["acme"], [], 50);
    const raw = rows.find((r) => r.id === "rel_x")!;
    const hit = hydrateReleaseHit(raw, "https://media.releases.sh");
    expect(hit.productSlug).toBe("x");
  });
});
