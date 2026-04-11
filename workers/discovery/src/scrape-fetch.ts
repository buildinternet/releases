/**
 * Lightweight scrape fetch for the discovery worker.
 *
 * When the managed agent calls fetch_source for a scrape source, the API
 * returns "flagged" because it can't do the rendering/parsing. This module
 * does the actual work using the discovery worker's Cloudflare and Anthropic
 * secrets, then inserts results via the API worker service binding.
 *
 * Supports two content acquisition paths:
 * 1. Markdown URL — direct fetch when source has `markdownUrl` in metadata
 *    (skips Cloudflare rendering entirely)
 * 2. Cloudflare Browser Rendering — single-page render for all other sources
 *
 * Both paths feed into the same incremental AI parse → API insert pipeline.
 * No crawl support — that requires the full CLI adapter.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  releaseItemProperties,
  releaseItemRequired,
  sanitizeVersion,
  withParseInstructions,
  INCREMENTAL_SYSTEM,
  formatKnownReleases,
  findContentStart,
  type KnownRelease,
} from "@releases/ai/shared.js";
import { getSourceMeta } from "@releases/adapters/source-meta.js";
import type { ParsedRelease } from "@releases/ai/ingest.js";

// ── Cloudflare Browser Rendering (inlined to avoid transitive logger/config imports) ──

const CF_REJECT_RESOURCE_TYPES = ["font", "stylesheet"] as const;

async function renderToMarkdown(
  url: string,
  accountId: string,
  apiToken: string,
): Promise<string | null> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      rejectResourceTypes: [...CF_REJECT_RESOURCE_TYPES],
      gotoOptions: { waitUntil: "networkidle2" },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { success: boolean; result: string };
  return (data.success && data.result?.trim()) ? data.result : null;
}

// ── Types ──────────────────────────────────────────────────────────

interface ScrapeEnv {
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  anthropicApiKey: string;
  /** Service binding or fetcher for API worker calls. */
  apiFetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  apiKey: string;
  sessionId?: string;
}


// ── Incremental parse (uses shared utilities from @releases/ai/shared) ───────

const extractReleasesTool: Anthropic.Tool = {
  name: "extract_releases",
  description: "Extract the NEW release entries you found. Only include releases not in the known list. Return an empty array if there are no new releases.",
  input_schema: {
    type: "object" as const,
    properties: {
      releases: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: { ...releaseItemProperties },
          required: [...releaseItemRequired],
        },
      },
      needsMoreContext: {
        type: "boolean" as const,
        description: "Set to true ONLY if the provided lines don't contain any changelog content.",
      },
    },
    required: ["releases", "needsMoreContext"],
  },
};

async function incrementalParse(
  client: Anthropic,
  markdown: string,
  knownReleases: KnownRelease[],
  parseInstructions?: string,
): Promise<ParsedRelease[]> {
  if (knownReleases.length === 0) return [];

  const lines = markdown.split("\n");
  const contentStart = findContentStart(lines);
  const previewCount = Math.min(200, lines.length - contentStart);
  const previewSlice = lines.slice(contentStart, contentStart + previewCount);
  const preview = previewSlice.map((l, i) => `${contentStart + i + 1}: ${l}`).join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 8192,
    system: [
      {
        type: "text",
        text: withParseInstructions(INCREMENTAL_SYSTEM, parseInstructions),
        cache_control: { type: "ephemeral" },
      },
    ],
    tools: [extractReleasesTool],
    tool_choice: { type: "tool", name: "extract_releases" },
    messages: [
      {
        role: "user",
        content: `<known_releases>\n${formatKnownReleases(knownReleases)}\n</known_releases>\n\n## Changelog (lines ${contentStart + 1}–${contentStart + previewCount} of ${lines.length} total)\n\n<changelog>\n${preview}\n</changelog>`,
      },
    ],
  });

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "extract_releases",
  );

  const input = toolBlock?.input as { releases?: ParsedRelease[]; needsMoreContext?: boolean } | undefined;
  const rawReleases = Array.isArray(input?.releases) ? input.releases : [];

  return rawReleases.map((r) => ({ ...r, version: sanitizeVersion(r.version) }));
}

// ── API helpers ────────────────────────────────────────────────────

