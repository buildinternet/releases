/**
 * Failed-input-hash memoization on the crawl path (#1852 follow-up). A crawl
 * body that already maxed the output-token cap (`hitMaxTokens`) can only fail
 * the same way again on a byte-identical re-crawl, so re-running the
 * extraction just re-bills Anthropic for a guaranteed-doomed result. When the
 * freshly-crawled markdown hashes to `metadata.lastFailedExtractHash`, the
 * crawl branch must skip calling `extractFromBody` entirely and record a
 * distinct `skipped` fetch-log status — critically, WITHOUT resetting the
 * #1851 error backoff (no `updateSourceAfterFetch`, which the `no_change`
 * path calls and which zeroes `consecutiveErrors`/`nextFetchAfter`) and
 * WITHOUT re-triggering it either (no `model`-categorized throw, which would
 * bump `consecutiveErrors` again via fetch-log.ts's
 * `applyScrapeFailureBackoff` on every single skip).
 *
 * `extractFromBody` is stubbed via `mock.module("@releases/adapters/extract")`
 * (a bare specifier — reliably intercepted regardless of which file registers
 * it, unlike the relative `./extract-deps-worker.js` stub other scrape-fetch
 * tests use, which only shadows the real module for imports resolved from
 * the SAME directory as the mock.module call and is a no-op here). This
 * keeps every test hermetic — no real Anthropic client ever gets invoked.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { sha256Hex } from "@releases/core-internal/hash";
import { restoreGlobalFetch } from "../../../tests/global-fetch";
// Import the two crawl-branch dependencies scrape-fetch.ts actually exercises
// (mapEntries, CRAWL_SYSTEM_PROMPT) from their concrete submodule rather than
// the `@releases/adapters/extract` barrel, since that barrel is the specifier
// being mocked below — re-entering it from inside the mock factory (e.g. via
// a dynamic `import()` of the barrel) breaks module resolution.
import { mapEntries, CRAWL_SYSTEM_PROMPT } from "../../../packages/adapters/src/extract/shared.js";

const PAGE_URL = "https://harvey.ai/release-notes/2026-06-01";
const PAGE_MARKDOWN = "# 2026-06-01\n\nSome release content.";
// Mirrors acquireCrawlMarkdown's concatenation exactly (scrape-fetch.ts).
const CRAWL_MARKDOWN = `\n\n# ${PAGE_URL}\n\n${PAGE_MARKDOWN}\n\n`;
const CRAWL_MARKDOWN_HASH = sha256Hex(CRAWL_MARKDOWN);
const STALE_HASH = "a".repeat(64); // deliberately does not match CRAWL_MARKDOWN_HASH

function buildSource(metadata: Record<string, unknown>) {
  return {
    id: "src_djFtfbJFwNTRq_dKhinln",
    orgId: "org_test",
    slug: "release-notes",
    url: "https://harvey.ai/release-notes",
    type: "scrape" as const,
    name: "Harvey release notes",
    metadata: JSON.stringify(metadata),
    feedUrl: null,
    feedType: null,
    feedEtag: null,
    feedLastModified: null,
    fetchPriority: "normal" as const,
    consecutiveErrors: 3,
    consecutiveNoChange: 0,
  };
}

mock.module("@releases/adapters/crawl", () => ({
  startCrawl: async () => "job_x",
  pollCrawlResults: async () => [{ url: PAGE_URL, markdown: PAGE_MARKDOWN }],
}));

mock.module("@releases/adapters/user-agent", () => ({
  RELEASES_BOT_UA: "releases-test/1.0",
}));

// `hitMaxTokens` toggled per-test via this mutable box; the factory closes
// over it so each `it()` controls the next extraction outcome.
let nextExtractResult = {
  entries: [] as unknown[],
  totalInput: 100,
  totalOutput: 50,
  hitMaxTokens: false,
  mode: "oneshot" as const,
  toolRounds: null as number | null,
  toolChars: null as number | null,
  fallbackReason: null as string | null,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  modelUsed: "claude-haiku-4-5",
};

mock.module("@releases/adapters/extract", () => ({
  mapEntries,
  CRAWL_SYSTEM_PROMPT,
  extractFromBody: async () => nextExtractResult,
  // extract-deps-worker.ts (real, unmocked — see the module-comment above)
  // also imports this from the barrel; env.openrouterEnabled is unset in
  // every test here so it's never actually invoked.
  buildOpenRouterExtractModel: async () => undefined,
  // Unused by the crawl branch under test — stubbed only so the barrel's
  // named imports in scrape-fetch.ts resolve to something callable.
  runDirectFetchExtraction: async () => {
    throw new Error("runDirectFetchExtraction should not be called from the crawl branch");
  },
  runAgentExtraction: async () => {
    throw new Error("runAgentExtraction should not be called from the crawl branch");
  },
  runIncrementalExtraction: async () => {
    throw new Error("runIncrementalExtraction should not be called from the crawl branch");
  },
}));

type FetchLogPayload = { status: string; error?: string; errorCategory?: string | null };
let capturedFetchLogPayloads: FetchLogPayload[] = [];
let capturedMetadataPatches: Array<Record<string, unknown>> = [];
let capturedSourcePatches: Array<Record<string, unknown>> = [];
let mockSourceResponse: Record<string, unknown>;

function buildApiFetcher() {
  return {
    fetch: async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/v1/admin/logs/fetch")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        capturedFetchLogPayloads.push(body);
        return new Response(JSON.stringify({ id: "log_1", ...body }), { status: 201 });
      }
      if (url.includes("/playbook")) {
        return new Response("", { status: 404 });
      }
      if (url.includes("/known-releases")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith("/metadata") && init?.method === "PATCH") {
        const body = JSON.parse((init.body as string) ?? "{}");
        capturedMetadataPatches.push(body);
        return new Response("{}", { status: 200 });
      }
      if (url.includes("/v1/sources/") || url.includes("/v1/orgs/")) {
        if (init?.method === "PATCH") {
          const body = JSON.parse((init.body as string) ?? "{}");
          capturedSourcePatches.push(body);
          return new Response("{}", { status: 200 });
        }
        return new Response(JSON.stringify(mockSourceResponse), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
  };
}

async function runFetch() {
  const { scrapeFetch } = await import("../src/scrape-fetch.js");
  return scrapeFetch(
    {
      cloudflareAccountId: "acct",
      cloudflareApiToken: "tok",
      anthropicApiKey: "sk-test",
      apiFetcher: buildApiFetcher(),
      apiKey: "rel_key",
    },
    "src_djFtfbJFwNTRq_dKhinln",
  );
}

describe("scrapeFetch crawl-extract-skip memoization", () => {
  beforeEach(() => {
    capturedFetchLogPayloads = [];
    capturedMetadataPatches = [];
    capturedSourcePatches = [];
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    nextExtractResult = {
      entries: [],
      totalInput: 100,
      totalOutput: 50,
      hitMaxTokens: false,
      mode: "oneshot",
      toolRounds: null,
      toolChars: null,
      fallbackReason: null,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      modelUsed: "claude-haiku-4-5",
    };
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  it("skips extraction and writes a distinct `skipped` status when the crawl body matches the last failed-extract hash", async () => {
    mockSourceResponse = buildSource({
      crawlEnabled: true,
      lastFailedExtractHash: CRAWL_MARKDOWN_HASH,
    });

    const result = await runFetch();

    expect(result).toMatch(/^Skipped \[unchanged_failed_input\]:/);

    expect(capturedFetchLogPayloads).toHaveLength(1);
    const log = capturedFetchLogPayloads[0]!;
    expect(log.status).toBe("skipped");
    // No errorCategory on a skip — must never be "model"/"bot_challenge",
    // which would re-trigger fetch-log.ts's applyScrapeFailureBackoff and
    // bump consecutiveErrors again on every single skip.
    expect(log.errorCategory ?? null).toBeNull();

    // A skip must not reset the #1851 backoff. `updateSourceAfterFetch`
    // (called only by `finalize()`, the no_change/success path) is what
    // zeroes consecutiveErrors/nextFetchAfter — it must never run on a skip.
    const backoffResettingPatch = capturedSourcePatches.find(
      (p) => "consecutiveErrors" in p || "nextFetchAfter" in p,
    );
    expect(backoffResettingPatch).toBeUndefined();
    // The extraction call itself never ran, so there's nothing to (re-)memoize —
    // no `lastFailedExtractHash` write on a skip (the crawl-job-bookkeeping
    // PATCH from `acquireCrawlMarkdown` — lastCrawlJobId/lastCrawlAt — still
    // fires regardless and is unrelated to this memoization).
    const hashPatch = capturedMetadataPatches.find((p) => "lastFailedExtractHash" in p);
    expect(hashPatch).toBeUndefined();
  });

  it("does not skip when there is no stored failed-extract hash, and extracts normally", async () => {
    mockSourceResponse = buildSource({ crawlEnabled: true });
    nextExtractResult = { ...nextExtractResult, entries: [], hitMaxTokens: false };

    const result = await runFetch();

    expect(result).not.toMatch(/^Skipped/);
    expect(capturedFetchLogPayloads.some((p) => p.status === "skipped")).toBe(false);
  });

  it("clears a stale lastFailedExtractHash once extraction completes cleanly on a changed body (natural recovery)", async () => {
    mockSourceResponse = buildSource({
      crawlEnabled: true,
      // A DIFFERENT hash than the current crawl body — extraction must run
      // (not skip) since the body has changed since the last failure.
      lastFailedExtractHash: STALE_HASH,
    });
    nextExtractResult = { ...nextExtractResult, entries: [], hitMaxTokens: false };

    const result = await runFetch();

    expect(result).not.toMatch(/^Skipped/);
    const clearPatch = capturedMetadataPatches.find(
      (p) => "lastFailedExtractHash" in p && p.lastFailedExtractHash === null,
    );
    expect(clearPatch).toBeDefined();
  });

  it("persists the failed-extract hash (without clearing it) when extraction hits max_tokens on a fresh body", async () => {
    mockSourceResponse = buildSource({ crawlEnabled: true });
    nextExtractResult = { ...nextExtractResult, entries: [], hitMaxTokens: true };

    const result = await runFetch();

    // Existing #1852 behavior preserved: a maxed-out extraction still throws
    // a `model`-categorized error so fetch-log.ts's backoff/auto-pause fires.
    expect(result).toMatch(/^Error \[model\]:/);
    const log = capturedFetchLogPayloads[capturedFetchLogPayloads.length - 1]!;
    expect(log.errorCategory).toBe("model");

    const persistPatch = capturedMetadataPatches.find((p) => p.lastFailedExtractHash != null);
    expect(persistPatch).toBeDefined();
    expect(persistPatch!.lastFailedExtractHash).toBe(CRAWL_MARKDOWN_HASH);
  });
});
