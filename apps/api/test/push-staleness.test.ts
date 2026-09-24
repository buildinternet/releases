/**
 * Tests for the push-fed staleness scan (#2381): flag push-fed sources
 * whose publisher has quietly stopped pushing.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

const { scanStalePushFedSources, NO_CADENCE_WINDOW_DAYS } =
  await import("../src/cron/push-staleness.js");

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
  pushFed?: boolean;
  medianGapDays?: number | null;
  fetchPriority?: "normal" | "low" | "paused";
  lastFetchedAt?: string | null;
  createdAt?: string;
  isHidden?: boolean;
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
      metadata: opts.pushFed === false ? "{}" : JSON.stringify({ ingestMode: "push" }),
      medianGapDays: opts.medianGapDays === undefined ? null : opts.medianGapDays,
      fetchPriority: opts.fetchPriority ?? "normal",
      lastFetchedAt: opts.lastFetchedAt ?? null,
      isHidden: opts.isHidden ?? false,
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

describe("scanStalePushFedSources", () => {
  it("flags a push-fed source whose last activity is past its adaptive window", async () => {
    // median 7d × 3 = 21d window. Last fetched 40d ago → stale.
    seedSource({ id: "stale", medianGapDays: 7, lastFetchedAt: iso(40 * DAY) });
    // Last fetched 5d ago → fresh.
    seedSource({ id: "fresh", medianGapDays: 7, lastFetchedAt: iso(5 * DAY) });

    const res = await scanStalePushFedSources(baseEnv());
    expect(res.scanned).toBe(2);
    expect(res.stale).toBe(1);
    expect(res.entries[0]?.sourceId).toBe("stale");
  });

  it("uses the fixed no-cadence window when medianGapDays is null, without skipping", async () => {
    // No cadence established. Last fetched 40d ago → past the 30d fallback → stale.
    seedSource({ id: "sparse-stale", medianGapDays: null, lastFetchedAt: iso(40 * DAY) });
    // Last fetched 10d ago → within the 30d fallback → fresh.
    seedSource({ id: "sparse-fresh", medianGapDays: null, lastFetchedAt: iso(10 * DAY) });

    const res = await scanStalePushFedSources(baseEnv());
    expect(res.scanned).toBe(2);
    expect(res.stale).toBe(1);
    expect(res.entries[0]?.windowDays).toBe(NO_CADENCE_WINDOW_DAYS);
  });

  it("uses the later of lastFetchedAt and the newest non-suppressed release as last activity", async () => {
    // lastFetchedAt is stale (old scrape era) but a recent release exists —
    // last activity should be the release date, so this stays fresh.
    seedSource({ id: "recent-release", medianGapDays: 7, lastFetchedAt: iso(90 * DAY) });
    seedRelease("recent-release", 2 * DAY);

    const res = await scanStalePushFedSources(baseEnv());
    expect(res.stale).toBe(0);

    // The reverse: lastFetchedAt is recent but the only release is old —
    // last activity should be the fetch date, so this also stays fresh.
    seedSource({ id: "recent-fetch", medianGapDays: 7, lastFetchedAt: iso(1 * DAY) });
    seedRelease("recent-fetch", 90 * DAY);

    const res2 = await scanStalePushFedSources(baseEnv());
    const entry = res2.entries.find((e) => e.sourceId === "recent-fetch");
    expect(entry).toBeUndefined();
  });

  it("excludes paused, hidden, deleted, and non-push-fed sources", async () => {
    seedSource({
      id: "paused",
      medianGapDays: 7,
      fetchPriority: "paused",
      lastFetchedAt: iso(60 * DAY),
    });
    seedSource({ id: "hidden", medianGapDays: 7, isHidden: true, lastFetchedAt: iso(60 * DAY) });
    seedSource({
      id: "deleted",
      medianGapDays: 7,
      deletedAt: iso(1 * DAY),
      lastFetchedAt: iso(60 * DAY),
    });
    seedSource({
      id: "polled",
      pushFed: false,
      medianGapDays: 7,
      lastFetchedAt: iso(60 * DAY),
    });

    const res = await scanStalePushFedSources(baseEnv());
    // hidden + deleted + non-push filtered in SQL; paused filtered in JS → 1 scanned, 0 stale.
    expect(res.scanned).toBe(1);
    expect(res.stale).toBe(0);
  });

  it("never flags polled (non-push-fed) sources, even when equally overdue", async () => {
    seedSource({
      id: "polled-stale",
      pushFed: false,
      medianGapDays: 7,
      lastFetchedAt: iso(90 * DAY),
    });

    const res = await scanStalePushFedSources(baseEnv());
    expect(res.scanned).toBe(0);
    expect(res.stale).toBe(0);
  });

  it("ignores suppressed releases when finding last activity", async () => {
    seedSource({ id: "supp", medianGapDays: 7, lastFetchedAt: iso(60 * DAY) });
    seedRelease("supp", 60 * DAY);
    seedRelease("supp", 2 * DAY, /* suppressed */ true);

    const res = await scanStalePushFedSources(baseEnv());
    expect(res.stale).toBe(1);
  });

  it("uses createdAt as the clock when neither lastFetchedAt nor a release exists", async () => {
    seedSource({ id: "never", medianGapDays: 7, createdAt: iso(60 * DAY) });
    const res = await scanStalePushFedSources(baseEnv());
    expect(res.stale).toBe(1);
  });

  it("respects the shared floor/multiplier env overrides", async () => {
    // Daily cadence (median 1d). Default window = max(14, 1×3) = 14d. 20d ago → stale.
    seedSource({ id: "daily", medianGapDays: 1, lastFetchedAt: iso(20 * DAY) });

    const def = await scanStalePushFedSources(baseEnv());
    expect(def.stale).toBe(1);

    // Raise the floor to 30d → 20d-old is now within window → not stale.
    const wider = await scanStalePushFedSources({ ...baseEnv(), SOURCE_STALE_FLOOR_DAYS: "30" });
    expect(wider.stale).toBe(0);
  });

  it("no-ops when CRON_ENABLED is false", async () => {
    seedSource({ id: "s", medianGapDays: 7, lastFetchedAt: iso(60 * DAY) });
    const res = await scanStalePushFedSources({ ...baseEnv(), CRON_ENABLED: "false" });
    expect(res).toEqual({ scanned: 0, stale: 0, entries: [] });
  });
});
