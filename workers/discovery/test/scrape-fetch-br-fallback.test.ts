/**
 * When headless Cloudflare Browser Rendering returns empty (it can't hydrate a
 * page, or the /markdown converter chokes on it) but the origin serves good
 * static HTML to a plain GET, scrapeFetch must fall back to a non-headless
 * render:false fetch (`fetchCloudflareMarkdownFast`) before declaring the
 * source unreachable. See #1298 (amplitude/product-updates was BR-empty yet a
 * render:false fetch returned the full dated changelog).
 *
 * Uses the REAL isCloudflareChallengePage detector (not mocked). The positive
 * test feeds challenge-shaped markdown out of the fallback so the run
 * short-circuits to the `blocked` signal — which proves the fallback content
 * reached the downstream pipeline instead of hitting the BR-empty `infra`
 * error, without having to stand up the full extraction path.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";

const BR_EMPTY_ERROR = "Cloudflare Browser Rendering returned no content";

const mockSource = {
  id: "src_test",
  orgId: "org_test",
  slug: "product-updates",
  url: "https://amplitude.com/releases",
  type: "scrape" as const,
  name: "Amplitude product updates",
  metadata: null,
  feedUrl: null,
  feedType: null,
  feedEtag: null,
  feedLastModified: null,
  fetchPriority: "normal" as const,
  consecutiveErrors: 0,
  consecutiveNoChange: 0,
};

// Challenge-shaped markdown — fed out of the fallback so the real detector
// short-circuits to `blocked`, confirming the fallback output flowed downstream.
const CHALLENGE_MARKDOWN =
  "# Just a moment...\n\namplitude.com\n\nVerifying you are human. This may take a few seconds.\n\namplitude.com needs to review the security of your connection before proceeding.\n\nPerformance & security by Cloudflare";

// Per-test knobs for the mocked cloudflare module.
let fallbackReturn: string | null = CHALLENGE_MARKDOWN;
let fastCalls: Array<{ url: string; auth: unknown }> = [];

mock.module("@releases/adapters/cloudflare", () => ({
  // Headless Browser Rendering returns empty.
  fetchCloudflareMarkdown: async () => null,
  // Non-headless render:false fallback.
  fetchCloudflareMarkdownFast: async (url: string, auth: unknown) => {
    fastCalls.push({ url, auth });
    return fallbackReturn;
  },
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

function runScrapeFetch() {
  return import("../src/scrape-fetch.js").then(({ scrapeFetch }) =>
    scrapeFetch(
      {
        cloudflareAccountId: "acct",
        cloudflareApiToken: "tok",
        anthropicApiKey: "sk-test",
        apiFetcher: buildApiFetcher(),
        apiKey: "rel_key",
      },
      "src_test",
    ),
  );
}

describe("scrapeFetch render:false fallback when Browser Rendering is empty", () => {
  beforeEach(() => {
    capturedFetchLogPayloads = [];
    fastCalls = [];
    // probeUpstreamStatus hits globalThis.fetch; keep it hermetic and "not gone".
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("falls back to a render:false fetch (with auth) and uses its content", async () => {
    fallbackReturn = CHALLENGE_MARKDOWN;
    const result = await runScrapeFetch();

    // The fallback was invoked for the source URL, carrying worker auth.
    expect(fastCalls.length).toBe(1);
    expect(fastCalls[0]!.url).toBe("https://amplitude.com/releases");
    expect(fastCalls[0]!.auth).toEqual({ accountId: "acct", apiToken: "tok" });

    // We progressed PAST the BR-empty error using the fallback content (here it
    // happens to be a challenge page, so the real detector flags it `blocked`).
    expect(result).toMatch(/^Blocked \[bot_challenge\]:/);
    const errors = capturedFetchLogPayloads.map((p) => p.error ?? "");
    expect(errors).not.toContain(BR_EMPTY_ERROR);
  });

  it("still errors with the BR-empty signal when the fallback is also empty", async () => {
    fallbackReturn = null;
    const result = await runScrapeFetch();

    expect(fastCalls.length).toBe(1);
    expect(result).toBe(`Error [infra]: ${BR_EMPTY_ERROR} for https://amplitude.com/releases`);
    const last = capturedFetchLogPayloads[capturedFetchLogPayloads.length - 1]!;
    expect(last.status).toBe("error");
    expect(last.errorCategory).toBe("infra");
    expect(last.error).toBe(BR_EMPTY_ERROR);
  });
});
