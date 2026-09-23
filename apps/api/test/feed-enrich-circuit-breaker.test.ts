/**
 * Circuit-breaker tests for feed enrichment.
 *
 * After ENRICH_CONSECUTIVE_FAILURE_LIMIT consecutive failed enrichment
 * attempts on a source, `enrichNewThinItems` must skip the source entirely
 * (no calls to `enrichFn`) and return an empty map. The counter is stored in
 * `source.metadata.enrichment.consecutiveFailures`. A success resets it.
 *
 * These tests use the pure helper functions exported from feed-enrich:
 * - `isEnrichmentCircuitOpen` — reads the counter from SourceMetadata and
 *   returns true when the breaker has tripped.
 * - `nextEnrichmentMetadata` — derives the next metadata enrichment block
 *   (increment on failure, reset to 0 on success).
 * - `ENRICH_CONSECUTIVE_FAILURE_LIMIT` — named constant.
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta";
import {
  isEnrichmentCircuitOpen,
  nextEnrichmentMetadata,
  enrichNewThinItems,
  ENRICH_CONSECUTIVE_FAILURE_LIMIT,
  type EnrichItem,
  type EnrichResult,
} from "../src/cron/feed-enrich.js";
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";
import type { SourceMetadata } from "@releases/adapters/source-meta";

describe("ENRICH_CONSECUTIVE_FAILURE_LIMIT", () => {
  it("is a positive integer", () => {
    expect(ENRICH_CONSECUTIVE_FAILURE_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(ENRICH_CONSECUTIVE_FAILURE_LIMIT)).toBe(true);
  });
});

describe("isEnrichmentCircuitOpen", () => {
  it("returns false when no enrichment metadata is present", () => {
    const meta: SourceMetadata = {};
    expect(isEnrichmentCircuitOpen(meta)).toBe(false);
  });

  it("returns false when consecutiveFailures is below the limit", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: ENRICH_CONSECUTIVE_FAILURE_LIMIT - 1 },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(false);
  });

  it("returns true when consecutiveFailures equals the limit", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: ENRICH_CONSECUTIVE_FAILURE_LIMIT },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(true);
  });

  it("returns true when consecutiveFailures exceeds the limit", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: ENRICH_CONSECUTIVE_FAILURE_LIMIT + 5 },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(true);
  });

  it("returns false when consecutiveFailures is 0 (reset after a success)", () => {
    const meta: SourceMetadata = {
      enrichment: { consecutiveFailures: 0 },
    };
    expect(isEnrichmentCircuitOpen(meta)).toBe(false);
  });
});

describe("nextEnrichmentMetadata", () => {
  it("starts count at 1 on the first failure when there is no prior enrichment block", () => {
    const next = nextEnrichmentMetadata(undefined, false);
    expect(next.consecutiveFailures).toBe(1);
  });

  it("increments consecutiveFailures on a failure", () => {
    const next = nextEnrichmentMetadata({ consecutiveFailures: 2 }, false);
    expect(next.consecutiveFailures).toBe(3);
  });

  it("resets consecutiveFailures to 0 on a success", () => {
    const next = nextEnrichmentMetadata({ consecutiveFailures: 5 }, true);
    expect(next.consecutiveFailures).toBe(0);
  });

  it("resets from undefined to 0 on the first success", () => {
    const next = nextEnrichmentMetadata(undefined, true);
    expect(next.consecutiveFailures).toBe(0);
  });

  it("preserves consecutiveFailures at 0 on repeated successes", () => {
    const next = nextEnrichmentMetadata({ consecutiveFailures: 0 }, true);
    expect(next.consecutiveFailures).toBe(0);
  });
});

/**
 * End-to-end breaker behavior: `enrichNewThinItems` must persist the
 * consecutive-failure counter to `sources.metadata.enrichment` after each
 * fire so the breaker can trip on its own across cron fires. An all-fail batch
 * increments; one success resets to 0; a batch with no attempts (nothing
 * thin/new to enrich) must NOT bump the counter.
 */
function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  return ensureBatchShim(drizzle(sqlite));
}

function seedSource(
  db: ReturnType<typeof mkDb>,
  meta: SourceMetadata = { feedContentDepth: "summary-only" },
): Source {
  db.insert(organizations).values({ id: "org_1", name: "Acme", slug: "acme" }).run();
  const row = {
    id: "src_1",
    slug: "acme-blog",
    name: "Acme Blog",
    orgId: "org_1",
    type: "feed" as const,
    url: "https://acme.example.com/blog",
    metadata: JSON.stringify(meta),
  };
  db.insert(sources)
    .values(row as never)
    .run();
  return db.select().from(sources).where(eq(sources.id, "src_1")).all()[0] as unknown as Source;
}

