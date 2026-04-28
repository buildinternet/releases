import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../db-helper";
import { searchQueries } from "@buildinternet/releases-core/schema";
import {
  DEFAULT_MIN_VOLUME,
  DEFAULT_THRESHOLD_PCT,
  evaluateNoResultsAlert,
  formatNoResultsAlertBody,
  getNoResultsStats,
  parseThresholds,
} from "../../workers/api/src/lib/search-no-results";

function mkDb() {
  const sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  return drizzle(sqlite);
}

const NOW = Date.now();

type SeedRow = {
  id: string;
  timestamp?: number;
  query: string;
  orgHits?: number | null;
  catalogHits?: number | null;
  releaseHits?: number | null;
  chunkHits?: number | null;
  userAgent?: string | null;
};

async function seed(db: ReturnType<typeof mkDb>, rows: SeedRow[]) {
  await db.insert(searchQueries).values(
    rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp ?? NOW - 1_000,
      query: r.query,
      surface: "web" as const,
      clientKind: "external",
      userAgent: r.userAgent !== undefined ? r.userAgent : "TestClient/1.0",
      orgHits: r.orgHits ?? null,
      catalogHits: r.catalogHits ?? null,
      releaseHits: r.releaseHits ?? null,
      chunkHits: r.chunkHits ?? null,
    })),
  );
}

describe("getNoResultsStats", () => {
  it("returns total=0 when no rows exist", async () => {
    const db = mkDb();
    const stats = await getNoResultsStats(db, { since: NOW - 86_400_000 });
    expect(stats.total).toBe(0);
    expect(stats.zeroHits).toBe(0);
    expect(stats.topQueries).toEqual([]);
  });

  it("counts zero-hit rows and groups them by query text", async () => {
    const db = mkDb();
    await seed(db, [
      // zero-hit (sum = 0)
      { id: "1", query: "obscure-tool", orgHits: 0, releaseHits: 0 },
      { id: "2", query: "obscure-tool", orgHits: 0, releaseHits: 0 },
      { id: "3", query: "another-miss", orgHits: 0, catalogHits: 0 },
      // hit
      { id: "4", query: "next.js", orgHits: 1, releaseHits: 5 },
    ]);
    const stats = await getNoResultsStats(db, { since: NOW - 86_400_000 });
    expect(stats.total).toBe(4);
    expect(stats.zeroHits).toBe(3);
    expect(stats.topQueries).toEqual([
      { query: "obscure-tool", count: 2, lastSeen: expect.any(Number) },
      { query: "another-miss", count: 1, lastSeen: expect.any(Number) },
    ]);
  });

  it("excludes rows with all-null hit columns from total and zeroHits", async () => {
    const db = mkDb();
    await seed(db, [
      // unscored row — should be invisible to the alert
      { id: "1", query: "logged-but-not-scored" },
      { id: "2", query: "miss", orgHits: 0, releaseHits: 0 },
      { id: "3", query: "hit", orgHits: 3 },
    ]);
    const stats = await getNoResultsStats(db, { since: NOW - 86_400_000 });
    expect(stats.total).toBe(2);
    expect(stats.zeroHits).toBe(1);
  });

  it("treats partial-null hit columns as zero (coalesce)", async () => {
    const db = mkDb();
    await seed(db, [
      // orgHits=null, releaseHits=0 — sum is 0 → counts as zero-hit
      { id: "1", query: "partial-null", releaseHits: 0 },
      // releaseHits=null, orgHits=2 — sum is 2 → hit
      { id: "2", query: "partial-hit", orgHits: 2 },
    ]);
    const stats = await getNoResultsStats(db, { since: NOW - 86_400_000 });
    expect(stats.total).toBe(2);
    expect(stats.zeroHits).toBe(1);
    expect(stats.topQueries.map((r) => r.query)).toEqual(["partial-null"]);
  });

  it("excludes bot rows by default", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "1", query: "spam", orgHits: 0, userAgent: "Googlebot/2.1" },
      { id: "2", query: "real-miss", orgHits: 0 },
    ]);
    const stats = await getNoResultsStats(db, { since: NOW - 86_400_000 });
    expect(stats.total).toBe(1);
    expect(stats.zeroHits).toBe(1);
    expect(stats.topQueries.map((r) => r.query)).toEqual(["real-miss"]);
  });

  it("includes bot rows when excludeBots: false", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "1", query: "spam", orgHits: 0, userAgent: "Googlebot/2.1" },
      { id: "2", query: "real", orgHits: 0 },
    ]);
    const stats = await getNoResultsStats(db, {
      since: NOW - 86_400_000,
      excludeBots: false,
    });
    expect(stats.total).toBe(2);
    expect(stats.zeroHits).toBe(2);
  });

  it("respects topLimit", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "a", query: "q1", orgHits: 0 },
      { id: "b", query: "q2", orgHits: 0 },
      { id: "c", query: "q3", orgHits: 0 },
    ]);
    const stats = await getNoResultsStats(db, { since: NOW - 86_400_000, topLimit: 2 });
    expect(stats.topQueries.length).toBe(2);
  });

  it("excludes rows older than `since`", async () => {
    const db = mkDb();
    await seed(db, [
      { id: "old", query: "ancient", orgHits: 0, timestamp: NOW - 7 * 86_400_000 },
      { id: "new", query: "recent", orgHits: 0, timestamp: NOW - 1_000 },
    ]);
    const stats = await getNoResultsStats(db, { since: NOW - 86_400_000 });
    expect(stats.total).toBe(1);
    expect(stats.topQueries.map((r) => r.query)).toEqual(["recent"]);
  });
});

