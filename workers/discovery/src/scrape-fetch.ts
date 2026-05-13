/**
 * Extraction entry point for the discovery worker.
 *
 * Routes on `source.type`:
 *   - `scrape`   → markdown URL (if set) OR Cloudflare Browser Rendering →
 *                  incremental Haiku parse.
 *   - `agent`    → direct-fetch strategy (if `metadata.fetchUrl` is set) OR
 *                  full agent extraction (web_fetch + Cloudflare fallback).
 *
 * All strategy logic lives in `@releases/adapters/extract`; this module
 * handles source resolution, content acquisition for the scrape path, and
 * persistence (release insert, fetch log, source-after-fetch updates) via
 * the API worker.
 *
 * The export is still named `scrapeFetch` for back-compat with
 * `managed-agents-session.ts`, even though it now covers agent-type sources.
 */

import type { Source } from "@buildinternet/releases-core/schema";
import { fetchCloudflareMarkdown } from "@releases/adapters/cloudflare";
import { startCrawl, pollCrawlResults } from "@releases/adapters/crawl";
import { getSourceMeta } from "@releases/adapters/source-meta";
import {
  runDirectFetchExtraction,
  runAgentExtraction,
  runIncrementalExtraction,
  type KnownRelease,
  type MappedEntry,
} from "@releases/adapters/extract";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { logEvent } from "@releases/lib/log-event.js";
import { buildWorkerExtractDeps } from "./extract-deps-worker.js";

/**
 * True when a source has no indexed releases yet — its first fetch should run
 * full agent extraction rather than incremental, which bails early on empty
 * known lists and would produce a false-positive `no_change` status.
 */
export function isSeedRun(knownReleases: readonly KnownRelease[]): boolean {
  return knownReleases.length === 0;
}

// ── Types ──────────────────────────────────────────────────────────

export interface ScrapeEnv {
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  anthropicApiKey: string;
  /** Optional Cloudflare AI Gateway passthrough for Anthropic calls in extract. */
  anthropicBaseURL?: string;
  aiGatewayToken?: string;
  /** Service binding or fetcher for API worker calls. */
  apiFetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  apiKey: string;
  sessionId?: string;
  /** "true" to enable tool-loop extraction for large bodies globally. */
  extractToolLoopEnabled?: string;
}

// ── API helpers ────────────────────────────────────────────────────

/**
 * Build an org-scoped sub-resource path for a source. Mirrors the helper in
 * `extract-deps-worker.ts` — passing `source.orgId` + `source.id` (both
 * `org_…`/`src_…` IDs) avoids the bare-slug ambiguity that #690 introduced
 * and unblocks the planned 400-on-bare-slug rejection (#698).
 */
function sourceSubpath(source: Source, sub?: string): string {
  const tail = sub ? `/${sub}` : "";
  return `/v1/orgs/${encodeURIComponent(source.orgId)}/sources/${encodeURIComponent(source.id)}${tail}`;
}

async function fetchSourceInfo(env: ScrapeEnv, identifier: string): Promise<Source | null> {
  // Callers (cron triggers, manual scrape requests, the agent's manage_source
  // fetch fallback) hand us a `src_…` ID, an `org/slug` coordinate, or a bare
  // slug. Typed IDs and coordinates have unambiguous routes after #698 — bare
  // slugs are rejected on the legacy path. Pick the right URL by shape so the
  // coordinate form (used by the agent fallback once #710 lands) doesn't 404.
  const slash = identifier.indexOf("/");
  const url = identifier.startsWith("src_")
    ? `https://api/v1/sources/${encodeURIComponent(identifier)}`
    : slash > 0 && slash < identifier.length - 1
      ? `https://api/v1/orgs/${encodeURIComponent(identifier.slice(0, slash))}/sources/${encodeURIComponent(identifier.slice(slash + 1))}`
      : `https://api/v1/sources/${encodeURIComponent(identifier)}`;
  const res = await env.apiFetcher.fetch(url, {
    headers: { Authorization: `Bearer ${env.apiKey}` },
  });
  if (!res.ok) return null;
  return res.json() as Promise<Source>;
}

