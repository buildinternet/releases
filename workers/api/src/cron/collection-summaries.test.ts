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
  collectionSummaryCatchupDates,
  collectionWeeklyDigestCatchupWeeks,
  generateCollectionSummariesForDay,
  generateCollectionWeeklyDigestsForWeek,
  generateWeeklyDigestForCollection,
  runCollectionSummaries,
  type CollectionSummariesEnv,
} from "./collection-summaries";
import {
  listCollectionDailySummaries,
  upsertCollectionDailySummary,
  getCollectionWeekReleases,
  hasCollectionWeeklyDigest,
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

describe("collectionSummaryCatchupDates", () => {
  test("returns the N days before todayEt", () => {
    expect(collectionSummaryCatchupDates("2026-06-15", 2)).toEqual(["2026-06-14", "2026-06-13"]);
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

// ── Weekly digests ────────────────────────────────────────────────

function fakeWeeklyModel(onCall?: () => void): TextModel {
  return {
    id: "openrouter:test",
    async complete() {
      onCall?.();
      return {
        text:
          "<title>Week</title><intro>I</intro>" +
          "<body>[Big release](rel:rel_wk_1) shipped, plus [two](rel:rel_wk_2) and [three](rel:rel_wk_3).</body>" +
          "<releases>rel_wk_1, rel_wk_2, rel_wk_3</releases>",
        usage: { input: 1, output: 1, cacheCreate: 0, cacheRead: 0 },
      };
    },
  };
}

/**
 * Seeds `col_week` with 3 substantive releases (long bodies) inside the ET
 * week 2026-06-08..2026-06-14 (Monday-starting), so the quality floor is met
 * and a digest generates.
 */
async function seedWeeklyCollection(db: ReturnType<typeof createTestDb>["db"]): Promise<void> {
  await db.insert(organizations).values({
    id: "org_wk",
    slug: "org_wk",
    name: "Org org_wk",
  });
  await db.insert(sources).values({
    id: "src_wk",
    slug: "src_wk",
    name: "Source src_wk",
    type: "scrape",
    url: "https://example.com/src_wk",
    orgId: "org_wk",
    productId: null,
  });
  const longBody = "x".repeat(250);
  await db.insert(releases).values([
    {
      id: "rel_wk_1",
      sourceId: "src_wk",
      title: "Big release",
      content: longBody,
      publishedAt: "2026-06-09T15:00:00.000Z",
      importance: 5,
    },
    {
      id: "rel_wk_2",
      sourceId: "src_wk",
      title: "Second release",
      content: longBody,
      publishedAt: "2026-06-10T15:00:00.000Z",
    },
    {
      id: "rel_wk_3",
      sourceId: "src_wk",
      title: "Third release",
      content: longBody,
      publishedAt: "2026-06-11T15:00:00.000Z",
    },
  ]);
  await db
    .insert(collections)
    .values({ id: "col_week", slug: "week", name: "Week", weeklyDigestEnabled: true });
  await db.insert(collectionMembers).values({ collectionId: "col_week", orgId: "org_wk" });
}

describe("collectionWeeklyDigestCatchupWeeks", () => {
  test("returns the just-closed week for a 1-week catch-up", () => {
    // 2026-06-15 is a Monday; the just-closed week starts 2026-06-08.
    expect(collectionWeeklyDigestCatchupWeeks("2026-06-15", 1)).toEqual(["2026-06-08"]);
  });
  test("returns N prior weeks for a wider catch-up", () => {
    expect(collectionWeeklyDigestCatchupWeeks("2026-06-15", 2)).toEqual([
      "2026-06-08",
      "2026-06-01",
    ]);
  });
});

describe("generateWeeklyDigestForCollection", () => {
  test("skips a week with fewer than 3 substantive releases (no row, no model call)", async () => {
    const { db } = createTestDb();
    await db
      .insert(collections)
      .values({ id: "col_thin", slug: "thin", name: "Thin", weeklyDigestEnabled: true });
    let called = false;
    const outcome = await generateWeeklyDigestForCollection(
      db,
      fakeWeeklyModel(() => {
        called = true;
      }),
      { id: "col_thin", name: "Thin" },
      "2026-06-08",
    );
    expect(outcome).toBe("skipped");
    expect(called).toBe(false);
  });

  test("writes a digest row for a week with >= 3 substantive releases", async () => {
    const { db } = createTestDb();
    await seedWeeklyCollection(db);
    const outcome = await generateWeeklyDigestForCollection(
      db,
      fakeWeeklyModel(),
      { id: "col_week", name: "Week" },
      "2026-06-08",
    );
    expect(outcome).toBe("generated");
  });

  test("resolves the release placeholder to a real path via the provided release set", async () => {
    const { db } = createTestDb();
    await seedWeeklyCollection(db);
    const members = { orgIds: ["org_wk"], productIds: [] };
    const releasesInWeek = await getCollectionWeekReleases(db, members, {
      startUtc: "2026-06-08T04:00:00.000Z",
      endUtc: "2026-06-15T04:00:00.000Z",
    });
    expect(releasesInWeek).toHaveLength(3);
    expect(releasesInWeek.find((r) => r.id === "rel_wk_1")?.importance).toBe(5);
  });

  test("force regenerates an existing row in place", async () => {
    const { db } = createTestDb();
    await seedWeeklyCollection(db);
    await generateWeeklyDigestForCollection(
      db,
      fakeWeeklyModel(),
      { id: "col_week", name: "Week" },
      "2026-06-08",
    );
    let called = false;
    const outcome = await generateWeeklyDigestForCollection(
      db,
      fakeWeeklyModel(() => {
        called = true;
      }),
      { id: "col_week", name: "Week" },
      "2026-06-08",
      { force: true },
    );
    expect(outcome).toBe("generated");
    expect(called).toBe(true);
  });

  test("does not regenerate when a digest already exists for that week", async () => {
    const { db } = createTestDb();
    await seedWeeklyCollection(db);
    await generateWeeklyDigestForCollection(
      db,
      fakeWeeklyModel(),
      { id: "col_week", name: "Week" },
      "2026-06-08",
    );
    let called = false;
    const outcome = await generateWeeklyDigestForCollection(
      db,
      fakeWeeklyModel(() => {
        called = true;
      }),
      { id: "col_week", name: "Week" },
      "2026-06-08",
    );
    expect(outcome).toBe("skipped");
    expect(called).toBe(false);
  });
});

describe("generateCollectionWeeklyDigestsForWeek", () => {
  test("respects weekly_digest_enabled = false", async () => {
    const { db } = createTestDb();
    await db
      .insert(collections)
      .values({ id: "col_off", slug: "off", name: "Off", weeklyDigestEnabled: false });
    const result = await generateCollectionWeeklyDigestsForWeek(
      db,
      fakeWeeklyModel(),
      "2026-06-08",
    );
    expect(result).toEqual({ generated: 0, skipped: 0, failed: 0 });
  });

  test("generates for every enabled collection in scope", async () => {
    const { db } = createTestDb();
    await seedWeeklyCollection(db);
    const result = await generateCollectionWeeklyDigestsForWeek(
      db,
      fakeWeeklyModel(),
      "2026-06-08",
    );
    expect(result.generated).toBe(1);
  });
});

describe("runCollectionSummaries — weekly digest hook", () => {
  function env(db: ReturnType<typeof createTestDb>["db"], extra?: Partial<CollectionSummariesEnv>) {
    return {
      DB: undefined as unknown as D1Database,
      _drizzleOverride: db,
      _modelOverride: fakeModel(),
      _weeklyDigestModelOverride: fakeWeeklyModel(),
      ...extra,
    } satisfies CollectionSummariesEnv;
  }

  test("generates the weekly digest when the cron tick lands on an ET Monday", async () => {
    const { db } = createTestDb();
    await seedWeeklyCollection(db);
    // 2026-06-15T15:00:00Z is 2026-06-15 11:00 EDT — Monday ET.
    await runCollectionSummaries(env(db), new Date("2026-06-15T15:00:00.000Z"));
    expect(await hasCollectionWeeklyDigest(db, "col_week", "2026-06-08")).toBe(true);
  });

  test("does not attempt a weekly digest on a non-Monday tick", async () => {
    const { db } = createTestDb();
    await seedWeeklyCollection(db);
    let called = false;
    await runCollectionSummaries(
      env(db, {
        _weeklyDigestModelOverride: fakeWeeklyModel(() => {
          called = true;
        }),
      }),
      new Date("2026-06-12T15:00:00.000Z"), // Friday ET
    );
    expect(called).toBe(false);
  });
});
