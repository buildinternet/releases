/**
 * Tests for the crawl-enabled dispatch helpers in `scrape-fetch.ts`:
 *
 *   - `deriveCrawlPattern`         — URL → include-pattern derivation (kept for back-compat)
 *   - `resolveCrawlIncludePatterns` — kept for back-compat, no longer wired to Cloudflare
 *   - `acquireCrawlMarkdown`        — dispatch with DI'd crawl primitives
 *
 * Crawl primitives are injected via the `CrawlDeps` parameter rather than
 * being intercepted with `mock.module`. Bun's `mock.module` is process-global
 * and leaks across test files (see `tests/mock-module.ts` and #615) — the
 * earlier mock.module-based version of this file broke the
 * scrape-agent-sweep-workflow and poll-and-fetch-workflow suites by replacing
 * `@releases/adapters/extract` with a factory missing most of its exports.
 * DI keeps these tests isolated.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import type { Source } from "@buildinternet/releases-core/schema";
import { CrawlTimeoutError } from "@releases/lib/errors";
import {
  acquireCrawlMarkdown,
  deriveCrawlPattern,
  pathMatchesIncludePrefix,
  resolveCrawlIncludePatterns,
  type CrawlDeps,
} from "@releases/adapters/scrape-fetch";
import { restoreGlobalFetch } from "../global-fetch";

// ── Fixtures ────────────────────────────────────────────────────────

function makeSource(): Source {
  return {
    id: "src_test",
    slug: "resend-changelog",
    name: "Resend Changelog",
    type: "scrape",
    url: "https://resend.com/changelog",
    orgId: "org_resend",
    productId: null,
    metadata: null,
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

interface DepsRecorder {
  startCrawlCalls: Array<{ url: string; options: unknown }>;
  pollCalls: string[];
  metaPatches: Array<{ sourceId: string; patch: Record<string, unknown> }>;
  deps: CrawlDeps;
}

function makeDeps(behavior: {
  pages?: Array<{ url: string; markdown: string }>;
  pollThrows?: Error;
  startThrows?: Error;
  jobId?: string;
  metaThrows?: Error;
}): DepsRecorder {
  const recorder: DepsRecorder = {
    startCrawlCalls: [],
    pollCalls: [],
    metaPatches: [],
    deps: {
      async startCrawl(url, options) {
        recorder.startCrawlCalls.push({ url, options });
        if (behavior.startThrows) throw behavior.startThrows;
        return behavior.jobId ?? "job_test";
      },
      async pollCrawlResults(jobId) {
        recorder.pollCalls.push(jobId);
        if (behavior.pollThrows) throw behavior.pollThrows;
        return behavior.pages ?? [];
      },
      async updateSourceMeta(source, patch) {
        recorder.metaPatches.push({ sourceId: source.id, patch });
        if (behavior.metaThrows) throw behavior.metaThrows;
      },
    },
  };
  return recorder;
}

// ── deriveCrawlPattern ─────────────────────────────────────────────

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

// ── pathMatchesIncludePrefix ───────────────────────────────────────

describe("pathMatchesIncludePrefix", () => {
  const source = "https://resend.com/changelog";

  it("returns true when prefix is empty (filter disabled)", () => {
    expect(pathMatchesIncludePrefix("https://resend.com/pricing", source, "")).toBe(true);
  });

  it("returns true when pathname starts with prefix", () => {
    expect(pathMatchesIncludePrefix("https://resend.com/changelog/v2", source, "/changelog/")).toBe(
      true,
    );
  });

  it("returns false when pathname is outside the prefix", () => {
    expect(pathMatchesIncludePrefix("https://resend.com/pricing", source, "/changelog/")).toBe(
      false,
    );
  });

  it("returns false for cross-origin URLs even when path would match", () => {
    expect(pathMatchesIncludePrefix("https://other.com/changelog/x", source, "/changelog/")).toBe(
      false,
    );
  });

  it("treats trailing-slash prefix strictly — `/changelog` matches but `/changelog2` does not", () => {
    expect(pathMatchesIncludePrefix("https://resend.com/changelog2", source, "/changelog/")).toBe(
      false,
    );
    expect(pathMatchesIncludePrefix("https://resend.com/changelog/x", source, "/changelog/")).toBe(
      true,
    );
  });

  it("returns false on a malformed pageUrl rather than throwing", () => {
    expect(pathMatchesIncludePrefix("not-a-url", source, "/changelog/")).toBe(false);
  });
});

// ── resolveCrawlIncludePatterns ────────────────────────────────────

describe("resolveCrawlIncludePatterns", () => {
  it("uses an explicit non-empty crawlPattern verbatim", () => {
    expect(resolveCrawlIncludePatterns("https://resend.com/changelog", "/posts/**")).toEqual([
      "/posts/**",
    ]);
  });

  it("returns an empty array when crawlPattern is the empty string (no filter)", () => {
    expect(resolveCrawlIncludePatterns("https://resend.com/changelog", "")).toEqual([]);
  });

  it("derives a default from source.url when crawlPattern is undefined", () => {
    expect(resolveCrawlIncludePatterns("https://resend.com/changelog", undefined)).toEqual([
      "/changelog/**",
    ]);
  });

  it("returns an empty array when crawlPattern is undefined and the URL has no path", () => {
    expect(resolveCrawlIncludePatterns("https://example.com", undefined)).toEqual([]);
  });
});

// ── acquireCrawlMarkdown ───────────────────────────────────────────

describe("acquireCrawlMarkdown", () => {
  it("returns concatenated markdown with URL headers when crawl returns pages", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls, pollCalls, metaPatches } = makeDeps({
      jobId: "job_abc",
      pages: [
        { url: "https://resend.com/changelog/welcome", markdown: "# Welcome\n\nHello world" },
        { url: "https://resend.com/changelog/v2", markdown: "# v2\n\nNew features" },
      ],
    });

    const { markdown, error } = await acquireCrawlMarkdown(
      source,
      { crawlExcludePatterns: [] },
      deps,
    );

    expect(error).toBeUndefined();
    expect(markdown).not.toBeNull();
    expect(markdown).toContain("# https://resend.com/changelog/welcome");
    expect(markdown).toContain("# https://resend.com/changelog/v2");
    expect(markdown).toContain("Hello world");
    expect(markdown).toContain("New features");

    expect(startCrawlCalls).toHaveLength(1);
    expect(startCrawlCalls[0].url).toBe("https://resend.com/changelog");
    expect(pollCalls).toEqual(["job_abc"]);

    // Best-effort metadata persistence after a successful crawl.
    expect(metaPatches).toHaveLength(1);
    expect(metaPatches[0].sourceId).toBe(source.id);
    expect(metaPatches[0].patch.lastCrawlJobId).toBe("job_abc");
    expect(typeof metaPatches[0].patch.lastCrawlAt).toBe("string");
  });

  it("returns markdown:null with no error (legitimate fall-through) when crawl returns zero pages", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls, metaPatches } = makeDeps({ jobId: "job_empty", pages: [] });

    const { markdown, error } = await acquireCrawlMarkdown(source, {}, deps);

    // Zero pages is NOT an error — the caller falls back to the index render.
    expect(markdown).toBeNull();
    expect(error).toBeUndefined();
    expect(startCrawlCalls).toHaveLength(1);
    expect(metaPatches).toHaveLength(0);
  });

  it("surfaces an error (not a bare null) when startCrawl throws", async () => {
    const source = makeSource();
    const { deps, metaPatches } = makeDeps({ startThrows: new Error("crawl API down") });

    const { markdown, error } = await acquireCrawlMarkdown(source, {}, deps);

    // A thrown crawl error must NOT look like a clean fall-through (#1341) —
    // the caller short-circuits to a distinct crawl_timeout status.
    expect(markdown).toBeNull();
    expect(error).toBeDefined();
    expect(error?.message).toContain("crawl API down");
    expect(metaPatches).toHaveLength(0);
  });

  it("surfaces an error when pollCrawlResults throws", async () => {
    const source = makeSource();
    const { deps, metaPatches } = makeDeps({ pollThrows: new Error("poll 500") });

    const { markdown, error } = await acquireCrawlMarkdown(source, {}, deps);

    expect(markdown).toBeNull();
    expect(error).toBeDefined();
    expect(error?.message).toContain("poll 500");
    expect(metaPatches).toHaveLength(0);
  });

  it("carries the infra category and timeout message when the crawl times out (#1341)", async () => {
    const source = makeSource();
    const { deps } = makeDeps({ pollThrows: new CrawlTimeoutError("job_slow", 300_000) });

    const { markdown, error } = await acquireCrawlMarkdown(source, {}, deps);

    expect(markdown).toBeNull();
    expect(error?.category).toBe("infra");
    expect(error?.message).toMatch(/timed out after 300s/);
  });

  it("default behavior (no overrides) — startCrawl receives includeExternalLinks: false and no excludePatterns", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls } = makeDeps({ pages: [] });

    await acquireCrawlMarkdown(source, {}, deps);

    expect(startCrawlCalls).toHaveLength(1);
    const opts = startCrawlCalls[0].options as {
      excludePatterns?: string[];
      includeExternalLinks?: boolean;
    };
    expect(opts.excludePatterns).toBeUndefined();
    expect(opts.includeExternalLinks).toBeUndefined();
  });

  it("crawlExcludePatterns set — startCrawl receives those patterns", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls } = makeDeps({ pages: [] });

    const excludePatterns = [
      "https://resend.com/humans/**",
      "https://resend.com/home",
      "https://resend.com/pricing",
      "https://resend.com/login",
      "https://resend.com/signup",
    ];

    await acquireCrawlMarkdown(source, { crawlExcludePatterns: excludePatterns }, deps);

    expect(startCrawlCalls).toHaveLength(1);
    const opts = startCrawlCalls[0].options as { excludePatterns?: string[] };
    expect(opts.excludePatterns).toEqual(excludePatterns);
  });

  it("crawlIncludeExternal: true — startCrawl receives includeExternalLinks: true", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls } = makeDeps({ pages: [] });

    await acquireCrawlMarkdown(source, { crawlIncludeExternal: true }, deps);

    expect(startCrawlCalls).toHaveLength(1);
    const opts = startCrawlCalls[0].options as { includeExternalLinks?: boolean };
    expect(opts.includeExternalLinks).toBe(true);
  });

  it("legacy crawlPattern set but no crawlExcludePatterns — crawlPattern not passed to startCrawl", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls } = makeDeps({ pages: [] });

    // crawlPattern is deprecated; acquireCrawlMarkdown no longer wires it to
    // Cloudflare's includePatterns (which is broken — see #929).
    await acquireCrawlMarkdown(source, { crawlPattern: "/changelog/**" }, deps);

    expect(startCrawlCalls).toHaveLength(1);
    const opts = startCrawlCalls[0].options as {
      includePatterns?: string[];
      excludePatterns?: string[];
    };
    expect(opts.includePatterns).toBeUndefined();
    expect(opts.excludePatterns).toBeUndefined();
  });

  it("forwards crawlSource and crawlRender overrides to startCrawl", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls } = makeDeps({ pages: [] });

    await acquireCrawlMarkdown(
      source,
      { crawlSource: "sitemaps", crawlRender: false, crawlMaxAge: 3600 },
      deps,
    );

    const opts = startCrawlCalls[0].options as {
      source?: string;
      render?: boolean;
      maxAge?: number;
    };
    expect(opts.source).toBe("sitemaps");
    expect(opts.render).toBe(false);
    expect(opts.maxAge).toBe(3600);
  });

  it("crawlIncludePathPrefix set — drops pages outside the prefix", async () => {
    const source = makeSource();
    const { deps, metaPatches } = makeDeps({
      jobId: "job_filtered",
      pages: [
        { url: "https://resend.com/changelog/welcome", markdown: "kept body 1" },
        { url: "https://resend.com/pricing", markdown: "filtered out" },
        { url: "https://resend.com/changelog/v2", markdown: "kept body 2" },
        { url: "https://resend.com/", markdown: "filtered out too" },
      ],
    });

    const { markdown } = await acquireCrawlMarkdown(
      source,
      { crawlIncludePathPrefix: "/changelog/" },
      deps,
    );

    expect(markdown).not.toBeNull();
    expect(markdown).toContain("kept body 1");
    expect(markdown).toContain("kept body 2");
    expect(markdown).not.toContain("filtered out");
    expect(markdown).toContain("# https://resend.com/changelog/welcome");
    expect(markdown).toContain("# https://resend.com/changelog/v2");
    expect(markdown).not.toContain("# https://resend.com/pricing");

    // Metadata persistence still runs once kept pages survive the filter.
    expect(metaPatches).toHaveLength(1);
    expect(metaPatches[0].patch.lastCrawlJobId).toBe("job_filtered");
  });

  it("crawlIncludePathPrefix drops every page → returns null (caller falls back)", async () => {
    const source = makeSource();
    const { deps, metaPatches } = makeDeps({
      jobId: "job_all_filtered",
      pages: [
        { url: "https://resend.com/pricing", markdown: "no" },
        { url: "https://resend.com/login", markdown: "also no" },
      ],
    });

    const { markdown, error } = await acquireCrawlMarkdown(
      source,
      { crawlIncludePathPrefix: "/changelog/" },
      deps,
    );

    // Every page filtered out is a legitimate fall-through, not a crawl error.
    expect(markdown).toBeNull();
    expect(error).toBeUndefined();
    // No metadata persistence when the post-filter wipes out the page set —
    // there's no successful crawl to anchor the lastCrawlJobId to.
    expect(metaPatches).toHaveLength(0);
  });

  it("crawlIncludePathPrefix never passed — no filtering happens", async () => {
    const source = makeSource();
    const { deps } = makeDeps({
      jobId: "job_no_filter",
      pages: [
        { url: "https://resend.com/changelog/post", markdown: "body" },
        { url: "https://resend.com/pricing", markdown: "kept too" },
      ],
    });

    const { markdown } = await acquireCrawlMarkdown(source, {}, deps);

    expect(markdown).toContain("body");
    expect(markdown).toContain("kept too");
  });

  it("does not throw when updateSourceMeta rejects (best-effort persistence)", async () => {
    const source = makeSource();
    const { deps } = makeDeps({
      jobId: "job_ok",
      pages: [{ url: "https://resend.com/changelog/post", markdown: "body" }],
      metaThrows: new Error("api down"),
    });

    // Should still return concatenated markdown — the .catch(() => {}) in
    // acquireCrawlMarkdown swallows the rejection.
    const { markdown } = await acquireCrawlMarkdown(source, {}, deps);
    expect(markdown).toContain("body");

    // Give the swallowed rejection a tick to settle so an unhandled-rejection
    // warning would surface here if the catch were missing.
    await Promise.resolve();
  });
});

// ── startCrawl body shape ─────────────────────────────────────────
// Direct unit tests for startCrawl itself. We mock `fetch` via a simple
// wrapper so we can inspect the request body without hitting Cloudflare.

import { startCrawl } from "../../packages/adapters/src/crawl";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetchForCrawl(returnJobId: string): {
  restore: () => void;
  capturedBodies: unknown[];
  capturedRequests: CapturedRequest[];
} {
  const capturedBodies: unknown[] = [];
  const capturedRequests: CapturedRequest[] = [];

  // @ts-expect-error — overriding globalThis.fetch for test isolation
  globalThis.fetch = async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      Object.keys(h).forEach((k) => {
        headers[k.toLowerCase()] = h[k];
      });
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    capturedBodies.push(body);
    capturedRequests.push({ url: String(url), headers, body });
    return new Response(JSON.stringify({ success: true, result: returnJobId }), { status: 200 });
  };

  return {
    restore: () => {
      restoreGlobalFetch();
    },
    capturedBodies,
    capturedRequests,
  };
}

describe("startCrawl body shape", () => {
  // startCrawl calls crawlBaseUrl() which throws when CLOUDFLARE_ACCOUNT_ID is
  // absent. Set dummy env vars so the function reaches the fetch() call, which
  // we mock anyway.
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;
  beforeAll(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "test_account";
    process.env.CLOUDFLARE_API_TOKEN = "test_token";
  });
  afterAll(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
  });

  it("excludePatterns populated → body.options.excludePatterns is the array", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_1");
    try {
      await startCrawl("https://example.com/changelog", {
        excludePatterns: ["https://example.com/humans/**", "https://example.com/login"],
      });
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    const opts = body.options as Record<string, unknown> | undefined;
    expect(opts?.excludePatterns).toEqual([
      "https://example.com/humans/**",
      "https://example.com/login",
    ]);
  });

  it("no exclude patterns → no body.options.excludePatterns (body.options still carries includeExternalLinks default)", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_2");
    try {
      await startCrawl("https://example.com/changelog", {});
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    const opts = body.options as Record<string, unknown> | undefined;
    expect(opts?.excludePatterns).toBeUndefined();
    // body.options is always present because includeExternalLinks defaults are nested under it
    expect(opts?.includeExternalLinks).toBe(false);
  });

  it("includeExternalLinks defaults false under body.options", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_3");
    try {
      await startCrawl("https://example.com/changelog", {});
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    // Cloudflare requires this nested under options, not at top level
    expect(body.includeExternalLinks).toBeUndefined();
    const opts = body.options as Record<string, unknown> | undefined;
    expect(opts?.includeExternalLinks).toBe(false);
  });

  it("includeExternalLinks forwarded when set to true (nested under body.options)", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_4");
    try {
      await startCrawl("https://example.com/changelog", { includeExternalLinks: true });
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.includeExternalLinks).toBeUndefined();
    const opts = body.options as Record<string, unknown> | undefined;
    expect(opts?.includeExternalLinks).toBe(true);
  });

  it("legacy includePatterns option ignored — not passed to Cloudflare", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_5");
    try {
      await startCrawl("https://example.com/changelog", {
        includePatterns: ["/changelog/**"],
      });
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    const opts = body.options as Record<string, unknown> | undefined;
    expect(opts?.includePatterns).toBeUndefined();
    // Ensure no top-level includePatterns either
    expect((body as Record<string, unknown>).includePatterns).toBeUndefined();
  });
});

// ── startCrawl credential threading ──────────────────────────────
// Verify that explicit CrawlAuth args take precedence over process.env, and
// that the fallback to process.env still works when no auth is provided.

describe("startCrawl credential threading", () => {
  const originalAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalApiToken = process.env.CLOUDFLARE_API_TOKEN;

  afterAll(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = originalAccountId;
    process.env.CLOUDFLARE_API_TOKEN = originalApiToken;
  });

  it("explicit auth → request URL contains the supplied accountId", async () => {
    // Clear env so we can prove the explicit arg is used, not process.env
    process.env.CLOUDFLARE_ACCOUNT_ID = "";
    process.env.CLOUDFLARE_API_TOKEN = "";

    const { restore, capturedRequests } = mockFetchForCrawl("job_auth_1");
    try {
      await startCrawl(
        "https://example.com/changelog",
        {},
        { accountId: "test-acct", apiToken: "test-tok" },
      );
    } finally {
      restore();
    }

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0].url).toContain("/accounts/test-acct/");
  });

  it("explicit auth → Authorization header is 'Bearer test-tok'", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "";
    process.env.CLOUDFLARE_API_TOKEN = "";

    const { restore, capturedRequests } = mockFetchForCrawl("job_auth_2");
    try {
      await startCrawl(
        "https://example.com/changelog",
        {},
        { accountId: "test-acct", apiToken: "test-tok" },
      );
    } finally {
      restore();
    }

    expect(capturedRequests[0].headers["authorization"]).toBe("Bearer test-tok");
  });

  it("no auth arg → falls back to process.env values", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "env-account";
    process.env.CLOUDFLARE_API_TOKEN = "env-token";

    const { restore, capturedRequests } = mockFetchForCrawl("job_auth_3");
    try {
      await startCrawl("https://example.com/changelog", {});
    } finally {
      restore();
    }

    expect(capturedRequests[0].url).toContain("/accounts/env-account/");
    expect(capturedRequests[0].headers["authorization"]).toBe("Bearer env-token");
  });

  it("explicit auth takes precedence over process.env when both are set", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "env-account";
    process.env.CLOUDFLARE_API_TOKEN = "env-token";

    const { restore, capturedRequests } = mockFetchForCrawl("job_auth_4");
    try {
      await startCrawl(
        "https://example.com/changelog",
        {},
        { accountId: "explicit-acct", apiToken: "explicit-tok" },
      );
    } finally {
      restore();
    }

    expect(capturedRequests[0].url).toContain("/accounts/explicit-acct/");
    expect(capturedRequests[0].headers["authorization"]).toBe("Bearer explicit-tok");
    // Prove the env values were not used
    expect(capturedRequests[0].url).not.toContain("env-account");
    expect(capturedRequests[0].headers["authorization"]).not.toContain("env-token");
  });
});