async function fetchKnownReleases(env: ScrapeEnv, source: Source): Promise<KnownRelease[]> {
  const res = await env.apiFetcher.fetch(
    `https://api${sourceSubpath(source, "known-releases")}?limit=10`,
    { headers: { Authorization: `Bearer ${env.apiKey}` } },
  );
  if (!res.ok) return [];
  return (await res.json()) as KnownRelease[];
}

async function insertReleases(
  env: ScrapeEnv,
  source: Source,
  releases: MappedEntry[],
): Promise<number> {
  if (releases.length === 0) return 0;

  const res = await env.apiFetcher.fetch(`https://api${sourceSubpath(source, "releases/batch")}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify({
      releases: releases.map((r) => ({
        title: r.title,
        content: r.content,
        url: r.url ?? null,
        version: r.version ?? null,
        publishedAt: r.publishedAt?.toISOString() ?? null,
        media: JSON.stringify(r.media ?? []),
      })),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Release insert failed (${res.status}): ${body}`);
  }

  const result = (await res.json()) as { inserted: number };
  return result.inserted;
}

async function updateSourceAfterFetch(env: ScrapeEnv, source: Source): Promise<void> {
  await env.apiFetcher.fetch(`https://api${sourceSubpath(source)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify({
      lastFetchedAt: new Date().toISOString(),
      changeDetectedAt: null,
      consecutiveErrors: 0,
      consecutiveNoChange: 0,
    }),
  });
}

async function writeFetchLog(
  env: ScrapeEnv,
  sourceId: string,
  result: {
    releasesFound: number;
    releasesInserted: number;
    durationMs: number;
    status: string;
    error?: string;
  },
): Promise<void> {
  await env.apiFetcher
    .fetch("https://api/v1/admin/logs/fetch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.apiKey}`,
      },
      body: JSON.stringify({
        sourceId,
        sessionId: env.sessionId ?? null,
        releasesFound: result.releasesFound,
        releasesInserted: result.releasesInserted,
        durationMs: result.durationMs,
        status: result.status,
        error: result.error ?? null,
      }),
    })
    .catch(() => {}); // best-effort
}

// ── Content acquisition for scrape path ───────────────────────────

/**
 * Derive a sensible default crawl include-pattern from the source URL.
 * For `https://resend.com/changelog` this returns `/changelog/**`.
 * Returns undefined when the URL has no meaningful path (e.g. bare domain).
 */
export function deriveCrawlPattern(sourceUrl: string): string | undefined {
  try {
    const { pathname } = new URL(sourceUrl);
    // Strip trailing slash, then require at least one path segment.
    const path = pathname.replace(/\/+$/, "");
    if (!path || path === "/") return undefined;
    return `${path}/**`;
  } catch {
    return undefined;
  }
}

/**
 * Compute the include-patterns array passed to `startCrawl`. Honors three
 * cases on `meta.crawlPattern`:
 *  - non-empty string → use that pattern verbatim
 *  - empty string     → no pattern filter (per-post URLs at unrelated paths)
 *  - undefined/absent → derive a sensible default from `source.url`
 */
export function resolveCrawlIncludePatterns(
  sourceUrl: string,
  crawlPattern: string | undefined,
): string[] {
  if (typeof crawlPattern === "string") {
    return crawlPattern.length > 0 ? [crawlPattern] : [];
  }
  const derived = deriveCrawlPattern(sourceUrl);
  return derived ? [derived] : [];
}

/**
 * Dependency-injected crawl helper. Runs `startCrawl` + `pollCrawlResults`,
 * concatenates pages into a single markdown body (with per-page URL headers
 * for attribution), persists `lastCrawlJobId` + `lastCrawlAt`, and logs the
 * outcome. Returns `null` when the crawl returns zero pages or throws — the
 * caller falls back to `fetchCloudflareMarkdown` in that case.
 *
 * Crawl primitives are passed in so unit tests can exercise the dispatch
 * logic without registering a process-global `mock.module` (which leaks
 * across files and breaks unrelated suites — see #615).
 */
export interface CrawlDeps {
  startCrawl: (
    url: string,
    options: {
      excludePatterns?: string[];
      includeExternalLinks?: boolean;
      limit?: number;
      source?: "all" | "sitemaps" | "links";
      render?: boolean;
      maxAge?: number;
    },
  ) => Promise<string>;
  pollCrawlResults: (jobId: string) => Promise<Array<{ url: string; markdown: string }>>;
  updateSourceMeta: (source: Source, patch: Record<string, unknown>) => Promise<void>;
}

