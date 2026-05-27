/**
 * Product-scoped org feed (#product-pages-default-unit). When opts.productId
 * is set, getOrgReleasesFeed returns only releases from sources under that
 * product — sources in sibling products and orphan (product-less) sources are
 * excluded. Absent the opt, the feed is unchanged.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, makeD1Shim } from "../../../tests/db-helper";
import { organizations, products, sources, releases } from "@buildinternet/releases-core/schema";
import { getOrgReleasesFeed } from "../src/queries/orgs.js";

const noCursor = { cursorWhere: "", cursorBindings: [] };

describe("getOrgReleasesFeed product filter", () => {
  let sqlite: Database;
  let db: ReturnType<typeof drizzle>;
  let d1: D1Database;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    applyMigrations(sqlite);
    d1 = makeD1Shim(sqlite);

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
        id: "rel_x",
        sourceId: "src_x",
        title: "X 1.0",
        content: "x",
        url: "https://acme.test/x/1",
        publishedAt: "2026-04-20T00:00:00Z",
      },
      {
        id: "rel_y",
        sourceId: "src_y",
        title: "Y 1.0",
        content: "y",
        url: "https://acme.test/y/1",
        publishedAt: "2026-04-21T00:00:00Z",
      },
      {
        id: "rel_orphan",
        sourceId: "src_orphan",
        title: "Blog post",
        content: "b",
        url: "https://acme.test/blog/1",
        publishedAt: "2026-04-22T00:00:00Z",
      },
    ]);
  });

  it("returns only the product's releases when productId is set", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50, { productId: "prod_x" });
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(["rel_x"]);
  });

  it("excludes sibling products and orphan sources", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50, { productId: "prod_x" });
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("rel_y");
    expect(ids).not.toContain("rel_orphan");
  });

  it("is unchanged (full org feed) when productId is absent", async () => {
    const rows = await getOrgReleasesFeed(d1, "org_a", noCursor, 50);
    expect(rows.map((r) => r.id).toSorted()).toEqual(["rel_orphan", "rel_x", "rel_y"]);
  });
});
