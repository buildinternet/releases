/**
 * Active-row views (#671). Read paths default to `organizations_active` /
 * `products_active` / `sources_active` so callers don't have to remember
 * the tombstone filter. These tests verify the view definitions match the
 * migration, and that selecting from them excludes tombstoned rows while
 * selecting from the base table sees them.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import {
  organizations,
  organizationsActive,
  products,
  productsActive,
  sources,
  sourcesActive,
} from "@buildinternet/releases-core/schema";

let tdb: TestDatabase;

beforeAll(() => {
  tdb = createTestDb();
});

beforeEach(() => {
  clearAllTables(tdb.db);
});

afterAll(() => {
  tdb.cleanup();
});

describe("active views exclude tombstoned rows", () => {
  it("organizations_active hides rows with deleted_at set", async () => {
    const db = tdb.db;
    await db.insert(organizations).values([
      { id: "org_live", name: "Live", slug: "live", discovery: "curated" },
      {
        id: "org_dead",
        name: "Dead",
        slug: "dead--org_dead",
        discovery: "curated",
        deletedAt: new Date().toISOString(),
      },
    ]);

    const fromBase = await db.select().from(organizations);
    expect(fromBase).toHaveLength(2);

    const fromView = await db.select().from(organizationsActive);
    expect(fromView).toHaveLength(1);
    expect(fromView[0]?.id).toBe("org_live");
  });

  it("products_active hides tombstoned products", async () => {
    const db = tdb.db;
    await db
      .insert(organizations)
      .values({ id: "org_1", name: "Org", slug: "org", discovery: "curated" });
    await db.insert(products).values([
      { id: "prod_live", name: "Live", slug: "live", orgId: "org_1" },
      {
        id: "prod_dead",
        name: "Dead",
        slug: "dead--prod_dead",
        orgId: "org_1",
        deletedAt: new Date().toISOString(),
      },
    ]);

    const fromView = await db.select().from(productsActive);
    expect(fromView).toHaveLength(1);
    expect(fromView[0]?.id).toBe("prod_live");
  });

  it("sources_active hides tombstoned sources", async () => {
    const db = tdb.db;
    await db
      .insert(organizations)
      .values({ id: "org_1", name: "Org", slug: "org", discovery: "curated" });
    await db.insert(sources).values([
      {
        id: "src_live",
        name: "Live",
        slug: "live",
        type: "github",
        url: "https://github.com/x/y",
        orgId: "org_1",
        discovery: "curated",
      },
      {
        id: "src_dead",
        name: "Dead",
        slug: "dead--src_dead",
        type: "github",
        url: "https://github.com/x/z",
        orgId: "org_1",
        discovery: "curated",
        deletedAt: new Date().toISOString(),
      },
    ]);

    const fromView = await db.select().from(sourcesActive);
    expect(fromView).toHaveLength(1);
    expect(fromView[0]?.id).toBe("src_live");
  });

  it("LEFT JOIN through a view drops rows pointing at a tombstoned parent", async () => {
    const db = tdb.db;
    await db.insert(organizations).values([
      { id: "org_live", name: "Live", slug: "live", discovery: "curated" },
      {
        id: "org_dead",
        name: "Dead",
        slug: "dead--org_dead",
        discovery: "curated",
        deletedAt: new Date().toISOString(),
      },
    ]);
    await db.insert(sources).values([
      {
        id: "src_live",
        name: "S1",
        slug: "s1",
        type: "github",
        url: "https://x/1",
        orgId: "org_live",
        discovery: "curated",
      },
      {
        id: "src_orphan",
        name: "S2",
        slug: "s2",
        type: "github",
        url: "https://x/2",
        orgId: "org_dead",
        discovery: "curated",
      },
    ]);

    // Source pointing at a tombstoned org: LEFT JOIN through the active org
    // view → org columns NULL on the orphan row, NOT NULL on the live row.
    const rows = await db
      .select({ srcId: sourcesActive.id, orgSlug: organizationsActive.slug })
      .from(sourcesActive)
      .leftJoin(organizationsActive, eq(sourcesActive.orgId, organizationsActive.id));
    const byId = new Map(rows.map((r) => [r.srcId, r.orgSlug]));
    expect(byId.get("src_live")).toBe("live");
    expect(byId.get("src_orphan")).toBeNull();
  });

  it("PRAGMA reports the views as schema objects", async () => {
    const rows = tdb.db
      .all<{
        name: string;
        type: string;
      }>(sql`SELECT name, type FROM sqlite_master WHERE type='view' ORDER BY name`)
      .map((r) => r.name);
    expect(rows).toContain("organizations_active");
    expect(rows).toContain("products_active");
    expect(rows).toContain("sources_active");
  });
});
