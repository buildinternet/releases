import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applyMigrations } from "../../../tests/db-helper";
import { eq, sql } from "drizzle-orm";
import { organizations, sources, releases, fetchLog } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types";

// Stateful stub for @releases/adapters/feed — configured per test via nextFeedResult.
let nextFeedResult: {
  releases?: RawRelease[];
  etag?: string | null;
  lastModified?: string | null;
  contentLength?: number | null;
  throwError?: Error;
} = {};

type FeedCall = {
  url: string;
  feedType: string;
  opts: { maxEntries?: number };
  headers?: Record<string, string>;
};
const feedCalls: FeedCall[] = [];

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
  headCheckUrl: async () => ({ changed: true }),
  bodyHashCheck: async () => ({ status: "unchanged", responseMs: 0 }),
  fetchAndParseFeed: async (
    url: string,
    feedType: string,
    opts: { maxEntries?: number },
    headers?: Record<string, string>,
  ) => {
    feedCalls.push({ url, feedType, opts, headers });
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
const { Hono } = await import("hono");
const { sourceRoutes } = await import("../src/routes/sources.js");

// Minimal STATUS_HUB DO stub — route fires a notification event we don't care about here.
const statusHubStub = {
  idFromName: () => "stub-id",
  get: () => ({
    fetch: async () => new Response("ok", { status: 200 }),
  }),
};

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  // bun-sqlite drizzle handles don't expose .batch (D1-only). Shim it so
  // fetchOne's db.batch() call resolves statements sequentially in tests.
  const db = rawDb as unknown as typeof rawDb & { batch?: unknown };
  if (!db.batch) {
    db.batch = async (ops: ReadonlyArray<Promise<unknown>>) => {
      const out: unknown[] = [];
      for (const op of ops) {
        // oxlint-disable-next-line no-await-in-loop -- shim mirrors D1 batch ordering
        out.push(await op);
      }
      return out;
    };
  }
  return db as typeof rawDb;
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
  feedCalls.length = 0;
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

describe("fetchOne → ETag conditional headers", () => {
  it("sends no conditional headers when source metadata has none", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { releases: [] };

    await fetchOne(db, src, {});

    expect(feedCalls).toHaveLength(1);
    expect(feedCalls[0].headers).toBeUndefined();
  });

  it("sends If-None-Match when source has a stored feedEtag", async () => {
    const db = mkDb();
    const src = await seed(db, {
      feedUrl: "https://a.test/feed",
      feedType: "atom",
      feedEtag: '"abc123"',
    });
    nextFeedResult = { releases: [] };

    await fetchOne(db, src, {});

    expect(feedCalls[0].headers).toEqual({ "If-None-Match": '"abc123"' });
  });

  it("sends If-Modified-Since when source has a stored feedLastModified", async () => {
    const db = mkDb();
    const src = await seed(db, {
      feedUrl: "https://a.test/feed",
      feedType: "atom",
      feedLastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
    });
    nextFeedResult = { releases: [] };

    await fetchOne(db, src, {});

    expect(feedCalls[0].headers).toEqual({
      "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT",
    });
  });

  it("persists new etag/lastModified from the feed response on a real fetch", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = {
      releases: [],
      etag: '"new-etag"',
      lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
    };

    await fetchOne(db, src, {});

    const [after] = await db.select().from(sources).where(eq(sources.id, "src_a1"));
    const meta = JSON.parse(after.metadata!);
    expect(meta.feedEtag).toBe('"new-etag"');
    expect(meta.feedLastModified).toBe("Wed, 01 Jan 2025 00:00:00 GMT");

    // A follow-up fetch should now send those back as conditional headers.
    feedCalls.length = 0;
    const [refreshed] = await db.select().from(sources).where(eq(sources.id, "src_a1"));
    nextFeedResult = { releases: [] };
    await fetchOne(db, refreshed, {});
    expect(feedCalls[0].headers).toEqual({
      "If-None-Match": '"new-etag"',
      "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT",
    });
  });
});

describe("fetchOne → maxEntries", () => {
  it("defaults to 200 when no maxEntries option is passed", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { releases: [] };

    await fetchOne(db, src, {});

    expect(feedCalls[0].opts.maxEntries).toBe(200);
  });

  it("forwards an explicit maxEntries option to the feed adapter", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { releases: [] };

    await fetchOne(db, src, {}, { maxEntries: 5 });

    expect(feedCalls[0].opts.maxEntries).toBe(5);
  });
});