describe("evaluateNoResultsAlert", () => {
  it("does not fire below minVolume", () => {
    const decision = evaluateNoResultsAlert(
      { total: 10, zeroHits: 9, topQueries: [] },
      { thresholdPct: 20, minVolume: 50 },
    );
    expect(decision.fire).toBe(false);
    if (!decision.fire) expect(decision.reason).toContain("volume 10 < min 50");
  });

  it("does not fire when ratio is at or below threshold", () => {
    // Exactly 20% — boundary is exclusive (`>` not `>=`) per the issue spec.
    const decision = evaluateNoResultsAlert(
      { total: 100, zeroHits: 20, topQueries: [] },
      { thresholdPct: 20, minVolume: 50 },
    );
    expect(decision.fire).toBe(false);
    if (!decision.fire) expect(decision.reason).toContain("<=");
  });

  it("fires when both thresholds are crossed", () => {
    const decision = evaluateNoResultsAlert(
      { total: 100, zeroHits: 25, topQueries: [] },
      { thresholdPct: 20, minVolume: 50 },
    );
    expect(decision.fire).toBe(true);
    if (decision.fire) expect(decision.ratio).toBeCloseTo(0.25, 5);
  });

  it("does not fire when total is zero (avoids divide-by-zero false positive)", () => {
    const decision = evaluateNoResultsAlert(
      { total: 0, zeroHits: 0, topQueries: [] },
      { thresholdPct: 20, minVolume: 1 },
    );
    expect(decision.fire).toBe(false);
  });
});

describe("formatNoResultsAlertBody", () => {
  it("includes counts, ratio, and top queries", () => {
    const body = formatNoResultsAlertBody(
      {
        total: 200,
        zeroHits: 60,
        topQueries: [
          { query: "obscure-thing", count: 12, lastSeen: NOW },
          { query: "another", count: 8, lastSeen: NOW },
        ],
      },
      { fire: true, ratio: 0.3 },
      { thresholdPct: 20, minVolume: 50 },
    );
    expect(body).toContain("Total scored queries: 200");
    expect(body).toContain("Zero-hit queries: 60 (30.0%)");
    expect(body).toContain("Threshold: 20% over 50+ queries");
    expect(body).toContain("obscure-thing");
    expect(body).toContain("another");
  });

  it("renders `(none)` when there are no top queries", () => {
    const body = formatNoResultsAlertBody(
      { total: 100, zeroHits: 30, topQueries: [] },
      { fire: true, ratio: 0.3 },
      { thresholdPct: 20, minVolume: 50 },
    );
    expect(body).toContain("(none)");
  });
});

describe("parseThresholds", () => {
  it("returns defaults when env is empty", () => {
    const t = parseThresholds({});
    expect(t.thresholdPct).toBe(DEFAULT_THRESHOLD_PCT);
    expect(t.minVolume).toBe(DEFAULT_MIN_VOLUME);
  });

  it("parses valid env values", () => {
    const t = parseThresholds({
      SEARCH_NO_RESULTS_THRESHOLD_PCT: "35",
      SEARCH_NO_RESULTS_MIN_VOLUME: "100",
    });
    expect(t.thresholdPct).toBe(35);
    expect(t.minVolume).toBe(100);
  });

  it("falls back on out-of-range or non-numeric values", () => {
    const t = parseThresholds({
      SEARCH_NO_RESULTS_THRESHOLD_PCT: "200", // > 100 → fallback
      SEARCH_NO_RESULTS_MIN_VOLUME: "not-a-number",
    });
    expect(t.thresholdPct).toBe(DEFAULT_THRESHOLD_PCT);
    expect(t.minVolume).toBe(DEFAULT_MIN_VOLUME);
  });
});
