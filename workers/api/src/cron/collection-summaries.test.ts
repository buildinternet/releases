import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../../tests/db-helper";
import {
  collections,
  collectionMembers,
  organizations,
  releases,
  sources,
} from "@buildinternet/releases-core/schema";
import {
  generateCollectionSummariesForDay,
  runCollectionSummaries,
  type CollectionSummariesEnv,
} from "./collection-summaries";
import {
  listCollectionDailySummaries,
  upsertCollectionDailySummary,
} from "../queries/collection-summaries";
import type { TextModel } from "@releases/ai-internal/text-model";

function fakeModel(onCall?: () => void): TextModel {
  return {
    id: "openrouter:test",
    async complete() {
      onCall?.();
      return {
        text: "<title>Day</title><summary>S</summary><takeaways><item>x</item></takeaways>",
        usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 },
      };
    },
  };
}

/**
 * Seed org + source + an in-window release (2026-06-11 ET) plus the `col_live`
 * collection with that org as a member, so `getCollectionDayReleases` returns a
 * release for the day and a model call fires.
 */
async function seedLiveCollection(db: ReturnType<typeof createTestDb>["db"]): Promise<void> {
  await db.insert(organizations).values({
    id: "org_live",
    slug: "org_live",
    name: "Org org_live",
  });
  await db.insert(sources).values({
    id: "src_live",
    slug: "src_live",
    name: "Source src_live",
    type: "scrape",
    url: "https://example.com/src_live",
    orgId: "org_live",
    productId: null,
  });
  // 15:00Z is mid-day ET (UTC-4/5), well inside the ET day 2026-06-11.
  await db.insert(releases).values({
    id: "rel_live",
    sourceId: "src_live",
    title: "Live release",
    content: "body",
    publishedAt: "2026-06-11T15:00:00.000Z",
  });
  await db.insert(collections).values({ id: "col_live", slug: "live", name: "Live" });
  await db.insert(collectionMembers).values({ collectionId: "col_live", orgId: "org_live" });
}

describe("generateCollectionSummariesForDay", () => {
  test("skips a collection with no releases that day (no row, no model call)", async () => {
    const { db } = createTestDb();
    await db.insert(collections).values({ id: "col_a", slug: "a", name: "A" });
    let called = false;
    await generateCollectionSummariesForDay(
      db,
      fakeModel(() => {
        called = true;
      }),
      "2026-06-11",
    );
    expect(called).toBe(false);
    const rows = await listCollectionDailySummaries(db, "col_a", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(0);
  });

  test("respects daily_summary_enabled = false", async () => {
    const { db } = createTestDb();
    await db
      .insert(collections)
      .values({ id: "col_off", slug: "off", name: "Off", dailySummaryEnabled: false });
    await generateCollectionSummariesForDay(db, fakeModel(), "2026-06-11");
    const rows = await listCollectionDailySummaries(db, "col_off", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(0);
  });

  test("writes a summary row for a collection that had releases that day", async () => {
    const { db } = createTestDb();
    await seedLiveCollection(db);

    const result = await generateCollectionSummariesForDay(db, fakeModel(), "2026-06-11");
    expect(result.generated).toBe(1);

    const rows = await listCollectionDailySummaries(db, "col_live", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Day");
    expect(rows[0].takeaways).toEqual(["x"]);
    expect(rows[0].releaseCount).toBe(1);
  });

  test("counts a collection as failed when the model throws, and writes no row", async () => {
    const { db } = createTestDb();
    await seedLiveCollection(db);

    const throwingModel: TextModel = {
      id: "bad",
      async complete() {
        throw new Error("bad output");
      },
    };
    const result = await generateCollectionSummariesForDay(db, throwingModel, "2026-06-11");
    expect(result.failed).toBe(1);
    expect(result.generated).toBe(0);

    const rows = await listCollectionDailySummaries(db, "col_live", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(0);
  });

  test("does not regenerate when a summary already exists for that day", async () => {
    const { db } = createTestDb();
    await db.insert(collections).values({ id: "col_dup", slug: "dup", name: "Dup" });

    // Insert an existing summary row so the cron should skip this collection
    await upsertCollectionDailySummary(db, {
      collectionId: "col_dup",
      summaryDate: "2026-06-11",
      title: "Pre-existing",
      summary: "Already done",
      takeaways: ["already"],
      releaseCount: 5,
      modelId: "openrouter:test",
    });

    let called = false;
    const result = await generateCollectionSummariesForDay(
      db,
      fakeModel(() => {
        called = true;
      }),
      "2026-06-11",
    );
    expect(called).toBe(false);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    // Row should remain as originally inserted (not clobbered)
    const rows = await listCollectionDailySummaries(db, "col_dup", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Pre-existing");
  });

  test("force regenerates an existing row in place", async () => {
    const { db } = createTestDb();
    await seedLiveCollection(db);
    await upsertCollectionDailySummary(db, {
      collectionId: "col_live",
      summaryDate: "2026-06-11",
      title: "Old",
      summary: "old",
      takeaways: ["old"],
      releaseCount: 99,
      modelId: "openrouter:test",
    });

    const result = await generateCollectionSummariesForDay(db, fakeModel(), "2026-06-11", {
      force: true,
    });
    expect(result.generated).toBe(1);

    const rows = await listCollectionDailySummaries(db, "col_live", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Day"); // replaced
    expect(rows[0].releaseCount).toBe(1);
  });
});

describe("runCollectionSummaries", () => {
  // scheduledTime is 2026-06-12 ET, so the i=1 catch-up day is 2026-06-11 —
  // the day seedLiveCollection puts a release on.
  const scheduledTime = new Date("2026-06-12T15:00:00.000Z");

  function env(db: ReturnType<typeof createTestDb>["db"], extra?: Partial<CollectionSummariesEnv>) {
    return {
      DB: undefined as unknown as D1Database,
      _drizzleOverride: db,
      _modelOverride: fakeModel(),
      ...extra,
    } satisfies CollectionSummariesEnv;
  }

  test("CRON_ENABLED=false short-circuits before any work", async () => {
    const { db } = createTestDb();
    await seedLiveCollection(db);
    await runCollectionSummaries(env(db, { CRON_ENABLED: "false" }), scheduledTime);
    const rows = await listCollectionDailySummaries(db, "col_live", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(0);
  });

  test("summarizes the just-closed ET day within the catch-up window", async () => {
    const { db } = createTestDb();
    await seedLiveCollection(db);
    await runCollectionSummaries(env(db, { COLLECTION_SUMMARY_CATCHUP_DAYS: "2" }), scheduledTime);
    const rows = await listCollectionDailySummaries(db, "col_live", "2026-06-11", "2026-06-11");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Day");
  });
});
