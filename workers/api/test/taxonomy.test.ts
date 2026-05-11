import { describe, it, expect } from "bun:test";
import { organizations, products } from "@buildinternet/releases-core/schema";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { taxonomyRoutes } from "../src/routes/taxonomy.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, taxonomyRoutes);

describe("GET /v1/categories", () => {
  it("returns every category in the taxonomy with org and product counts", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      { id: "org_a1", slug: "anthropic", name: "Anthropic", category: "ai" },
      { id: "org_a2", slug: "openai", name: "OpenAI", category: "ai" },
      { id: "org_cl", slug: "cloudy", name: "Cloudy", category: "cloud" },
      // on_demand should be invisible — organizations_public filters it out,
      // and the count comes from that view.
      {
        id: "org_hidden",
        slug: "hidden-lab",
        name: "Hidden Lab",
        category: "ai",
        discovery: "on_demand",
      },
      // No-category org should not contribute to any bucket.
      { id: "org_nocat", slug: "nocat", name: "NoCat" },
    ]);
    await db.insert(products).values([
      // Product category overrides parent org category in the rollup, but for
      // the count list it just contributes to its own bucket. Cloudy → framework
      // exercises that path.
      {
        id: "prod_next",
        slug: "next",
        name: "Next.js",
        orgId: "org_cl",
        category: "framework",
      },
      // Product whose own category is NULL — should not be counted under any
      // bucket on the product side.
      { id: "prod_nocat", slug: "uncategorized", name: "Uncategorized", orgId: "org_a1" },
    ]);

    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/categories"));
    expect(res.status).toBe(200);
    const body = await res.json();

    // Every slug in the fixed taxonomy is present, in CATEGORIES order.
    expect(body.map((c: { slug: string }) => c.slug)).toEqual([...CATEGORIES]);

    const bySlug = new Map(body.map((c: { slug: string }) => [c.slug, c]));
    expect(bySlug.get("ai")).toMatchObject({
      slug: "ai",
      name: "AI",
      orgCount: 2,
      productCount: 0,
    });
    expect(bySlug.get("cloud")).toMatchObject({
      slug: "cloud",
      name: "Cloud",
      orgCount: 1,
      productCount: 0,
    });
    expect(bySlug.get("framework")).toMatchObject({
      slug: "framework",
      name: "Framework",
      orgCount: 0,
      productCount: 1,
    });
    // Empty buckets still appear with zeroes — the API advertises the full
    // taxonomy, not just populated slugs.
    expect(bySlug.get("design")).toMatchObject({ orgCount: 0, productCount: 0 });
    expect(bySlug.get("devops")).toMatchObject({ name: "DevOps" });
  });

  it("excludes soft-deleted orgs and their products from counts", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      // Live row exists in `database` so the bucket has a baseline to compare
      // against — confirms the soft-deleted row is the one being filtered out,
      // not the whole bucket.
      { id: "org_live", slug: "live-db", name: "Live DB", category: "database" },
      {
        id: "org_tomb",
        slug: "tombstoned",
        name: "Tombstoned",
        category: "database",
        deletedAt: "2026-04-01T00:00:00.000Z",
      },
    ]);
    await db.insert(products).values({
      id: "prod_tomb",
      slug: "tombstoned-product",
      name: "Tombstoned Product",
      orgId: "org_tomb",
      category: "framework",
    });

    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/categories"));
    const body = await res.json();
    const database = body.find((c: { slug: string }) => c.slug === "database");
    // Soft-deleted org filtered through organizations_public — only the live
    // row counts.
    expect(database).toMatchObject({ orgCount: 1, productCount: 0 });
    const framework = body.find((c: { slug: string }) => c.slug === "framework");
    // Product joined through organizations_public, which excludes the
    // soft-deleted parent — the product disappears with the org.
    expect(framework).toMatchObject({ orgCount: 0, productCount: 0 });
  });

  it("excludes products of on_demand orgs from product counts", async () => {
    const db = mkDb();
    await db.insert(organizations).values([
      {
        id: "org_hidden",
        slug: "hidden-org",
        name: "Hidden Org",
        category: "ai",
        discovery: "on_demand",
      },
    ]);
    await db.insert(products).values([
      {
        id: "prod_hidden",
        slug: "hidden-fw",
        name: "Hidden FW",
        orgId: "org_hidden",
        category: "framework",
      },
    ]);

    const fetch = mkApp(db);
    const res = await fetch(new Request("http://test/v1/categories"));
    const body = await res.json();
    const fw = body.find((c: { slug: string }) => c.slug === "framework");
    // Product belongs to an on_demand org, so it's hidden behind
    // organizations_public — neither the org nor the product should show.
    expect(fw).toMatchObject({ orgCount: 0, productCount: 0 });
    const ai = body.find((c: { slug: string }) => c.slug === "ai");
    expect(ai).toMatchObject({ orgCount: 0 });
  });
});
