/**
 * Read-path guards for migration 20261105000000:
 *
 * - `computeStats` reads the release window once (`recentReleasesBySourceSql`)
 *   and derives both `releasesInPeriod` and `sourceActivity.recentReleases`
 *   from it. The counts must match what the two separate queries used to
 *   return: hidden sources count toward the total but aren't listed, deleted
 *   sources count toward neither, and suppressed / coverage-side releases are
 *   excluded.
 * - The window query range-seeks the covering `idx_releases_published_source`.
 * - `listLatestReleases({ minImportance })` walks `idx_releases_scored_feed` in
 *   feed order instead of seeking every scored row and sorting.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import * as schema from "@buildinternet/releases-core/schema";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/core-internal/schema-coverage";
import { listLatestReleases } from "@releases/queries/releases";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { applyMigrations, createTestDb } from "../../../tests/db-helper.js";
import { computeStats, recentReleasesBySourceSql } from "../src/routes/stats.js";

const NOW = new Date().toISOString();
const RECENT = daysAgoIso(2);
const OLD = daysAgoIso(90);

type Db = ReturnType<typeof createTestDb>["db"];

async function seed(db: Db) {
  await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
  const src = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    orgId: "org_a",
    slug: id,
    name: id,
    type: "feed" as const,
    url: `https://${id}.test`,
    createdAt: NOW,
    ...extra,
  });
  await db
    .insert(sources)
    .values([
      src("src_busy"),
      src("src_quiet"),
      src("src_idle"),
      src("src_hidden", { isHidden: true }),
      src("src_deleted", { deletedAt: NOW }),
    ]);
  const rel = (
    id: string,
    sourceId: string,
    publishedAt: string | null,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    sourceId,
    title: id,
    content: "",
    url: `https://${sourceId}.test/${id}`,
    publishedAt,
    fetchedAt: NOW,
    ...extra,
  });
  await db.insert(releases).values([
    rel("b1", "src_busy", RECENT),
    rel("b2", "src_busy", RECENT),
    rel("b3", "src_busy", RECENT),
    rel("b_cov", "src_busy", RECENT), // coverage side of b1: not visible
    rel("b_sup", "src_busy", RECENT, { suppressed: true }),
    rel("b_old", "src_busy", OLD),
    rel("b_undated", "src_busy", null),
    rel("q1", "src_quiet", RECENT),
    rel("i_old", "src_idle", OLD),
    rel("h1", "src_hidden", RECENT),
    rel("h2", "src_hidden", RECENT),
    rel("d1", "src_deleted", RECENT),
  ]);
  await db
    .insert(releaseCoverage)
    .values({ coverageId: "b_cov", canonicalId: "b1", decidedBy: "test", decidedAt: NOW });
}

describe("computeStats window counts", () => {
  it("derives releasesInPeriod and per-source recent counts from one window read", async () => {
    const { db } = createTestDb();
    await seed(db);
    const stats = await computeStats(db as unknown as D1Database, 30);

    // busy 3 + quiet 1 + hidden 2; deleted, suppressed, coverage, old and undated excluded.
    expect(stats.totals.releasesInPeriod).toBe(6);

    // Visible sources only, most recent releases first.
    expect(
      stats.sourceActivity.map((s) => [s.sourceSlug, s.recentReleases, s.totalReleases]),
    ).toEqual([
      ["src_busy", 3, 5],
      ["src_quiet", 1, 1],
      ["src_idle", 0, 1],
    ]);
    expect(Object.keys(stats.sourceActivity[0]!)).toEqual([
      "sourceName",
      "sourceSlug",
      "sourceType",
      "orgName",
      "lastFetchedAt",
      "totalReleases",
      "recentReleases",
    ]);
  });

  it("range-seeks the covering published_at index", async () => {
    const { db } = createTestDb();
    const plan = (await db.all(
      sql`EXPLAIN QUERY PLAN ${recentReleasesBySourceSql(daysAgoIso(30))}`,
    )) as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail);
    expect(details).toContainEqual(
      expect.stringContaining(
        "USING COVERING INDEX idx_releases_published_source (published_at>?)",
      ),
    );
    expect(details.some((d) => d.startsWith("SCAN releases"))).toBe(false);
  });
});

describe("listLatestReleases minImportance", () => {
  function capturingDb() {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite);
    let last: { sql: string; params: unknown[] } | null = null;
    const db = drizzle(sqlite, {
      schema,
      logger: {
        logQuery(query, params) {
          last = { sql: query, params };
        },
      },
    });
    return { sqlite, db, lastQuery: () => last! };
  }

  it("walks the scored feed index in feed order and returns newest first", async () => {
    const { sqlite, db, lastQuery } = capturingDb();
    await db.insert(organizations).values({ id: "org_a", slug: "acme", name: "Acme" });
    await db.insert(sources).values({
      id: "src_a",
      orgId: "org_a",
      slug: "a",
      name: "a",
      type: "feed",
      url: "https://a.test",
      createdAt: NOW,
    });
    const rows = [
      { id: "r_hi_old", publishedAt: daysAgoIso(10), importance: 5 },
      { id: "r_lo_new", publishedAt: daysAgoIso(1), importance: 2 },
      { id: "r_hi_new", publishedAt: daysAgoIso(2), importance: 4 },
      { id: "r_unscored", publishedAt: daysAgoIso(1), importance: null },
      { id: "r_hi_undated", publishedAt: null, importance: 5 },
    ];
    await db.insert(releases).values(
      rows.map((r) => ({
        ...r,
        sourceId: "src_a",
        title: r.id,
        content: "",
        url: `https://a.test/${r.id}`,
        fetchedAt: NOW,
      })),
    );

    const result = await listLatestReleases(db as never, { minImportance: 4, limit: 20 });
    expect(result.map((r) => r.id)).toEqual(["r_hi_new", "r_hi_old", "r_hi_undated"]);

    const { sql: query, params } = lastQuery();
    const plan = sqlite.query(`EXPLAIN QUERY PLAN ${query}`).all(...(params as never[])) as Array<{
      detail: string;
    }>;
    expect(plan.map((r) => r.detail)).toContainEqual(
      expect.stringContaining("USING INDEX idx_releases_scored_feed"),
    );
  });
});
