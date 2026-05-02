/**
 * Soft-delete behavior for organizations, sources, and products (#666).
 *
 * Verifies the partial unique indexes (deleted_at IS NULL) allow re-onboarding
 * under the same slug after tombstone, and that `*Where()` helpers default to
 * filtering tombstones.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { eq, isNull } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import { orgWhere, sourceWhere, productWhere } from "../../workers/api/src/utils.js";

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

async function expectThrows(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let threw: Error | null = null;
  try {
    await fn();
  } catch (e) {
    threw = e as Error;
  }
  expect(threw).not.toBeNull();
  expect(threw!.message).toMatch(pattern);
}

describe("partial unique index on slug", () => {
  it("allows re-inserting an org under a tombstoned slug", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_old",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await db
      .update(organizations)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(organizations.id, "org_old"));
    await db.insert(organizations).values({
      id: "org_new",
      name: "Acme Reborn",
      slug: "acme",
      discovery: "curated",
    });
    const active = await db.select().from(organizations).where(isNull(organizations.deletedAt));
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("org_new");
  });

  it("rejects two active orgs at the same slug", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_1",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    await expectThrows(
      () =>
        db.insert(organizations).values({
          id: "org_2",
          name: "Acme2",
          slug: "acme",
          discovery: "curated",
        }),
      /UNIQUE/,
    );
  });

  it("blocks reviving a tombstoned org when its slug is reclaimed", async () => {
    const db = tdb.db;
    const ts = new Date().toISOString();
    await db.insert(organizations).values({
      id: "org_old",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
      deletedAt: ts,
    });
    await db.insert(organizations).values({
      id: "org_new",
      name: "AcmeNew",
      slug: "acme",
      discovery: "curated",
    });
    // Trying to clear deleted_at on org_old must collide with org_new.
    await expectThrows(
      () =>
        db.update(organizations).set({ deletedAt: null }).where(eq(organizations.id, "org_old")),
      /UNIQUE/,
    );
  });

  it("partial unique indexes also cover sources and products", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_a",
      name: "A",
      slug: "a",
      discovery: "curated",
    });

    await db.insert(sources).values({
      id: "src_1",
      orgId: "org_a",
      name: "S1",
      slug: "s1",
      type: "github",
      url: "https://example.com/1",
    });
    await expectThrows(
      () =>
        db.insert(sources).values({
          id: "src_2",
          orgId: "org_a",
          name: "S2",
          slug: "s1",
          type: "github",
          url: "https://example.com/2",
        }),
      /UNIQUE/,
    );

    await db
      .update(sources)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(sources.id, "src_1"));
    // Now slug s1 is reclaimable.
    await db.insert(sources).values({
      id: "src_3",
      orgId: "org_a",
      name: "S3",
      slug: "s1",
      type: "github",
      url: "https://example.com/3",
    });

    await db.insert(products).values({ id: "prod_1", orgId: "org_a", name: "P", slug: "p" });
    await expectThrows(
      () => db.insert(products).values({ id: "prod_2", orgId: "org_a", name: "P2", slug: "p" }),
      /UNIQUE/,
    );
    await db
      .update(products)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(products.id, "prod_1"));
    await db.insert(products).values({ id: "prod_3", orgId: "org_a", name: "P3", slug: "p" });
  });
});

describe("orgWhere/sourceWhere/productWhere filter tombstones by default", () => {
  it("orgWhere skips tombstoned orgs by slug", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_t",
      name: "Tombstoned",
      slug: "ghost",
      discovery: "curated",
      deletedAt: new Date().toISOString(),
    });
    const result = await db.select().from(organizations).where(orgWhere("ghost"));
    expect(result).toHaveLength(0);

    const withDeleted = await db
      .select()
      .from(organizations)
      .where(orgWhere("ghost", { includeDeleted: true }));
    expect(withDeleted).toHaveLength(1);
  });

  it("sourceWhere skips tombstoned sources by id and slug", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_a",
      name: "A",
      slug: "a",
      discovery: "curated",
    });
    await db.insert(sources).values({
      id: "src_dead",
      orgId: "org_a",
      name: "Dead",
      slug: "dead",
      type: "github",
      url: "https://example.com/dead",
      deletedAt: new Date().toISOString(),
    });
    const byId = await db.select().from(sources).where(sourceWhere("src_dead"));
    expect(byId).toHaveLength(0);
    const bySlug = await db.select().from(sources).where(sourceWhere("dead"));
    expect(bySlug).toHaveLength(0);
    const includingDeleted = await db
      .select()
      .from(sources)
      .where(sourceWhere("src_dead", { includeDeleted: true }));
    expect(includingDeleted).toHaveLength(1);
  });

  it("productWhere skips tombstoned products", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_a",
      name: "A",
      slug: "a",
      discovery: "curated",
    });
    await db.insert(products).values({
      id: "prod_dead",
      orgId: "org_a",
      name: "P",
      slug: "p",
      deletedAt: new Date().toISOString(),
    });
    const result = await db.select().from(products).where(productWhere("p"));
    expect(result).toHaveLength(0);
  });
});
