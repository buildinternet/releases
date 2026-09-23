/**
 * Tests for the first-party source staleness scan (#1528): flag established-
 * cadence sources we still poll but that have quietly stopped producing.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

const { scanStaleSources } = await import("../src/cron/source-staleness.js");

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" }).run();
});

function seedSource(opts: {
  id: string;
  medianGapDays?: number | null;
  fetchPriority?: "normal" | "low" | "paused";
  lastPolledAt?: string | null;
  lastFetchedAt?: string | null;
  createdAt?: string;
  firecrawl?: boolean;
  deletedAt?: string;
}) {
  db.insert(sources)
    .values({
      id: opts.id,
      orgId: "org_1",
      name: opts.id,
      slug: opts.id,
      type: "scrape",
      url: `https://example.com/${opts.id}`,
      metadata: opts.firecrawl ? JSON.stringify({ firecrawl: { enabled: true } }) : "{}",
      medianGapDays: opts.medianGapDays === undefined ? 7 : opts.medianGapDays,
      fetchPriority: opts.fetchPriority ?? "normal",
      // Default: actively polled an hour ago.
      lastPolledAt: opts.lastPolledAt === undefined ? iso(1 * DAY) : opts.lastPolledAt,
      lastFetchedAt: opts.lastFetchedAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
    })
    .run();
}

function seedRelease(sourceId: string, publishedMsAgo: number, suppressed = false) {
  db.insert(releases)
    .values({
      id: `rel_${sourceId}_${publishedMsAgo}`,
      sourceId,
      title: "x",
      content: "x",
      url: `https://example.com/${sourceId}/${publishedMsAgo}`,
      publishedAt: iso(publishedMsAgo),
      suppressed,
    })
    .run();
}

const baseEnv = () => ({ DB: {} as never, _drizzleOverride: db });

describe("scanStaleSources", () => {
  it("flags an established source whose newest release is past its window", async () => {
    // median 7d × 3 = 21d window. Newest release 40d ago → stale.
    seedSource({ id: "stale", medianGapDays: 7 });
    seedRelease("stale", 40 * DAY);
    // Newest release 5d ago → fresh.
    seedSource({ id: "fresh", medianGapDays: 7 });
    seedRelease("fresh", 5 * DAY);

    const res = await scanStaleSources(baseEnv());
    expect(res.scanned).toBe(2);
    expect(res.stale).toBe(1);
  });

  it("ignores sources without an established cadence (medianGapDays null)", async () => {
    seedSource({ id: "no-cadence", medianGapDays: null });
    seedRelease("no-cadence", 90 * DAY);

    const res = await scanStaleSources(baseEnv());
    expect(res.scanned).toBe(0);
    expect(res.stale).toBe(0);
  });

  it("does not flag sources we've stopped actively monitoring", async () => {
    // Overdue on output, but last polled 10d ago (> 3d recency) → skipped.
    seedSource({ id: "abandoned", medianGapDays: 7, lastPolledAt: iso(10 * DAY) });
    seedRelease("abandoned", 60 * DAY);

    const res = await scanStaleSources(baseEnv());
    expect(res.stale).toBe(0);
  });

  it("counts lastFetchedAt as active monitoring when lastPolledAt is null", async () => {
    seedSource({
      id: "fetched-recently",
      medianGapDays: 7,
      lastPolledAt: null,
      lastFetchedAt: iso(1 * DAY),
    });
    seedRelease("fetched-recently", 60 * DAY);

    const res = await scanStaleSources(baseEnv());
    expect(res.stale).toBe(1);
  });

  it("excludes paused, deleted, and Firecrawl-owned sources", async () => {
    seedSource({ id: "paused", medianGapDays: 7, fetchPriority: "paused" });
    seedRelease("paused", 60 * DAY);
    seedSource({ id: "deleted", medianGapDays: 7, deletedAt: iso(1 * DAY) });
    seedRelease("deleted", 60 * DAY);
    seedSource({ id: "firecrawl", medianGapDays: 7, firecrawl: true });
    seedRelease("firecrawl", 60 * DAY);

    const res = await scanStaleSources(baseEnv());
    // deleted + firecrawl filtered in SQL; paused filtered in JS → 1 scanned, 0 stale.
    expect(res.scanned).toBe(1);
    expect(res.stale).toBe(0);
  });

  it("honors the floor for fast cadences and respects multiplier/floor env overrides", async () => {
    // Daily cadence (median 1d). Default window = max(14, 1×3) = 14d. Newest 20d ago → stale.
    seedSource({ id: "daily", medianGapDays: 1 });
    seedRelease("daily", 20 * DAY);

    const def = await scanStaleSources(baseEnv());
    expect(def.stale).toBe(1);

    // Raise the floor to 30d → 20d-old is now within window → not stale.
    const wider = await scanStaleSources({ ...baseEnv(), SOURCE_STALE_FLOOR_DAYS: "30" });
    expect(wider.stale).toBe(0);
  });

  it("ignores suppressed releases when finding the newest output", async () => {
    // Only a recent *suppressed* release; newest real output is 60d ago → stale.
    seedSource({ id: "supp", medianGapDays: 7 });
    seedRelease("supp", 60 * DAY);
    seedRelease("supp", 2 * DAY, /* suppressed */ true);

    const res = await scanStaleSources(baseEnv());
    expect(res.stale).toBe(1);
  });

  it("uses createdAt as the clock for a source that never produced", async () => {
    seedSource({ id: "never", medianGapDays: 7, createdAt: iso(60 * DAY) });
    const res = await scanStaleSources(baseEnv());
    expect(res.stale).toBe(1);
  });

  it("no-ops when CRON_ENABLED is false", async () => {
    seedSource({ id: "s", medianGapDays: 7 });
    seedRelease("s", 60 * DAY);
    const res = await scanStaleSources({ ...baseEnv(), CRON_ENABLED: "false" });
    expect(res).toEqual({ scanned: 0, stale: 0, entries: [] });
  });
});