function readMeta(db: ReturnType<typeof mkDb>): SourceMetadata {
  const row = db
    .select()
    .from(sources)
    .where(eq(sources.id, "src_1"))
    .all()[0] as unknown as Source;
  return getSourceMeta(row);
}

/** A thin feed item carrying its own teaser as content (so isThinItem is true). */
function thinItem(n: number): RawRelease {
  return {
    title: `Release ${n}`,
    content: "tiny teaser",
    contentFromSummary: true,
    isBreaking: false,
    url: `https://acme.example.com/blog/post-${n}`,
  };
}

const ENABLED_ENV = { FEED_ENRICH_ENABLED: "true" } as const;
const alwaysFail = async (_item: EnrichItem): Promise<EnrichResult> => ({
  status: "no_improvement",
});
const alwaysSucceed = async (_item: EnrichItem): Promise<EnrichResult> => ({
  status: "enriched",
  via: "fetch",
  content: "x".repeat(2000),
});

describe("enrichNewThinItems circuit-breaker write-back", () => {
  it("increments consecutiveFailures to the limit across all-fail fires and then trips the breaker", async () => {
    const db = mkDb();
    let source = seedSource(db);

    // Drive ENRICH_CONSECUTIVE_FAILURE_LIMIT all-fail fires, each with a fresh
    // thin item (distinct URL so it isn't deduped against prior inserts).
    for (let fire = 1; fire <= ENRICH_CONSECUTIVE_FAILURE_LIMIT; fire++) {
      // oxlint-disable-next-line no-await-in-loop -- sequential fires model the cron
      const meta = readMeta(db);
      // oxlint-disable-next-line no-await-in-loop
      await enrichNewThinItems(db as never, source, meta, [thinItem(fire)], ENABLED_ENV, {
        enrichFn: alwaysFail,
      });
      expect(readMeta(db).enrichment?.consecutiveFailures).toBe(fire);
      source = db
        .select()
        .from(sources)
        .where(eq(sources.id, "src_1"))
        .all()[0] as unknown as Source;
    }

    // Breaker is now open.
    expect(isEnrichmentCircuitOpen(readMeta(db))).toBe(true);

    // A subsequent fire is short-circuited: enrichFn must not be called.
    let called = false;
    await enrichNewThinItems(db as never, source, readMeta(db), [thinItem(99)], ENABLED_ENV, {
      enrichFn: async (item) => {
        called = true;
        return alwaysFail(item);
      },
    });
    expect(called).toBe(false);
    // Counter is untouched by the skipped fire.
    expect(readMeta(db).enrichment?.consecutiveFailures).toBe(ENRICH_CONSECUTIVE_FAILURE_LIMIT);
  });

  it("resets consecutiveFailures to 0 on a success", async () => {
    const db = mkDb();
    // Start just below the limit so the breaker is still closed.
    const source = seedSource(db, {
      feedContentDepth: "summary-only",
      enrichment: { consecutiveFailures: ENRICH_CONSECUTIVE_FAILURE_LIMIT - 1 },
    });

    await enrichNewThinItems(db as never, source, readMeta(db), [thinItem(1)], ENABLED_ENV, {
      enrichFn: alwaysSucceed,
    });

    expect(readMeta(db).enrichment?.consecutiveFailures).toBe(0);
    expect(isEnrichmentCircuitOpen(readMeta(db))).toBe(false);
  });

  it("does not bump the counter when there is nothing to enrich (no attempts)", async () => {
    const db = mkDb();
    const source = seedSource(db, {
      feedContentDepth: "summary-only",
      enrichment: { consecutiveFailures: 1 },
    });

    // A full-body item is not thin → no candidates → no attempts.
    const fullItem: RawRelease = {
      title: "Full release",
      content: "x".repeat(2000),
      contentFromSummary: false,
      isBreaking: false,
      url: "https://acme.example.com/blog/full",
    };
    let called = false;
    await enrichNewThinItems(db as never, source, readMeta(db), [fullItem], ENABLED_ENV, {
      enrichFn: async (item) => {
        called = true;
        return alwaysFail(item);
      },
    });

    expect(called).toBe(false);
    // Counter unchanged — a no-attempt fire must not count as a failure.
    expect(readMeta(db).enrichment?.consecutiveFailures).toBe(1);
  });
});
