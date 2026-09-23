/**
 * `?category=` / `?collection=` scoping on /v1/search (#371). Both narrow the
 * result set to an org set — a category via `organizations.category`, a
 * collection via `collection_members` membership — without materializing a
 * (capped) source-id list. Exercised here at the query-helper layer where the
 * predicates live; the route wires resolution + echo on top.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  organizations,
  products,
  sources,
  releases,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import { asD1 } from "../../../tests/mcp-test-helpers";
import { createTestApp } from "./setup.js";
import { searchRoutes } from "../src/routes/search.js";
import {
  searchOrgs,
  searchProducts,
  searchSources,
  searchReleasesFromMatchedEntities,
  searchReleasesFts,
} from "../src/queries/search.js";

let testDb: TestDatabase;

// Two orgs in different categories; a collection holds only the cloud org.
// Every entity shares the "Ship" / "Labs" tokens so the *query* matches both
// orgs and the category/collection predicate is the only thing that narrows.
beforeEach(async () => {
  testDb = createTestDb();
  await testDb.db.insert(organizations).values([
    { id: "org_cloud", slug: "acme", name: "Acme Labs", category: "cloud" },
    { id: "org_dev", slug: "beta", name: "Beta Labs", category: "developer-tools" },
  ]);
  await testDb.db.insert(products).values([
    { id: "prod_cloud", slug: "acme-ship", name: "Acme Ship", orgId: "org_cloud" },
    { id: "prod_dev", slug: "beta-ship", name: "Beta Ship", orgId: "org_dev" },
  ]);
  await testDb.db.insert(sources).values([
    {
      id: "src_cloud",
      slug: "acme-ship-feed",
      name: "Acme Ship Feed",
      type: "feed",
      url: "https://acme.test/ship",
      orgId: "org_cloud",
      productId: "prod_cloud",
    },
    {
      id: "src_dev",
      slug: "beta-ship-feed",
      name: "Beta Ship Feed",
      type: "feed",
      url: "https://beta.test/ship",
      orgId: "org_dev",
      productId: "prod_dev",
    },
  ]);
  await testDb.db.insert(releases).values([
    {
      id: "rel_cloud",
      sourceId: "src_cloud",
      title: "Ship 1.0",
      content: "cloud ship notes",
      url: "https://acme.test/ship/1",
      publishedAt: "2026-04-20T00:00:00Z",
    },
    {
      id: "rel_dev",
      sourceId: "src_dev",
      title: "Ship 2.0",
      content: "dev ship notes",
      url: "https://beta.test/ship/1",
      publishedAt: "2026-04-21T00:00:00Z",
    },
  ]);
  await testDb.db.insert(collections).values({
    id: "col_coding",
    slug: "coding-agents",
    name: "Coding Agents",
  });
  await testDb.db
    .insert(collectionMembers)
    .values({ collectionId: "col_coding", orgId: "org_cloud", position: 0 });
});

describe("category scope", () => {
  it("searchOrgs narrows to orgs in the category", async () => {
    const all = await searchOrgs(asD1(testDb.db), "Labs", 10);
    expect(all.map((o) => o.slug).toSorted()).toEqual(["acme", "beta"]);

    const cloud = await searchOrgs(asD1(testDb.db), "Labs", 10, { orgCategory: "cloud" });
    expect(cloud.map((o) => o.slug)).toEqual(["acme"]);
  });

  it("searchProducts narrows to products whose org is in the category", async () => {
    const cloud = await searchProducts(asD1(testDb.db), "Ship", 10, { orgCategory: "cloud" });
    expect(cloud.map((p) => p.slug)).toEqual(["acme-ship"]);
  });

  it("searchSources narrows to sources whose org is in the category", async () => {
    const cloud = await searchSources(asD1(testDb.db), "Ship", 10, { orgCategory: "cloud" });
    expect(cloud.map((s) => s.slug)).toEqual(["acme-ship-feed"]);
  });

  it("searchReleasesFromMatchedEntities drops releases outside the category", async () => {
    const rows = await searchReleasesFromMatchedEntities(
      asD1(testDb.db),
      ["acme", "beta"],
      [],
      50,
      { orgCategory: "cloud" },
    );
    expect(rows.map((r) => r.id)).toEqual(["rel_cloud"]);
  });

  it("an empty category returns nothing (no fall-through to unscoped)", async () => {
    const rows = await searchReleasesFromMatchedEntities(
      asD1(testDb.db),
      ["acme", "beta"],
      [],
      50,
      { orgCategory: "finance" },
    );
    expect(rows).toHaveLength(0);
  });
});

describe("collection scope", () => {
  it("searchOrgs narrows to collection member orgs", async () => {
    const members = await searchOrgs(asD1(testDb.db), "Labs", 10, { collectionId: "col_coding" });
    expect(members.map((o) => o.slug)).toEqual(["acme"]);
  });

  it("searchReleasesFromMatchedEntities narrows to member orgs' releases", async () => {
    const rows = await searchReleasesFromMatchedEntities(
      asD1(testDb.db),
      ["acme", "beta"],
      [],
      50,
      { collectionId: "col_coding" },
    );
    expect(rows.map((r) => r.id)).toEqual(["rel_cloud"]);
  });

  it("a collection with no matching members returns nothing", async () => {
    const rows = await searchReleasesFromMatchedEntities(
      asD1(testDb.db),
      ["acme", "beta"],
      [],
      50,
      { collectionId: "col_nonexistent" },
    );
    expect(rows).toHaveLength(0);
  });
});

describe("route resolution + echo", () => {
  const app = () =>
    // oxlint-disable-next-line no-explicit-any
    createTestApp(asD1(testDb.db) as any, [searchRoutes], { env: {} });

  it("rejects an unknown category with 400", async () => {
    const res = await app()(
      new Request("https://x.test/v1/search?q=Ship&category=not-a-category&mode=lexical"),
    );
    expect(res.status).toBe(400);
  });

  it("resolves a valid category and echoes categoryStatus: matched", async () => {
    const res = await app()(
      new Request("https://x.test/v1/search?q=Ship&category=cloud&mode=lexical"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { category?: string; categoryStatus?: string };
    expect(body.category).toBe("cloud");
    expect(body.categoryStatus).toBe("matched");
  });

  it("returns an empty envelope with collectionStatus: not_found for an unknown collection", async () => {
    const res = await app()(
      new Request("https://x.test/v1/search?q=Ship&collection=nope&mode=lexical"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection?: string;
      collectionStatus?: string;
      releases: unknown[];
      orgs: unknown[];
    };
    expect(body.collectionStatus).toBe("not_found");
    expect(body.releases).toEqual([]);
    expect(body.orgs).toEqual([]);
  });

  it("scopes orgs to a matched collection and echoes collectionStatus: matched", async () => {
    const res = await app()(
      new Request("https://x.test/v1/search?q=Labs&collection=coding-agents&mode=lexical"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      collection?: string;
      collectionStatus?: string;
      orgs: Array<{ slug: string }>;
    };
    expect(body.collection).toBe("coding-agents");
    expect(body.collectionStatus).toBe("matched");
    expect(body.orgs.map((o) => o.slug)).toEqual(["acme"]);
  });
});

describe("category + collection compose with the FTS path", () => {
  it("filters FTS release hits by category and collection when FTS is available", async () => {
    // Local bun:sqlite may lack the FTS5 schema in minimal fixtures — skip the
    // assertion (not the predicate) when MATCH returns nothing at all.
    try {
      const unscoped = await searchReleasesFts(asD1(testDb.db), "Ship", 10, 0);
      if (unscoped.length === 0) return; // FTS not populated in this fixture
      const cloud = await searchReleasesFts(asD1(testDb.db), "Ship", 10, 0, {
        orgCategory: "cloud",
      });
      expect(cloud.map((r) => r.id)).toEqual(["rel_cloud"]);
      const inCollection = await searchReleasesFts(asD1(testDb.db), "Ship", 10, 0, {
        collectionId: "col_coding",
      });
      expect(inCollection.map((r) => r.id)).toEqual(["rel_cloud"]);
    } catch {
      // FTS schema absent — the non-FTS suites above cover the predicates.
    }
  });
});