describe("fetchOne → dry-run", () => {
  it("writes fetch_log with status=dry_run and reports releasesFound", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = {
      releases: [mkRaw("https://a.test/v1"), mkRaw("https://a.test/v2")],
    };

    const result = await fetchOne(db, src, {}, { dryRun: true });

    expect(result.status).toBe("dry_run");
    expect(result.releasesFound).toBe(2);
    expect(result.releasesInserted).toBe(0);

    const rows = await db.select().from(fetchLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("dry_run");
    expect(rows[0].releasesFound).toBe(2);
    expect(rows[0].releasesInserted).toBe(0);
  });

  it("does not insert any releases", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { releases: [mkRaw("https://a.test/v1")] };

    await fetchOne(db, src, {}, { dryRun: true });

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(releases)
      .where(eq(releases.sourceId, "src_a1"));
    expect(n).toBe(0);
  });

  it("does not update source.lastFetchedAt or counters", async () => {
    const db = mkDb();
    const src = await seed(db);
    const before = await db.select().from(sources).where(eq(sources.id, "src_a1"));
    nextFeedResult = { releases: [mkRaw("https://a.test/v1")] };

    await fetchOne(db, src, {}, { dryRun: true });

    const [after] = await db.select().from(sources).where(eq(sources.id, "src_a1"));
    expect(after.lastFetchedAt).toBe(before[0].lastFetchedAt);
    expect(after.consecutiveNoChange).toBe(before[0].consecutiveNoChange);
    expect(after.nextFetchAfter).toBe(before[0].nextFetchAfter);
  });

  it("does not persist new etag/lastModified to source.metadata", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = {
      releases: [mkRaw("https://a.test/v1")],
      etag: '"probe-etag"',
      lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
    };

    await fetchOne(db, src, {}, { dryRun: true });

    const [after] = await db.select().from(sources).where(eq(sources.id, "src_a1"));
    const meta = JSON.parse(after.metadata!);
    expect(meta.feedEtag).toBeUndefined();
    expect(meta.feedLastModified).toBeUndefined();
  });

  it("still reports status=error when source has no feedUrl", async () => {
    // Dry-run only affects the happy path — real error states still surface as errors.
    const db = mkDb();
    const src = await seed(db, null);

    const result = await fetchOne(db, src, {}, { dryRun: true });

    expect(result.status).toBe("error");
    const rows = await db.select().from(fetchLog);
    expect(rows[0].status).toBe("error");
  });

  it("still reports status=error when fetchAndParseFeed throws", async () => {
    const db = mkDb();
    const src = await seed(db);
    nextFeedResult = { throwError: new Error("upstream 500") };

    const result = await fetchOne(db, src, {}, { dryRun: true });

    expect(result.status).toBe("error");
    const rows = await db.select().from(fetchLog);
    expect(rows[0].status).toBe("error");
    expect(rows[0].error).toBe("upstream 500");
  });
});

describe("POST /v1/sources/:slug/fetch query params", () => {
  function mkApp(db: ReturnType<typeof mkDb>) {
    const fakeEnv = { DB: db, STATUS_HUB: statusHubStub };
    const fakeCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const app = new Hono();
    const v1 = new Hono();
    v1.route("/", sourceRoutes);
    app.route("/v1", v1);
    return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
  }

  it("passes dryRun=true through so releases are not inserted", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    nextFeedResult = { releases: [mkRaw("https://a.test/v1")] };

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_a1/fetch?dryRun=true", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; releasesInserted: number };
    expect(body.status).toBe("dry_run");
    expect(body.releasesInserted).toBe(0);

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(releases)
      .where(eq(releases.sourceId, "src_a1"));
    expect(n).toBe(0);
  });

  it("forwards max=N to the feed adapter", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);
    nextFeedResult = { releases: [] };

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_a1/fetch?max=42", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(feedCalls[0].opts.maxEntries).toBe(42);
  });

  it("returns 400 for a non-integer max", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_a1/fetch?max=abc", { method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_max");
  });

  it("returns 400 for a zero or negative max", async () => {
    const db = mkDb();
    await seed(db);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_a1/fetch?max=0", { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/sources/:slug/fetch — scrape source inline dispatch", () => {
  async function seedScrape(db: ReturnType<typeof mkDb>, meta: Record<string, unknown> | null) {
    await db
      .insert(organizations)
      .values({ id: "org_b", slug: "beta", name: "Beta", category: "cloud" });
    await db.insert(sources).values({
      id: "src_b1",
      orgId: "org_b",
      slug: "beta-scrape",
      name: "Beta Scrape",
      url: "https://b.test/changelog",
      type: "scrape",
      metadata: meta ? JSON.stringify(meta) : null,
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_b1"));
    return src;
  }

  function mkApp(db: ReturnType<typeof mkDb>) {
    const fakeEnv = { DB: db, STATUS_HUB: statusHubStub };
    const fakeCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;
    const app = new Hono();
    const v1 = new Hono();
    v1.route("/", sourceRoutes);
    app.route("/v1", v1);
    return (req: Request) => app.fetch(req, fakeEnv, fakeCtx);
  }

  it("runs inline (fetched=true) for a scrape source that has a discovered feedUrl", async () => {
    const db = mkDb();
    await seedScrape(db, { feedUrl: "https://b.test/feed.xml", feedType: "rss" });
    const fetch = mkApp(db);
    nextFeedResult = { releases: [mkRaw("https://b.test/v1")] };

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_b1/fetch", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.fetched).toBe(true);
    // feedCalls proves fetchAndParseFeed was actually invoked
    expect(feedCalls.length).toBeGreaterThan(0);
  });

  it("flags (queued=true) for a scrape source without a feedUrl", async () => {
    const db = mkDb();
    await seedScrape(db, null);
    const fetch = mkApp(db);

    const res = await fetch(
      new Request("https://x.test/v1/sources/src_b1/fetch", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.queued).toBe(true);
    expect(body.type).toBe("flagged");
    // fetchAndParseFeed must NOT have been called
    expect(feedCalls.length).toBe(0);
  });
});
