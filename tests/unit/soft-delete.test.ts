/**
 * Soft-delete behavior for organizations, sources, and products (#666).
 *
 * The route handlers tombstone via UPDATE deleted_at + slug rename so the
 * inline UNIQUE constraint on slug doesn't block a re-onboard under the
 * original slug. These tests verify the rename approach is sound: same-slug
 * collisions still rejected; tombstoned-then-renamed slugs free up; the
 * `*Where` helpers filter tombstones by default.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "bun:test";
import { eq, isNull } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import {
  orgWhere,
  sourceMatchByIdOrSlug,
  productMatchByIdOrSlug,
} from "../../workers/api/src/utils.js";

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

describe("tombstone-and-rename keeps slug uniqueness intact", () => {
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

  it("frees the original slug after rename-on-tombstone", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_old",
      name: "Acme",
      slug: "acme",
      discovery: "curated",
    });
    // Tombstone with slug rename — mirrors what the DELETE handler does.
    await db
      .update(organizations)
      .set({ deletedAt: new Date().toISOString(), slug: "acme--org_old" })
      .where(eq(organizations.id, "org_old"));
    // The original "acme" slug is now free.
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

  it("rename-on-tombstone applies cleanly to sources and products", async () => {
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
      .set({ deletedAt: new Date().toISOString(), slug: "s1--src_1" })
      .where(eq(sources.id, "src_1"));
    // Slug s1 is now reclaimable.
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
      .set({ deletedAt: new Date().toISOString(), slug: "p--prod_1" })
      .where(eq(products.id, "prod_1"));
    await db.insert(products).values({ id: "prod_3", orgId: "org_a", name: "P3", slug: "p" });
  });
});

describe("orgWhere/sourceMatchByIdOrSlug/productMatchByIdOrSlug filter tombstones by default", () => {
  it("orgWhere skips tombstoned orgs by their (post-rename) slug", async () => {
    const db = tdb.db;
    await db.insert(organizations).values({
      id: "org_t",
      name: "Tombstoned",
      slug: "ghost--org_t",
      discovery: "curated",
      deletedAt: new Date().toISOString(),
    });
    // Both the original "ghost" (free) and the mangled form should miss.
    expect(await db.select().from(organizations).where(orgWhere("ghost"))).toHaveLength(0);
    expect(await db.select().from(organizations).where(orgWhere("ghost--org_t"))).toHaveLength(0);

    const withDeleted = await db
      .select()
      .from(organizations)
      .where(orgWhere("ghost--org_t", { includeDeleted: true }));
    expect(withDeleted).toHaveLength(1);
  });

  it("sourceMatchByIdOrSlug skips tombstoned sources by id and post-rename slug", async () => {
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
      slug: "dead--src_dead",
      type: "github",
      url: "https://example.com/dead",
      deletedAt: new Date().toISOString(),
    });
    expect(await db.select().from(sources).where(sourceMatchByIdOrSlug("src_dead"))).toHaveLength(
      0,
    );
    expect(await db.select().from(sources).where(sourceMatchByIdOrSlug("dead"))).toHaveLength(0);
    expect(
      await db.select().from(sources).where(sourceMatchByIdOrSlug("dead--src_dead")),
    ).toHaveLength(0);
    const includingDeleted = await db
      .select()
      .from(sources)
      .where(sourceMatchByIdOrSlug("src_dead", { includeDeleted: true }));
    expect(includingDeleted).toHaveLength(1);
  });

  it("productMatchByIdOrSlug skips tombstoned products", async () => {
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
      slug: "p--prod_dead",
      deletedAt: new Date().toISOString(),
    });
    expect(await db.select().from(products).where(productMatchByIdOrSlug("p"))).toHaveLength(0);
    expect(
      await db.select().from(products).where(productMatchByIdOrSlug("p--prod_dead")),
    ).toHaveLength(0);
  });
});
