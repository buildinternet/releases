import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import {
  collections,
  collectionMembers,
  organizations,
  orgAccounts,
  products,
} from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import {
  countCollections,
  findCollectionBySlug,
  findCollectionsByMemberOrgs,
  getCollectionFullMembers,
  interleaveMembers,
  listCollectionMemberIds,
  listCollectionsWhere,
  searchCollectionsDirect,
} from "./collections.js";

const DELETED_AT = "2026-01-01T00:00:00Z";

describe("collection reads", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = createTestDb();
    await tdb.db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme", domain: "acme.example.com" },
      { id: "org_zed", name: "Zed", slug: "zed" },
      { id: "org_hidden", name: "Hidden", slug: "hidden", isHidden: true },
      { id: "org_stub", name: "Stub", slug: "stub", discovery: "on_demand" },
      { id: "org_gone", name: "Gone", slug: "gone--org_gone", deletedAt: DELETED_AT },
    ]);
    await tdb.db.insert(orgAccounts).values([
      { id: "oa_acme_1", orgId: "org_acme", platform: "github", handle: "acme-gh" },
      { id: "oa_acme_2", orgId: "org_acme", platform: "github", handle: "acme-gh-2" },
    ]);
    await tdb.db.insert(products).values([
      { id: "prod_app", name: "App", slug: "app", orgId: "org_acme" },
      { id: "prod_old", name: "Old", slug: "old", orgId: "org_acme", deletedAt: DELETED_AT },
      { id: "prod_stub", name: "StubApp", slug: "stub-app", orgId: "org_stub" },
      { id: "prod_gone", name: "GoneApp", slug: "gone-app", orgId: "org_gone" },
    ]);
    await tdb.db.insert(collections).values([
      { id: "col_tools", slug: "tools", name: "Tools", description: "Dev tooling" },
      { id: "col_empty", slug: "empty", name: "Empty", isFeatured: true },
      { id: "col_zed", slug: "zed-only", name: "Zed only" },
    ]);
    await tdb.db.insert(collectionMembers).values([
      // Same position: name then slug decides the order.
      { collectionId: "col_tools", orgId: "org_zed", position: 0 },
      { collectionId: "col_tools", orgId: "org_acme", position: 0 },
      { collectionId: "col_tools", productId: "prod_app", position: 0 },
      // `organizations_public` drops deleted and on_demand orgs but keeps
      // hidden ones, so the hidden org stays a visible member (as in the API).
      { collectionId: "col_tools", orgId: "org_hidden", position: 1 },
      // Invisible members of every kind.
      { collectionId: "col_tools", orgId: "org_stub", position: 1 },
      { collectionId: "col_tools", orgId: "org_gone", position: 1 },
      { collectionId: "col_tools", productId: "prod_old", position: 1 },
      { collectionId: "col_tools", productId: "prod_stub", position: 1 },
      { collectionId: "col_tools", productId: "prod_gone", position: 1 },
      { collectionId: "col_zed", orgId: "org_zed", position: 0 },
    ]);
  });
  afterAll(() => tdb.cleanup());

  it("findCollectionBySlug returns the full row or null", async () => {
    const row = await findCollectionBySlug(tdb.db, "tools");
    expect(row?.id).toBe("col_tools");
    expect(row?.description).toBe("Dev tooling");
    expect(await findCollectionBySlug(tdb.db, "nope")).toBeNull();
  });

  it("countCollections counts every row", async () => {
    expect(await countCollections(tdb.db)).toBe(3);
  });

  it("listCollectionsWhere counts only visible org and product members", async () => {
    const rows = await listCollectionsWhere(tdb.db);
    expect(rows.map((r) => [r.slug, r.memberCount])).toEqual([
      ["empty", 0],
      ["tools", 4],
      ["zed-only", 1],
    ]);
    expect(rows.find((r) => r.slug === "empty")?.isFeatured).toBe(true);
  });

  it("listCollectionsWhere honors a predicate and a page window", async () => {
    const featured = await listCollectionsWhere(tdb.db, sql`c.is_featured = 1`);
    expect(featured.map((r) => r.slug)).toEqual(["empty"]);
    const page = await listCollectionsWhere(tdb.db, undefined, { limit: 1, offset: 1 });
    expect(page.map((r) => r.slug)).toEqual(["tools"]);
  });

  it("listCollectionMemberIds drops on_demand and deleted members, keeps hidden orgs", async () => {
    const ids = await listCollectionMemberIds(tdb.db, "col_tools");
    expect(ids.orgs.map((o) => o.orgId).sort()).toEqual(["org_acme", "org_hidden", "org_zed"]);
    // A product under an on_demand or deleted org is dropped even though the
    // product row itself is active.
    expect(ids.products.map((p) => p.productId)).toEqual(["prod_app"]);
  });

  it("getCollectionFullMembers interleaves by (position, name, slug) with one GitHub handle", async () => {
    const members = await getCollectionFullMembers(tdb.db, "col_tools");
    expect(members.map((m) => `${m.kind}:${m.slug}`)).toEqual([
      "org:acme",
      "product:app",
      "org:zed",
      "org:hidden",
    ]);
    const acme = members[0];
    expect(acme.kind === "org" && acme.githubHandle).toBe("acme-gh");
    const app = members[1];
    expect(app.kind === "product" && app.org.slug).toBe("acme");
    expect(await getCollectionFullMembers(tdb.db, "col_empty")).toEqual([]);
  });

  it("interleaveMembers uses binary collation and a slug tiebreak", () => {
    const org = (name: string, slug: string, position = 0) => ({
      position,
      slug,
      name,
      domain: null,
      avatarUrl: null,
      description: null,
      githubHandle: null,
    });
    const out = interleaveMembers(
      [org("b", "b-2"), org("B", "big"), org("b", "b-1"), org("a", "a", 1)],
      [
        {
          position: 0,
          productSlug: "a-prod",
          productName: "a",
          productDescription: null,
          parentOrgSlug: "x",
          parentOrgName: "X",
          parentOrgDomain: null,
          parentOrgAvatarUrl: null,
          parentOrgGithubHandle: null,
        },
      ],
    );
    // Uppercase sorts before lowercase under BINARY; equal names fall back to slug.
    expect(out.map((m) => m.slug)).toEqual(["big", "a-prod", "b-1", "b-2", "a"]);
  });

  it("searchCollectionsDirect matches name, slug, or description with visible org counts", async () => {
    const byDescription = await searchCollectionsDirect(tdb.db, "tooling", 10);
    expect(byDescription).toEqual([
      { slug: "tools", name: "Tools", description: "Dev tooling", memberCount: 3, via: "direct" },
    ]);
    const bySlug = await searchCollectionsDirect(tdb.db, "zed-only", 10);
    expect(bySlug.map((c) => c.slug)).toEqual(["zed-only"]);
    expect(await searchCollectionsDirect(tdb.db, "nothing-here", 10)).toEqual([]);
  });

  it("findCollectionsByMemberOrgs rolls up visible member orgs and lists which matched", async () => {
    const hits = await findCollectionsByMemberOrgs(tdb.db, ["zed", "acme", "stub", "gone"], 10);
    expect(hits).toEqual([
      {
        slug: "tools",
        name: "Tools",
        description: "Dev tooling",
        memberCount: 3,
        via: "member",
        matchedOrgSlugs: ["acme", "zed"],
      },
      {
        slug: "zed-only",
        name: "Zed only",
        description: null,
        memberCount: 1,
        via: "member",
        matchedOrgSlugs: ["zed"],
      },
    ]);
    expect(await findCollectionsByMemberOrgs(tdb.db, [], 10)).toEqual([]);
    expect(await findCollectionsByMemberOrgs(tdb.db, ["stub", "gone--org_gone"], 10)).toEqual([]);
    expect((await findCollectionsByMemberOrgs(tdb.db, ["zed"], 1)).length).toBe(1);
  });
});
