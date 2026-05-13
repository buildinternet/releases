/**
 * Tests for the month-only date inference applied at ingest time (#926).
 *
 * When the AI extractor returns `publishedAt: null` and the release title is
 * a bare month-year string (e.g. "March 2026"), the batch-insert path should
 * use `inferMonthOnlyDate` to derive the correct first-of-month ISO date
 * instead of leaving the column null.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { sourceRoutes } from "../../workers/api/src/routes/sources.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

let testDb: TestDatabase;

beforeEach(() => {
  testDb = createTestDb();
  clearAllTables(testDb.db);

  testDb.db.insert(organizations).values({ id: "org_b", name: "Upstash", slug: "upstash" }).run();

  testDb.db
    .insert(sources)
    .values({
      id: "src_upstash1",
      orgId: "org_b",
      slug: "upstash-redis-changelog",
      name: "Redis Changelog",
      url: "https://upstash.com/docs/redis/overall/changelog",
      type: "feed",
      metadata: "{}",
    })
    .run();
});

afterEach(() => {
  testDb.cleanup();
});

function makeEnv() {
  return { DB: testDb.db as unknown as D1Database };
}

function makeExecutionCtx() {
  const ctx = {
    waitUntil(_p: Promise<unknown>) {},
    passThroughOnException() {},
  } as never;
  return ctx;
}

async function postBatch(
  sourceId: string,
  releaseBodies: Array<{
    title: string;
    content: string;
    publishedAt?: string | null;
    url?: string;
  }>,
) {
  // Use the typed ID form -- bare slugs are rejected on the legacy bare path (#698).
  return sourceRoutes.request(
    `/sources/${sourceId}/releases/batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releases: releaseBodies }),
    },
    makeEnv(),
    makeExecutionCtx(),
  );
}

describe("batch ingest -- month-only title date inference", () => {
  it("infers the first-of-month date when publishedAt is null and title is a month-year", async () => {
    const res = await postBatch("src_upstash1", [
      { title: "March 2026", content: "Some content", publishedAt: null },
    ]);
    expect(res.status).toBe(200);

    const [row] = testDb.db
      .select({ publishedAt: releases.publishedAt })
      .from(releases)
      .where(eq(releases.title, "March 2026"))
      .all();

    expect(row?.publishedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("infers the correct date for December titles", async () => {
    const res = await postBatch("src_upstash1", [
      {
        title: "December 2025",
        content: "Year-end update",
        publishedAt: null,
        url: "https://upstash.com/docs/redis/overall/changelog#dec-2025",
      },
    ]);
    expect(res.status).toBe(200);

    const [row] = testDb.db
      .select({ publishedAt: releases.publishedAt })
      .from(releases)
      .where(eq(releases.title, "December 2025"))
      .all();

    expect(row?.publishedAt).toBe("2025-12-01T00:00:00.000Z");
  });

  it("does not overwrite an explicit publishedAt when provided", async () => {
    const res = await postBatch("src_upstash1", [
      {
        title: "March 2026",
        content: "Explicit date",
        publishedAt: "2026-03-15T12:00:00.000Z",
        url: "https://upstash.com/docs/redis/overall/changelog#mar-2026-explicit",
      },
    ]);
    expect(res.status).toBe(200);

    const [row] = testDb.db
      .select({ publishedAt: releases.publishedAt })
      .from(releases)
      .where(eq(releases.title, "March 2026"))
      .all();

    expect(row?.publishedAt).toBe("2026-03-15T12:00:00.000Z");
  });

  it("leaves publishedAt null for non-month-only titles", async () => {
    const res = await postBatch("src_upstash1", [
      {
        title: "v1.2.3 -- Bugfix release",
        content: "Fixed an issue",
        publishedAt: null,
        url: "https://upstash.com/docs/redis/overall/changelog#v1-2-3",
      },
    ]);
    expect(res.status).toBe(200);

    const [row] = testDb.db
      .select({ publishedAt: releases.publishedAt })
      .from(releases)
      .where(eq(releases.title, "v1.2.3 -- Bugfix release"))
      .all();

    expect(row?.publishedAt).toBeNull();
  });
});
