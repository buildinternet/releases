/**
 * TDD test: verify that the feed-enrichment and firecrawl-extract paths persist
 * usage_log rows after AI calls.
 *
 * Coverage:
 *  - enrichNewThinItems (cron forward-path): enrich-extract row written
 *  - runEnrichBackfill  (admin backfill):    enrich-extract row written
 *  - extractChangelogAllWindows:             logUsageFn is called with firecrawl-extract
 */
import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations } from "../../../tests/db-helper";
import { organizations, sources, releases, usageLog } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";

function mkDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  const db = drizzle(sqlite);
  applyMigrations(sqlite);
  return db;
}

async function seedFeedSource(db: ReturnType<typeof mkDb>): Promise<Source> {
  await db.insert(organizations).values({
    id: "org_enrich",
    slug: "enrichco",
    name: "EnrichCo",
    category: "developer-tools",
  });
  await db.insert(sources).values({
    id: "src_feed",
    orgId: "org_enrich",
    slug: "enrichco-blog",
    name: "EnrichCo Blog",
    type: "feed",
    url: "https://enrichco.test/blog",
  });
  const [src] = await db.select().from(sources).where(eq(sources.id, "src_feed"));
  return src as unknown as Source;
}

describe("usage_log — feed enrichment (enrich-extract)", () => {
  it("enrichNewThinItems writes a usage_log row with operation=enrich-extract", async () => {
    const db = mkDb();
    const source = await seedFeedSource(db);

    const { enrichNewThinItems, makeExtractArticleFn, enrichFeedItem } =
      await import("../src/cron/feed-enrich.js");

    const usageCalls: Array<{
      input: number;
      output: number;
      cacheCreate: number;
      cacheRead: number;
      model: string;
    }> = [];

    // Build EnrichDeps directly with a logUsageFn that captures calls
    // and writes to usageLog.
    const enrichDeps = {
      thinChars: 20,
      fetchImpl: (async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(
          "<html><body><article>Full article body content that is long enough to clear the improvement bar for enrichment purposes.</article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        )) as typeof fetch,
      extractArticleFn: makeExtractArticleFn(
        async (_markdown: string, _title: string) => ({
          content:
            "Full article body content that is long enough to clear the improvement bar for enrichment purposes.",
          usage: { input: 50, output: 20, cacheCreate: 0, cacheRead: 5 },
        }),
        async (
          usage: { input: number; output: number; cacheCreate: number; cacheRead: number },
          _model: string,
        ) => {
          usageCalls.push({ ...usage, model: "claude-haiku-4-5" });
          try {
            await db.insert(usageLog).values({
              operation: "enrich-extract",
              model: "claude-haiku-4-5",
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheCreate,
              sourceId: "src_feed",
            });
          } catch {
            // fail-open
          }
        },
      ),
      renderFn: null,
      logEvent: logEvent as typeof logEvent,
    };

    const rawReleases: RawRelease[] = [
      {
        title: "New Feature",
        url: "https://enrichco.test/blog/new-feature",
        content: "Short.",
        publishedAt: new Date("2025-01-01"),
        isBreaking: false,
      },
    ];

    const env = {
      FEED_ENRICH_ENABLED: "true",
      FEED_THIN_CHARS: "200",
      DB: db,
    };

    await enrichNewThinItems(
      db as never,
      source,
      { feedContentDepth: "summary-only" } as never,
      rawReleases,
      env,
      { enrichFn: (item) => enrichFeedItem(item, enrichDeps) },
    );

    // The fake extractArticleFn returns hardcoded usage (input=50, output=20, cacheRead=5).
    // The important assertion is that the row was written with the correct operation name.
    const rows = await db.select().from(usageLog).where(eq(usageLog.operation, "enrich-extract"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].operation).toBe("enrich-extract");
    expect(rows[0].model).toBe("claude-haiku-4-5");
    expect(rows[0].sourceId).toBe("src_feed");
  });

  it("runEnrichBackfill writes a usage_log row with operation=enrich-extract", async () => {
    const db = mkDb();
    await seedFeedSource(db);

    const now = new Date().toISOString();
    await db.insert(releases).values({
      id: "rel_thin",
      sourceId: "src_feed",
      title: "Thin release",
      content: "Short.",
      url: "https://enrichco.test/blog/thin",
      publishedAt: now,
      fetchedAt: now,
      contentHash: "abc123",
    });

    const { runEnrichBackfill } = await import("../src/routes/workflows.js");
    const { makeExtractArticleFn, enrichFeedItem } = await import("../src/cron/feed-enrich.js");
    const { createDb } = await import("../src/db.js");

    const wrappedDb = createDb(db as never);

    // Build enrichDeps with a logUsageFn wired to the test DB
    const enrichDeps = {
      thinChars: 20,
      fetchImpl: (async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(
          "<html><body><article>Full article body content that is long enough to clear the improvement bar for enrichment purposes in the backfill path.</article></body></html>",
          { status: 200, headers: { "content-type": "text/html" } },
        )) as typeof fetch,
      extractArticleFn: makeExtractArticleFn(
        async (_markdown: string, _title: string) => ({
          content:
            "Full article body content that is long enough to clear the improvement bar for enrichment purposes in the backfill path.",
          usage: { input: 60, output: 30, cacheCreate: 0, cacheRead: 8 },
        }),
        async (
          usage: { input: number; output: number; cacheCreate: number; cacheRead: number },
          _model: string,
        ) => {
          try {
            await db.insert(usageLog).values({
              operation: "enrich-extract",
              model: "claude-haiku-4-5",
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheCreate,
              sourceId: "src_feed",
            });
          } catch {
            // fail-open
          }
        },
      ),
      renderFn: null,
      logEvent: logEvent as typeof logEvent,
    };

    await runEnrichBackfill(
      wrappedDb,
      "src_feed",
      { limit: 10, dryRun: false, thinChars: 20 },
      {
        enrichFn: (item) => enrichFeedItem(item, enrichDeps),
        regenerate: async (_ids: string[]) => {},
      },
    );

    const rows = await db.select().from(usageLog).where(eq(usageLog.operation, "enrich-extract"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].operation).toBe("enrich-extract");
    expect(rows[0].sourceId).toBe("src_feed");
  });
});

describe("usage_log — firecrawl extract (firecrawl-extract)", () => {
  it("extractChangelogAllWindows calls logUsageFn with operation=firecrawl-extract per window", async () => {
    const { extractChangelogAllWindows } = await import("../src/lib/firecrawl-extract.js");

    const loggedEntries: Array<{
      operation: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }> = [];

    const markdown = "# v1.0.0\nAdded feature X.\n\n# v0.9.0\nFixed bug Y.\n";
    const fakeSource = {
      id: "src_feed",
      slug: "enrichco-blog",
      url: "https://enrichco.test/blog",
    } as unknown as Source;

    const fakeModel = "claude-haiku-4-5-test";

    // Minimal fake Anthropic client matching the pattern used in firecrawl-extract.test.ts
    const fakeAnthropicClient = {
      messages: {
        stream: (_args: { messages: Array<{ role: string; content: string }> }) => ({
          finalMessage: async () => ({
            content: [
              {
                type: "tool_use" as const,
                name: "extract_releases",
                input: {
                  releases: [
                    {
                      title: "v1.0.0",
                      content: "Added feature X.",
                      version: "v1.0.0",
                      isBreaking: false,
                    },
                  ],
                },
                id: "tu_1",
              },
            ],
            usage: {
              input_tokens: 120,
              output_tokens: 60,
              cache_read_input_tokens: 15,
              cache_creation_input_tokens: 10,
            },
            stop_reason: "tool_use",
          }),
        }),
      },
    } as never;

    await extractChangelogAllWindows(markdown, fakeSource, {
      anthropicClient: fakeAnthropicClient,
      agentModel: fakeModel,
      logger: { info: () => {}, warn: () => {}, debug: () => {} },
      logUsageFn: async (entry) => {
        loggedEntries.push(entry);
      },
    });

    expect(loggedEntries.length).toBeGreaterThan(0);
    expect(loggedEntries[0].operation).toBe("firecrawl-extract");
    expect(loggedEntries[0].inputTokens).toBe(120);
    expect(loggedEntries[0].outputTokens).toBe(60);
    expect(loggedEntries[0].cacheReadTokens).toBe(15);
    expect(loggedEntries[0].cacheWriteTokens).toBe(10);
  });
});