export async function acquireCrawlMarkdown(
  source: Source,
  meta: {
    crawlPattern?: string;
    crawlExcludePatterns?: string[];
    crawlIncludeExternal?: boolean;
    crawlSource?: "all" | "sitemaps" | "links";
    crawlRender?: boolean;
    crawlMaxAge?: number;
  },
  crawl: CrawlDeps,
): Promise<string | null> {
  const excludePatterns = meta.crawlExcludePatterns;
  const includeExternalLinks = meta.crawlIncludeExternal;

  logEvent("info", {
    component: "scrape-fetch",
    event: "crawl-started",
    sourceSlug: source.slug,
    excludePatterns,
    includeExternalLinks,
  });

  let jobId: string | undefined;
  try {
    jobId = await crawl.startCrawl(source.url, {
      excludePatterns: excludePatterns?.length ? excludePatterns : undefined,
      includeExternalLinks,
      limit: 30,
      source: meta.crawlSource ?? "links",
      render: meta.crawlRender ?? true,
      maxAge: meta.crawlMaxAge,
    });

    const pages = await crawl.pollCrawlResults(jobId);

    if (pages.length === 0) {
      logEvent("warn", {
        component: "scrape-fetch",
        event: "crawl-fallback",
        sourceSlug: source.slug,
        jobId,
        reason: "crawl returned zero pages",
      });
      return null;
    }

    logEvent("info", {
      component: "scrape-fetch",
      event: "crawl-completed",
      sourceSlug: source.slug,
      jobId,
      pageCount: pages.length,
    });

    // Concatenate per-page markdown with a URL header so the extractor can
    // attribute content to individual release pages.
    const markdown = pages.map((p) => `\n\n# ${p.url}\n\n${p.markdown}\n\n`).join("");

    // Persist crawl job metadata — best-effort, don't block on failure.
    crawl
      .updateSourceMeta(source, {
        lastCrawlJobId: jobId,
        lastCrawlAt: new Date().toISOString(),
      })
      .catch(() => {});

    return markdown;
  } catch (err) {
    logEvent("warn", {
      component: "scrape-fetch",
      event: "crawl-fallback",
      sourceSlug: source.slug,
      jobId,
      reason: "crawl threw an error",
      err,
    });
    return null;
  }
}

async function fetchMarkdownUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": RELEASES_BOT_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

// ── Main entry point ──────────────────────────────────────────────

export async function scrapeFetch(env: ScrapeEnv, sourceIdentifier: string): Promise<string> {
  const start = Date.now();

  const source = await fetchSourceInfo(env, sourceIdentifier);
  if (!source) return `Error: source ${sourceIdentifier} not found`;

  if (source.type !== "scrape" && source.type !== "agent") {
    return `Error: source ${source.slug} is type "${source.type}", not scrape/agent`;
  }

  const deps = buildWorkerExtractDeps({
    anthropicApiKey: env.anthropicApiKey,
    anthropicBaseURL: env.anthropicBaseURL,
    aiGatewayToken: env.aiGatewayToken,
    cloudflareAccountId: env.cloudflareAccountId,
    cloudflareApiToken: env.cloudflareApiToken,
    apiFetcher: env.apiFetcher,
    apiKey: env.apiKey,
    sessionId: env.sessionId,
    extractToolLoopEnabled: (env.extractToolLoopEnabled ?? "false") === "true",
  });

  const meta = getSourceMeta(source);
  const playbookContext = (await deps.repo.getOrgPlaybook(source.orgId)) ?? undefined;
  const guidance = { parseInstructions: meta.parseInstructions, playbookContext };

  try {
    if (source.type === "agent") {
      return await runAgentPath(env, source, meta, guidance, deps, start);
    }
    return await runScrapePath(env, source, meta, guidance, deps, start);
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    await writeFetchLog(env, source.id, {
      releasesFound: 0,
      releasesInserted: 0,
      durationMs,
      status: "error",
      error: message,
    });
    return `Error: ${message}`;
  }
}

// ── Agent path (handles type=agent sources) ──────────────────────

