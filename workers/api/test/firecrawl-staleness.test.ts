/**
 * Tests for the Firecrawl staleness scan (resilience option A): flag
 * firecrawl-enabled sources whose monitor has stopped delivering.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import type { FirecrawlClient } from "@releases/adapters/firecrawl.js";

const { scanStaleFirecrawlSources, cronIntervalHours, thresholdHours } =
  await import("../src/cron/firecrawl-staleness.js");

// Minimal client whose getMonitor returns a fixed schedule (or throws). Cast to
// FirecrawlClient — the scan only ever calls getMonitor.
const clientWithCron = (cron: string): FirecrawlClient =>
  ({ getMonitor: async () => ({ schedule: { cron } }) }) as unknown as FirecrawlClient;
const clientThatThrows = (): FirecrawlClient =>
  ({
    getMonitor: async () => {
      throw new Error("boom");
    },
  }) as unknown as FirecrawlClient;

const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

beforeEach(() => {
  const sqlite = new Database(":memory:");
  db = ensureBatchShim(drizzle(sqlite));
  applyMigrations(sqlite);
  db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" }).run();
});

function seed(opts: {
  id: string;
  firecrawl?: { enabled: boolean; monitorId?: string } | null;
  lastFetchedAt?: string | null;
  createdAt?: string;
}) {
  db.insert(sources)
    .values({
      id: opts.id,
      orgId: "org_1",
      name: opts.id,
      slug: opts.id,
      type: "scrape",
      url: `https://example.com/${opts.id}`,
      metadata:
        opts.firecrawl === null
          ? "{}"
          : JSON.stringify({ firecrawl: opts.firecrawl ?? { enabled: true } }),
      lastFetchedAt: opts.lastFetchedAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    })
    .run();
}

const baseEnv = () => ({ DB: {} as never, _drizzleOverride: db });

describe("scanStaleFirecrawlSources", () => {
  it("flags enabled sources past the window; ignores fresh, disabled, and non-firecrawl", async () => {
    seed({ id: "stale", firecrawl: { enabled: true }, lastFetchedAt: iso(72 * HOUR) });
    seed({ id: "fresh", firecrawl: { enabled: true }, lastFetchedAt: iso(1 * HOUR) });
    seed({ id: "disabled", firecrawl: { enabled: false }, lastFetchedAt: iso(72 * HOUR) });
    seed({ id: "nofc", firecrawl: null, lastFetchedAt: iso(72 * HOUR) });

    const res = await scanStaleFirecrawlSources(baseEnv());
    // Only the two enabled sources are scanned; only the 72h-old one is stale.
    expect(res.scanned).toBe(2);
    expect(res.stale).toBe(1);
  });

  it("uses createdAt as the clock for never-run sources (null lastFetchedAt)", async () => {
    seed({
      id: "old-unrun",
      firecrawl: { enabled: true },
      lastFetchedAt: null,
      createdAt: iso(72 * HOUR),
    });
    seed({
      id: "new-unrun",
      firecrawl: { enabled: true },
      lastFetchedAt: null,
      createdAt: iso(1 * HOUR),
    });

    const res = await scanStaleFirecrawlSources(baseEnv());
    expect(res.scanned).toBe(2);
    expect(res.stale).toBe(1);
  });

  it("honors FIRECRAWL_STALE_HOURS and no-ops when CRON_ENABLED is false", async () => {
    seed({ id: "s", firecrawl: { enabled: true }, lastFetchedAt: iso(10 * HOUR) });

    // 10h-old against a 6h window → stale.
    const tight = await scanStaleFirecrawlSources({ ...baseEnv(), FIRECRAWL_STALE_HOURS: "6" });
    expect(tight.stale).toBe(1);

    // Default 48h window → not stale.
    const wide = await scanStaleFirecrawlSources(baseEnv());
    expect(wide.stale).toBe(0);

    // Disabled cron → no-op without touching the DB.
    const off = await scanStaleFirecrawlSources({ ...baseEnv(), CRON_ENABLED: "false" });
    expect(off).toEqual({ scanned: 0, stale: 0 });
  });

  it("raises the threshold to 2x the monitor's live cadence for slow schedules", async () => {
    // 72h since the last fetch: past the 48h floor, but well within a weekly
    // monitor's 2×168h = 336h window.
    seed({
      id: "weekly",
      firecrawl: { enabled: true, monitorId: "mon_weekly" },
      lastFetchedAt: iso(72 * HOUR),
    });

    // Floor only (no client): flagged at 48h.
    const floor = await scanStaleFirecrawlSources(baseEnv());
    expect(floor.stale).toBe(1);

    // Live weekly schedule (cron "0 0 * * 0" → 168h → 336h threshold): not stale.
    const withSchedule = await scanStaleFirecrawlSources({
      ...baseEnv(),
      _firecrawlClientOverride: clientWithCron("0 0 * * 0"),
    });
    expect(withSchedule.stale).toBe(0);
  });

  it("falls back to the floor when the schedule read fails (never suppresses a warning)", async () => {
    seed({
      id: "broken",
      firecrawl: { enabled: true, monitorId: "mon_x" },
      lastFetchedAt: iso(72 * HOUR),
    });

    const res = await scanStaleFirecrawlSources({
      ...baseEnv(),
      _firecrawlClientOverride: clientThatThrows(),
    });
    // getMonitor threw → floor (48h) applies → still flagged.
    expect(res.stale).toBe(1);
  });

  it("does not read the schedule for sources fresh against the floor", async () => {
    seed({
      id: "fresh",
      firecrawl: { enabled: true, monitorId: "mon_fresh" },
      lastFetchedAt: iso(1 * HOUR),
    });

    let calls = 0;
    const counting = {
      getMonitor: async () => {
        calls++;
        return { schedule: { cron: "0 0 * * 0" } };
      },
    } as unknown as FirecrawlClient;

    const res = await scanStaleFirecrawlSources({
      ...baseEnv(),
      _firecrawlClientOverride: counting,
    });
    expect(res.stale).toBe(0);
    // Within the floor window → skipped before any (paid) getMonitor call.
    expect(calls).toBe(0);
  });

  it("degrades to floor-only when the API-key secret resolution throws", async () => {
    seed({
      id: "stale",
      firecrawl: { enabled: true, monitorId: "mon_x" },
      lastFetchedAt: iso(72 * HOUR),
    });

    // A Secrets Store blip: getSecret retries then throws. The scan must still
    // complete (floor applies) rather than aborting and emitting no warnings.
    const FIRECRAWL_API_KEY = {
      get: async () => {
        throw new Error("secrets store unavailable");
      },
    };

    const res = await scanStaleFirecrawlSources({ ...baseEnv(), FIRECRAWL_API_KEY });
    expect(res).toEqual({ scanned: 1, stale: 1 });
  });
});

describe("thresholdHours", () => {
  it("reports basis 'schedule' only when 2x cadence clears the floor", async () => {
    // Weekly cadence (168h → 336h) exceeds the 48h floor → schedule drives it.
    expect(await thresholdHours(clientWithCron("0 0 * * 0"), "mon", 48)).toEqual({
      hours: 336,
      basis: "schedule",
    });

    // 6h cadence (→ 12h) is below the floor → the floor wins, so the basis must
    // say "floor" to match the emitted hours.
    expect(await thresholdHours(clientWithCron("0 */6 * * *"), "mon", 48)).toEqual({
      hours: 48,
      basis: "floor",
    });
  });

  it("falls back to the floor with no client, no monitor id, or a read error", async () => {
    expect(await thresholdHours(undefined, "mon", 48)).toEqual({ hours: 48, basis: "floor" });
    expect(await thresholdHours(clientWithCron("0 0 * * 0"), null, 48)).toEqual({
      hours: 48,
      basis: "floor",
    });
    expect(await thresholdHours(clientThatThrows(), "mon", 48)).toEqual({
      hours: 48,
      basis: "floor",
    });
  });
});

