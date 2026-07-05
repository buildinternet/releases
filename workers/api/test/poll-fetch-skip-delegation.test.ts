/**
 * Covers the `skipDelegation` opt introduced in #1061.
 *
 * When `fetchOne` is called with `opts.skipDelegation = true` on a
 * summary-only, crawl-enabled source, it must NOT invoke
 * `delegateScrapeToUpdateWorkflow` — even if the workflow binding is present
 * and `shouldDelegateToCrawl` would normally return true. Instead it should
 * proceed with the inline parse-and-insert path.
 *
 * This simulates the fix for update-run self-collision: the API route sets
 * `skipDelegation` when it detects the `X-Releases-MA-Session` request header,
 * preventing a run from re-entering its own dispatch path.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import { applyMigrations, ensureBatchShim } from "../../../tests/db-helper";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types";

// ── feed-adapter stub ───────────────────────────────────────────────────────
//
// Returns configurable RawRelease items with empty content so that
// `shouldDelegateToCrawl` considers the batch delegation-eligible (all items
// have no body). Per-test state is reset in beforeEach.

let nextFeedReleases: RawRelease[] = [];
const feedFetchCalls: string[] = [];

// Spread the real adapter as the base so exports the fetch path imports
// transitively — e.g. `htmlToMarkdown` via cron/feed-enrich.ts — resolve to
// their real (pure) implementations. Only the entry points this test needs to
// control are overridden below. Without the spread, every newly-imported feed
// export silently breaks this mock's ESM bindings at module-eval time (#1391).
//
// IMPORTANT: do NOT override the github-override-path helpers
// (`getSourceMeta`, `isGitHubFetched`, `effectiveGitHubUrl`,
// `synthesizeReleaseUrl`). `mock.module` is process-global and irreversible
// (AGENTS.md), so any override here leaks into the real-feed override test
// (poll-fetch-github-override.test.ts) when Bun evaluates this file first.
// This file's old hand-rolled `synthesizeReleaseUrl` dropped the
// `releaseUrlTemplate` arg, so the leak made that test synthesize the default
// `#anchor` URL instead of the templated one — a deterministic CI flake (#1565).
// `...actualFeed` already supplies the real, template-faithful implementations.
const actualFeed = await import("@releases/adapters/feed.js");

mock.module("@releases/adapters/feed.js", () => ({
  ...actualFeed,
  FEED_4XX_INVALIDATE_THRESHOLD: 5,
  CLEARED_FEED_FIELDS: {
    feedUrl: undefined,
    feedType: undefined,
    feedEtag: undefined,
    feedLastModified: undefined,
  },
  headCheckUrl: async () => ({ status: "changed" as const }),
  bodyHashCheck: async () => ({ status: "unchanged" as const, responseMs: 0 }),
  filterByCategoryAllow: (items: RawRelease[]) => ({ kept: items, dropped: 0 }),
  fetchAndParseFeed: async (feedUrl: string) => {
    feedFetchCalls.push(feedUrl);
    return {
      releases: nextFeedReleases,
      etag: undefined,
      lastModified: undefined,
      contentLength: undefined,
    };
  },
  extractMediaFromMarkdown: (_body: string) => [],
}));

// Import fetchOne + shouldDelegateToCrawl after mock.module is set up.
const { fetchOne, shouldDelegateToCrawl } = await import("../src/cron/poll-fetch.js");

// ── DB helpers ────────────────────────────────────────────────────────────────

function mkDb() {
  const sqlite = new Database(":memory:");
  const rawDb = drizzle(sqlite);
  applyMigrations(sqlite);
  return ensureBatchShim(rawDb);
}

async function seedScrapeSource(
  db: ReturnType<typeof mkDb>,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(organizations)
    .values({ id: "org_nd", slug: "notion", name: "Notion", category: "productivity" });
  await db.insert(sources).values({
    id: "src_notion_blog",
    orgId: "org_nd",
    slug: "notion-blog",
    name: "Notion Blog",
    type: "scrape",
    url: "https://notion.so/blog",
    metadata: JSON.stringify(metadata),
  });
}

// Fake DETERMINISTIC_UPDATE_WORKFLOW binding — records created instances
// (dispatch replaced the discovery RPC in #1946).
function makeUpdateWorkflow() {
  const calls: unknown[] = [];
  return {
    calls,
    create: async (opts: { id: string; params: unknown }) => {
      calls.push(opts.params);
      return {} as never;
    },
  };
}

function makeEnv(workflow?: ReturnType<typeof makeUpdateWorkflow>): unknown {
  return {
    GITHUB_TOKEN: undefined,
    RELEASES_INDEX: undefined,
    CHANGELOG_CHUNKS_INDEX: undefined,
    DETERMINISTIC_UPDATE_WORKFLOW: workflow ?? undefined,
  };
}

// ── summary-only items (no body → shouldDelegateToCrawl returns true) ─────────

const SUMMARY_ONLY_ITEMS: RawRelease[] = [
  {
    title: "Notion AI gets better at tables",
    content: "",
    url: "https://notion.so/blog/notion-ai-tables",
    publishedAt: new Date("2026-05-18T10:00:00Z"),
    isBreaking: false,
    media: [],
  },
  {
    title: "New sidebar navigation",
    content: "",
    url: "https://notion.so/blog/sidebar-nav",
    publishedAt: new Date("2026-05-17T10:00:00Z"),
    isBreaking: false,
    media: [],
  },
];

// ── tests ─────────────────────────────────────────────────────────────────────

describe("shouldDelegateToCrawl — unit", () => {
  it("returns true for scrape + crawlEnabled + summary-only depth", () => {
    const source = { type: "scrape" } as Parameters<typeof shouldDelegateToCrawl>[0];
    const meta = { crawlEnabled: true, feedContentDepth: "summary-only" } as Parameters<
      typeof shouldDelegateToCrawl
    >[1];
    const items = [{ title: "", content: "" }] as Parameters<typeof shouldDelegateToCrawl>[2];
    expect(shouldDelegateToCrawl(source, meta, items)).toBe(true);
  });

  it("returns true for scrape + crawlEnabled + all-empty-content batch", () => {
    const source = { type: "scrape" } as Parameters<typeof shouldDelegateToCrawl>[0];
    const meta = { crawlEnabled: true } as Parameters<typeof shouldDelegateToCrawl>[1];
    const items = [
      { title: "", content: "" },
      { title: "", content: "   " },
    ] as Parameters<typeof shouldDelegateToCrawl>[2];
    expect(shouldDelegateToCrawl(source, meta, items)).toBe(true);
  });

  it("returns false for feed type", () => {
    const source = { type: "feed" } as Parameters<typeof shouldDelegateToCrawl>[0];
    const meta = { crawlEnabled: true, feedContentDepth: "summary-only" } as Parameters<
      typeof shouldDelegateToCrawl
    >[1];
    const items = [{ title: "", content: "" }] as Parameters<typeof shouldDelegateToCrawl>[2];
    expect(shouldDelegateToCrawl(source, meta, items)).toBe(false);
  });
});

describe("fetchOne — skipDelegation option (#1061)", () => {
  beforeEach(() => {
    feedFetchCalls.length = 0;
    nextFeedReleases = SUMMARY_ONLY_ITEMS;
  });

  it("delegates to DISCOVERY_WORKER when skipDelegation is absent", async () => {
    const db = mkDb();
    await seedScrapeSource(db, {
      feedUrl: "https://notion.so/feed.xml",
      feedType: "rss",
      crawlEnabled: true,
      feedContentDepth: "summary-only",
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));

    const worker = makeUpdateWorkflow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv(worker) as any);

    // Delegation should have been attempted — a workflow instance created
    expect(worker.calls.length).toBe(1);
    // Delegation surfaces a dedicated "delegated" discriminant (#1056 / #1062).
    expect(result.status).toBe("delegated");
    // No releases were inserted (delegation skips inline insert)
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_notion_blog"));
    expect(rows.length).toBe(0);
  });

  it("skips delegation and inserts inline when skipDelegation=true", async () => {
    const db = mkDb();
    await seedScrapeSource(db, {
      feedUrl: "https://notion.so/feed.xml",
      feedType: "rss",
      crawlEnabled: true,
      feedContentDepth: "summary-only",
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));

    const worker = makeUpdateWorkflow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv(worker) as any, {
      skipDelegation: true,
    });

    // The workflow must NOT have been created
    expect(worker.calls.length).toBe(0);
    // Inline path runs: releases are inserted
    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_notion_blog"));
    expect(rows.length).toBe(2);
  });

  it("skips delegation when skipDelegation=true even if the workflow binding is present", async () => {
    // Belt-and-suspenders: same as above but we also assert that the worker
    // binding itself is not consulted at all.
    const db = mkDb();
    await seedScrapeSource(db, {
      feedUrl: "https://notion.so/feed.xml",
      feedType: "rss",
      crawlEnabled: true,
    });
    // Seed all-empty-content batch (empirical summary-only detection)
    nextFeedReleases = SUMMARY_ONLY_ITEMS;

    const [src] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));

    const worker = makeUpdateWorkflow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchOne(db as any, src, makeEnv(worker) as any, { skipDelegation: true });

    expect(worker.calls.length).toBe(0);
  });
});

// ── novelty gate ──────────────────────────────────────────────────────────────
//
// A summary-only crawl source whose feed window contains only URLs we've
// already indexed must NOT spawn a managed-agent crawl. It should fold into the
// standard no-change backoff instead. Delegation fires only when the feed
// surfaces a genuinely new release URL.

async function seedRelease(db: ReturnType<typeof mkDb>, url: string): Promise<void> {
  await db.insert(releases).values({
    sourceId: "src_notion_blog",
    title: `seeded ${url}`,
    content: "already indexed",
    url,
  });
}

describe("fetchOne — crawl novelty gate", () => {
  beforeEach(() => {
    feedFetchCalls.length = 0;
    nextFeedReleases = SUMMARY_ONLY_ITEMS;
  });

  it("skips delegation and records no_change when every feed URL already exists", async () => {
    const db = mkDb();
    await seedScrapeSource(db, {
      feedUrl: "https://notion.so/feed.xml",
      feedType: "rss",
      crawlEnabled: true,
      feedContentDepth: "summary-only",
    });
    // Both feed item URLs are already indexed → nothing new to crawl.
    await Promise.all(SUMMARY_ONLY_ITEMS.map((item) => seedRelease(db, item.url!)));
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));

    const worker = makeUpdateWorkflow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv(worker) as any);

    // No managed-agent session spawned.
    expect(worker.calls.length).toBe(0);
    // Folds into the no-change path.
    expect(result.status).toBe("no_change");
    expect(result.releasesInserted).toBe(0);
    expect(result.releasesFound).toBe(SUMMARY_ONLY_ITEMS.length);

    // Backoff advanced: consecutiveNoChange bumped and nextFetchAfter stamped.
    const [after] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));
    expect(after!.consecutiveNoChange).toBe(1);
    expect(after!.nextFetchAfter).not.toBeNull();
    expect(after!.changeDetectedAt).toBeNull();
  });

  it("delegates when at least one feed URL is new", async () => {
    const db = mkDb();
    await seedScrapeSource(db, {
      feedUrl: "https://notion.so/feed.xml",
      feedType: "rss",
      crawlEnabled: true,
      feedContentDepth: "summary-only",
    });
    // Only one of the two feed URLs is already indexed → the other is new.
    await seedRelease(db, SUMMARY_ONLY_ITEMS[1]!.url!);
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));

    const worker = makeUpdateWorkflow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv(worker) as any);

    expect(worker.calls.length).toBe(1);
    expect(result.status).toBe("delegated");
  });
});

// ── refusal cooldown (#1946 phase 2 nitpick) ────────────────────────────────
//
// When the dispatch gate REFUSES a summary-only delegation (kill switch / spend
// cap / lock), the source must NOT stay "due" and re-fire delegation every poll
// tick. `delegateScrapeToUpdateWorkflow` stamps a short `nextFetchAfter` cooldown
// on the refusal path to pace the retries — the runaway the success path guards.

describe("fetchOne — delegation refusal cooldown", () => {
  beforeEach(() => {
    feedFetchCalls.length = 0;
    nextFeedReleases = SUMMARY_ONLY_ITEMS;
  });

  it("stamps nextFetchAfter (no workflow instance) when dispatch is refused by the kill switch", async () => {
    const db = mkDb();
    await seedScrapeSource(db, {
      feedUrl: "https://notion.so/feed.xml",
      feedType: "rss",
      crawlEnabled: true,
      feedContentDepth: "summary-only",
    });
    const [src] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));

    const worker = makeUpdateWorkflow();
    // Kill switch ON → startDeterministicUpdate refuses before creating anything.
    const env = { ...(makeEnv(worker) as object), MA_SESSIONS_DISABLED: "true" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, env as any);

    // Refused: no workflow instance, surfaced as an error.
    expect(worker.calls.length).toBe(0);
    expect(result.status).toBe("error");

    // Cooldown stamped so the next poll tick doesn't immediately re-delegate.
    const [after] = await db.select().from(sources).where(eq(sources.id, "src_notion_blog"));
    expect(after!.nextFetchAfter).not.toBeNull();
    expect(new Date(after!.nextFetchAfter as string).getTime()).toBeGreaterThan(Date.now());
    // Refusal must not bump the no-change backoff counter.
    expect(after!.consecutiveNoChange ?? 0).toBe(0);
  });
});
