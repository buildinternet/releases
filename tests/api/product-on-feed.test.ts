/**
 * Tests for #1217: owning product threaded onto release-feed rows.
 *
 * Covers both feed surfaces:
 *   - GET /v1/releases/latest  (releaseRoutes / getLatestReleasesAcross)
 *   - GET /v1/orgs/:slug/releases  (orgRoutes / getOrgReleasesFeed)
 *
 * The org-releases feed uses raw D1 prepare/bind (not Drizzle), so we drive
 * it through the Hono route harness (same pattern as source-kind-filter.test.ts)
 * rather than calling the query function directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseRoutes } from "../../workers/api/src/routes/releases.js";
import { orgRoutes } from "../../workers/api/src/routes/orgs.js";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { makeCaller } from "./route-test-helpers.js";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return {
    DB: testDb.db as unknown as never,
    MEDIA_ORIGIN: "",
  };
}

const callRelease = makeCaller(releaseRoutes, makeEnv);
const callOrg = makeCaller(orgRoutes, makeEnv);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedOrg(slug = "acme") {
  await testDb.db.insert(organizations).values({
    id: `org_${slug}`,
    name: slug,
    slug,
    discovery: "curated",
  });
}

async function seedProduct(opts: { id: string; slug: string; orgSlug?: string }) {
  await testDb.db.insert(products).values({
    id: opts.id,
    name: `${opts.slug}-product`,
    slug: opts.slug,
    orgId: `org_${opts.orgSlug ?? "acme"}`,
  });
}

async function seedSource(opts: {
  id: string;
  slug: string;
  orgSlug?: string;
  productId?: string | null;
}) {
  await testDb.db.insert(sources).values({
    id: opts.id,
    orgId: `org_${opts.orgSlug ?? "acme"}`,
    slug: opts.slug,
    name: opts.slug,
    url: `https://example.com/${opts.slug}`,
    type: "feed",
    metadata: "{}",
    productId: opts.productId ?? null,
  });
}

async function seedRelease(opts: {
  id: string;
  sourceId: string;
  title: string;
  publishedAt?: string;
}) {
  await testDb.db.insert(releases).values({
    id: opts.id,
    sourceId: opts.sourceId,
    title: opts.title,
    content: "",
    url: `https://example.com/${opts.id}`,
    publishedAt: opts.publishedAt ?? "2024-01-01T00:00:00Z",
  });
}

// ---------------------------------------------------------------------------
// GET /v1/releases/latest — product field
// ---------------------------------------------------------------------------

describe("GET /v1/releases/latest — product field", () => {
  it("returns product: null when the source has no product_id", async () => {
    await seedOrg("acme");
    await seedSource({ id: "src_no_prod", slug: "no-prod-src" });
    await seedRelease({ id: "rel_no_prod", sourceId: "src_no_prod", title: "No-product release" });

    const res = await callRelease("/releases/latest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { releases: Array<{ title: string; product: unknown }> };
    const rel = body.releases.find((r) => r.title === "No-product release");
    expect(rel).toBeDefined();
    expect(rel!.product).toBeNull();
  });

  it("returns product: { slug, name } when the source belongs to a product", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_widget", slug: "widget" });
    await seedSource({ id: "src_widget", slug: "widget-src", productId: "prod_widget" });
    await seedRelease({ id: "rel_widget", sourceId: "src_widget", title: "Widget release" });

    const res = await callRelease("/releases/latest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ title: string; product: { slug: string; name: string } | null }>;
    };
    const rel = body.releases.find((r) => r.title === "Widget release");
    expect(rel).toBeDefined();
    expect(rel!.product).toEqual({ slug: "widget", name: "widget-product" });
  });

  it("returns correct product per release when sources mix product/no-product", async () => {
    await seedOrg("acme");
    await seedProduct({ id: "prod_mixed", slug: "mixed-prod" });
    await seedSource({ id: "src_with_prod", slug: "with-prod", productId: "prod_mixed" });
    await seedSource({ id: "src_without_prod", slug: "without-prod", productId: null });
    await seedRelease({
      id: "rel_with",
      sourceId: "src_with_prod",
      title: "Release with product",
      publishedAt: "2024-02-01T00:00:00Z",
    });
    await seedRelease({
      id: "rel_without",
      sourceId: "src_without_prod",
      title: "Release without product",
      publishedAt: "2024-01-01T00:00:00Z",
    });

    const res = await callRelease("/releases/latest");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ title: string; product: { slug: string; name: string } | null }>;
    };

    const withProd = body.releases.find((r) => r.title === "Release with product");
    const withoutProd = body.releases.find((r) => r.title === "Release without product");
    expect(withProd!.product).toEqual({ slug: "mixed-prod", name: "mixed-prod-product" });
    expect(withoutProd!.product).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/orgs/:slug/releases — product field
// ---------------------------------------------------------------------------

describe("GET /v1/orgs/:slug/releases — product field", () => {
  it("returns product: null when the source has no product_id", async () => {
    await seedOrg("beta");
    await seedSource({ id: "src_beta_no_prod", slug: "beta-no-prod", orgSlug: "beta" });
    await seedRelease({
      id: "rel_beta_no_prod",
      sourceId: "src_beta_no_prod",
      title: "Beta no-product",
    });

    const res = await callOrg("/orgs/beta/releases");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ title: string; product: unknown }>;
    };
    const rel = body.releases.find((r) => r.title === "Beta no-product");
    expect(rel).toBeDefined();
    expect(rel!.product).toBeNull();
  });

  it("returns product: { slug, name } when the source belongs to a product", async () => {
    await seedOrg("gamma");
    await seedProduct({ id: "prod_gamma", slug: "gamma-prod", orgSlug: "gamma" });
    await seedSource({
      id: "src_gamma",
      slug: "gamma-src",
      orgSlug: "gamma",
      productId: "prod_gamma",
    });
    await seedRelease({ id: "rel_gamma", sourceId: "src_gamma", title: "Gamma product release" });

    const res = await callOrg("/orgs/gamma/releases");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      releases: Array<{ title: string; product: { slug: string; name: string } | null }>;
    };
    const rel = body.releases.find((r) => r.title === "Gamma product release");
    expect(rel).toBeDefined();
    expect(rel!.product).toEqual({ slug: "gamma-prod", name: "gamma-prod-product" });
  });
});