describe("cronIntervalHours", () => {
  it("maps the cron shapes Firecrawl emits to coarse hours", () => {
    expect(cronIntervalHours("0 */6 * * *")).toBe(6);
    expect(cronIntervalHours("0 0 * * *")).toBe(24);
    expect(cronIntervalHours("0 0 * * 0")).toBe(24 * 7);
    expect(cronIntervalHours("0 0 1 * *")).toBe(24 * 30);
    expect(cronIntervalHours("*/30 * * * *")).toBe(0.5);
    expect(cronIntervalHours("0 * * * *")).toBe(1);
  });

  it("returns null for unparseable / missing crons", () => {
    expect(cronIntervalHours(undefined)).toBeNull();
    expect(cronIntervalHours(null)).toBeNull();
    expect(cronIntervalHours("")).toBeNull();
    expect(cronIntervalHours("not a cron")).toBeNull();
  });

  it("returns null for lists, ranges, names, and out-of-range fields", () => {
    expect(cronIntervalHours("0 0 * * 1,3")).toBeNull(); // day-of-week list
    expect(cronIntervalHours("15-45 * * * *")).toBeNull(); // minute range
    expect(cronIntervalHours("0 0 * * MON")).toBeNull(); // named day
    expect(cronIntervalHours("0 0 1-15 * *")).toBeNull(); // day-of-month range
    expect(cronIntervalHours("99 0 * * *")).toBeNull(); // minute out of range
    expect(cronIntervalHours("0 25 * * *")).toBeNull(); // hour out of range
  });
});
