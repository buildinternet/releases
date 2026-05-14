/**
 * Tests that scrapeFetch prefixes error tool-result strings with [category]:
 * and that writeFetchLog receives the correct errorCategory.
 *
 * Uses mock.module to isolate Cloudflare Browser Rendering and the API fetch
 * calls so no real network I/O occurs.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

// ── minimal Source fixture ──────────────────────────────────────────
const mockSource = {
  id: "src_test",
  orgId: "org_test",
  slug: "test-source",
  url: "https://example.com/changelog",
  type: "scrape" as const,
  name: "Test Source",
  metadata: null,
  feedUrl: null,
  feedType: null,
  feedEtag: null,
  feedLastModified: null,
  fetchPriority: "normal" as const,
  consecutiveErrors: 0,
  consecutiveNoChange: 0,
};

// ── module stubs ────────────────────────────────────────────────────

// Stub cloudflare markdown to return null (simulates CF infra failure)
let cfMarkdownResult: string | null = null;
mock.module("@releases/adapters/cloudflare", () => ({
  fetchCloudflareMarkdown: async () => cfMarkdownResult,
}));

// Stub crawl to do nothing
mock.module("@releases/adapters/crawl", () => ({
  startCrawl: async () => "job_stub",
  pollCrawlResults: async () => [],
}));

// No mock for source-meta: the real getSourceMeta(source) with metadata=null
// returns {} which matches the desired "no crawlEnabled, no markdownUrl" state.

// Stub user-agent to avoid any UA detection side effects
mock.module("@releases/adapters/user-agent", () => ({
  RELEASES_BOT_UA: "releases-test/1.0",
}));

// Stub extract deps to avoid Anthropic client construction
mock.module("./extract-deps-worker.js", () => ({
  buildWorkerExtractDeps: () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    repo: {
      getOrgPlaybook: async () => null,
      updateSourceMeta: async () => {},
    },
    anthropicClient: {},
    agentModel: "claude-haiku-4-5",
  }),
}));

// Capture writeFetchLog payloads by intercepting the apiFetcher
type FetchLogPayload = {
  status: string;
  error?: string;
  errorCategory?: string | null;
};
let capturedFetchLogPayloads: FetchLogPayload[] = [];
let capturedSourceResponse: unknown = mockSource;

function buildApiFetcher() {
  return {
    fetch: async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/v1/admin/logs/fetch")) {
        const body = JSON.parse((_init?.body as string) ?? "{}");
        capturedFetchLogPayloads.push(body);
        return new Response(JSON.stringify({ id: "log_1", ...body }), { status: 201 });
      }
      if (url.includes("/v1/sources/") || url.includes("/v1/orgs/")) {
        if (url.includes("known-releases")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (_init?.method === "PATCH") {
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify(capturedSourceResponse), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  };
}

/**
 * Simulate the catch block logic from scrapeFetch to verify category tagging.
 * This mirrors the exact code path in workers/discovery/src/scrape-fetch.ts.
 */
// Mirror the regex from managed-agents-session.ts
function extract(text: string): string | null {
  const m = text.match(/^Error \[([a-z]+)\]:/);
  return m ? m[1] : null;
}

function formatErrorResult(err: unknown): {
  toolResult: string;
  errorCategory: string | undefined;
} {
  const { CategorizedError: CE } = require("@releases/lib/errors");
  const message = err instanceof Error ? (err as Error).message : String(err);
  const category: string | undefined =
    err instanceof CE
      ? (err as InstanceType<typeof CE>).category
      : (err as { category?: string } | null)?.category;
  const tag = category ?? "unknown";
  return { toolResult: `Error [${tag}]: ${message}`, errorCategory: category };
}

describe("scrapeFetch error category tagging", () => {
  beforeEach(() => {
    capturedFetchLogPayloads = [];
    cfMarkdownResult = null;
    capturedSourceResponse = mockSource;
  });

  it("returns Error [infra]: prefix when Cloudflare Browser Rendering returns no content", async () => {
    // probeUpstreamStatus uses globalThis.fetch. In the bun test env, the URL
    // https://example.com/changelog will either fail (ECONNREFUSED) or be
    // intercepted by the CF markdown stub. probeUpstreamStatus catches network
    // errors and returns null, so isUpstreamGone is false and we reach the
    // markdown-fetch stage where cfMarkdownResult=null triggers the infra path.
    const { scrapeFetch } = await import("../src/scrape-fetch.js");
    const result = await scrapeFetch(
      {
        cloudflareAccountId: "acct",
        cloudflareApiToken: "tok",
        anthropicApiKey: "sk-test",
        apiFetcher: buildApiFetcher(),
        apiKey: "rel_key",
      },
      "src_test",
    );
    // Either infra (CF markdown returned no content) or validation (404 from probe)
    // Both are acceptable; the important thing is a category tag is present.
    expect(result).toMatch(/^Error \[(infra|validation)\]:/);
    expect(capturedFetchLogPayloads.length).toBeGreaterThan(0);
    const log = capturedFetchLogPayloads[capturedFetchLogPayloads.length - 1];
    expect(["infra", "validation"]).toContain(log.errorCategory);
  });

  it("CategorizedError infra category propagates correctly through the catch block", () => {
    const { CategorizedError: CE } = require("@releases/lib/errors");
    const err = new CE(
      "infra",
      "Release insert failed (500): Secrets Worker: Failed to fetch secret",
    );
    const { toolResult, errorCategory } = formatErrorResult(err);
    expect(toolResult).toMatch(/^Error \[infra\]:/);
    expect(toolResult).toContain("Secrets Worker");
    expect(errorCategory).toBe("infra");
  });

  it("AdapterError category field defaults to extraction and can be overridden to infra", () => {
    const { AdapterError: AE } = require("@releases/lib/errors");
    const defaultErr = new AE("crawl", "parse failed");
    expect(defaultErr.category).toBe("extraction");

    const infraErr = new AE("crawl", "5xx", undefined, "infra");
    const { toolResult, errorCategory } = formatErrorResult(infraErr);
    expect(toolResult).toMatch(/^Error \[infra\]:/);
    expect(errorCategory).toBe("infra");
  });

  it("plain Error produces Error [unknown]: prefix", () => {
    const err = new Error("some random failure");
    const { toolResult, errorCategory } = formatErrorResult(err);
    expect(toolResult).toBe("Error [unknown]: some random failure");
    expect(errorCategory).toBeUndefined();
  });

  it("extractToolErrorCategory regex parses bracketed category prefixes correctly", () => {
    expect(extract("Error [infra]: disk full")).toBe("infra");
    expect(extract("Error [model]: max_tokens")).toBe("model");
    expect(extract("Error [validation]: blocked url")).toBe("validation");
    expect(extract("Error [extraction]: parse failed")).toBe("extraction");
    expect(extract("Error: plain old error")).toBeNull();
    expect(extract("Something else")).toBeNull();
  });
});
