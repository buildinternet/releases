import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { createTestDb } from "../../../../../tests/db-helper.js";
import {
  AUTO_PAUSE_AFTER_ERRORS,
  bumpSourceCounter,
  recordConsecutiveFetchError,
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
});
