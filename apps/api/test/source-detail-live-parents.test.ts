/**
 * GET /v1/sources/:id names only live parents: a soft-deleted org or product
 * comes back null instead of by its tombstoned slug (shared with MCP source
 * detail via `findLiveParents`).
 */
import { describe, it, expect } from "bun:test";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { sourceRoutes } from "../src/routes/sources.js";
import { createTestDb, createTestApp } from "./setup";

const DELETED_AT = "2026-01-01T00:00:00Z";

describe("GET /v1/sources/:id — parent attribution", () => {
  it("nulls a soft-deleted product and org, keeps live ones", async () => {
    const db = createTestDb();
    await db.insert(organizations).values([
      { id: "org_live", slug: "live", name: "Live" },
      { id: "org_gone", slug: "gone--org_gone", name: "Gone", deletedAt: DELETED_AT },
    ]);
    await db.insert(products).values([
      { id: "prod_live", slug: "app", name: "App", orgId: "org_live" },
      { id: "prod_old", slug: "old", name: "Old", orgId: "org_live", deletedAt: DELETED_AT },
    ]);
    const src = (id: string, orgId: string, productId: string | null) => ({
      id,
      orgId,
      productId,
      slug: id.replace("src_", ""),
      name: id,
      type: "feed" as const,
      url: `https://example.com/${id}`,
    });
    await db
      .insert(sources)
      .values([
        src("src_ok", "org_live", "prod_live"),
        src("src_old_product", "org_live", "prod_old"),
        src("src_gone_org", "org_gone", null),
      ]);
    const fetch = createTestApp(db, [sourceRoutes], { env: {} });

    const read = async (id: string) =>
      (await (await fetch(new Request(`https://x.test/v1/sources/${id}`))).json()) as {
        org: { slug: string } | null;
        productSlug: string | null;
      };

    const ok = await read("src_ok");
    expect(ok.org?.slug).toBe("live");
    expect(ok.productSlug).toBe("app");

    expect((await read("src_old_product")).productSlug).toBeNull();
    expect((await read("src_gone_org")).org).toBeNull();
  });
});
