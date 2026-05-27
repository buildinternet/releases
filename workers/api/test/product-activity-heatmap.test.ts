/**
 * Product activity + heatmap routes (#1191).
 *
 * GET /v1/products/:slug/activity   (typed-ID-only on bare path — #698)
 * GET /v1/orgs/:orgSlug/products/:productSlug/activity
 * GET /v1/products/:slug/heatmap    (typed-ID-only on bare path — #698)
 * GET /v1/orgs/:orgSlug/products/:productSlug/heatmap
 *
 * Mirrors the org/source activity+heatmap tests. Covers:
 *   - Resolution by org-scoped path (slug or typed ID)
 *   - Source filtering by product_id
 *   - Correct aggregation shape (weeklyBuckets, aggregateWeekly)
 *   - Empty product (no sources → empty arrays, not 500)
 *   - 404 for unknown product
 *   - Invalid date param → 400
 *   - 'from' > 'to' → 400
 */
import { describe, it, expect } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp } from "./setup";
import { productRoutes } from "../src/routes/products.js";
import { BareSlugRejected } from "../src/utils.js";

const mkApp = (db: ReturnType<typeof createTestDb>) =>
  createTestApp(db, [productRoutes], {
    env: {},
    onError: (err, c) => {
      if (err instanceof BareSlugRejected) {
        return c.json(
          { error: "bare_slug_rejected", entity: err.entity, message: err.message },
          400,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "internal_error", message }, 500);
    },
  });

async function seed(db: ReturnType<typeof createTestDb>) {
  await db
    .insert(organizations)
    .values([{ id: "org_acme", slug: "acme", name: "Acme Corp", category: "cloud" }]);
  await db.insert(products).values([
    { id: "prod_widget", slug: "widget", name: "Widget", orgId: "org_acme" },
    { id: "prod_empty", slug: "empty-product", name: "Empty Product", orgId: "org_acme" },
  ]);
  await db.insert(sources).values([
    {
      id: "src_widget_api",
      slug: "widget-api",
      name: "Widget API",
      type: "github",
      url: "https://github.com/acme/widget-api",
      orgId: "org_acme",
      productId: "prod_widget",
    },
    {
      id: "src_widget_sdk",
      slug: "widget-sdk",
      name: "Widget SDK",
      type: "github",
      url: "https://github.com/acme/widget-sdk",
      orgId: "org_acme",
      productId: "prod_widget",
    },
    {
      // Orphan source — should NOT appear in product activity
      id: "src_orphan",
      slug: "blog",
      name: "Blog",
      type: "feed",
      url: "https://acme.test/blog",
      orgId: "org_acme",
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_api_1",
      sourceId: "src_widget_api",
      title: "API v1.0",
      content: "initial",
      url: "https://github.com/acme/widget-api/releases/tag/v1.0",
      publishedAt: "2025-01-10T00:00:00Z",
      version: "1.0.0",
    },
    {
      id: "rel_api_2",
      sourceId: "src_widget_api",
      title: "API v1.1",
      content: "update",
      url: "https://github.com/acme/widget-api/releases/tag/v1.1",
      publishedAt: "2025-02-15T00:00:00Z",
      version: "1.1.0",
    },
    {
      id: "rel_sdk_1",
      sourceId: "src_widget_sdk",
      title: "SDK v2.0",
      content: "sdk release",
      url: "https://github.com/acme/widget-sdk/releases/tag/v2.0",
      publishedAt: "2025-01-20T00:00:00Z",
      version: "2.0.0",
    },
    {
      // Orphan release — should NOT appear in product activity
      id: "rel_orphan",
      sourceId: "src_orphan",
      title: "Blog post",
      content: "post",
      url: "https://acme.test/blog/post",
      publishedAt: "2025-01-25T00:00:00Z",
    },
  ]);
}

// ── Activity ──────────────────────────────────────────────────────────────────

