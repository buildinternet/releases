/**
 * Org detail exposes a per-product releaseCount for the web hub cards
 * (#product-pages-default-unit). Counts visible releases across the product's
 * sources; orphan-source releases don't inflate any product's count.
 */
import { describe, it, expect } from "bun:test";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { createTestDb, createTestApp } from "./setup";
import { orgRoutes } from "../src/routes/orgs.js";

describe("GET /v1/orgs/:slug — per-product releaseCount", () => {
  it("counts visible releases per product and excludes orphan-source releases", async () => {
    const db = createTestDb();
    await db
      .insert(organizations)
      .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
    await db.insert(products).values([
      { id: "prod_x", slug: "x", name: "Product X", orgId: "org_a" },
      { id: "prod_y", slug: "y", name: "Product Y", orgId: "org_a" },
    ]);
    await db.insert(sources).values([
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
        id: "src_y",
        slug: "y-feed",
        name: "Y Feed",
        type: "feed",
        url: "https://acme.test/y",
        orgId: "org_a",
        productId: "prod_y",
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
    await db.insert(releases).values([
      {
        id: "rel_x1",
        sourceId: "src_x",
        title: "X 1",
        content: "x",
        url: "https://acme.test/x/1",
        publishedAt: "2026-04-20T00:00:00Z",
      },
      {
        id: "rel_x2",
        sourceId: "src_x",
        title: "X 2",
        content: "x",
        url: "https://acme.test/x/2",
        publishedAt: "2026-04-21T00:00:00Z",
      },
      {
        id: "rel_orphan",
        sourceId: "src_orphan",
        title: "Post",
        content: "b",
        url: "https://acme.test/blog/1",
        publishedAt: "2026-04-22T00:00:00Z",
      },
    ]);

    const fetch = createTestApp(db, [orgRoutes], { env: {} });
    const res = await fetch(new Request("https://x.test/v1/orgs/acme"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { products: { slug: string; releaseCount: number }[] };

    const x = body.products.find((p) => p.slug === "x");
    const y = body.products.find((p) => p.slug === "y");
    expect(x?.releaseCount).toBe(2);
    expect(y?.releaseCount).toBe(0);
  });
});
