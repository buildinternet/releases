import { describe, expect, test } from "bun:test";
import { createTestDb } from "../../../../tests/db-helper";
import { collectionDailySummaries } from "@buildinternet/releases-core/schema";

describe("collection_daily_summaries schema", () => {
  test("table is queryable through the test DB", async () => {
    const { db } = createTestDb();
    const rows = await db.select().from(collectionDailySummaries);
    expect(rows).toEqual([]);
  });
});
