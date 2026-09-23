// Optional `?category=` filter on the orgs list. Narrows the directory to a
// single canonical category; aliases are resolved to canonical slugs;
// empty/invalid values are ignored (fail-open to unfiltered).
// `meta.emptyOrgCount` stays scoped to the same filter so the
// "show empty orgs" toggle stays accurate within a category view.
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases, categories } from "@buildinternet/releases-core/schema";
import { orgRoutes } from "../src/routes/orgs.js";
import { createTestDb as mkDb, createTestApp } from "./setup";

const mkApp = (db: ReturnType<typeof mkDb>) => createTestApp(db, orgRoutes);

const NOW = "2026-05-15T12:00:00.000Z";

async function seed(db: ReturnType<typeof mkDb>) {
  // Two AI orgs (one with a release, one empty) and one cloud org with a
  // release — so the category filter, the empty filter, and their interaction
  // can all be exercised.
  await db.insert(organizations).values([
    { id: "org_acme", slug: "acme", name: "Acme", category: "ai" },
    { id: "org_beta", slug: "beta", name: "Beta", category: "cloud" },
    { id: "org_gamma", slug: "gamma", name: "Gamma", category: "ai" }, // empty (no releases)
  ]);
  await db.insert(sources).values([
    {
      id: "src_acme",
      orgId: "org_acme",
      slug: "acme-changelog",
      name: "Acme Changelog",
      type: "scrape",
      url: "https://acme.example/changelog",
      createdAt: NOW,
    },
    {
      id: "src_beta",
      orgId: "org_beta",
      slug: "beta-changelog",
      name: "Beta Changelog",
      type: "scrape",
      url: "https://beta.example/changelog",
      createdAt: NOW,
    },
  ]);
  await db.insert(releases).values([
    {
      id: "rel_acme_1",
      sourceId: "src_acme",
      title: "Acme 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
    {
      id: "rel_beta_1",
      sourceId: "src_beta",
      title: "Beta 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    },
  ]);
}

type ListBody = {
  items: Array<{ slug: string; category: string | null }>;
  pagination: { totalItems: number };
  meta?: { emptyOrgCount?: number };
};

describe("GET /v1/orgs — category filter", () => {
  it("narrows the list to a single category and scopes the empty count to it", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?category=ai"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;

    // Only the AI org with a release; Beta (cloud) excluded, Gamma (empty) hidden.
    expect(body.items.map((o) => o.slug)).toEqual(["acme"]);
    expect(body.items.every((o) => o.category === "ai")).toBe(true);
    expect(body.pagination.totalItems).toBe(1);
    // Gamma is an empty AI org — counted, scoped to the category.
    expect(body.meta?.emptyOrgCount).toBe(1);
  });

  it("surfaces empty orgs in the category when ?includeEmpty=true", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(
      new Request("https://x.test/v1/orgs?category=ai&includeEmpty=true"),
    );
    const body = (await res.json()) as ListBody;
    expect(body.items.map((o) => o.slug).toSorted()).toEqual(["acme", "gamma"]);
    expect(body.pagination.totalItems).toBe(2);
    expect(body.meta?.emptyOrgCount).toBe(1);
  });

  it("filters to a different category independently", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?category=cloud"));
    const body = (await res.json()) as ListBody;
    expect(body.items.map((o) => o.slug)).toEqual(["beta"]);
    expect(body.pagination.totalItems).toBe(1);
    expect(body.meta?.emptyOrgCount).toBe(0);
  });

  it("ignores an invalid category (fail-open to unfiltered)", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?category=bogus"));
    const body = (await res.json()) as ListBody;
    // Same as no filter: both orgs with releases, empty Gamma hidden but counted.
    expect(body.items.map((o) => o.slug).toSorted()).toEqual(["acme", "beta"]);
    expect(body.pagination.totalItems).toBe(2);
    expect(body.meta?.emptyOrgCount).toBe(1);
  });

  it("resolves a category alias to its canonical slug and filters correctly", async () => {
    const db = mkDb();
    await seed(db);
    // Register "e-commerce" as an alias for the canonical "commerce" category,
    // then add an org in the "commerce" category with a release.
    await db.insert(categories).values({
      slug: "commerce",
      aliases: JSON.stringify(["e-commerce"]),
    });
    await db.insert(organizations).values({
      id: "org_shop",
      slug: "shopify",
      name: "Shopify",
      category: "commerce",
    });
    await db.insert(sources).values({
      id: "src_shop",
      orgId: "org_shop",
      slug: "shopify-changelog",
      name: "Shopify Changelog",
      type: "scrape",
      url: "https://shopify.example/changelog",
      createdAt: NOW,
    });
    await db.insert(releases).values({
      id: "rel_shop_1",
      sourceId: "src_shop",
      title: "Shopify 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    });

    // The alias "e-commerce" resolves to "commerce", so only the Shopify org appears.
    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?category=e-commerce"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.map((o) => o.slug)).toEqual(["shopify"]);
    expect(body.items.every((o) => o.category === "commerce")).toBe(true);
    expect(body.pagination.totalItems).toBe(1);
    expect(body.meta?.emptyOrgCount).toBe(0);
  });

  it("a canonical category still filters correctly (unchanged behaviour)", async () => {
    const db = mkDb();
    await seed(db);

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?category=ai"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.items.map((o) => o.slug)).toEqual(["acme"]);
    expect(body.pagination.totalItems).toBe(1);
    // Gamma is an empty AI org — counted but not listed.
    expect(body.meta?.emptyOrgCount).toBe(1);
  });

  it("emptyOrgCount is scoped to the resolved alias filter", async () => {
    const db = mkDb();
    await seed(db);
    // Register alias and add one commerce org with a release and one empty.
    await db.insert(categories).values({
      slug: "commerce",
      aliases: JSON.stringify(["e-commerce"]),
    });
    await db.insert(organizations).values([
      { id: "org_shop2", slug: "shopify2", name: "Shopify2", category: "commerce" },
      { id: "org_empty_commerce", slug: "empty-shop", name: "Empty Shop", category: "commerce" },
    ]);
    await db.insert(sources).values({
      id: "src_shop2",
      orgId: "org_shop2",
      slug: "shopify2-changelog",
      name: "Shopify2 Changelog",
      type: "scrape",
      url: "https://shopify2.example/changelog",
      createdAt: NOW,
    });
    await db.insert(releases).values({
      id: "rel_shop2_1",
      sourceId: "src_shop2",
      title: "Shopify2 1.0",
      content: "Initial release",
      publishedAt: NOW,
      fetchedAt: NOW,
    });

    const res = await mkApp(db)(new Request("https://x.test/v1/orgs?category=e-commerce"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    // Only the org with a release is listed.
    expect(body.items.map((o) => o.slug)).toEqual(["shopify2"]);
    expect(body.pagination.totalItems).toBe(1);
    // emptyOrgCount is scoped to commerce (resolved from "e-commerce").
    expect(body.meta?.emptyOrgCount).toBe(1);
  });
});
