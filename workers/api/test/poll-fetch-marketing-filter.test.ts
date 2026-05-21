/**
 * Integration coverage for the per-source marketing classifier.
 *
 * A `feed` source carrying `metadata.marketingFilter = true` should run each
 * newly-parsed item through the classifier and insert items it tags as
 * marketing with `suppressed = true` and `suppressedReason` of the form
 * `marketing_classifier:<slug>`. Non-marketing items insert visibly. The
 * suppressed IDs should be excluded from `insertedIds` on the result so the
 * downstream publish + embed steps skip them.
 *
 * When `marketingFilter` is unset, the classifier never runs (no Anthropic
 * call) and all rows insert visibly.
 *
 * Why we stub `@releases/adapters/feed.js` via `mock.module` instead of
 * mocking `globalThis.fetch` at the test boundary: `workers/api/test/fetch-log.test.ts`
 * already registers a process-global `mock.module` for the same path with a
 * stub that returns `releases: []` by default. Bun applies that stub for every
 * subsequently-evaluated test file in the same run, so any test below it that
 * tries to drive `fetchAndParseFeed` through a real HTTP call gets an empty
 * array regardless of what `globalThis.fetch` does. The fix is to register our
 * own override at this file's module-load with a per-test state hook.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types";

// ── feed-adapter stub ───────────────────────────────────────────────────────
//
// Per-test state for what `fetchAndParseFeed` should return. Reset in
// beforeEach so a prior test can't leak data into the next.

let nextFeedReleases: RawRelease[] = [];
const feedFetchCalls: Array<{ feedUrl: string }> = [];

// Bun's `mock.module` is process-global — once we register this stub it
// applies to every later-evaluated test file. The branch helpers (isGitHubFetched,
// effectiveGitHubUrl) and getSourceMeta therefore have to match production
// behavior, not just whatever we'd write inline for the marketing tests, or
// downstream tests like poll-fetch-github-override.test.ts break.

type StubSource = { type?: string; url: string; metadata: string | null };
type StubMeta = { feedUrl?: string; feedType?: string; githubUrl?: string };

const parseMeta = (src: StubSource): StubMeta =>
  src.metadata ? (JSON.parse(src.metadata) as StubMeta) : {};

mock.module("@releases/adapters/feed.js", () => ({
  FEED_4XX_INVALIDATE_THRESHOLD: 5,
  CLEARED_FEED_FIELDS: {
    feedUrl: undefined,
    feedType: undefined,
    feedEtag: undefined,
    feedLastModified: undefined,
  },
  getSourceMeta: parseMeta,
  // Change-detector helpers — not exercised by the marketing-filter tests but
  // poll-fetch.ts imports them, so they have to resolve to functions.
  headCheckUrl: async () => ({ status: "changed" as const }),
  bodyHashCheck: async () => ({ status: "unchanged" as const, responseMs: 0 }),
  isGitHubFetched: (src: StubSource, meta?: StubMeta) => {
    if (src.type === "github") return true;
    const m = meta ?? parseMeta(src);
    return typeof m.githubUrl === "string" && m.githubUrl.length > 0;
  },
  effectiveGitHubUrl: (src: StubSource, meta?: StubMeta) => {
    const m = meta ?? parseMeta(src);
    return m.githubUrl ?? src.url;
  },
  filterByCategoryAllow: (items: RawRelease[]) => ({ kept: items, dropped: 0 }),
  // The actual stub — returns canned RawRelease data from per-test state and
  // captures the call shape for assertions.
  fetchAndParseFeed: async (feedUrl: string) => {
    feedFetchCalls.push({ feedUrl });
    return {
      releases: nextFeedReleases,
      etag: undefined,
      lastModified: undefined,
      contentLength: undefined,
    };
  },
  synthesizeReleaseUrl: (args: { sourceUrl: string; version: string; template?: string }) => {
    if (!args.template) {
      const stripped = args.version.replace(/^v/i, "");
      return `${args.sourceUrl}#${stripped.replace(/\./g, "-")}`;
    }
    return args.template
      .split("${sourceUrl}")
      .join(args.sourceUrl)
      .split("${versionDashed}")
      .join(args.version.replace(/\./g, "-"))
      .split("${version}")
      .join(args.version);
  },
}));

// fetchOne must be imported AFTER mock.module is registered so its
// `@releases/adapters/feed.js` import resolves to the stub.
const { fetchOne } = await import("../src/cron/poll-fetch.js");

// ── Anthropic mock (globalThis.fetch) ───────────────────────────────────────
//
// The classifier issues real HTTP calls through the Anthropic SDK, which uses
// `globalThis.fetch`. We intercept only the Anthropic origin to keep the test
// hermetic — the feed origin never gets hit because the adapter is stubbed
// above.

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>;
let realFetch: typeof fetch | undefined;
const requestedUrls: string[] = [];

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installFetch(handler: FetchHandler) {
  requestedUrls.length = 0;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    requestedUrls.push(urlOf(input));
    return await handler(input, init);
  }) as typeof fetch;
}

function restoreFetch() {
  if (realFetch !== undefined) {
    (globalThis as { fetch: typeof fetch }).fetch = realFetch;
  }
}

function anthropicJson(verdict: { marketing: boolean; reason: string }): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5",
      content: [
        {
          type: "text",
          text: `<marketing>${verdict.marketing}</marketing><reason>${verdict.reason}</reason>`,
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 50,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// ── canned feed items ───────────────────────────────────────────────────────
//
// One obvious case study and one product release. Shipped as RawRelease
// objects directly because the upstream RSS parser is stubbed out.

const ITEMS_FOR_CLASSIFICATION: RawRelease[] = [
  {
    title: "How TestCo migrated from Postgres to ClickHouse",
    content: "How TestCo cut analytics query times by 100x with ClickHouse.",
    url: "https://clickhouse.com/blog/testco",
    publishedAt: new Date("2026-05-18T09:31:37.000Z"),
    isBreaking: false,
    media: [],
  },
  {
    title: "ClickHouse Release 26.4",
    content: "Native AI functions, faster joins, Arrow Flight SQL.",
    url: "https://clickhouse.com/blog/clickhouse-release-26-04",
    publishedAt: new Date("2026-05-17T08:00:00.000Z"),
    version: "26.4",
    isBreaking: false,
    media: [],
  },
];

// ── DB helpers ───────────────────────────────────────────────────────────────

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

async function seedFeedSource(db: ReturnType<typeof mkDb>, metadata: Record<string, unknown>) {
  await db
    .insert(organizations)
    .values({ id: "org_ch", slug: "clickhouse", name: "ClickHouse", category: "database" });
  await db.insert(sources).values({
    id: "src_ch_blog",
    orgId: "org_ch",
    slug: "clickhouse-blog",
    name: "ClickHouse Blog",
    type: "feed",
    url: "https://clickhouse.com/blog",
    metadata: JSON.stringify(metadata),
  });
}

// Stub env. The Anthropic key is a fake secret binding — only present when the
// test wants the classifier to actually fire. Embed bindings stay undefined so
// the inline embed step is a no-op (the assertion is about insert state, not
// vector writes).
function makeEnv(opts: { withAnthropic: boolean }): unknown {
  return {
    GITHUB_TOKEN: undefined,
    RELEASES_INDEX: undefined,
    CHANGELOG_CHUNKS_INDEX: undefined,
    ANTHROPIC_API_KEY: opts.withAnthropic ? { get: async () => "sk-ant-test-key" } : undefined,
  };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("fetchOne — metadata.marketingFilter", () => {
  beforeEach(() => {
    if (realFetch === undefined) realFetch = globalThis.fetch;
    feedFetchCalls.length = 0;
    nextFeedReleases = ITEMS_FOR_CLASSIFICATION;
  });
  afterEach(() => {
    restoreFetch();
  });

  it("does not call the classifier when marketingFilter is unset", async () => {
    let anthropicCalls = 0;
    installFetch((input) => {
      const url = urlOf(input);
      if (url.includes("api.anthropic.com")) {
        anthropicCalls++;
        return anthropicJson({ marketing: true, reason: "case_study" });
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedFeedSource(db, {
      feedUrl: "https://clickhouse.com/rss.xml",
      feedType: "rss",
      // marketingFilter intentionally unset
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_ch_blog"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv({ withAnthropic: true }) as any);

    expect(feedFetchCalls.length).toBe(1);
    expect(feedFetchCalls[0].feedUrl).toBe("https://clickhouse.com/rss.xml");
    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);
    expect(anthropicCalls).toBe(0);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows.every((r) => r.suppressed === false)).toBe(true);
  });

  it("suppresses marketing items at insert and lets product news through", async () => {
    installFetch((input, init) => {
      const url = urlOf(input);
      if (url.includes("api.anthropic.com")) {
        const bodyText = init?.body as string | undefined;
        if (bodyText?.includes("How TestCo migrated")) {
          return anthropicJson({ marketing: true, reason: "case_study" });
        }
        return anthropicJson({ marketing: false, reason: "not_marketing" });
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedFeedSource(db, {
      feedUrl: "https://clickhouse.com/rss.xml",
      feedType: "rss",
      marketingFilter: true,
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_ch_blog"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv({ withAnthropic: true }) as any);

    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);
    expect(result.insertedIds?.length).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    const marketingRow = byUrl.get("https://clickhouse.com/blog/testco");
    expect(marketingRow?.suppressed).toBe(true);
    expect(marketingRow?.suppressedReason).toBe("marketing_classifier:case_study");

    const productRow = byUrl.get("https://clickhouse.com/blog/clickhouse-release-26-04");
    expect(productRow?.suppressed).toBe(false);
    expect(productRow?.suppressedReason).toBeNull();

    expect(result.insertedIds?.[0]).toBe(productRow?.id);
  });

  it("counts only genuinely-new items against the per-fire cap", async () => {
    // Regression for the cap counting the full feed window: feeds re-list their
    // whole window every fetch (dbt-blog returns 25, ClickHouse 200), so a cap
    // checked against `rawReleases.length` trips on every fire and the
    // classifier never runs. Only items not already in the DB should count.
    let anthropicCalls = 0;
    installFetch((input, init) => {
      const url = urlOf(input);
      if (url.includes("api.anthropic.com")) {
        anthropicCalls++;
        const bodyText = init?.body as string | undefined;
        if (bodyText?.includes("How NewCo migrated")) {
          return anthropicJson({ marketing: true, reason: "case_study" });
        }
        return anthropicJson({ marketing: false, reason: "not_marketing" });
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedFeedSource(db, {
      feedUrl: "https://clickhouse.com/rss.xml",
      feedType: "rss",
      marketingFilter: true,
    });

    // Pre-seed 20 already-ingested rows whose URLs the feed will re-list.
    const existingUrls = Array.from(
      { length: 20 },
      (_, i) => `https://clickhouse.com/blog/existing-${i}`,
    );
    await db.insert(releases).values(
      existingUrls.map((u, i) => ({
        sourceId: "src_ch_blog",
        title: `Existing post ${i}`,
        content: "Already in the database.",
        url: u,
      })),
    );

    // Feed re-lists all 20 existing URLs plus one genuinely-new marketing item.
    // 21 total > cap (20); only the 1 new item should be classified.
    nextFeedReleases = [
      ...existingUrls.map((u, i) => ({
        title: `Existing post ${i}`,
        content: "Already in the database.",
        url: u,
        publishedAt: new Date("2026-05-01T00:00:00.000Z"),
        isBreaking: false,
        media: [],
      })),
      {
        title: "How NewCo migrated to ClickHouse",
        content: "How NewCo cut analytics query times by 100x with ClickHouse.",
        url: "https://clickhouse.com/blog/newco",
        publishedAt: new Date("2026-05-20T00:00:00.000Z"),
        isBreaking: false,
        media: [],
      },
    ];

    const [src] = await db.select().from(sources).where(eq(sources.id, "src_ch_blog"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv({ withAnthropic: true }) as any);

    expect(result.status).toBe("success");
    // Only the new row is inserted; the 20 existing collide and are skipped.
    expect(result.releasesInserted).toBe(1);
    // Classifier ran on exactly the one new item, not the whole feed window.
    expect(anthropicCalls).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    const newRow = rows.find((r) => r.url === "https://clickhouse.com/blog/newco");
    expect(newRow?.suppressed).toBe(true);
    expect(newRow?.suppressedReason).toBe("marketing_classifier:case_study");
    // Suppressed-at-insert row stays out of insertedIds.
    expect(result.insertedIds?.length).toBe(0);
  });

  it("still trips the cap when more than the cap's worth of items are genuinely new", async () => {
    // The cap is retained as a cost backstop — but on the new-item set, not the
    // re-listed feed window. A burst of >20 brand-new items skips classification
    // and inserts visibly for operator backfill.
    let anthropicCalls = 0;
    installFetch((input) => {
      const url = urlOf(input);
      if (url.includes("api.anthropic.com")) {
        anthropicCalls++;
        return anthropicJson({ marketing: true, reason: "case_study" });
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedFeedSource(db, {
      feedUrl: "https://clickhouse.com/rss.xml",
      feedType: "rss",
      marketingFilter: true,
    });

    nextFeedReleases = Array.from({ length: 21 }, (_, i) => ({
      title: `Brand-new post ${i}`,
      content: "Never seen before.",
      url: `https://clickhouse.com/blog/fresh-${i}`,
      publishedAt: new Date("2026-05-20T00:00:00.000Z"),
      isBreaking: false,
      media: [],
    }));

    const [src] = await db.select().from(sources).where(eq(sources.id, "src_ch_blog"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv({ withAnthropic: true }) as any);

    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(21);
    expect(anthropicCalls).toBe(0);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows.every((r) => r.suppressed === false)).toBe(true);
  });

  it("fails open when the classifier throws — inserts everything visibly", async () => {
    installFetch((input) => {
      const url = urlOf(input);
      if (url.includes("api.anthropic.com")) {
        // Garbage response forces parseMarketingVerdict to throw.
        return new Response(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "this is not the format we asked for" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 50, output_tokens: 8 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const db = mkDb();
    await seedFeedSource(db, {
      feedUrl: "https://clickhouse.com/rss.xml",
      feedType: "rss",
      marketingFilter: true,
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_ch_blog"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv({ withAnthropic: true }) as any);

    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    expect(rows.every((r) => r.suppressed === false)).toBe(true);
  });
});
