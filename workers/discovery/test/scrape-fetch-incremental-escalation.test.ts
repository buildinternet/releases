/**
 * Incremental-window escalation (#2193). `runIncrementalExtraction` feeds the
 * model a fixed ~200-line window starting at `findContentStart`. Confirmed on
 * langchain-changelog (docs.langchain.com/langsmith/changelog, a Mintlify
 * page): the window correctly lands on real content at line 0, but the
 * newest single entry alone runs ~285 markdown lines — the window is
 * exhausted mid-entry, and the five-plus older unindexed entries below it
 * never enter the model's view at all. The result is a clean `releasesFound:
 * 0` indistinguishable from genuine "nothing new".
 *
 * The fix: when the incremental pass returns zero releases, check whether the
 * page's content hash changed since the last successful fetch (or whether the
 * model itself flagged `needsMoreContext`). Either signal is suspicious for a
 * source with substantial known history — escalate once to a full-body
 * extraction (`extractFromBody`, which already tiers into the tool-loop for
 * bodies over the size threshold) instead of trusting the structural zero.
 *
 * `runIncrementalExtraction` / `extractFromBody` are stubbed via
 * `mock.module("@releases/adapters/extract")` — the same pattern already used
 * by the sibling scrape-fetch-*.test.ts files in this directory (this test
 * group runs discovery/tests/web/mcp/webhooks in one `bun test` process per
 * AGENTS.md; workers/api is isolated separately specifically because of this
 * kind of module-mock leak risk, so this mock must stay confined to
 * workers/discovery — never used from a test importing the barrel for real).
 *
 * `extract-deps-worker.ts` is left REAL (not mocked): its content-hash repo
 * methods (`peekContentHash`/`commitContentHash`) are thin `apiFetcher.fetch`
 * wrappers, so this test drives them by responding to the
 * `/v1/orgs/:org/sources/:id/content-hash` route directly — a relative
 * `mock.module("./extract-deps-worker.js", ...)` was tried first but doesn't
 * reliably shadow the module scrape-fetch.ts actually imports from a
 * different directory (bun's mock.module resolves relative specifiers
 * against the CALLING file, not the target import site — see
 * reference_bun_mockmodule_monorepo_leak.md), so it silently fell through to
 * the real network-backed implementation. Exercising the real repo against a
 * controlled fetcher is more faithful to production wiring anyway.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { restoreGlobalFetch } from "../../../tests/global-fetch";
import {
  mapEntries,
  CLOUDFLARE_SYSTEM_PROMPT,
  CRAWL_SYSTEM_PROMPT,
} from "../../../packages/adapters/src/extract/shared.js";
// Passed through (not stubbed) in the `@releases/adapters/extract` mock
// below — `extract-deps-worker.ts` (real, unmocked) imports these from the
// barrel unconditionally on every `buildWorkerExtractDeps` call, regardless
// of this test's scenario. A `mock.module` factory that omits or stubs a
// barrel export other test files in this same `bun test` process rely on can
// leak past this file (module mocks aren't file-scoped) — see
// reference_bun_mockmodule_monorepo_leak.md.
import { resolveToolLoopAiSdkModel } from "../../../packages/adapters/src/extract/resolve-tool-loop-model.js";
import { buildOpenRouterExtractModel } from "../../../packages/adapters/src/extract/openrouter-model.js";

const mockSource = {
  id: "src_test",
  orgId: "org_test",
  slug: "langchain-changelog",
  url: "https://docs.langchain.com/langsmith/changelog",
  type: "scrape" as const,
  name: "LangSmith changelog",
  metadata: null,
  feedUrl: null,
  feedType: null,
  feedEtag: null,
  feedLastModified: null,
  fetchPriority: "normal" as const,
  consecutiveErrors: 0,
  consecutiveNoChange: 0,
};

const MARKDOWN = "# LangSmith Cloud changelog\n\nsome content\n";
const KNOWN_RELEASES = [{ title: "v old entry", version: null, publishedAt: "2026-01-01" }];

mock.module("@releases/adapters/cloudflare", () => ({
  fetchCloudflareMarkdown: async () => MARKDOWN,
  fetchCloudflareMarkdownFast: async () => null,
}));

mock.module("@releases/adapters/crawl", () => ({
  startCrawl: async () => "job_stub",
  pollCrawlResults: async () => [],
}));

mock.module("@releases/adapters/user-agent", () => ({
  RELEASES_BOT_UA: "releases-test/1.0",
}));

// ── per-test knobs ──────────────────────────────────────────────────

let incrementalResult: {
  releases: unknown[];
  totalInput: number;
  totalOutput: number;
  needsMoreContext: boolean;
} = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: false };

let incrementalCalls = 0;
let escalationCalls: Array<{ body: string; systemPrompt: string; useToolLoop?: boolean }> = [];
let escalationResult: {
  entries: unknown[];
  totalInput: number;
  totalOutput: number;
  hitMaxTokens: boolean;
  mode: "oneshot" | "toolloop";
  toolRounds: number | null;
  toolChars: number | null;
  fallbackReason: string | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelUsed: string;
} = {
  entries: [],
  totalInput: 0,
  totalOutput: 0,
  hitMaxTokens: false,
  mode: "oneshot",
  toolRounds: null,
  toolChars: null,
  fallbackReason: null,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  modelUsed: "claude-haiku-4-5",
};
let escalationShouldThrow = false;

mock.module("@releases/adapters/extract", () => ({
  mapEntries,
  CLOUDFLARE_SYSTEM_PROMPT,
  CRAWL_SYSTEM_PROMPT,
  runIncrementalExtraction: async () => {
    incrementalCalls++;
    return incrementalResult;
  },
  extractFromBody: async (opts: { body: string; systemPrompt: string; useToolLoop?: boolean }) => {
    escalationCalls.push(opts);
    if (escalationShouldThrow) throw new Error("escalation boom");
    return escalationResult;
  },
  buildOpenRouterExtractModel,
  resolveToolLoopAiSdkModel,
  runDirectFetchExtraction: async () => {
    throw new Error("runDirectFetchExtraction should not be called from the incremental branch");
  },
  runAgentExtraction: async () => {
    throw new Error("runAgentExtraction should not be called (not a seed run)");
  },
}));

// ── content-hash control (drives the REAL peekContentHash/commitContentHash,
//    which are thin apiFetcher.fetch wrappers around /content-hash) ────────

type PeekMode = "unchanged" | "changed" | "throw";
let peekMode: PeekMode = "changed";
let commitContentHashCalls: Array<{ hash: string }> = [];
let usageLogCalls: unknown[] = [];

// ── API fetcher (source resolution, known-releases, fetch-log, content-hash) ─

type FetchLogPayload = { status: string; releasesFound: number; releasesInserted: number };
let capturedFetchLogPayloads: FetchLogPayload[] = [];
let capturedInserts: Array<{ releases: unknown[] }> = [];

function buildApiFetcher() {
  return {
    fetch: async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/content-hash")) {
        const isPeek = url.includes("peek=true");
        if (isPeek) {
          if (peekMode === "throw") throw new Error("content-hash peek network failure");
          return new Response(JSON.stringify({ unchanged: peekMode === "unchanged" }), {
            status: 200,
          });
        }
        // commitContentHash: no peek param — record it and report "changed"
        // (matches the real route: differing hash always returns unchanged:false).
        const body = JSON.parse((init?.body as string) ?? "{}");
        commitContentHashCalls.push({ hash: body.contentHash });
        return new Response(JSON.stringify({ unchanged: false }), { status: 200 });
      }
      if (url.includes("/v1/admin/logs/usage")) {
        usageLogCalls.push(JSON.parse((init?.body as string) ?? "{}"));
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/v1/admin/logs/fetch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        capturedFetchLogPayloads.push(body);
        return new Response(JSON.stringify({ id: "log_1", ...body }), { status: 201 });
      }
      if (url.includes("/known-releases")) {
        return new Response(JSON.stringify(KNOWN_RELEASES), { status: 200 });
      }
      if (url.includes("/playbook")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/batch") || url.endsWith("/releases")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        capturedInserts.push(body);
        return new Response(JSON.stringify({ inserted: body.releases?.length ?? 0, ids: [] }), {
          status: 200,
        });
      }
      if (url.includes("/v1/sources/") || url.includes("/v1/orgs/")) {
        if (init?.method === "PATCH") {
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify(mockSource), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  };
}

function runScrapeFetch() {
  return import("@releases/adapters/scrape-fetch").then(({ scrapeFetch }) =>
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

describe("scrapeFetch incremental-window escalation (#2193)", () => {
  beforeEach(() => {
    incrementalCalls = 0;
    escalationCalls = [];
    escalationShouldThrow = false;
    commitContentHashCalls = [];
    usageLogCalls = [];
    capturedFetchLogPayloads = [];
    capturedInserts = [];
    peekMode = "changed";
    incrementalResult = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: false };
    escalationResult = {
      entries: [],
      totalInput: 0,
      totalOutput: 0,
      hitMaxTokens: false,
      mode: "oneshot",
      toolRounds: null,
      toolChars: null,
      fallbackReason: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelUsed: "claude-haiku-4-5",
    };
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  it("escalates to full-body extraction when incremental returns 0 and the content hash changed, and persists the found releases", async () => {
    peekMode = "changed";
    incrementalResult = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: false };
    escalationResult = {
      ...escalationResult,
      entries: [
        {
          title: "July 13-17, 2026",
          content: "Weekly update",
          isBreaking: false,
        },
      ],
    };

    const result = await runScrapeFetch();

    expect(incrementalCalls).toBe(1);
    expect(escalationCalls).toHaveLength(1);
    expect(escalationCalls[0]!.systemPrompt).toBe(CLOUDFLARE_SYSTEM_PROMPT);
    expect(JSON.parse(result).releasesFound).toBe(1);
    expect(capturedInserts).toHaveLength(1);
    expect(usageLogCalls).toHaveLength(1);
    // Hash committed after a successful escalation so a subsequent
    // byte-identical fetch doesn't re-escalate forever.
    expect(commitContentHashCalls).toHaveLength(1);
  });

  it("does NOT escalate when incremental returns 0 and the content hash is unchanged", async () => {
    peekMode = "unchanged";
    incrementalResult = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: false };

    const result = await runScrapeFetch();

    expect(incrementalCalls).toBe(1);
    expect(escalationCalls).toHaveLength(0);
    expect(JSON.parse(result).status).toBe("no_change");
    // Nothing changed — no need to re-commit an identical hash.
    expect(commitContentHashCalls).toHaveLength(0);
  });

  it("escalates when the model itself flags needsMoreContext, even if the hash check says unchanged", async () => {
    peekMode = "unchanged";
    incrementalResult = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: true };

    await runScrapeFetch();

    expect(escalationCalls).toHaveLength(1);
  });

  it("does not escalate at all when incremental already found releases", async () => {
    incrementalResult = {
      releases: mapEntries(
        [
          {
            title: "v2",
            url: "https://x/2",
            content: "c",
            publishedAt: "2026-01-02",
            isBreaking: false,
          },
        ],
        { sourceUrl: mockSource.url },
      ),
      totalInput: 100,
      totalOutput: 10,
      needsMoreContext: false,
    };

    const result = await runScrapeFetch();

    expect(escalationCalls).toHaveLength(0);
    expect(JSON.parse(result).releasesFound).toBe(1);
  });

  it("fails open when the content-hash check errors — degrades to today's behavior (no escalation, no_change)", async () => {
    peekMode = "throw";
    incrementalResult = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: false };

    const result = await runScrapeFetch();

    expect(escalationCalls).toHaveLength(0);
    expect(JSON.parse(result).status).toBe("no_change");
  });

  it("fails open when the escalation call itself throws — still returns a clean no_change fetch result", async () => {
    peekMode = "changed";
    incrementalResult = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: false };
    escalationShouldThrow = true;

    const result = await runScrapeFetch();

    expect(escalationCalls).toHaveLength(1);
    expect(JSON.parse(result).status).toBe("no_change");
    expect(JSON.parse(result).releasesFound).toBe(0);
  });

  it("still commits the content hash when escalation runs but also finds nothing (verified zero)", async () => {
    peekMode = "changed";
    incrementalResult = { releases: [], totalInput: 100, totalOutput: 10, needsMoreContext: false };
    escalationResult = { ...escalationResult, entries: [] };

    const result = await runScrapeFetch();

    expect(escalationCalls).toHaveLength(1);
    expect(JSON.parse(result).status).toBe("no_change");
    expect(commitContentHashCalls).toHaveLength(1);
  });
});
