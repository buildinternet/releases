/**
 * Product cross-source release feed parity.
 *
 * `get_latest_releases` with a `product` identifier must return releases from
 * ALL sources under the product — mirroring the REST ?product= expansion in
 * `GET /v1/orgs/:slug/releases?product=<productSlug>` (see `getOrgReleasesFeed`).
 *
 * Before the fix the `product` param called `resolveSource`, so it:
 *   1. Only matched source slugs / src_ ids (not product slugs / prod_ ids).
 *   2. Returned a single-source filter even for multi-source products.
 *   3. Emitted the misleading error "No product found" when the identifier was
 *      actually a valid product coord that didn't match any source.
 *
 * After the fix `resolveEntityToSourceIds` is used, which expands a prod_ id
 * or org/productSlug coordinate to the full set of source IDs under that product.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, sources, releases, products } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { asD1 } from "../mcp-test-helpers.js";
import { getLatestReleases } from "../../workers/mcp/src/tools.js";

interface FeedRow {
  id: string;
  source: { name: string; coordinate: string; type: string };
  product: { name: string; slug: string } | null;
}

interface StructuredResult {
  releases: FeedRow[];
}

let testDb: TestDatabase;

beforeEach(async () => {
  testDb = createTestDb();

  // Org: Vercel
  await testDb.db.insert(organizations).values({
    id: "org_vercel",
    name: "Vercel",
    slug: "vercel",
    discovery: "curated",
  });

  // Product: Next.js (groups two sources)
  await testDb.db
    .insert(products)
    .values({ id: "prod_nextjs", orgId: "org_vercel", name: "Next.js", slug: "next-js" });

  // Source 1: GitHub releases feed (under product)
  await testDb.db.insert(sources).values({
    id: "src_nextjs_gh",
    orgId: "org_vercel",
    productId: "prod_nextjs",
    name: "Next.js GitHub",
    slug: "next-js-github",
    type: "github",
    url: "https://github.com/vercel/next.js",
    discovery: "curated",
  });

  // Source 2: Next.js blog (under same product)
  await testDb.db.insert(sources).values({
    id: "src_nextjs_blog",
    orgId: "org_vercel",
    productId: "prod_nextjs",
    name: "Next.js Blog",
    slug: "next-js-blog",
    type: "feed",
    url: "https://nextjs.org/blog",
    discovery: "curated",
  });

  // Source 3: Turborepo — a different product, releases must NOT appear
  await testDb.db
    .insert(products)
    .values({ id: "prod_turbo", orgId: "org_vercel", name: "Turborepo", slug: "turborepo" });
  await testDb.db.insert(sources).values({
    id: "src_turbo",
    orgId: "org_vercel",
    productId: "prod_turbo",
    name: "Turborepo GitHub",
    slug: "turborepo-github",
    type: "github",
    url: "https://github.com/vercel/turborepo",
    discovery: "curated",
  });

  // Releases: two from Next.js sources, one from Turborepo
  await testDb.db.insert(releases).values([
    {
      id: "rel_nextjs_gh_1",
      sourceId: "src_nextjs_gh",
      title: "Next.js 15.0.0",
      type: "feature",
      content: "GitHub release body.",
      publishedAt: "2026-05-01T00:00:00Z",
    },
    {
      id: "rel_nextjs_blog_1",
      sourceId: "src_nextjs_blog",
      title: "Introducing Next.js 15",
      type: "feature",
      content: "Blog post body.",
      publishedAt: "2026-05-02T00:00:00Z",
    },
    {
      id: "rel_turbo_1",
      sourceId: "src_turbo",
      title: "Turborepo 2.0",
      type: "feature",
      content: "Turborepo release.",
      publishedAt: "2026-05-03T00:00:00Z",
    },
  ]);
});

afterEach(() => testDb.cleanup());

describe("get_latest_releases — product cross-source feed", () => {
  it("returns releases from ALL sources under a product when given a prod_ id", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { product: "prod_nextjs" });
    const rows = (out.structuredContent as unknown as StructuredResult).releases;
    const ids = rows.map((r) => r.id);
    // Both Next.js sources must appear
    expect(ids).toContain("rel_nextjs_gh_1");
    expect(ids).toContain("rel_nextjs_blog_1");
    // Turborepo release must NOT appear
    expect(ids).not.toContain("rel_turbo_1");
    expect(rows).toHaveLength(2);
  });

  it("returns releases from ALL sources under a product when given an org/productSlug coordinate", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { product: "vercel/next-js" });
    const rows = (out.structuredContent as unknown as StructuredResult).releases;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_nextjs_gh_1");
    expect(ids).toContain("rel_nextjs_blog_1");
    expect(ids).not.toContain("rel_turbo_1");
    expect(rows).toHaveLength(2);
  });

  it("returns releases from a single source when given a src_ id", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { product: "src_nextjs_gh" });
    const rows = (out.structuredContent as unknown as StructuredResult).releases;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_nextjs_gh_1");
    expect(ids).not.toContain("rel_nextjs_blog_1");
    expect(ids).not.toContain("rel_turbo_1");
    expect(rows).toHaveLength(1);
  });

  it("returns releases from a single source when given an org/sourceSlug coordinate", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { product: "vercel/next-js-blog" });
    const rows = (out.structuredContent as unknown as StructuredResult).releases;
    const ids = rows.map((r) => r.id);
    expect(ids).toContain("rel_nextjs_blog_1");
    expect(ids).not.toContain("rel_nextjs_gh_1");
    expect(ids).not.toContain("rel_turbo_1");
    expect(rows).toHaveLength(1);
  });

  it("returns a model-readable error for unknown identifiers", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { product: "vercel/nonexistent" });
    const resultText = out.content[0]?.text ?? "";
    expect(resultText).toContain("No product or source found matching");
  });

  it("returns a model-readable hint for bare slugs", async () => {
    const out = await getLatestReleases(asD1(testDb.db), { product: "next-js" });
    const resultText = out.content[0]?.text ?? "";
    expect(resultText).toContain("ambiguous");
    expect(resultText).toContain("prod_");
  });
});
