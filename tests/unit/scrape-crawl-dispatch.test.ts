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
import {
  acquireCrawlMarkdown,
  deriveCrawlPattern,
  resolveCrawlIncludePatterns,
  type CrawlDeps,
} from "../../workers/discovery/src/scrape-fetch";

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

    const markdown = await acquireCrawlMarkdown(source, { crawlExcludePatterns: [] }, deps);

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

  it("returns null and skips metadata persistence when crawl returns zero pages", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls, metaPatches } = makeDeps({ jobId: "job_empty", pages: [] });

    const markdown = await acquireCrawlMarkdown(source, {}, deps);

    expect(markdown).toBeNull();
    expect(startCrawlCalls).toHaveLength(1);
    expect(metaPatches).toHaveLength(0);
  });

  it("returns null when startCrawl throws (degrades to caller's fallback)", async () => {
    const source = makeSource();
    const { deps, metaPatches } = makeDeps({ startThrows: new Error("crawl API down") });

    const markdown = await acquireCrawlMarkdown(source, {}, deps);

    expect(markdown).toBeNull();
    expect(metaPatches).toHaveLength(0);
  });

  it("returns null when pollCrawlResults throws", async () => {
    const source = makeSource();
    const { deps, metaPatches } = makeDeps({ pollThrows: new Error("poll 500") });

    const markdown = await acquireCrawlMarkdown(source, {}, deps);

    expect(markdown).toBeNull();
    expect(metaPatches).toHaveLength(0);
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

  it("does not throw when updateSourceMeta rejects (best-effort persistence)", async () => {
    const source = makeSource();
    const { deps } = makeDeps({
      jobId: "job_ok",
      pages: [{ url: "https://resend.com/changelog/post", markdown: "body" }],
      metaThrows: new Error("api down"),
    });

    // Should still return concatenated markdown — the .catch(() => {}) in
    // acquireCrawlMarkdown swallows the rejection.
    const markdown = await acquireCrawlMarkdown(source, {}, deps);
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

function mockFetchForCrawl(returnJobId: string): {
  restore: () => void;
  capturedBodies: unknown[];
} {
  const capturedBodies: unknown[] = [];
  const original = globalThis.fetch;

  // @ts-expect-error — overriding globalThis.fetch for test isolation
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(init?.body as string));
    return new Response(JSON.stringify({ success: true, result: returnJobId }), { status: 200 });
  };

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    capturedBodies,
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

  it("no exclude patterns → no body.options.excludePatterns (or empty body.options)", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_2");
    try {
      await startCrawl("https://example.com/changelog", {});
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    const opts = body.options as Record<string, unknown> | undefined;
    expect(opts?.excludePatterns).toBeUndefined();
    // body.options itself should be absent when there's nothing to set
    expect(body.options).toBeUndefined();
  });

  it("includeExternalLinks defaults false", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_3");
    try {
      await startCrawl("https://example.com/changelog", {});
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.includeExternalLinks).toBe(false);
  });

  it("includeExternalLinks forwarded when set to true", async () => {
    const { restore, capturedBodies } = mockFetchForCrawl("job_4");
    try {
      await startCrawl("https://example.com/changelog", { includeExternalLinks: true });
    } finally {
      restore();
    }
    const body = capturedBodies[0] as Record<string, unknown>;
    expect(body.includeExternalLinks).toBe(true);
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
