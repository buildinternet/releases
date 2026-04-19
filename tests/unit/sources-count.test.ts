/**
 * Unit test for `countSourcesForList` — the count query that backs the
 * opt-in pagination envelope on GET /v1/sources.
 *
 * Uses the bun:sqlite test harness rather than a D1 mock because the SQL
 * is dialect-compatible and the helper accepts any drizzle-compatible db.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql, eq, and } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { organizations, sources } from "@releases/core-internal/schema";
import { countSourcesForList } from "../../workers/api/src/queries/sources.js";

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = createTestDb();
  const db = tdb.db;

  await db.insert(organizations).values([
    { id: "org_a", name: "Org A", slug: "org-a", category: "ai" },
    { id: "org_b", name: "Org B", slug: "org-b", category: "developer-tools" },
  ]);

  await db.insert(sources).values([
    {
      id: "src_1",
      orgId: "org_a",
      name: "A1",
      slug: "a1",
      type: "github",
      url: "https://a.example/1",
    },
    {
      id: "src_2",
      orgId: "org_a",
      name: "A2",
      slug: "a2",
      type: "feed",
      url: "https://a.example/2",
    },
    {
      id: "src_3",
      orgId: "org_a",
      name: "A3",
      slug: "a3",
      type: "scrape",
      url: "https://a.example/3",
      isHidden: true,
    },
    {
      id: "src_4",
      orgId: "org_b",
      name: "B1",
      slug: "b1",
      type: "github",
      url: "https://b.example/1",
    },
  ]);
});

afterAll(() => tdb.cleanup());

describe("countSourcesForList", () => {
  it("counts all sources when no whereClause is provided", async () => {
    const count = await countSourcesForList(tdb.db as never);
    expect(count).toBe(4);
  });

  it("applies whereClause — org filter", async () => {
    const count = await countSourcesForList(tdb.db as never, eq(sources.orgId, "org_a"));
    expect(count).toBe(3);
  });

  it("applies whereClause — compound filter (org + not hidden)", async () => {
    const where = and(
      eq(sources.orgId, "org_a"),
      sql`(${sources.isHidden} IS NULL OR ${sources.isHidden} = 0)`,
    );
    const count = await countSourcesForList(tdb.db as never, where);
    expect(count).toBe(2);
  });

  it("returns 0 when nothing matches", async () => {
    const count = await countSourcesForList(tdb.db as never, eq(sources.orgId, "org_missing"));
    expect(count).toBe(0);
  });

  it("applies whereClause — category filter via correlated subquery (mirrors route)", async () => {
    // The route uses an EXISTS subquery against organizations/products for
    // category filtering. Confirm the COUNT query handles it end-to-end.
    const where = sql`
      EXISTS (SELECT 1 FROM organizations o2 WHERE o2.id = ${sources.orgId} AND o2.category = 'ai')
    `;
    const count = await countSourcesForList(tdb.db as never, where);
    expect(count).toBe(3);
  });
});
