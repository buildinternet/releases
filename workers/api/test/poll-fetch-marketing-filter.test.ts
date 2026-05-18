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
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { fetchOne } from "../src/cron/poll-fetch.js";

// ── fetch mock ──────────────────────────────────────────────────────────────
//
// Captured per-test (in beforeEach), not at module load, so a prior test
// file's leaked mock can't end up as our "original" baseline. Required to keep
// `restoreFetch` from re-installing another suite's stale handler on CI when
// bun evaluates modules in a slightly different order than locally.

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

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml", ...headers },
  });
}

function anthropicJson(verdict: { marketing: boolean; reason: string }): Response {
  // Shape mirrors @anthropic-ai/sdk's MessageStream completion envelope.
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

// Hand-rolled RSS payload with one obvious case study and one product release.
// Kept inline so the test fully owns the feed-shape contract it tests against.
const CLICKHOUSE_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>ClickHouse Blog</title>
    <link>https://clickhouse.com/blog</link>
    <description>Test feed</description>
    <item>
      <title><![CDATA[How TestCo migrated from Postgres to ClickHouse]]></title>
      <link>https://clickhouse.com/blog/testco</link>
      <guid>https://clickhouse.com/blog/testco</guid>
      <pubDate>Mon, 18 May 2026 09:31:37 GMT</pubDate>
      <description><![CDATA[How TestCo cut analytics query times by 100x with ClickHouse.]]></description>
    </item>
    <item>
      <title><![CDATA[ClickHouse Release 26.4]]></title>
      <link>https://clickhouse.com/blog/clickhouse-release-26-04</link>
      <guid>https://clickhouse.com/blog/clickhouse-release-26-04</guid>
      <pubDate>Sun, 17 May 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[Native AI functions, faster joins, Arrow Flight SQL.]]></description>
    </item>
  </channel>
</rss>`;

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
  });
  afterEach(() => {
    restoreFetch();
  });

  it("does not call the classifier when marketingFilter is unset", async () => {
    let anthropicCalls = 0;
    installFetch((input) => {
      const url = urlOf(input);
      if (url === "https://clickhouse.com/rss.xml") return text(CLICKHOUSE_RSS);
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

    // Sanity-check the fetch mock ran. If this fails on CI it points at a
    // global-fetch ordering issue between test files, not at the classifier.
    expect(requestedUrls).toContain("https://clickhouse.com/rss.xml");
    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);
    expect(anthropicCalls).toBe(0);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    // Every row visible (none suppressed)
    expect(rows.every((r) => r.suppressed === false)).toBe(true);
  });

  it("suppresses marketing items at insert and lets product news through", async () => {
    installFetch((input, init) => {
      const url = urlOf(input);
      if (url === "https://clickhouse.com/rss.xml") return text(CLICKHOUSE_RSS);
      if (url.includes("api.anthropic.com")) {
        // Dispatch on the title carried in the user message so we can hold the
        // canonical verdict per item without parsing JSON path expressions.
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
    // Marketing-suppressed IDs are excluded from insertedIds so downstream
    // publish + embed never touch them.
    expect(result.insertedIds?.length).toBe(1);

    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_ch_blog"));
    const byUrl = new Map(rows.map((r) => [r.url, r]));

    const marketingRow = byUrl.get("https://clickhouse.com/blog/testco");
    expect(marketingRow?.suppressed).toBe(true);
    expect(marketingRow?.suppressedReason).toBe("marketing_classifier:case_study");

    const productRow = byUrl.get("https://clickhouse.com/blog/clickhouse-release-26-04");
    expect(productRow?.suppressed).toBe(false);
    expect(productRow?.suppressedReason).toBeNull();

    // And the returned insertedIds points to the product release, not the case study.
    expect(result.insertedIds?.[0]).toBe(productRow?.id);
  });

  it("fails open when the classifier throws — inserts everything visibly", async () => {
    installFetch((input) => {
      const url = urlOf(input);
      if (url === "https://clickhouse.com/rss.xml") return text(CLICKHOUSE_RSS);
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
    // Fail-open: both items visible despite the classifier throwing on each.
    expect(rows.every((r) => r.suppressed === false)).toBe(true);
  });
});
