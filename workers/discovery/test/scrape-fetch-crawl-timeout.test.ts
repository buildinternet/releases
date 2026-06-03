/**
 * When a crawl-enabled scrape source times out (Cloudflare `/crawl` throws a
 * `CrawlTimeoutError` after 300s) or otherwise errors, scrapeFetch must
 * short-circuit to a distinct `crawl_timeout` fetch-log status instead of
 * falling through to the index render → incremental → 0 new → a misleading
 * `no_change`. Mirrors the `blocked` short-circuit from #1171. See issue #1341.
 *
 * The crawl primitives are stubbed via `mock.module` (same pattern as the other
 * scrape-fetch integration tests in this dir): `pollCrawlResults` throws a real
 * `CrawlTimeoutError`, and the Cloudflare index render is stubbed to null so a
 * (buggy) fall-through would log `error: no content` — provably distinct from
 * the `crawl_timeout` status we assert.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { CrawlTimeoutError } from "@releases/lib/errors";

const mockSource = {
  id: "src_crawl",
  orgId: "org_test",
  slug: "product-updates",
  url: "https://beehiiv.com/product-updates",
  type: "scrape" as const,
  name: "beehiiv product updates",
  // crawl-enabled, per-post index — the exact shape from the #1341 repro.
  metadata: JSON.stringify({ crawlEnabled: true, crawlIncludePathPrefix: "/p/" }),
  feedUrl: null,
  feedType: null,
  feedEtag: null,
  feedLastModified: null,
  fetchPriority: "normal" as const,
  consecutiveErrors: 0,
  consecutiveNoChange: 0,
};

mock.module("@releases/adapters/cloudflare", () => ({
  // Index render returns nothing — if the crawl error wrongly fell through,
  // this path would log `error` ("no content"), not `crawl_timeout`.
  fetchCloudflareMarkdown: async () => null,
  fetchCloudflareMarkdownFast: async () => null,
}));

mock.module("@releases/adapters/crawl", () => ({
  startCrawl: async () => "job_timeout",
  pollCrawlResults: async () => {
    throw new CrawlTimeoutError("job_timeout", 300_000);
  },
}));

mock.module("@releases/adapters/user-agent", () => ({
  RELEASES_BOT_UA: "releases-test/1.0",
}));

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

type FetchLogPayload = { status: string; error?: string; errorCategory?: string | null };
let capturedFetchLogPayloads: FetchLogPayload[] = [];

function buildApiFetcher() {
  return {
    fetch: async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/v1/admin/logs/fetch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        capturedFetchLogPayloads.push(body);
        return new Response(JSON.stringify({ id: "log_1", ...body }), { status: 201 });
      }
      if (url.includes("/v1/sources/") || url.includes("/v1/orgs/")) {
        if (url.includes("known-releases")) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (init?.method === "PATCH") {
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify(mockSource), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  };
}

const originalFetch = globalThis.fetch;

describe("scrapeFetch crawl-timeout short-circuit", () => {
  beforeEach(() => {
    capturedFetchLogPayloads = [];
    // probeUpstreamStatus hits globalThis.fetch; keep it hermetic and "not gone"
    // so we reach the crawl stage.
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("writes crawl_timeout (not no_change) when the crawl throws a timeout", async () => {
    const { scrapeFetch } = await import("../src/scrape-fetch.js");
    const result = await scrapeFetch(
      {
        cloudflareAccountId: "acct",
        cloudflareApiToken: "tok",
        anthropicApiKey: "sk-test",
        apiFetcher: buildApiFetcher(),
        apiKey: "rel_key",
      },
      "src_crawl",
    );

    expect(result).toMatch(/^Degraded \[crawl_timeout\]:/);

    // Exactly one fetch-log write on the short-circuit — an accidental
    // double-write (e.g. a stray no_change before the timeout) would fail here.
    expect(capturedFetchLogPayloads).toHaveLength(1);
    const log = capturedFetchLogPayloads[0]!;
    expect(log.status).toBe("crawl_timeout");
    expect(log.errorCategory).toBe("infra");
    expect(log.error).toMatch(/timed out/);

    // The whole point of #1341: the timeout must NOT be masked as a healthy no-op.
    expect(capturedFetchLogPayloads.some((p) => p.status === "no_change")).toBe(false);
    expect(capturedFetchLogPayloads.some((p) => p.status === "success")).toBe(false);
  });
});
