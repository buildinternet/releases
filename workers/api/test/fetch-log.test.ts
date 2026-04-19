import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { organizations, sources, fetchLog } from "@releases/core-internal/schema";
import type { RawRelease } from "@releases/adapters/types";

// Stateful stub for @releases/adapters/feed — configured per test via nextFeedResult.
let nextFeedResult: {
  releases?: RawRelease[];
  etag?: string | null;
  lastModified?: string | null;
  contentLength?: number | null;
  throwError?: Error;
} = {};

mock.module("@releases/adapters/feed.js", () => ({
  // poll-fetch.ts reads these two constants. Values match production.
  FEED_4XX_INVALIDATE_THRESHOLD: 3,
  CLEARED_FEED_FIELDS: {
    feedUrl: undefined,
    feedType: undefined,
    feedEtag: undefined,
    feedLastModified: undefined,
  },
  getSourceMeta: (src: { metadata: string | null }) =>
    src.metadata ? JSON.parse(src.metadata) : {},
  headCheckFeed: async () => ({ changed: true }),
  fetchAndParseFeed: async () => {
    if (nextFeedResult.throwError) throw nextFeedResult.throwError;
    return {
      releases: nextFeedResult.releases ?? [],
      etag: nextFeedResult.etag ?? null,
      lastModified: nextFeedResult.lastModified ?? null,
      contentLength: nextFeedResult.contentLength ?? null,
    };
  },
}));

const { fetchOne } = await import("../src/cron/poll-fetch.js");

function mkDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "src/db/migrations" });
  return db;
}

async function seed(
  db: ReturnType<typeof mkDb>,
  meta: Record<string, unknown> | null = { feedUrl: "https://a.test/feed", feedType: "atom" },
) {
  await db
    .insert(organizations)
    .values({ id: "org_a", slug: "acme", name: "Acme", category: "cloud" });
  await db.insert(sources).values({
    id: "src_a1",
    orgId: "org_a",
    slug: "acme-one",
    name: "Acme One",
    url: "https://a.test/1",
    type: "feed",
    metadata: meta ? JSON.stringify(meta) : null,
  });
  const [src] = await db.select().from(sources).where(eq(sources.id, "src_a1"));
  return src;
}

function mkRaw(url: string, title = "rel"): RawRelease {
  return { title, content: `body ${url}`, url, publishedAt: new Date("2026-01-01T00:00:00Z") };
}

beforeEach(() => {
  nextFeedResult = {};
});

describe("fetchOne → fetch_log writes", () => {
  it("writes status=success with counts when releases are inserted", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = {
      releases: [mkRaw("https://a.test/v1", "v1"), mkRaw("https://a.test/v2", "v2")],
    };

    const result = await fetchOne(db, src, {});

    expect(result.status).toBe("success");
    expect(result.releasesFound).toBe(2);
    expect(result.releasesInserted).toBe(2);

    const rows = await db.select().from(fetchLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("success");
    expect(rows[0].sourceId).toBe("src_a1");
    expect(rows[0].releasesFound).toBe(2);
    expect(rows[0].releasesInserted).toBe(2);
    expect(rows[0].error).toBeNull();
    expect(rows[0].sessionId).toBeNull();
    expect(rows[0].durationMs).not.toBeNull();
    expect(rows[0].durationMs!).toBeGreaterThanOrEqual(0);
  });

  it("writes status=no_change when the feed returns zero releases", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { releases: [] };

    const result = await fetchOne(db, src, {});

    expect(result.status).toBe("no_change");
    expect(result.releasesFound).toBe(0);
    expect(result.releasesInserted).toBe(0);

    const rows = await db.select().from(fetchLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("no_change");
    expect(rows[0].releasesFound).toBe(0);
    expect(rows[0].releasesInserted).toBe(0);
    expect(rows[0].error).toBeNull();
  });

  it("writes status=no_change when every release conflicts with existing rows", async () => {
    // Second fetch of identical URLs: onConflictDoNothing skips them all, so
    // releasesFound>0 but releasesInserted=0 → status falls back to no_change.
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { releases: [mkRaw("https://a.test/v1")] };
    await fetchOne(db, src, {});

    nextFeedResult = { releases: [mkRaw("https://a.test/v1")] };
    const result = await fetchOne(db, src, {});

    expect(result.status).toBe("no_change");
    expect(result.releasesFound).toBe(1);
    expect(result.releasesInserted).toBe(0);

    const rows = await db.select().from(fetchLog);
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toBe("no_change");
    expect(rows[1].releasesFound).toBe(1);
    expect(rows[1].releasesInserted).toBe(0);
  });

  it("writes status=error when the source has no feed metadata", async () => {
    const db = mkDb();
    const src = await seed(db, null);

    const result = await fetchOne(db, src, {});

    expect(result.status).toBe("error");
    const rows = await db.select().from(fetchLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toContain("Missing feedUrl");
    expect(rows[0].releasesFound).toBe(0);
    expect(rows[0].releasesInserted).toBe(0);
  });

  it("writes status=error with the thrown message when fetchAndParseFeed fails", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { throwError: new Error("upstream 500") };

    const result = await fetchOne(db, src, {});

    expect(result.status).toBe("error");

    const rows = await db.select().from(fetchLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toBe("upstream 500");
  });

  it("propagates sessionId into the fetch_log row across status paths", async () => {
    const db = mkDb();
    const src = await seed(db);

    nextFeedResult = { releases: [mkRaw("https://a.test/v1")] };
    await fetchOne(db, src, {}, { sessionId: "sess_success" });

    nextFeedResult = { releases: [] };
    await fetchOne(db, src, {}, { sessionId: "sess_nochange" });

    nextFeedResult = { throwError: new Error("boom") };
    await fetchOne(db, src, {}, { sessionId: "sess_error" });

    const rows = await db.select().from(fetchLog).orderBy(fetchLog.createdAt);
    expect(rows.map((r) => r.sessionId)).toEqual(["sess_success", "sess_nochange", "sess_error"]);
  });
});
