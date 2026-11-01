import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../../../tests/db-helper.js";
import {
  AUTO_PAUSE_AFTER_ERRORS,
  bumpSourceCounter,
  firecrawlBookkeepingMetadata,
  recordConsecutiveFetchError,
  recordEnrichmentOutcome,
  recordFeed4xx,
} from "./source-fetch-health.js";

async function seed() {
  const tdb = createTestDb();
  await tdb.db.insert(organizations).values({
    id: "org_a",
    slug: "acme",
    name: "Acme",
    category: "cloud",
  });
  await tdb.db.insert(sources).values({
    id: "src_a",
    orgId: "org_a",
    slug: "acme",
    name: "Acme",
    url: "https://acme.example/changelog",
    type: "scrape",
  });
  return tdb;
}

describe("source fetch-health transitions", () => {
  it("increments from the stored counter, including a null, and backs off from that count", async () => {
    const tdb = await seed();
    await tdb.db.update(sources).set({ consecutiveErrors: null }).where(eq(sources.id, "src_a"));

    const first = await recordConsecutiveFetchError(tdb.db as never, "src_a");
    const second = await recordConsecutiveFetchError(tdb.db as never, "src_a");

    expect(first?.value).toBe(1);
    expect(second?.value).toBe(2);
    expect(second?.fetchPriority).not.toBe("paused");
    const waitMs = Date.parse(second!.nextFetchAfter!) - Date.now();
    // Second hit: pre-update count was 1 → 2h, not another 1h from a stale read of 0.
    expect(waitMs).toBeGreaterThan(1.5 * 3600_000);
    expect(waitMs).toBeLessThan(2.2 * 3600_000);
    tdb.cleanup();
  });

  it("pauses when the stored streak crosses 6, not when a caller-supplied count does", async () => {
    const tdb = await seed();
    await tdb.db
      .update(sources)
      .set({ consecutiveErrors: 5, fetchPriority: "normal" })
      .where(eq(sources.id, "src_a"));

    const bumped = await recordConsecutiveFetchError(tdb.db as never, "src_a", {
      pauseAt: AUTO_PAUSE_AFTER_ERRORS,
    });
    expect(bumped?.value).toBe(6);
    expect(bumped?.didPause).toBe(true);
    expect(bumped?.fetchPriority).toBe("paused");

    const alreadyPaused = await recordConsecutiveFetchError(tdb.db as never, "src_a", {
      pauseAt: AUTO_PAUSE_AFTER_ERRORS,
    });
    expect(alreadyPaused?.value).toBe(7);
    expect(alreadyPaused?.didPause).toBe(false);

    await tdb.db.update(sources).set({ fetchPriority: "normal" }).where(eq(sources.id, "src_a"));
    const repaused = await recordConsecutiveFetchError(tdb.db as never, "src_a", {
      pauseAt: AUTO_PAUSE_AFTER_ERRORS,
    });
    expect(repaused?.value).toBe(8);
    expect(repaused?.didPause).toBe(true);
    expect(repaused?.fetchPriority).toBe("paused");

    const waitMs = Date.parse(bumped!.nextFetchAfter!) - Date.now();
    // pre-update 5 → 32h
    expect(waitMs).toBeGreaterThan(30 * 3600_000);
    expect(waitMs).toBeLessThan(34 * 3600_000);
    tdb.cleanup();
  });

  it("does not pause a feed source after repeated poll errors", async () => {
    const tdb = await seed();
    await tdb.db
      .update(sources)
      .set({ type: "feed", fetchPriority: "normal", consecutiveErrors: 0 })
      .where(eq(sources.id, "src_a"));

    let last;
    for (let i = 0; i < 8; i++) {
      last = await recordConsecutiveFetchError(tdb.db as never, "src_a");
      expect(last?.didPause).toBe(false);
    }
    expect(last?.value).toBe(8);
    expect(last?.fetchPriority).not.toBe("paused");
    tdb.cleanup();
  });

  it("honors a Retry-After floor longer than the exponential step", async () => {
    const tdb = await seed();
    const retryAfterMs = 10 * 3600_000;
    const before = Date.now();
    const bumped = await recordConsecutiveFetchError(tdb.db as never, "src_a", { retryAfterMs });
    expect(bumped?.value).toBe(1);
    expect(Date.parse(bumped!.nextFetchAfter!) - before).toBeGreaterThanOrEqual(
      retryAfterMs - 5_000,
    );
    tdb.cleanup();
  });

  it("pauses an unproductive drain on the fifth stored increment and leaves a shorter streak running", async () => {
    const tdb = await seed();
    await tdb.db.update(sources).set({ unproductiveDrains: 3 }).where(eq(sources.id, "src_a"));

    const fourth = await bumpSourceCounter(tdb.db as never, "src_a", "unproductiveDrains", {
      pauseAt: 5,
    });
    expect(fourth?.value).toBe(4);
    expect(fourth?.didPause).toBe(false);
    expect(fourth?.fetchPriority).not.toBe("paused");

    const fifth = await bumpSourceCounter(tdb.db as never, "src_a", "unproductiveDrains", {
      pauseAt: 5,
    });
    expect(fifth?.value).toBe(5);
    expect(fifth?.didPause).toBe(true);
    expect(fifth?.fetchPriority).toBe("paused");
    tdb.cleanup();
  });

  it("a no-change bump clears the error counter and advances the stored no-change streak", async () => {
    const tdb = await seed();
    await tdb.db
      .update(sources)
      .set({ consecutiveErrors: 4, consecutiveNoChange: 2 })
      .where(eq(sources.id, "src_a"));

    const bumped = await bumpSourceCounter(tdb.db as never, "src_a", "consecutiveNoChange", {
      backoffCapHours: 48,
      extra: { consecutiveErrors: 0 },
    });
    expect(bumped?.value).toBe(3);
    const [row] = await tdb.db
      .select({ consecutiveErrors: sources.consecutiveErrors })
      .from(sources)
      .where(eq(sources.id, "src_a"));
    expect(row?.consecutiveErrors).toBe(0);
    const waitMs = Date.parse(bumped!.nextFetchAfter!) - Date.now();
    // pre-update streak 2 → 4h
    expect(waitMs).toBeGreaterThan(3.5 * 3600_000);
    expect(waitMs).toBeLessThan(4.5 * 3600_000);
    tdb.cleanup();
  });

  it("increments a feed 4xx streak without dropping other metadata, and clears the feed at the threshold", async () => {
    const tdb = await seed();
    await tdb.db
      .update(sources)
      .set({
        metadata: JSON.stringify({ feedUrl: "https://acme.example/feed.xml", keep: true }),
        consecutiveErrors: 2,
      })
      .where(eq(sources.id, "src_a"));

    const first = await recordFeed4xx(tdb.db as never, "src_a", 5);
    expect(first).toEqual({ streak: 1, invalidated: false });
    const [kept] = await tdb.db.select().from(sources).where(eq(sources.id, "src_a"));
    const keptMeta = JSON.parse(kept!.metadata!);
    expect(keptMeta.feed4xxStreak).toBe(1);
    expect(keptMeta.feedUrl).toBe("https://acme.example/feed.xml");
    expect(keptMeta.keep).toBe(true);

    await tdb.db
      .update(sources)
      .set({
        metadata: JSON.stringify({
          feedUrl: "https://acme.example/feed.xml",
          feed4xxStreak: 4,
          keep: true,
        }),
      })
      .where(eq(sources.id, "src_a"));
    const tripped = await recordFeed4xx(tdb.db as never, "src_a", 5);
    expect(tripped).toEqual({ streak: 5, invalidated: true });
    const [cleared] = await tdb.db.select().from(sources).where(eq(sources.id, "src_a"));
    const clearedMeta = JSON.parse(cleared!.metadata!);
    expect(clearedMeta.feedUrl).toBeUndefined();
    expect(clearedMeta.feed4xxStreak).toBeUndefined();
    expect(clearedMeta.keep).toBe(true);
    expect(clearedMeta.noFeedFound).toBe(false);
    expect(cleared!.consecutiveErrors).toBe(0);
    tdb.cleanup();
  });

  it("leaves malformed metadata untouched instead of throwing", async () => {
    const tdb = await seed();
    await tdb.db.update(sources).set({ metadata: "not-json" }).where(eq(sources.id, "src_a"));
    const bumped = await recordFeed4xx(tdb.db as never, "src_a", 5);
    expect(bumped).toEqual({ streak: 0, invalidated: false });
    const [row] = await tdb.db.select().from(sources).where(eq(sources.id, "src_a"));
    expect(row?.metadata).toBe("not-json");
    tdb.cleanup();
  });

  it("does not let an enrichment success reset a newer failure", async () => {
    const tdb = await seed();
    await tdb.db
      .update(sources)
      .set({ metadata: JSON.stringify({ keep: true, enrichment: { consecutiveFailures: 1 } }) })
      .where(eq(sources.id, "src_a"));

    await recordEnrichmentOutcome(tdb.db as never, "src_a", { succeeded: false });
    await recordEnrichmentOutcome(tdb.db as never, "src_a", {
      succeeded: true,
      observedFailures: 1,
    });
    const [row] = await tdb.db.select().from(sources).where(eq(sources.id, "src_a"));
    const meta = JSON.parse(row!.metadata!);
    expect(meta.keep).toBe(true);
    expect(meta.enrichment.consecutiveFailures).toBe(2);
    tdb.cleanup();
  });

  it("patches Firecrawl bookkeeping without rewriting the rest of the metadata", async () => {
    const tdb = await seed();
    await tdb.db
      .update(sources)
      .set({
        metadata: JSON.stringify({
          keep: true,
          dataset: { enabled: false },
          firecrawl: { enabled: false, webhook: "https://hooks.example/x" },
        }),
      })
      .where(eq(sources.id, "src_a"));
    await tdb.db
      .update(sources)
      .set({ metadata: firecrawlBookkeepingMetadata("chk_1", "2026-06-01T00:00:00.000Z") })
      .where(eq(sources.id, "src_a"));
    const [row] = await tdb.db.select().from(sources).where(eq(sources.id, "src_a"));
    const meta = JSON.parse(row!.metadata!);
    expect(meta.keep).toBe(true);
    expect(meta.dataset).toEqual({ enabled: false });
    expect(meta.firecrawl.webhook).toBe("https://hooks.example/x");
    expect(meta.firecrawl.enabled).toBe(true);
    expect(meta.firecrawl.lastCheckId).toBe("chk_1");
    tdb.cleanup();
  });
});