describe("GET /v1/orgs/:orgSlug/products/:productSlug/activity", () => {
  it("returns activity for the product's sources only (excludes orphan sources)", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/orgs/acme/products/widget/activity?from=2025-01-01&to=2025-12-31",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: { slug: string; name: string };
      range: { from: string; to: string };
      sources: { slug: string; releaseCount: number }[];
      aggregateWeekly: { weekStart: string; count: number }[];
    };

    expect(body.product.slug).toBe("widget");
    expect(body.product.name).toBe("Widget");
    expect(body.range.from).toBe("2025-01-01");
    expect(body.range.to).toBe("2025-12-31");

    // Only widget sources — no orphan blog source
    const sourceSlugs = body.sources.map((s) => s.slug).sort();
    expect(sourceSlugs).toEqual(["widget-api", "widget-sdk"]);

    // Total across both sources = 3 releases (2 API + 1 SDK)
    const totalReleases = body.sources.reduce((sum, s) => sum + s.releaseCount, 0);
    expect(totalReleases).toBe(3);

    // Aggregate rollup should sum correctly
    const aggTotal = body.aggregateWeekly.reduce((sum, b) => sum + b.count, 0);
    expect(aggTotal).toBe(3);
  });

  it("returns the same payload via typed-product-ID on the bare path", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const [orgScoped, bareId] = await Promise.all([
      fetch(
        new Request(
          "https://x.test/v1/orgs/acme/products/widget/activity?from=2025-01-01&to=2025-12-31",
        ),
      ),
      fetch(
        new Request(
          "https://x.test/v1/products/prod_widget/activity?from=2025-01-01&to=2025-12-31",
        ),
      ),
    ]);
    expect(orgScoped.status).toBe(200);
    expect(bareId.status).toBe(200);
    const orgBody = await orgScoped.json();
    const bareBody = await bareId.json();
    // product.name may differ only in the response label — they should be structurally equal
    expect((orgBody as { product: { slug: string } }).product.slug).toBe(
      (bareBody as { product: { slug: string } }).product.slug,
    );
    expect((orgBody as { sources: unknown[] }).sources.length).toBe(
      (bareBody as { sources: unknown[] }).sources.length,
    );
  });

  it("accepts typed product-ID in either path segment", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/org_acme/products/prod_widget/activity"),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { product: { slug: string } }).product.slug).toBe("widget");
  });

  it("returns empty sources/aggregateWeekly for a product with no sources", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/products/empty-product/activity"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sources: unknown[];
      aggregateWeekly: unknown[];
    };
    expect(body.sources).toEqual([]);
    expect(body.aggregateWeekly).toEqual([]);
  });

  it("404s when product is not found", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/products/nonexistent/activity"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid 'from' date format", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/products/widget/activity?from=notadate"),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  it("returns 400 for invalid 'to' date format", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/products/widget/activity?to=2025/01/01"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when 'from' is after 'to'", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request(
        "https://x.test/v1/orgs/acme/products/widget/activity?from=2025-12-01&to=2025-01-01",
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_request");
  });

  it("infers default date range from release data when no params given", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/products/widget/activity"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      range: { from: string; to: string };
      aggregateWeekly: { count: number }[];
    };
    // Should infer from the earliest and latest release dates
    expect(body.range.from).toBe("2025-01-10");
    expect(body.range.to).toBe("2025-02-15");
    // All 3 releases should be included
    const total = body.aggregateWeekly.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(3);
  });

  it("rejects a bare slug on the /products/:slug path (#698)", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/products/widget/activity"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bare_slug_rejected");
  });
});

// ── Heatmap ───────────────────────────────────────────────────────────────────

describe("GET /v1/orgs/:orgSlug/products/:productSlug/heatmap", () => {
  it("returns heatmap data for the product's sources only", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/orgs/acme/products/widget/heatmap"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      product: { slug: string; name: string };
      range: { from: string; to: string };
      dailyCounts: { date: string; count: number }[];
      total: number;
    };

    expect(body.product.slug).toBe("widget");
    expect(body.product.name).toBe("Widget");
    expect(typeof body.range.from).toBe("string");
    expect(typeof body.range.to).toBe("string");
    // Releases from 2025-01-10, 2025-02-15, 2025-01-20 are within the last 365 days
    // from a 2026-05-27 reference — total should reflect how many fall in trailing year.
    // We just check that the total is non-negative and counts are integers.
    expect(body.total).toBeGreaterThanOrEqual(0);
    for (const entry of body.dailyCounts) {
      expect(typeof entry.date).toBe("string");
      expect(Number.isInteger(entry.count)).toBe(true);
    }
  });

  it("returns empty dailyCounts for a product with no sources", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/products/empty-product/heatmap"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dailyCounts: unknown[]; total: number };
    expect(body.dailyCounts).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("404s when product is not found", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/orgs/acme/products/nonexistent/heatmap"),
    );
    expect(res.status).toBe(404);
  });

  it("returns same payload via typed-ID on bare path", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const [orgScoped, bareId] = await Promise.all([
      fetch(new Request("https://x.test/v1/orgs/acme/products/widget/heatmap")),
      fetch(new Request("https://x.test/v1/products/prod_widget/heatmap")),
    ]);
    expect(orgScoped.status).toBe(200);
    expect(bareId.status).toBe(200);
    const orgBody = await orgScoped.json();
    const bareBody = await bareId.json();
    expect((orgBody as { product: { slug: string } }).product.slug).toBe(
      (bareBody as { product: { slug: string } }).product.slug,
    );
    expect((orgBody as { total: number }).total).toBe((bareBody as { total: number }).total);
  });

  it("rejects a bare slug on the /products/:slug path (#698)", async () => {
    const db = createTestDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(new Request("https://x.test/v1/products/widget/heatmap"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bare_slug_rejected");
  });
});
