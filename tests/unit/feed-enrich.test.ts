import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  enrichFeedItem,
  makeExtractArticleFn,
  parsePositiveInt,
  type EnrichDeps,
  enrichNewThinItems,
} from "../../workers/api/src/cron/feed-enrich.js";
import { createTestDb, clearAllTables, type TestDatabase } from "../db-helper.js";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";

const noop = (() => {}) as unknown as EnrichDeps["logEvent"];

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

function baseDeps(over: Partial<EnrichDeps>): EnrichDeps {
  return {
    thinChars: 600,
    fetchImpl: async () => htmlResponse("<p>shell</p>"),
    extractArticleFn: async () => ({ content: "", media: [] }),
    renderFn: null,
    logEvent: noop,
    ...over,
  };
}

const item = { url: "https://x.test/a", title: "A", summary: "one line teaser" };

describe("enrichFeedItem", () => {
  it("accepts the cheap path when content clears the bar", async () => {
    const deps = baseDeps({
      fetchImpl: async () => htmlResponse("<article>full</article>"),
      extractArticleFn: async () => ({
        content: "x".repeat(800),
        media: [{ type: "image", url: "https://x.test/i.png" }],
      }),
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("enriched");
    expect(res.via).toBe("fetch");
    expect(res.content!.length).toBe(800);
    expect(res.media).toHaveLength(1);
  });

  it("passes an abort signal to the cheap-path fetch (timeout guard)", async () => {
    let seenSignal: unknown;
    const deps = baseDeps({
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        seenSignal = init?.signal;
        return htmlResponse("<article>full</article>");
      },
      extractArticleFn: async () => ({ content: "x".repeat(800), media: [] }),
    });
    await enrichFeedItem(item, deps);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("escalates to render when the cheap path is still thin", async () => {
    let calls = 0;
    const deps = baseDeps({
      extractArticleFn: async ({ markdown }: { markdown: string; title: string }) => {
        calls++;
        return { content: markdown === "RENDERED" ? "y".repeat(800) : "tiny", media: [] };
      },
      renderFn: async () => "RENDERED",
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("enriched");
    expect(res.via).toBe("render");
    expect(calls).toBe(2);
  });

  it("skips render escalation when renderFn is null", async () => {
    const deps = baseDeps({
      extractArticleFn: async () => ({ content: "tiny", media: [] }),
      renderFn: null,
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("no_improvement");
  });

  it("skips a bad-shape URL without fetching", async () => {
    let fetched = 0;
    const deps = baseDeps({
      fetchImpl: async () => {
        fetched++;
        return htmlResponse("<article>full</article>");
      },
      extractArticleFn: async () => ({ content: "x".repeat(800), media: [] }),
    });
    const anchored = { ...item, url: "https://x.test/docs/changelog#march-2026" };
    const res = await enrichFeedItem(anchored, deps);
    expect(res.status).toBe("no_improvement");
    expect(fetched).toBe(0);
  });

  it("fails open on a thrown fetch error", async () => {
    const deps = baseDeps({
      fetchImpl: async () => {
        throw new Error("network");
      },
      renderFn: null,
    });
    const res = await enrichFeedItem(item, deps);
    expect(res.status).toBe("no_improvement");
  });

  it("clears the bar relative to a long summary", async () => {
    const longSummary = { ...item, summary: "z".repeat(700) };
    const deps = baseDeps({
      extractArticleFn: async () => ({ content: "z".repeat(800), media: [] }),
    });
    // bar = max(600, 700*1.5=1050) = 1050; 800 < 1050 => no improvement
    expect((await enrichFeedItem(longSummary, deps)).status).toBe("no_improvement");
  });
});

describe("parsePositiveInt", () => {
  it("falls back on missing, non-numeric, zero, or negative input", () => {
    expect(parsePositiveInt(undefined, 600)).toBe(600);
    expect(parsePositiveInt("abc", 600)).toBe(600);
    expect(parsePositiveInt("0", 10)).toBe(10);
    expect(parsePositiveInt("-5", 10)).toBe(10);
  });
  it("parses and floors a positive value", () => {
    expect(parsePositiveInt("600", 10)).toBe(600);
    expect(parsePositiveInt("7.9", 10)).toBe(7);
  });
});

describe("makeExtractArticleFn", () => {
  it("pulls media from the cleaned article body, not the full page", async () => {
    // runExtract returns only the article (one image); the page markdown also
    // carries chrome images that must NOT leak into the release media.
    const fn = makeExtractArticleFn(async () => ({
      content: "# Title\n\n![hero](https://cdn.test/hero.png)\n\nBody.",
    }));
    const page =
      "![logo](https://cdn.test/logo.png)\n\n# Title\n\n![hero](https://cdn.test/hero.png)\n\n" +
      "Body.\n\n## More posts\n\n![thumb](https://cdn.test/thumb.png)";

    const { media } = await fn({ markdown: page, title: "Title" });
    const urls = media.map((m: { url: string }) => m.url);
    expect(urls).toContain("https://cdn.test/hero.png");
    expect(urls).not.toContain("https://cdn.test/logo.png");
    expect(urls).not.toContain("https://cdn.test/thumb.png");
  });
});

let tdb: TestDatabase;
beforeAll(() => {
  tdb = createTestDb();
});
beforeEach(() => clearAllTables(tdb.db));
afterAll(() => tdb.cleanup());

async function seedSource() {
  await tdb.db
    .insert(organizations)
    .values({ id: "org_1", name: "Acme", slug: "acme", discovery: "curated" });
  await tdb.db.insert(sources).values({
    id: "src_1",
    slug: "acme-feed",
    name: "Acme Feed",
    type: "feed",
    url: "https://x.test",
    orgId: "org_1",
    discovery: "curated",
  });
  await tdb.db.insert(releases).values({
    id: "rel_existing",
    sourceId: "src_1",
    type: "feature",
    title: "old",
    content: "old body",
    url: "https://x.test/seen",
  });
  return { id: "src_1", slug: "acme-feed", orgId: "org_1" };
}

// Hoisted to module scope (captures nothing) per unicorn/consistent-function-scoping.
const raw = (url: string, thin: boolean) => ({
  title: "t",
  content: thin ? "teaser" : "x".repeat(2000),
  contentFromSummary: thin,
  url,
  isBreaking: false,
});

describe("enrichNewThinItems", () => {
  const env = { FEED_ENRICH_ENABLED: "true", FEED_THIN_CHARS: "600" } as any;

  it("returns empty when the kill switch is off", async () => {
    const source = await seedSource();
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      [raw("https://x.test/new", true)],
      { ...env, FEED_ENRICH_ENABLED: "false" },
      { enrichFn: async () => ({ status: "enriched", content: "X".repeat(800), media: [] }) },
    );
    expect(map.size).toBe(0);
  });

  it("enriches only new thin URLs and records markers", async () => {
    const source = await seedSource();
    const items = [
      raw("https://x.test/seen", true),
      raw("https://x.test/new", true),
      raw("https://x.test/full", false),
    ];
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      items,
      env,
      {
        enrichFn: async () => ({
          status: "enriched",
          via: "fetch",
          content: "X".repeat(800),
          media: [],
        }),
      },
    );
    expect([...map.keys()]).toEqual([1]);
    expect(map.get(1)!.content!.length).toBe(800);
    expect(map.get(1)!.marker.succeeded).toBe(true);
  });

  it("excludes thin items with a bad-shape URL from enrichment", async () => {
    const source = await seedSource();
    const items = [
      raw("https://x.test/docs/changelog#march-2026", true), // anchored fragment → skip
      raw("https://x.test/new-post", true), // clean permalink → enrich
    ];
    let enrichCalls = 0;
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      items,
      env,
      {
        enrichFn: async () => {
          enrichCalls++;
          return { status: "enriched", via: "fetch", content: "X".repeat(800), media: [] };
        },
      },
    );
    // Only the clean URL (index 1) is enriched; the anchored one is never attempted.
    expect([...map.keys()]).toEqual([1]);
    expect(enrichCalls).toBe(1);
  });

  it("marks enriched-without-content as a failure", async () => {
    const source = await seedSource();
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      [raw("https://x.test/new", true)],
      env,
      // Degenerate result: status enriched but no body — must not be marked succeeded.
      { enrichFn: async () => ({ status: "enriched", via: "fetch" }) },
    );
    const outcome = map.get(0)!;
    expect(outcome.marker.succeeded).toBe(false);
    expect(outcome.content).toBeUndefined();
  });

  it("does not treat a URL owned by another source as already-present", async () => {
    const source = await seedSource();
    await tdb.db.insert(sources).values({
      id: "src_2",
      slug: "other-feed",
      name: "Other",
      type: "feed",
      url: "https://y.test",
      orgId: "org_1",
      discovery: "curated",
    });
    await tdb.db.insert(releases).values({
      id: "rel_other",
      sourceId: "src_2",
      type: "feature",
      title: "o",
      content: "x",
      url: "https://x.test/other",
    });
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      [raw("https://x.test/other", true)],
      env,
      {
        enrichFn: async () => ({
          status: "enriched",
          via: "fetch",
          content: "X".repeat(800),
          media: [],
        }),
      },
    );
    expect(map.get(0)?.marker.succeeded).toBe(true);
  });

  it("records a failed marker but no content on no_improvement", async () => {
    const source = await seedSource();
    const map = await enrichNewThinItems(
      tdb.db as any,
      source as any,
      { feedContentDepth: "summary-only" } as any,
      [raw("https://x.test/new", true)],
      env,
      { enrichFn: async () => ({ status: "no_improvement" }) },
    );
    expect(map.get(0)!.content).toBeUndefined();
    expect(map.get(0)!.marker.succeeded).toBe(false);
  });
});
