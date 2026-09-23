/**
 * MCP read visibility matches the API (docs/architecture/shared-queries.md,
 * D1–D8). One fixture holds a live row next to a soft-deleted, hidden, or
 * coverage-side sibling for each case; every test asserts the sibling stays
 * out of MCP output (and, for D2, that a hidden org still resolves).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import {
  collections,
  collectionMembers,
  domainAliases,
  organizations,
  orgAccounts,
  products,
  releaseLocations,
  releases,
  sources,
} from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage";
import { loadReleaseLocations } from "@releases/queries/release-locations";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import type { D1Db } from "../src/db";
import {
  getCatalogEntry,
  getCollection,
  getCollectionReleases,
  getLatestReleases,
  getOrganization,
  getRelease,
  listCatalog,
  listOrganizations,
} from "../src/tools";

const WEB = "https://releases.sh";
const DELETED_AT = "2026-01-01T00:00:00Z";
const PUBLISHED = "2026-05-01T00:00:00Z";

let tdb: TestDatabase;
let db: D1Db;

function textOf(res: { content: [{ text: string }] }): string {
  return res.content[0].text;
}

function src(id: string, orgId: string, extra: Partial<typeof sources.$inferInsert> = {}) {
  const slug = id.replace(/^src_/, "").replaceAll("_", "-");
  return {
    id,
    orgId,
    name: `Source ${slug}`,
    slug,
    type: "feed" as const,
    url: `https://example.com/${slug}`,
    ...extra,
  };
}

function rel(id: string, sourceId: string, extra: Partial<typeof releases.$inferInsert> = {}) {
  return {
    id,
    sourceId,
    title: `Release ${id}`,
    type: "feature" as const,
    content: `Body of ${id}`,
    publishedAt: PUBLISHED,
    url: `https://example.com/${id}`,
    ...extra,
  };
}

beforeAll(async () => {
  tdb = createTestDb();
  db = tdb.db as unknown as D1Db;

  await tdb.db.insert(organizations).values([
    { id: "org_live", name: "Live Co", slug: "live", domain: "live.example.com" },
    { id: "org_hidden", name: "Hidden Co", slug: "hidden", isHidden: true },
    { id: "org_stub", name: "Stub Co", slug: "stub", discovery: "on_demand" },
    { id: "org_tier_stub", name: "Tier Stub", slug: "tier-stub", tier: "stub" },
    {
      id: "org_gone",
      name: "Gone Co",
      slug: "gone--org_gone",
      domain: "gone.example.com",
      deletedAt: DELETED_AT,
    },
  ]);
  await tdb.db
    .insert(domainAliases)
    .values({ domain: "gone-alias.example.com", orgId: "org_gone" });
  await tdb.db
    .insert(orgAccounts)
    .values({ id: "oa_gone", orgId: "org_gone", platform: "github", handle: "gone-gh" });

  await tdb.db.insert(products).values([
    { id: "prod_live", name: "Live App", slug: "app", orgId: "org_live" },
    {
      id: "prod_dead",
      name: "Dead App",
      slug: "dead-app",
      orgId: "org_live",
      deletedAt: DELETED_AT,
    },
    { id: "prod_stub", name: "Stub App", slug: "stub-app", orgId: "org_stub" },
  ]);

  await tdb.db
    .insert(sources)
    .values([
      src("src_live", "org_live", { productId: "prod_live" }),
      src("src_live_hidden", "org_live", { productId: "prod_live", isHidden: true }),
      src("src_live_dead", "org_live", { productId: "prod_live", deletedAt: DELETED_AT }),
      src("src_standalone", "org_live"),
      src("src_standalone_dead", "org_live", { deletedAt: DELETED_AT }),
      src("src_under_dead_product", "org_live", { productId: "prod_dead" }),
      src("src_hidden_org", "org_hidden"),
      src("src_gone_org", "org_gone"),
      src("src_stub_product", "org_stub", { productId: "prod_stub" }),
    ]);

  await tdb.db
    .insert(releases)
    .values([
      rel("rel_live", "src_live"),
      rel("rel_canonical", "src_live"),
      rel("rel_coverage", "src_live"),
      rel("rel_dead_product", "src_under_dead_product"),
      rel("rel_hidden_org", "src_hidden_org"),
      rel("rel_gone_org", "src_gone_org"),
      rel("rel_standalone", "src_standalone"),
      rel("rel_stub_product", "src_stub_product"),
    ]);
  await tdb.db
    .insert(releaseCoverage)
    .values({ coverageId: "rel_coverage", canonicalId: "rel_canonical", decidedBy: "test" });

  // One collection holding a member of every visibility class.
  await tdb.db.insert(collections).values({ id: "col_mix", slug: "mix", name: "Mix" });
  await tdb.db.insert(collectionMembers).values([
    { collectionId: "col_mix", orgId: "org_live" },
    { collectionId: "col_mix", orgId: "org_gone" },
    { collectionId: "col_mix", orgId: "org_stub" },
    { collectionId: "col_mix", productId: "prod_live" },
    { collectionId: "col_mix", productId: "prod_dead" },
    { collectionId: "col_mix", productId: "prod_stub" },
  ]);

  // Declared locations on a stub: a canonical row that sorts last by
  // match_key, and a soft-deleted one.
  await tdb.db.insert(releaseLocations).values(
    [
      ["loc_a", "https://a.example.com", false, null],
      ["loc_z", "https://z.example.com", true, null],
      ["loc_gone", "https://gone.example.com", false, DELETED_AT],
    ].map(([id, url, canonical, deletedAt]) => ({
      id: id as string,
      orgId: "org_tier_stub",
      url: url as string,
      canonical: canonical as boolean,
      basis: "declared" as const,
      matchKey: `url:${url}`,
      createdAt: PUBLISHED,
      updatedAt: PUBLISHED,
      deletedAt: deletedAt as string | null,
    })),
  );

  // A release whose source row is gone (FK off to plant the orphan).
  tdb.db.run(sql`PRAGMA foreign_keys = OFF`);
  await tdb.db.insert(releases).values(rel("rel_orphan", "src_missing"));
  tdb.db.run(sql`PRAGMA foreign_keys = ON`);
});

afterAll(() => tdb.cleanup());

describe("D1: soft-deleted sources and products don't resolve", () => {
  it("typed source ID of a deleted source is not found", async () => {
    const out = textOf(await getCatalogEntry(db, { identifier: "src_live_dead" }));
    expect(out).toContain("No source found");
  });

  it("typed product ID of a deleted product is not found", async () => {
    const out = textOf(await getCatalogEntry(db, { identifier: "prod_dead" }));
    expect(out).toContain("No product found");
  });

  it("org/slug coordinate of a deleted product or source is not found", async () => {
    expect(textOf(await getCatalogEntry(db, { identifier: "live/dead-app" }))).toContain(
      "No catalog entry found",
    );
    expect(textOf(await getCatalogEntry(db, { identifier: "live/live-dead" }))).toContain(
      "No catalog entry found",
    );
  });

  it("a live product still resolves", async () => {
    expect(textOf(await getCatalogEntry(db, { identifier: "prod_live" }))).toContain(
      "**Product: Live App**",
    );
  });
});

describe("D2: findOrg skips deleted orgs on every key, keeps hidden ones", () => {
  for (const key of [
    "org_gone",
    "gone--org_gone",
    "Gone Co",
    "gone.example.com",
    "gone-alias.example.com",
    "gone-gh",
  ]) {
    it(`does not resolve a deleted org by "${key}"`, async () => {
      const out = textOf(await getOrganization(db, { identifier: key }));
      expect(out).toContain("No organization found");
    });
  }

  it("resolves a hidden org by direct lookup", async () => {
    const out = textOf(await getOrganization(db, { identifier: "hidden" }));
    expect(out).toContain("Hidden Co");
    expect(out).not.toContain("No organization found");
  });
});

describe("D3: get_latest_releases drops releases under hidden or deleted orgs", () => {
  it("omits hidden-org and deleted-org releases from the global feed", async () => {
    const res = await getLatestReleases(db, { limit: 50 }, WEB);
    const ids = (res.structuredContent as { releases: { id: string }[] }).releases.map((r) => r.id);
    expect(ids).toContain("rel_live");
    expect(ids).not.toContain("rel_hidden_org");
    expect(ids).not.toContain("rel_gone_org");
    expect(ids).not.toContain("rel_coverage");
  });

  it("reads products_active: a deleted product's name is not attached", async () => {
    const res = await getLatestReleases(db, { limit: 50 }, WEB);
    const row = (
      res.structuredContent as { releases: { id: string; product: unknown }[] }
    ).releases.find((r) => r.id === "rel_dead_product");
    expect(row).toBeDefined();
    expect(row!.product).toBeNull();
  });

  it("an org-scoped feed for a hidden org is empty, like the API", async () => {
    const res = await getLatestReleases(db, { organization: "hidden", limit: 50 }, WEB);
    // The API drops hidden-org releases from the latest feed even when scoped.
    expect(textOf(res)).toBe("No releases found.");
  });
});

describe("D4: list_organizations omits hidden and deleted orgs", () => {
  it("default listing", async () => {
    const out = textOf(await listOrganizations(db, {}));
    expect(out).toContain("Live Co");
    expect(out).not.toContain("Hidden Co");
    expect(out).not.toContain("Gone Co");
  });

  it("query that matches a hidden or deleted org by domain, alias, or handle", async () => {
    for (const query of ["hidden", "gone", "gone-alias", "gone-gh"]) {
      const out = textOf(await listOrganizations(db, { query, include_empty: true }));
      expect(out).toBe("No organizations found.");
    }
  });

  it("platform filter still works", async () => {
    const out = textOf(await listOrganizations(db, { platform: "github", include_empty: true }));
    expect(out).toBe("No organizations found.");
  });
});

describe("D5: get_release matches GET /v1/releases/:id", () => {
  it("coverage-side release is not found", async () => {
    const out = textOf(await getRelease(db, { id: "rel_coverage" }, WEB));
    expect(out).toContain("No release found");
  });

  it("release with a missing source row is not found", async () => {
    const out = textOf(await getRelease(db, { id: "rel_orphan" }, WEB));
    expect(out).toContain("No release found");
  });

  it("deleted parent org or product comes back null", async () => {
    const gone = await getRelease(db, { id: "rel_gone_org" }, WEB);
    expect((gone.structuredContent as { org: unknown }).org).toBeNull();
    const deadProduct = await getRelease(db, { id: "rel_dead_product" }, WEB);
    expect((deadProduct.structuredContent as { product: unknown }).product).toBeNull();
  });

  it("canonical release still resolves", async () => {
    const res = await getRelease(db, { id: "rel_canonical" }, WEB);
    expect((res.structuredContent as { id: string }).id).toBe("rel_canonical");
  });
});

describe("D6: catalog and product detail omit deleted and hidden children", () => {
  it("list_catalog skips deleted products and deleted standalone sources", async () => {
    const out = textOf(await listCatalog(db, { organization: "live" }));
    expect(out).toContain("Live App");
    expect(out).toContain("Source standalone");
    expect(out).not.toContain("Dead App");
    expect(out).not.toContain("Source standalone-dead");
    // A source under a deleted product stays listed as standalone.
    expect(out).toContain("Source under-dead-product");
  });

  it("list_catalog without an org skips children of deleted orgs", async () => {
    const out = textOf(await listCatalog(db, { limit: 200 }));
    expect(out).not.toContain("Source gone-org");
  });

  it("product detail lists only visible sources", async () => {
    const out = textOf(await getCatalogEntry(db, { identifier: "prod_live" }));
    expect(out).toContain("Source live");
    expect(out).not.toContain("Source live-hidden");
    expect(out).not.toContain("Source live-dead");
  });
});

describe("D7: collection members and releases match GET /v1/collections/:slug", () => {
  it("get_collection lists members through organizations_public and products_active", async () => {
    const out = textOf(await getCollection(db, { slug: "mix" }));
    expect(out).toContain("Members (2 members)");
    expect(out).toContain("**Live Co** (live)");
    expect(out).toContain("**Live App** (product · Live Co / app)");
    expect(out).not.toContain("Gone Co");
    expect(out).not.toContain("Stub");
    expect(out).not.toContain("Dead App");
  });

  it("get_collection_releases drops a product whose parent org is on_demand", async () => {
    const res = await getCollectionReleases(db, { slug: "mix", limit: 50 }, WEB);
    const ids = (res.structuredContent as { releases: { id: string }[] }).releases.map((r) => r.id);
    expect(ids).toContain("rel_live");
    expect(ids).toContain("rel_standalone");
    expect(ids).not.toContain("rel_stub_product");
    expect(ids).not.toContain("rel_gone_org");
  });
});

describe("D8: stub release locations match the API's order", () => {
  it("get_organization lists locations in the same order as GET /v1/orgs/:slug", async () => {
    const out = textOf(await getOrganization(db, { identifier: "tier-stub" }));
    const apiOrder = (await loadReleaseLocations(db, "org_tier_stub")).map((l) => l.url!);
    expect(apiOrder).toEqual(["https://z.example.com", "https://a.example.com"]);
    const mcpOrder = apiOrder.map((u) => out.indexOf(u));
    expect(mcpOrder.every((i) => i >= 0)).toBe(true);
    expect(mcpOrder).toEqual([...mcpOrder].sort((a, b) => a - b));
    expect(out).not.toContain("gone.example.com");
  });
});