async function fetchSourceInfo(env: ScrapeEnv, identifier: string) {
  const res = await env.apiFetcher.fetch(
    `https://api/v1/sources/${encodeURIComponent(identifier)}`,
    { headers: { Authorization: `Bearer ${env.apiKey}` } },
  );
  if (!res.ok) return null;
  return res.json() as Promise<{
    id: string; slug: string; url: string; type: string;
    metadata: string | null; orgId: string | null;
  }>;
}

async function fetchKnownReleases(env: ScrapeEnv, sourceSlug: string): Promise<KnownRelease[]> {
  const res = await env.apiFetcher.fetch(
    `https://api/v1/sources/${encodeURIComponent(sourceSlug)}/known-releases?limit=10`,
    { headers: { Authorization: `Bearer ${env.apiKey}` } },
  );
  if (!res.ok) return [];
  const data = await res.json() as Array<{ version: string | null; title: string; publishedAt: string | null }>;
  return data;
}

async function insertReleases(
  env: ScrapeEnv,
  sourceSlug: string,
  releases: ParsedRelease[],
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
          version: r.version ?? null,
          publishedAt: r.publishedAt ?? null,
          media: JSON.stringify(r.media ?? []),
        })),
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Release insert failed (${res.status}): ${body}`);
  }

  const result = await res.json() as { inserted: number };
  return result.inserted;
}

async function updateSourceAfterFetch(
  env: ScrapeEnv,
  sourceId: string,
): Promise<void> {
  await env.apiFetcher.fetch(
    `https://api/v1/sources/${encodeURIComponent(sourceId)}`,
    {
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
    },
  );
}

async function writeFetchLog(
  env: ScrapeEnv,
  sourceId: string,
  result: { releasesFound: number; releasesInserted: number; durationMs: number; status: string; error?: string },
): Promise<void> {
  await env.apiFetcher.fetch("https://api/v1/fetch-log", {
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
  }).catch(() => {}); // best-effort
}

// ── Markdown URL fetch (direct, no Cloudflare needed) ────────────

async function fetchMarkdownUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "releases/0.1 (+https://releases.sh)" },
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

export async function scrapeFetch(
  env: ScrapeEnv,
  sourceIdentifier: string,
): Promise<string> {
  const start = Date.now();

  // 1. Get source info
  const source = await fetchSourceInfo(env, sourceIdentifier);
  if (!source) return `Error: source ${sourceIdentifier} not found`;
  if (source.type !== "scrape") return `Error: source ${source.slug} is type "${source.type}", not scrape`;

  const meta = getSourceMeta({ metadata: source.metadata } as any);

  // 2. Get content — prefer markdown URL (cheap) over Cloudflare render (expensive)
  const knownReleasesPromise = fetchKnownReleases(env, source.slug);

  let markdown: string | null = null;

  if (meta.markdownUrl) {
    const [md, known] = await Promise.all([
      fetchMarkdownUrl(meta.markdownUrl),
      knownReleasesPromise,
    ]);
    markdown = md;
    if (markdown) {
      return runParseAndInsert(env, source, meta, markdown, known, start);
    }
    // Fall through to Cloudflare if markdown URL failed
  }

  const [rendered, knownReleases] = await Promise.all([
    renderToMarkdown(source.url, env.cloudflareAccountId, env.cloudflareApiToken),
    knownReleasesPromise,
  ]);
  markdown = rendered;

  if (!markdown) {
    const durationMs = Date.now() - start;
    await writeFetchLog(env, source.id, {
      releasesFound: 0, releasesInserted: 0, durationMs,
      status: "error", error: "Cloudflare Browser Rendering returned no content",
    });
    return `Error: Cloudflare Browser Rendering returned no content for ${source.url}`;
  }

  return runParseAndInsert(env, source, meta, markdown, knownReleases, start);
}

// ── Shared parse + insert pipeline ───────────────────────────────

async function runParseAndInsert(
  env: ScrapeEnv,
  source: { id: string; slug: string; url: string },
  meta: ReturnType<typeof getSourceMeta>,
  markdown: string,
  knownReleases: KnownRelease[],
  start: number,
): Promise<string> {
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  const releases = await incrementalParse(client, markdown, knownReleases, meta.parseInstructions);

  const durationMs = Date.now() - start;

  if (releases.length === 0) {
    await Promise.all([
      updateSourceAfterFetch(env, source.id),
      writeFetchLog(env, source.id, { releasesFound: 0, releasesInserted: 0, durationMs, status: "no_change" }),
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
