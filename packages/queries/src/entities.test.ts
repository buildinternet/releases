import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { clearAllTables, createTestDb, type TestDatabase } from "../../../tests/db-helper.js";
import {
  findProductById,
  findProductForOrgSlug,
  findSourceById,
  findSourceForOrgSlug,
  listProductsBySlug,
  listSourcesBySlug,
} from "./entities.js";

const DELETED_AT = "2026-01-01T00:00:00Z";

describe("entity resolution", () => {
  let tdb: TestDatabase;

  beforeAll(() => {
    tdb = createTestDb();
  });
  afterAll(() => tdb.cleanup());

  beforeEach(async () => {
    clearAllTables(tdb.db);
    await tdb.db.insert(organizations).values([
      { id: "org_acme", name: "Acme", slug: "acme" },
      { id: "org_globex", name: "Globex", slug: "globex" },
      { id: "org_gone", name: "Gone", slug: "gone", deletedAt: DELETED_AT },
    ]);
    await tdb.db.insert(products).values([
      { id: "prod_acme_app", name: "App", slug: "app", orgId: "org_acme" },
      { id: "prod_globex_app", name: "App", slug: "app", orgId: "org_globex" },
      {
        id: "prod_acme_old",
        name: "Old",
        slug: "old",
        orgId: "org_acme",
        deletedAt: DELETED_AT,
      },
    ]);
    await tdb.db.insert(sources).values([
      {
        id: "src_acme_blog",
        name: "Blog",
        slug: "blog",
        type: "feed",
        url: "https://acme.example.com/blog",
        orgId: "org_acme",
      },
      {
        id: "src_globex_blog",
        name: "Blog",
        slug: "blog",
        type: "feed",
        url: "https://globex.example.com/blog",
        orgId: "org_globex",
      },
      {
        id: "src_acme_dead",
        name: "Dead",
        slug: "dead",
        type: "scrape",
        url: "https://acme.example.com/dead",
        orgId: "org_acme",
        deletedAt: DELETED_AT,
      },
      {
        id: "src_gone_feed",
        name: "Feed",
        slug: "feed",
        type: "feed",
        url: "https://gone.example.com/feed",
        orgId: "org_gone",
      },
    ]);
  });

  describe("findSourceById", () => {
    it("returns the row for a live source", async () => {
      expect((await findSourceById(tdb.db, "src_acme_blog"))?.slug).toBe("blog");
    });

    it("hides soft-deleted sources unless includeDeleted", async () => {
      expect(await findSourceById(tdb.db, "src_acme_dead")).toBeNull();
      const row = await findSourceById(tdb.db, "src_acme_dead", { includeDeleted: true });
      expect(row?.id).toBe("src_acme_dead");
    });

    it("returns null for an unknown id", async () => {
      expect(await findSourceById(tdb.db, "src_missing")).toBeNull();
    });
  });

  describe("findProductById", () => {
    it("hides soft-deleted products unless includeDeleted", async () => {
      expect((await findProductById(tdb.db, "prod_acme_app"))?.orgId).toBe("org_acme");
      expect(await findProductById(tdb.db, "prod_acme_old")).toBeNull();
      expect((await findProductById(tdb.db, "prod_acme_old", { includeDeleted: true }))?.id).toBe(
        "prod_acme_old",
      );
    });
  });

  describe("findSourceForOrgSlug", () => {
    it("scopes a shared slug to the named org", async () => {
      expect((await findSourceForOrgSlug(tdb.db, "acme", "blog"))?.id).toBe("src_acme_blog");
      expect((await findSourceForOrgSlug(tdb.db, "globex", "blog"))?.id).toBe("src_globex_blog");
    });

    it("accepts typed ids in either segment", async () => {
      expect((await findSourceForOrgSlug(tdb.db, "org_acme", "blog"))?.id).toBe("src_acme_blog");
      expect((await findSourceForOrgSlug(tdb.db, "acme", "src_acme_blog"))?.id).toBe(
        "src_acme_blog",
      );
    });

    it("does not resolve a source id through the wrong org", async () => {
      expect(await findSourceForOrgSlug(tdb.db, "globex", "src_acme_blog")).toBeNull();
    });

    it("hides deleted sources and sources under deleted orgs unless includeDeleted", async () => {
      expect(await findSourceForOrgSlug(tdb.db, "acme", "dead")).toBeNull();
      expect(await findSourceForOrgSlug(tdb.db, "gone", "feed")).toBeNull();
      const opts = { includeDeleted: true };
      expect((await findSourceForOrgSlug(tdb.db, "acme", "dead", opts))?.id).toBe("src_acme_dead");
      expect((await findSourceForOrgSlug(tdb.db, "gone", "feed", opts))?.id).toBe("src_gone_feed");
    });
  });

  describe("findProductForOrgSlug", () => {
    it("scopes a shared slug to the named org", async () => {
      expect((await findProductForOrgSlug(tdb.db, "acme", "app"))?.id).toBe("prod_acme_app");
      expect((await findProductForOrgSlug(tdb.db, "globex", "app"))?.id).toBe("prod_globex_app");
    });

    it("hides deleted products unless includeDeleted", async () => {
      expect(await findProductForOrgSlug(tdb.db, "acme", "old")).toBeNull();
      expect(
        (await findProductForOrgSlug(tdb.db, "acme", "old", { includeDeleted: true }))?.id,
      ).toBe("prod_acme_old");
    });
  });

  describe("listSourcesBySlug / listProductsBySlug", () => {
    it("returns every live org's match for a shared slug", async () => {
      const src = await listSourcesBySlug(tdb.db, "blog");
      expect(src.map((m) => `${m.orgSlug}/${m.row.id}`).toSorted()).toEqual([
        "acme/src_acme_blog",
        "globex/src_globex_blog",
      ]);
      const prod = await listProductsBySlug(tdb.db, "app");
      expect(prod.map((m) => m.row.id).toSorted()).toEqual(["prod_acme_app", "prod_globex_app"]);
    });

    it("skips deleted rows and rows under a deleted org", async () => {
      expect(await listSourcesBySlug(tdb.db, "dead")).toEqual([]);
      expect(await listSourcesBySlug(tdb.db, "feed")).toEqual([]);
      expect(await listProductsBySlug(tdb.db, "old")).toEqual([]);
    });
  });
});
