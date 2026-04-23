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
import { getSourceMeta } from "@releases/adapters/source-meta";
import {
  runDirectFetchExtraction,
  runAgentExtraction,
  runIncrementalExtraction,
  type KnownRelease,
  type MappedEntry,
} from "@releases/adapters/extract";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
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
}

// ── API helpers ────────────────────────────────────────────────────

async function fetchSourceInfo(env: ScrapeEnv, identifier: string): Promise<Source | null> {
  const res = await env.apiFetcher.fetch(
    `https://api/v1/sources/${encodeURIComponent(identifier)}`,
    { headers: { Authorization: `Bearer ${env.apiKey}` } },
  );
  if (!res.ok) return null;
  return res.json() as Promise<Source>;
}

async function fetchKnownReleases(env: ScrapeEnv, sourceSlug: string): Promise<KnownRelease[]> {
  const res = await env.apiFetcher.fetch(
    `https://api/v1/sources/${encodeURIComponent(sourceSlug)}/known-releases?limit=10`,
    { headers: { Authorization: `Bearer ${env.apiKey}` } },
  );
  if (!res.ok) return [];
  return (await res.json()) as KnownRelease[];
}

async function insertReleases(
  env: ScrapeEnv,
  sourceSlug: string,
  releases: MappedEntry[],
): Promise<number> {
  if (releases.length === 0) return 0;

  const res = await env.apiFetcher.fetch(
    `https://api/v1/sources/${encodeURIComponent(sourceSlug)}/releases/batch`,
    {
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
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Release insert failed (${res.status}): ${body}`);
  }

  const result = (await res.json()) as { inserted: number };
  return result.inserted;
}

async function updateSourceAfterFetch(env: ScrapeEnv, sourceId: string): Promise<void> {
  await env.apiFetcher.fetch(`https://api/v1/sources/${encodeURIComponent(sourceId)}`, {
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
  const knownReleasesPromise = fetchKnownReleases(env, source.slug);

  let markdown: string | null = null;
  if (meta.markdownUrl) {
    markdown = await fetchMarkdownUrl(meta.markdownUrl);
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
      updateSourceAfterFetch(env, source.id),
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

  const inserted = await insertReleases(env, source.slug, releases);
  const finalDuration = Date.now() - start;
  await Promise.all([
    updateSourceAfterFetch(env, source.id),
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
