/**
 * Tests for the crawl-enabled dispatch branch in `runScrapePath` and the
 * `deriveCrawlPattern` helper.
 *
 * The dispatch tests use Bun's `mock.module` to intercept `startCrawl` /
 * `pollCrawlResults` calls and verify the branching logic without making real
 * HTTP requests.
 *
 * Coverage:
 *  1. deriveCrawlPattern — URL → include-pattern derivation
 *  2. crawlEnabled: true + crawl returns pages → uses crawl body, skips CF markdown
 *  3. crawlEnabled: true + crawl returns empty → falls back to fetchCloudflareMarkdown
 *  4. crawlEnabled: false (or absent) → no crawl call, existing path runs
 */

import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import type { CrawlPage } from "@releases/adapters/types";

// ── deriveCrawlPattern ─────────────────────────────────────────────

// Import the pure helper directly — no mocking needed here.
import { deriveCrawlPattern } from "../../workers/discovery/src/scrape-fetch";

describe("deriveCrawlPattern", () => {
  it("returns /changelog/** for https://resend.com/changelog", () => {
    expect(deriveCrawlPattern("https://resend.com/changelog")).toBe("/changelog/**");
  });

  it("strips trailing slash before building the pattern", () => {
    expect(deriveCrawlPattern("https://example.com/changelog/")).toBe("/changelog/**");
  });

  it("returns undefined for a bare domain (no meaningful path)", () => {
    expect(deriveCrawlPattern("https://example.com")).toBeUndefined();
  });

  it("returns undefined for a bare domain with trailing slash", () => {
    expect(deriveCrawlPattern("https://example.com/")).toBeUndefined();
  });

  it("builds a pattern from a deeper path", () => {
    expect(deriveCrawlPattern("https://example.com/docs/changelog")).toBe("/docs/changelog/**");
  });

  it("returns undefined for an unparseable URL", () => {
    expect(deriveCrawlPattern("not-a-url")).toBeUndefined();
  });
});

// ── Dispatch logic (mock.module) ────────────────────────────────────

// Mutable stubs — tests set these before calling scrapeFetch.
let startCrawlStub: (url: string, opts: unknown) => Promise<string> = async () => "job_1";
let pollCrawlResultsStub: (jobId: string) => Promise<CrawlPage[]> = async () => [];
let fetchCloudflareMarkdownStub: (
  url: string,
  accountId: string,
  apiToken: string,
) => Promise<string | null> = async () => "# CF markdown";

// Mocks must be registered before the module under test is imported.
// Bun resolves mock.module paths relative to the test file.
beforeAll(async () => {
  mock.module("@releases/adapters/crawl", () => ({
    startCrawl: (url: string, opts: unknown) => startCrawlStub(url, opts),
    pollCrawlResults: (jobId: string) => pollCrawlResultsStub(jobId),
  }));

  mock.module("@releases/adapters/cloudflare", () => ({
    fetchCloudflareMarkdown: (url: string, accountId: string, apiToken: string) =>
      fetchCloudflareMarkdownStub(url, accountId, apiToken),
    CF_REJECT_RESOURCE_TYPES: ["font", "stylesheet"],
    fetchCloudflareMarkdownFast: async () => null,
  }));

  // Stub out heavy extraction paths — the dispatch tests only care about
  // which content-acquisition branch ran; they don't need real AI responses.
  mock.module("@releases/adapters/extract", () => ({
    runIncrementalExtraction: async () => ({ releases: [] }),
    runAgentExtraction: async () => ({ releases: [] }),
    runDirectFetchExtraction: async () => ({ releases: [] }),
  }));

  // Stub the API fetcher dependencies used by buildWorkerExtractDeps.
  mock.module("@releases/lib/anthropic-client.js", () => ({
    buildAnthropicClient: () => ({}),
  }));
});

afterAll(() => {
  mock.restore();
});

// ── Source fixture ──────────────────────────────────────────────────

function makeSource(metaOverrides: Record<string, unknown> = {}): Source {
  return {
    id: "src_test",
    slug: "resend-changelog",
    name: "Resend Changelog",
    type: "scrape",
    url: "https://resend.com/changelog",
    orgId: "org_resend",
    productId: null,
    metadata: JSON.stringify(metaOverrides),
    createdAt: new Date().toISOString(),
    lastFetchedAt: null,
    changeDetectedAt: null,
    lastPolledAt: null,
    fetchPriority: "normal",
    consecutiveNoChange: 0,
    consecutiveErrors: 0,
    nextFetchAfter: null,
    etag: null,
    isHidden: 0,
    isPrimary: 0,
    discovery: "curated",
    suppressed: 0,
  } as unknown as Source;
}

