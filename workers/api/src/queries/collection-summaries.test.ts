import { describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../../../tests/db-helper";
import {
  collectionDailySummaries,
  collections,
  collectionMembers,
  organizations,
  products,
  releases,
  sources,
} from "@buildinternet/releases-core/schema";
import {
  upsertCollectionDailySummary,
  listCollectionDailySummaries,
  getCollectionMembers,
  getCollectionDayReleases,
} from "./collection-summaries";

describe("collection_daily_summaries schema", () => {
  test("table is queryable through the test DB", async () => {
    const { db } = createTestDb();
    const rows = await db.select().from(collectionDailySummaries);
    expect(rows).toEqual([]);
  });
});

describe("collection daily-summary DAO", () => {
  test("upsert inserts then replaces on the same (collection, date)", async () => {
    const { db } = createTestDb();
    const colId = "col_test1";
    await db.insert(collections).values({ id: colId, slug: "c1", name: "C1" });

    await upsertCollectionDailySummary(db, {
      collectionId: colId,
      summaryDate: "2026-06-11",
      title: "First",
      summary: "s1",
      takeaways: ["a"],
      releaseCount: 2,
      modelId: "openrouter:test",
    });
    await upsertCollectionDailySummary(db, {
      collectionId: colId,
      summaryDate: "2026-06-11",
      title: "Second",
      summary: "s2",
      takeaways: ["b", "c"],
      releaseCount: 3,
      modelId: "openrouter:test",
    });

    const rows = await listCollectionDailySummaries(db, colId, "2026-06-01", "2026-06-30");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Second");
    expect(rows[0].takeaways).toEqual(["b", "c"]);
    expect(rows[0].releaseCount).toBe(3);
  });

  test("listCollectionDailySummaries returns rows in the inclusive range, newest first", async () => {
    const { db } = createTestDb();
    const colId = "col_test2";
    await db.insert(collections).values({ id: colId, slug: "c2", name: "C2" });
    await Promise.all(
      ["2026-06-09", "2026-06-10", "2026-06-11"].map((d) =>
        upsertCollectionDailySummary(db, {
          collectionId: colId,
          summaryDate: d,
          title: `t${d}`,
          summary: "s",
          takeaways: [],
          releaseCount: 1,
          modelId: null,
        }),
      ),
    );
    const rows = await listCollectionDailySummaries(db, colId, "2026-06-10", "2026-06-11");
    expect(rows.map((r) => r.date)).toEqual(["2026-06-11", "2026-06-10"]);
  });
});

/** Seed an org + one source under it; returns the ids. */
async function seedOrgSource(
  db: TestDb,
  ids: { orgId: string; sourceId: string; productId?: string },
): Promise<void> {
  await db.insert(organizations).values({
    id: ids.orgId,
    slug: ids.orgId,
    name: `Org ${ids.orgId}`,
  });
  if (ids.productId) {
    await db.insert(products).values({
      id: ids.productId,
      slug: ids.productId,
      name: `Product ${ids.productId}`,
      orgId: ids.orgId,
    });
  }
  await db.insert(sources).values({
    id: ids.sourceId,
    slug: ids.sourceId,
    name: `Source ${ids.sourceId}`,
    type: "scrape",
    url: `https://example.com/${ids.sourceId}`,
    orgId: ids.orgId,
    productId: ids.productId ?? null,
  });
}

describe("getCollectionMembers", () => {
  test("returns visible org and product member ids", async () => {
    const { db } = createTestDb();
    await seedOrgSource(db, { orgId: "org_m", sourceId: "src_m" });
    await seedOrgSource(db, { orgId: "org_p", sourceId: "src_p", productId: "prod_p" });

    const colId = "col_members";
    await db.insert(collections).values({ id: colId, slug: "cm", name: "CM" });
    await db.insert(collectionMembers).values([
      { collectionId: colId, orgId: "org_m" },
      { collectionId: colId, productId: "prod_p" },
    ]);

    const members = await getCollectionMembers(db, colId);
    expect(members.orgIds).toEqual(["org_m"]);
    expect(members.productIds).toEqual(["prod_p"]);
  });
});

describe("getCollectionDayReleases", () => {
  const window = { startUtc: "2026-06-11T00:00:00.000Z", endUtc: "2026-06-12T00:00:00.000Z" };

  test("returns in-window releases for an org member and excludes out-of-window ones", async () => {
    const { db } = createTestDb();
    await seedOrgSource(db, { orgId: "org_w", sourceId: "src_w" });
    await db.insert(releases).values([
      {
        id: "rel_in",
        sourceId: "src_w",
        title: "In window",
        content: "body",
        publishedAt: "2026-06-11T10:00:00.000Z",
      },
      {
        id: "rel_out",
        sourceId: "src_w",
        title: "Out of window",
        content: "body",
        publishedAt: "2026-06-12T10:00:00.000Z",
      },
    ]);

    const rows = await getCollectionDayReleases(db, { orgIds: ["org_w"], productIds: [] }, window);
    expect(rows.map((r) => r.title)).toEqual(["In window"]);
    expect(rows[0].org).toBe("Org org_w");
  });

  test("resolves product members through sources.productId", async () => {
    const { db } = createTestDb();
    await seedOrgSource(db, { orgId: "org_pw", sourceId: "src_pw", productId: "prod_pw" });
    await db.insert(releases).values({
      id: "rel_pw",
      sourceId: "src_pw",
      title: "Product release",
      content: "body",
      publishedAt: "2026-06-11T12:00:00.000Z",
    });

    const rows = await getCollectionDayReleases(
      db,
      { orgIds: [], productIds: ["prod_pw"] },
      window,
    );
    expect(rows.map((r) => r.title)).toEqual(["Product release"]);
    expect(rows[0].product).toBe("Product prod_pw");
  });

  test("excludes suppressed releases (matches feed visibility)", async () => {
    const { db } = createTestDb();
    await seedOrgSource(db, { orgId: "org_s", sourceId: "src_s" });
    await db.insert(releases).values([
      {
        id: "rel_visible",
        sourceId: "src_s",
        title: "Visible",
        content: "body",
        publishedAt: "2026-06-11T08:00:00.000Z",
      },
      {
        id: "rel_suppressed",
        sourceId: "src_s",
        title: "Suppressed",
        content: "body",
        publishedAt: "2026-06-11T09:00:00.000Z",
        suppressed: true,
      },
    ]);

    const rows = await getCollectionDayReleases(db, { orgIds: ["org_s"], productIds: [] }, window);
    expect(rows.map((r) => r.title)).toEqual(["Visible"]);
  });
});
