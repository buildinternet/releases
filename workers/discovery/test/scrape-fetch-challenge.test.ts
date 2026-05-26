/**
 * When Cloudflare Browser Rendering returns a Managed Challenge interstitial
 * (its datacenter egress fails the challenge), scrapeFetch must short-circuit
 * to a distinct `blocked` / `bot_challenge` signal instead of running extraction
 * on the interstitial and logging `no_change`. See issue #1171.
 *
 * Uses the REAL isCloudflareChallengePage detector — it lives in its own
 * module (@releases/adapters/cf-challenge), which we deliberately do NOT mock,
 * so this exercises true detection while only the impure markdown fetch
 * (@releases/adapters/cloudflare) is stubbed.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

const mockSource = {
  id: "src_test",
  orgId: "org_test",
  slug: "chatgpt-release-notes",
  url: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
  type: "scrape" as const,
  name: "ChatGPT release notes",
  metadata: null,
  feedUrl: null,
  feedType: null,
  feedEtag: null,
  feedLastModified: null,
  fetchPriority: "normal" as const,
  consecutiveErrors: 0,
  consecutiveNoChange: 0,
};

// A rendered Cloudflare Managed Challenge interstitial as Browser Rendering's
// /markdown converter would hand it back.
const CHALLENGE_MARKDOWN =
  "# Just a moment...\n\nhelp.openai.com\n\nVerifying you are human. This may take a few seconds.\n\nhelp.openai.com needs to review the security of your connection before proceeding.\n\nPerformance & security by Cloudflare";

mock.module("@releases/adapters/cloudflare", () => ({
  fetchCloudflareMarkdown: async () => CHALLENGE_MARKDOWN,
}));

mock.module("@releases/adapters/crawl", () => ({
  startCrawl: async () => "job_stub",
  pollCrawlResults: async () => [],
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

describe("scrapeFetch Cloudflare challenge detection", () => {
  beforeEach(() => {
    capturedFetchLogPayloads = [];
    // probeUpstreamStatus hits globalThis.fetch; keep it hermetic and "not gone"
    // so we reach the markdown stage.
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("short-circuits to a blocked/bot_challenge signal on a challenge interstitial", async () => {
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

    expect(result).toMatch(/^Blocked \[bot_challenge\]:/);
    expect(capturedFetchLogPayloads.length).toBeGreaterThan(0);
    const log = capturedFetchLogPayloads[capturedFetchLogPayloads.length - 1]!;
    expect(log.status).toBe("blocked");
    expect(log.errorCategory).toBe("bot_challenge");
  });
});