// Minimal ScrapeEnv — the fetcher returns canned responses.
function makeEnv(
  sourceResponse: Source | null,
  knownReleases: unknown[] = [{ title: "v1.0", version: "1.0", publishedAt: null }],
) {
  const fetcher = {
    async fetch(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const path = url.pathname;

      // Source lookup
      if (path.includes("/sources/") && !path.includes("known-releases")) {
        if (!sourceResponse) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(sourceResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Known releases
      if (path.includes("known-releases")) {
        return new Response(JSON.stringify(knownReleases), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Playbook
      if (path.includes("/playbook")) {
        return new Response(JSON.stringify({ content: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Fetch log, source PATCH, metadata PATCH — all best-effort, return 200
      return new Response(JSON.stringify({ inserted: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };

  return {
    cloudflareAccountId: "acct_test",
    cloudflareApiToken: "tok_test",
    anthropicApiKey: "sk-test",
    apiFetcher: fetcher,
    apiKey: "api_test",
  };
}

// ── Dispatch tests ──────────────────────────────────────────────────

describe("scrape-path crawl dispatch", () => {
  it("calls startCrawl and uses crawl body when crawlEnabled is true and crawl returns pages", async () => {
    const pages: CrawlPage[] = [
      { url: "https://resend.com/changelog/welcome", markdown: "# Welcome\n\nHello world" },
      { url: "https://resend.com/changelog/v2", markdown: "# v2\n\nNew features" },
    ];

    let startCrawlCalled = false;
    let cfMarkdownCalled = false;

    startCrawlStub = async (_url, _opts) => {
      startCrawlCalled = true;
      return "job_abc";
    };
    pollCrawlResultsStub = async (_jobId) => pages;
    fetchCloudflareMarkdownStub = async () => {
      cfMarkdownCalled = true;
      return "# CF fallback";
    };

    const source = makeSource({ crawlEnabled: true, crawlPattern: "/changelog/**" });
    const env = makeEnv(source);

    // Dynamically import after mocks are registered.
    const { scrapeFetch } = await import("../../workers/discovery/src/scrape-fetch");
    await scrapeFetch(env, "resend/resend-changelog");

    expect(startCrawlCalled).toBe(true);
    expect(cfMarkdownCalled).toBe(false);
  });

  it("falls back to fetchCloudflareMarkdown when crawl returns zero pages", async () => {
    let cfMarkdownCalled = false;

    startCrawlStub = async () => "job_empty";
    pollCrawlResultsStub = async () => [];
    fetchCloudflareMarkdownStub = async () => {
      cfMarkdownCalled = true;
      return "# CF fallback";
    };

    const source = makeSource({ crawlEnabled: true, crawlPattern: "/changelog/**" });
    const env = makeEnv(source);

    const { scrapeFetch } = await import("../../workers/discovery/src/scrape-fetch");
    await scrapeFetch(env, "resend/resend-changelog");

    expect(cfMarkdownCalled).toBe(true);
  });

  it("does not call startCrawl when crawlEnabled is false", async () => {
    let startCrawlCalled = false;

    startCrawlStub = async () => {
      startCrawlCalled = true;
      return "job_x";
    };
    fetchCloudflareMarkdownStub = async () => "# CF content";

    const source = makeSource({ crawlEnabled: false });
    const env = makeEnv(source);

    const { scrapeFetch } = await import("../../workers/discovery/src/scrape-fetch");
    await scrapeFetch(env, "resend/resend-changelog");

    expect(startCrawlCalled).toBe(false);
  });

  it("does not call startCrawl when crawlEnabled is absent", async () => {
    let startCrawlCalled = false;

    startCrawlStub = async () => {
      startCrawlCalled = true;
      return "job_x";
    };
    fetchCloudflareMarkdownStub = async () => "# CF content";

    const source = makeSource({});
    const env = makeEnv(source);

    const { scrapeFetch } = await import("../../workers/discovery/src/scrape-fetch");
    await scrapeFetch(env, "resend/resend-changelog");

    expect(startCrawlCalled).toBe(false);
  });
});
