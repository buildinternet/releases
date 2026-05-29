/**
 * Tests for the Firecrawl staleness scan (resilience option A): flag
 * firecrawl-enabled sources whose monitor has stopped delivering.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources } from "@buildinternet/releases-core/schema";

const { scanStaleFirecrawlSources } = await import("../src/cron/firecrawl-staleness.js");

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
  firecrawl?: { enabled: boolean } | null;
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
});
