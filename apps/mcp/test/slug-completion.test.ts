/**
 * Prompt/resource slug completion suggests only what the directory and
 * catalog list: no soft-deleted orgs, products, or sources, and no hidden
 * orgs or hidden sources.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { createTestDb, type TestDatabase } from "../../../tests/db-helper";
import type { D1Db } from "../src/db";
import {
  completeCatalogSlug,
  completeOrgSlug,
  completeProductSlug,
  completeSourceSlug,
} from "../src/slug-completion";

const DELETED_AT = "2026-01-01T00:00:00Z";

let tdb: TestDatabase;
let db: D1Db;

function feed(id: string, orgId: string, slug: string, extra = {}) {
  return {
    id,
    orgId,
    slug,
    name: slug,
    type: "feed" as const,
    url: `https://example.com/${id}`,
    ...extra,
  };
}

beforeAll(async () => {
  tdb = createTestDb();
  db = tdb.db as unknown as D1Db;
  await tdb.db.insert(organizations).values([
    { id: "org_acme", name: "Acme", slug: "acme" },
    { id: "org_acme_hidden", name: "Acme Hidden", slug: "acme-hidden", isHidden: true },
    {
      id: "org_acme_gone",
      name: "Acme Gone",
      slug: "acme-gone--org_acme_gone",
      deletedAt: DELETED_AT,
    },
  ]);
  await tdb.db.insert(products).values([
    { id: "prod_app", name: "App", slug: "app", orgId: "org_acme" },
    {
      id: "prod_app_old",
      name: "App Old",
      slug: "app-old",
      orgId: "org_acme",
      deletedAt: DELETED_AT,
    },
    { id: "prod_app_h", name: "App H", slug: "app-h", orgId: "org_acme_hidden" },
  ]);
  await tdb.db
    .insert(sources)
    .values([
      feed("src_blog", "org_acme", "blog"),
      feed("src_blog_hidden", "org_acme", "blog-hidden", { isHidden: true }),
      feed("src_blog_dead", "org_acme", "blog-dead", { deletedAt: DELETED_AT }),
      feed("src_blog_h", "org_acme_hidden", "blog-h"),
    ]);
});

afterAll(() => tdb.cleanup());

describe("slug completion", () => {
  it("orgs: skips hidden and soft-deleted orgs", async () => {
    expect(await completeOrgSlug(db, "acme")).toEqual(["acme"]);
  });

  it("products: skips soft-deleted products and products under hidden orgs", async () => {
    expect(await completeProductSlug(db, "app")).toEqual(["acme/app"]);
    expect(await completeProductSlug(db, "acme/")).toEqual(["acme/app"]);
    expect(await completeProductSlug(db, "acme-hidden/")).toEqual([]);
  });

  it("sources: skips hidden, soft-deleted, and hidden-org sources", async () => {
    expect(await completeSourceSlug(db, "blog")).toEqual(["acme/blog"]);
    expect(await completeSourceSlug(db, "acme/blog")).toEqual(["acme/blog"]);
  });

  it("catalog: merges the filtered product and source lists", async () => {
    expect(await completeCatalogSlug(db, "acme/")).toEqual(["acme/app", "acme/blog"]);
  });
});
