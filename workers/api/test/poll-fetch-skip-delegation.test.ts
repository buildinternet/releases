/**
 * Covers the `skipDelegation` opt introduced in #1061.
 *
 * When `fetchOne` is called with `opts.skipDelegation = true` on a
 * summary-only, crawl-enabled source, it must NOT invoke
 * `delegateScrapeToDiscovery` — even if `DISCOVERY_WORKER` is present and
 * `shouldDelegateToCrawl` would normally return true. Instead it should
 * proceed with the inline parse-and-insert path.
 *
 * This simulates the fix for MA session self-collision: the API route sets
 * `skipDelegation` when it detects the `X-Releases-MA-Session` request header,
 * preventing the session from re-entering its own session-start path.
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

type StubSource = { type?: string; url: string; metadata: string | null };
type StubMeta = {
  feedUrl?: string;
  feedType?: string;
  githubUrl?: string;
  crawlEnabled?: boolean;
  feedContentDepth?: string;
};

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
  fetchAndParseFeed: async (feedUrl: string) => {
    feedFetchCalls.push(feedUrl);
    return {
      releases: nextFeedReleases,
      etag: undefined,
      lastModified: undefined,
      contentLength: undefined,
    };
  },
  synthesizeReleaseUrl: (args: { sourceUrl: string; version: string; template?: string }) => {
    const stripped = args.version.replace(/^v/i, "");
    return `${args.sourceUrl}#${stripped.replace(/\./g, "-")}`;
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

// Fake DISCOVERY_WORKER binding — records whether startManagedFetchSession was called.
function makeDiscoveryWorker() {
  const calls: unknown[] = [];
  return {
    calls,
    startManagedFetchSession: async (args: unknown) => {
      calls.push(args);
      return { ok: true };
    },
  };
}

function makeEnv(
  discoveryWorker?: ReturnType<
    typeof makeDiscoveryWorker
  >["startManagedFetchSession"] extends undefined
    ? undefined
    : ReturnType<typeof makeDiscoveryWorker>,
): unknown {
  return {
    GITHUB_TOKEN: undefined,
    RELEASES_INDEX: undefined,
    CHANGELOG_CHUNKS_INDEX: undefined,
    DISCOVERY_WORKER: discoveryWorker ?? undefined,
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
    const items = [{ content: "" }] as Parameters<typeof shouldDelegateToCrawl>[2];
    expect(shouldDelegateToCrawl(source, meta, items)).toBe(true);
  });

  it("returns true for scrape + crawlEnabled + all-empty-content batch", () => {
    const source = { type: "scrape" } as Parameters<typeof shouldDelegateToCrawl>[0];
    const meta = { crawlEnabled: true } as Parameters<typeof shouldDelegateToCrawl>[1];
    const items = [{ content: "" }, { content: "   " }] as Parameters<
      typeof shouldDelegateToCrawl
    >[2];
    expect(shouldDelegateToCrawl(source, meta, items)).toBe(true);
  });

  it("returns false for feed type", () => {
    const source = { type: "feed" } as Parameters<typeof shouldDelegateToCrawl>[0];
    const meta = { crawlEnabled: true, feedContentDepth: "summary-only" } as Parameters<
      typeof shouldDelegateToCrawl
    >[1];
    const items = [{ content: "" }] as Parameters<typeof shouldDelegateToCrawl>[2];
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

    const worker = makeDiscoveryWorker();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv(worker) as any);

    // Delegation should have been attempted — DISCOVERY_WORKER.startManagedFetchSession called
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

    const worker = makeDiscoveryWorker();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await fetchOne(db as any, src, makeEnv(worker) as any, {
      skipDelegation: true,
    });

    // DISCOVERY_WORKER must NOT have been called
    expect(worker.calls.length).toBe(0);
    // Inline path runs: releases are inserted
    expect(result.status).toBe("success");
    expect(result.releasesInserted).toBe(2);
    const rows = await db.select().from(releases).where(eq(releases.sourceId, "src_notion_blog"));
    expect(rows.length).toBe(2);
  });

  it("skips delegation when skipDelegation=true even if DISCOVERY_WORKER is present", async () => {
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

    const worker = makeDiscoveryWorker();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fetchOne(db as any, src, makeEnv(worker) as any, { skipDelegation: true });

    expect(worker.calls.length).toBe(0);
  });
});
