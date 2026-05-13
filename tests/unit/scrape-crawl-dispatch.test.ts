/**
 * Tests for the crawl-enabled dispatch helpers in `scrape-fetch.ts`:
 *
 *   - `deriveCrawlPattern`         — URL → include-pattern derivation
 *   - `resolveCrawlIncludePatterns` — honors explicit / empty / absent crawlPattern
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

import { describe, it, expect } from "bun:test";
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

    const markdown = await acquireCrawlMarkdown(source, { crawlPattern: "/changelog/**" }, deps);

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

    const markdown = await acquireCrawlMarkdown(source, { crawlPattern: "/changelog/**" }, deps);

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

  it("uses an empty includePatterns when crawlPattern is empty string", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls } = makeDeps({ pages: [] });

    await acquireCrawlMarkdown(source, { crawlPattern: "" }, deps);

    // crawlPattern === "" means "no filter"; startCrawl receives undefined
    // for includePatterns so the Cloudflare crawl runs without an
    // include-list restriction.
    expect(startCrawlCalls).toHaveLength(1);
    const opts = startCrawlCalls[0].options as { includePatterns?: string[] };
    expect(opts.includePatterns).toBeUndefined();
  });

  it("passes the derived default pattern when crawlPattern is absent", async () => {
    const source = makeSource();
    const { deps, startCrawlCalls } = makeDeps({ pages: [] });

    await acquireCrawlMarkdown(source, {}, deps);

    expect(startCrawlCalls).toHaveLength(1);
    const opts = startCrawlCalls[0].options as { includePatterns?: string[] };
    expect(opts.includePatterns).toEqual(["/changelog/**"]);
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
