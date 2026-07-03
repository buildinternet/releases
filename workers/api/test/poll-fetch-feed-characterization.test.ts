/**
 * Characterization tests for the feed fetch cycle in `fetchOne` (issue #1652).
 *
 * `workers/api/src/cron/poll-fetch.ts` (~2,700 LOC) is a top churn hotspot and
 * carries the fetch → parse → dedup/upsert → backoff logic for every source
 * type. This suite pins CURRENT behavior of the feed branch via `fetchOne`
 * against a real migrated test DB.
 *
 * Why we stub `@releases/adapters/feed.js` via `mock.module` instead of
 * stubbing `globalThis.fetch` with raw RSS: several sibling test files
 * (`fetch-log.test.ts`, `poll-fetch-change-detectors.test.ts`,
 * `poll-fetch-marketing-filter.test.ts`, `poll-fetch-skip-delegation.test.ts`)
 * register a module-scope `mock.module` for the same path. Bun's `mock.module`
 * is process-global, so whichever of those files loads BEFORE this one leaks
 * its stub in — and test-file load order differs between macOS and Linux,
 * which made the original `globalThis.fetch` version of this file pass locally
 * but fail on Linux CI (PR #1847: every case resolved to a leaked stub that
 * returned `releases: []` for unknown feed URLs → `status: "no_change"` at
 * ~0ms, even for the 500/429/404 cases). Registering our own override with a
 * per-test state hook is the established sibling convention.
 *
 * Consequence: the raw RSS/Atom → RawRelease parsing is NOT covered here —
 * that lives in the adapter's own tests (`tests/unit/feed-parsers.test.ts`,
 * `tests/unit/feed-http-error.test.ts`). These five cases characterize what
 * `fetchOne` does with the adapter's OUTPUT: parsed items on success, and the
 * exact error shapes `fetchAndParseFeed` throws (plain `Error` on 5xx,
 * `FeedHttpError` with `retryAfterMs` on 4xx — see
 * `packages/adapters/src/feed.ts` ~lines 300-315).
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import type { RawRelease } from "@releases/adapters/types";
// NOTE: fetchOne's `instanceof FeedHttpError` checks import the class from
// `@releases/lib/errors` (poll-fetch.ts) — the adapter throws the same class
// from the same module — so constructing ours from that exact specifier is
// what guarantees the instanceof match. (`@releases/adapters/feed.js` does
// not re-export it.)
import { FeedHttpError } from "@releases/lib/errors";
import { createTestDb, type TestDb } from "./setup";

// ── feed-adapter stub ───────────────────────────────────────────────────────
//
// Per-test state for what `fetchAndParseFeed` should do: return parsed items
// (happy/dedup cases) or throw the same error shape the real adapter throws
// (error cases). Reset in beforeEach so no test leaks into the next.

let nextFeedImpl: () => Promise<{
  releases: RawRelease[];
  etag?: string;
  lastModified?: string;
  contentLength?: string;
}> = async () => ({ releases: [] });

// Spread the real adapter so exports the fetch path imports transitively
// resolve to their real implementations; only the entry points this test
// controls are overridden below. We deliberately do NOT hand-roll the
// github-override-path helpers (`getSourceMeta`, `isGitHubFetched`, …) —
// `...actualFeed` supplies the real implementations (the #1565 flake lesson).
const actualFeed = await import("@releases/adapters/feed.js");

mock.module("@releases/adapters/feed.js", () => ({
  ...actualFeed,
  // poll-fetch.ts reads these two constants; pin the production-faithful
  // values from the real module (threshold 5 + the full cleared-fields set).
  FEED_4XX_INVALIDATE_THRESHOLD: actualFeed.FEED_4XX_INVALIDATE_THRESHOLD,
  CLEARED_FEED_FIELDS: actualFeed.CLEARED_FEED_FIELDS,
  // Change-detector helpers — always report changed/proceed so the pollOne
  // pre-pass can never short-circuit a fetch in these tests.
  headCheckUrl: async () => ({ changed: true }),
  bodyHashCheck: async () => ({ status: "unchanged" as const, responseMs: 0 }),
  // The actual stub — per-test behavior via nextFeedImpl.
  fetchAndParseFeed: async () => nextFeedImpl(),
}));

// fetchOne must be imported AFTER mock.module is registered so its
// `@releases/adapters/feed.js` import resolves to the stub.
const { fetchOne } = await import("../src/cron/poll-fetch.js");

const FEED_URL = "https://acme.test/feed.xml";

// Two parsed feed items — the same shape `parseRss` produces for the
// rss-basic.xml fixture (title/content/url + `publishedAt` as a Date).
const ITEMS: RawRelease[] = [
  {
    title: "v2.1.0 — Dashboard Redesign",
    content: "Redesigned the dashboard.",
    url: "https://acme.test/changelog/v2-1-0",
    publishedAt: new Date("Mon, 15 Jan 2024 12:00:00 GMT"),
  },
  {
    title: "v2.0.0 — Initial Release",
    content: "First public release with core features.",
    url: "https://acme.test/changelog/v2-0-0",
    publishedAt: new Date("Wed, 01 Jan 2024 00:00:00 GMT"),
  },
];

async function seedFeedSource(db: TestDb) {
  await db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await db.insert(sources).values({
    id: "src_a",
    name: "Acme",
    slug: "acme-changelog",
    type: "feed",
    url: "https://acme.test/changelog",
    orgId: "org_a",
    metadata: JSON.stringify({ feedUrl: FEED_URL, feedType: "rss" }),
  });
  return (await db.select().from(sources).where(eq(sources.id, "src_a")))[0]!;
}

beforeEach(() => {
  nextFeedImpl = async () => ({ releases: [] });
});

describe("fetchOne — feed fetch cycle", () => {
  it("first fetch inserts the feed items as releases with mapped url/title/publishedAt", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    nextFeedImpl = async () => ({ releases: ITEMS });

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const result = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(result.status).toBe("success");
    expect(result.releasesFound).toBe(2);
    expect(result.releasesInserted).toBe(2);

    const rows = await db
      .select()
      .from(releases)
      .where(eq(releases.sourceId, "src_a"))
      .orderBy(releases.publishedAt);
    expect(rows).toHaveLength(2);
    const older = rows.find((r) => r.url === "https://acme.test/changelog/v2-0-0")!;
    expect(older.title).toBe("v2.0.0 — Initial Release");
    expect(older.publishedAt).toBe(new Date("Wed, 01 Jan 2024 00:00:00 GMT").toISOString());

    const newer = rows.find((r) => r.url === "https://acme.test/changelog/v2-1-0")!;
    expect(newer.title).toBe("v2.1.0 — Dashboard Redesign");
    expect(newer.content).toContain("Redesigned the dashboard");
  });

  it("second fetch with identical items inserts 0 (dedup on source_id+url)", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    nextFeedImpl = async () => ({ releases: ITEMS });

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const first = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(first.releasesInserted).toBe(2);

    const [refreshed] = await db.select().from(sources).where(eq(sources.id, "src_a"));
    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const second = await fetchOne(db as any, refreshed!, {} as never, { skipSideEffects: true });
    expect(second.releasesFound).toBe(2);
    expect(second.releasesInserted).toBe(0);
    expect(second.status).toBe("no_change");

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_a"));
    expect(rows).toHaveLength(2);
  });

  it("HTTP 500 on the feed: status=error, consecutiveErrors incremented, nextFetchAfter set", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    // On 5xx the real adapter throws a plain Error, NOT FeedHttpError — see
    // packages/adapters/src/feed.ts (the `res.status >= 400 && < 500` guard).
    nextFeedImpl = async () => {
      throw new Error("Feed fetch failed: 500 Internal Server Error");
    };

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const result = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(result.status).toBe("error");

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_a"));
    // A plain Error falls through to the generic consecutiveErrors ladder at
    // the bottom of fetchOne's catch block — NOT the transient-D1
    // short-circuit (this is an upstream HTTP error, not a D1 failure) and
    // NOT the feed4xxStreak branch (not a FeedHttpError).
    expect(row!.consecutiveErrors).toBe(1);
    expect(row!.nextFetchAfter).toBeTruthy();
    expect(Date.parse(row!.nextFetchAfter!)).toBeGreaterThan(Date.now());
  });

  it("HTTP 429 with Retry-After: backoff respects the header, rateLimited flag set, feed4xxStreak untouched", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    // Retry-After: 10h — clearly longer than the first-strike exponential
    // backoff (2^0 = 1h), so the header must be the value that wins.
    const retryAfterMs = 10 * 3600 * 1000;
    // Same shape the real adapter throws on 429: FeedHttpError(status,
    // feedUrl, statusText, retryAfterMs) with retryAfterMs parsed from the
    // Retry-After header — see packages/adapters/src/feed.ts ~lines 305-311.
    nextFeedImpl = async () => {
      throw new FeedHttpError(429, FEED_URL, "Too Many Requests", retryAfterMs);
    };

    const before = Date.now();
    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const result = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(result.status).toBe("error");
    expect((result as { rateLimited?: boolean }).rateLimited).toBe(true);

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_a"));
    expect(row!.consecutiveErrors).toBe(1);
    expect(row!.nextFetchAfter).toBeTruthy();
    const waitMs = Date.parse(row!.nextFetchAfter!) - before;
    // waitMs = max(backoffMs, retryAfterMs); with newErrors=1 the exponential
    // backoff is 1h, well under the 10h Retry-After, so the header wins.
    expect(waitMs).toBeGreaterThanOrEqual(retryAfterMs - 5000);

    // 429 is a transient rate-limit signal, not evidence the feed URL is gone
    // — feed4xxStreak (the invalidation counter for genuine 4xx like 404/410)
    // must NOT be touched by this branch.
    const meta = JSON.parse(row!.metadata!);
    expect(meta.feed4xxStreak).toBeUndefined();
  });

  it("HTTP 404 on the feed: status=error, feed4xxStreak incremented (not the generic consecutiveErrors backoff)", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    // Same shape the real adapter throws on a non-transient 4xx (no
    // Retry-After header → retryAfterMs undefined).
    nextFeedImpl = async () => {
      throw new FeedHttpError(404, FEED_URL, "Not Found", undefined);
    };

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const result = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(result.status).toBe("error");

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_a"));
    // characterizes current behavior: a genuine 4xx (not 429/408) tracks via
    // feed4xxStreak, NOT consecutiveErrors/nextFetchAfter — the cron keeps
    // polling at the normal cadence until the streak crosses the invalidation
    // threshold, rather than backing off for hours.
    const meta = JSON.parse(row!.metadata!);
    expect(meta.feed4xxStreak).toBe(1);
    expect(row!.consecutiveErrors).toBe(0);
    expect(row!.nextFetchAfter).toBeNull();
  });
});
