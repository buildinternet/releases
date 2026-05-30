// Optional `?category=` filter on the orgs list. Narrows the directory to a
// single canonical category; empty/invalid values are ignored (fail-open to
// unfiltered). `meta.emptyOrgCount` stays scoped to the same filter so the
// "show empty orgs" toggle stays accurate within a category view.
import { describe, it, expect } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
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
});
