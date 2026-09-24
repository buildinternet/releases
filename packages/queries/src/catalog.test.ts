import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import {
  listCatalogProducts,
  listCatalogStandaloneSources,
  listProductSources,
  listVisibleSourceIdsForOrg,
  listVisibleSourceIdsForProduct,
} from "./catalog.js";
import { findLiveParents } from "./entities.js";

const DELETED_AT = "2026-01-01T00:00:00Z";

describe("catalog reads", () => {
  let tdb: TestDatabase;

  beforeAll(async () => {
    tdb = createTestDb();
    await tdb.db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme" },
      { id: "org_gone", name: "Gone", slug: "gone--org_gone", deletedAt: DELETED_AT },
    ]);
    await tdb.db.insert(products).values([
      { id: "prod_app", name: "App", slug: "app", orgId: "org_acme" },
      { id: "prod_old", name: "Old", slug: "old", orgId: "org_acme", deletedAt: DELETED_AT },
      { id: "prod_gone", name: "GoneApp", slug: "gone-app", orgId: "org_gone" },
    ]);
    const feed = (id: string, orgId: string, extra = {}) => ({
      id,
      orgId,
      name: id,
      slug: id,
      type: "feed" as const,
      url: `https://example.com/${id}`,
      ...extra,
    });
    await tdb.db
      .insert(sources)
      .values([
        feed("src_app", "org_acme", { productId: "prod_app" }),
        feed("src_app_hidden", "org_acme", { productId: "prod_app", isHidden: true }),
        feed("src_app_dead", "org_acme", { productId: "prod_app", deletedAt: DELETED_AT }),
        feed("src_solo", "org_acme"),
        feed("src_solo_dead", "org_acme", { deletedAt: DELETED_AT }),
        feed("src_orphaned", "org_acme", { productId: "prod_old" }),
        feed("src_gone", "org_gone"),
      ]);
  });
  afterAll(() => tdb.cleanup());

  it("listProductSources returns only visible sources", async () => {
    const rows = await listProductSources(tdb.db, "prod_app");
    expect(rows.map((r) => r.id)).toEqual(["src_app"]);
  });

  it("listCatalogProducts skips deleted products and deleted orgs", async () => {
    const rows = await listCatalogProducts(tdb.db);
    expect(rows.map((r) => r.slug)).toEqual(["app"]);
  });

  it("listCatalogStandaloneSources keeps sources of a deleted product, drops deleted ones", async () => {
    const rows = await listCatalogStandaloneSources(tdb.db, { orgId: "org_acme" });
    expect(rows.map((r) => r.slug)).toEqual(["src_orphaned", "src_solo"]);
    expect((await listCatalogStandaloneSources(tdb.db)).map((r) => r.slug)).not.toContain(
      "src_gone",
    );
  });

  it("listVisibleSourceIdsForProduct / ForOrg skip hidden and deleted sources", async () => {
    expect(await listVisibleSourceIdsForProduct(tdb.db, "prod_app")).toEqual(["src_app"]);
    expect((await listVisibleSourceIdsForOrg(tdb.db, "org_acme")).toSorted()).toEqual([
      "src_app",
      "src_orphaned",
      "src_solo",
    ]);
  });

  it("findLiveParents names live parents and nulls deleted ones", async () => {
    expect(await findLiveParents(tdb.db, { orgId: "org_acme", productId: "prod_app" })).toEqual({
      org: { id: "org_acme", slug: "acme", name: "Acme" },
      product: { id: "prod_app", slug: "app", name: "App" },
    });
    expect(await findLiveParents(tdb.db, { orgId: "org_gone", productId: "prod_old" })).toEqual({
      org: null,
      product: null,
    });
    expect(await findLiveParents(tdb.db, { orgId: null, productId: null })).toEqual({
      org: null,
      product: null,
    });
  });
});
