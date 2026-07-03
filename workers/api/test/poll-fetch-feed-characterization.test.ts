/**
 * Characterization tests for the feed fetch cycle in `fetchOne` (issue #1652).
 *
 * `workers/api/src/cron/poll-fetch.ts` (~2,700 LOC) is the other top churn
 * hotspot and carries the fetch → parse → dedup/upsert → backoff logic for
 * every source type. This suite pins CURRENT behavior of the feed branch
 * (RSS/Atom) via `fetchOne` against a real migrated test DB and a stubbed
 * `globalThis.fetch` returning inline XML — mirroring the exact pattern in
 * `appstore-poll-fetch.test.ts` (`skipSideEffects: true`; no module mocking).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { fetchOne } from "../src/cron/poll-fetch.js";
import { createTestDb, type TestDb } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

afterEach(() => {
  restoreGlobalFetch();
});

// Two-item RSS 2.0 fixture — mirrors tests/fixtures/feeds/rss-basic.xml, kept
// inline here so this file has no cross-directory fixture dependency.
const RSS_TWO_ITEMS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Acme Changelog</title>
    <link>https://acme.test/changelog</link>
    <item>
      <title>v2.1.0 — Dashboard Redesign</title>
      <description><![CDATA[<p>Redesigned the dashboard.</p>]]></description>
      <link>https://acme.test/changelog/v2-1-0</link>
      <pubDate>Mon, 15 Jan 2024 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>v2.0.0 — Initial Release</title>
      <description>First public release with core features.</description>
      <link>https://acme.test/changelog/v2-0-0</link>
      <pubDate>Wed, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>
`;

async function seedFeedSource(db: TestDb) {
  await db.insert(organizations).values({ id: "org_a", name: "Acme", slug: "acme" });
  await db.insert(sources).values({
    id: "src_a",
    name: "Acme",
    slug: "acme-changelog",
    type: "feed",
    url: "https://acme.test/changelog",
    orgId: "org_a",
    metadata: JSON.stringify({ feedUrl: "https://acme.test/feed.xml", feedType: "rss" }),
  });
  return (await db.select().from(sources).where(eq(sources.id, "src_a")))[0]!;
}

function stubFetch(handler: (req: Request) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    return handler(req);
  }) as unknown as typeof fetch;
}

describe("fetchOne — feed fetch cycle", () => {
  it("first fetch inserts the feed items as releases with mapped url/title/publishedAt", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    stubFetch(() => new Response(RSS_TWO_ITEMS, { status: 200 }));

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

  it("second fetch with an identical fixture inserts 0 (dedup on source_id+url)", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    stubFetch(() => new Response(RSS_TWO_ITEMS, { status: 200 }));

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
    stubFetch(() => new Response("", { status: 500, statusText: "Internal Server Error" }));

    // oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
    const result = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
    expect(result.status).toBe("error");

    const [row] = await db.select().from(sources).where(eq(sources.id, "src_a"));
    // 5xx is a plain Error (not FeedHttpError), so it falls through to the
    // generic consecutiveErrors ladder at the bottom of fetchOne's catch block
    // — NOT the transient-D1 short-circuit (this is an upstream HTTP error,
    // not a D1 failure) and NOT the feed4xxStreak branch (5xx is not 4xx).
    expect(row!.consecutiveErrors).toBe(1);
    expect(row!.nextFetchAfter).toBeTruthy();
    expect(Date.parse(row!.nextFetchAfter!)).toBeGreaterThan(Date.now());
  });

  it("HTTP 429 with Retry-After: backoff respects the header, rateLimited flag set, feed4xxStreak untouched", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    // Retry-After: 3600s (1h) — longer than the first-strike exponential
    // backoff (2^0 = 1h too, so use a header that clearly wins: 10h).
    const retryAfterSeconds = 10 * 3600;
    stubFetch(
      () =>
        new Response("", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": String(retryAfterSeconds) },
        }),
    );

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
    // backoff is 2^0 = 1h (3,600,000ms), well under the 10h Retry-After, so
    // the header must be the one that wins.
    expect(waitMs).toBeGreaterThanOrEqual(retryAfterSeconds * 1000 - 5000);

    // 429 is a transient rate-limit signal, not evidence the feed URL is gone
    // — feed4xxStreak (the invalidation counter for genuine 4xx like 404/410)
    // must NOT be touched by this branch.
    const meta = JSON.parse(row!.metadata!);
    expect(meta.feed4xxStreak).toBeUndefined();
  });

  it("HTTP 404 on the feed: status=error, feed4xxStreak incremented (not the generic consecutiveErrors backoff)", async () => {
    const db = createTestDb();
    const source = await seedFeedSource(db);
    stubFetch(() => new Response("", { status: 404, statusText: "Not Found" }));

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