async function runAgentPath(
  env: ScrapeEnv,
  source: Source,
  meta: ReturnType<typeof getSourceMeta>,
  guidance: { parseInstructions?: string; playbookContext?: string },
  deps: ReturnType<typeof buildWorkerExtractDeps>,
  start: number,
): Promise<string> {
  if (meta.fetchUrl) {
    const result = await runDirectFetchExtraction(
      source,
      {
        fetchUrl: meta.fetchUrl,
        fetchEtag: meta.fetchEtag,
        fetchLastModified: meta.fetchLastModified,
        guidance,
      },
      deps,
    );
    return finalize(env, source, result.releases, start);
  }

  const result = await runAgentExtraction(source, { guidance }, deps);
  return finalize(env, source, result.releases, start);
}

// ── Scrape path (handles type=scrape sources) ────────────────────

async function runScrapePath(
  env: ScrapeEnv,
  source: Source,
  meta: ReturnType<typeof getSourceMeta>,
  guidance: { parseInstructions?: string; playbookContext?: string },
  deps: ReturnType<typeof buildWorkerExtractDeps>,
  start: number,
): Promise<string> {
  const knownReleasesPromise = fetchKnownReleases(env, source);

  let markdown: string | null = null;
  if (meta.markdownUrl) {
    markdown = await fetchMarkdownUrl(meta.markdownUrl);
  }

  if (!markdown && meta.crawlEnabled === true) {
    markdown = await acquireCrawlMarkdown(source, meta, {
      startCrawl,
      pollCrawlResults,
      updateSourceMeta: (s, patch) => deps.repo.updateSourceMeta(s, patch),
    });
    // markdown === null after a zero-page or thrown-error crawl — fall
    // through to fetchCloudflareMarkdown below.
  }

  if (!markdown) {
    markdown = await fetchCloudflareMarkdown(
      source.url,
      env.cloudflareAccountId,
      env.cloudflareApiToken,
    );
  }

  if (!markdown) {
    const durationMs = Date.now() - start;
    await writeFetchLog(env, source.id, {
      releasesFound: 0,
      releasesInserted: 0,
      durationMs,
      status: "error",
      error: "Cloudflare Browser Rendering returned no content",
    });
    return `Error: Cloudflare Browser Rendering returned no content for ${source.url}`;
  }

  const knownReleases = await knownReleasesPromise;

  // Incremental extraction is designed for already-indexed sources. On a
  // brand-new source (zero known releases) it would bail immediately and
  // return an empty list — the caller would then emit status=no_change even
  // though nothing has been fetched yet. Fall through to full agent extraction
  // so the first fetch is treated as a seed run rather than a no-op.
  if (isSeedRun(knownReleases)) {
    deps.logger.info(
      `No known releases for ${source.slug} — running full agent extraction (seed run)`,
    );
    const result = await runAgentExtraction(source, { guidance }, deps);
    return finalize(env, source, result.releases, start);
  }

  const result = await runIncrementalExtraction(
    source,
    { markdown, knownReleases, guidance },
    deps,
  );

  return finalize(env, source, result.releases, start);
}

async function finalize(
  env: ScrapeEnv,
  source: Source,
  releases: MappedEntry[],
  start: number,
): Promise<string> {
  const durationMs = Date.now() - start;

  if (releases.length === 0) {
    await Promise.all([
      updateSourceAfterFetch(env, source),
      writeFetchLog(env, source.id, {
        releasesFound: 0,
        releasesInserted: 0,
        durationMs,
        status: "no_change",
      }),
    ]);
    return JSON.stringify({
      fetched: true,
      status: "no_change",
      releasesFound: 0,
      releasesInserted: 0,
      source: source.slug,
    });
  }

  const inserted = await insertReleases(env, source, releases);
  const finalDuration = Date.now() - start;
  await Promise.all([
    updateSourceAfterFetch(env, source),
    writeFetchLog(env, source.id, {
      releasesFound: releases.length,
      releasesInserted: inserted,
      durationMs: finalDuration,
      status: inserted > 0 ? "success" : "no_change",
    }),
  ]);

  return JSON.stringify({
    fetched: true,
    status: "success",
    releasesFound: releases.length,
    releasesInserted: inserted,
    source: source.slug,
  });
}
