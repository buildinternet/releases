/**
 * Direct-fetch strategy: when a source has `metadata.fetchUrl` set, we do a
 * conditional GET against that URL (If-None-Match / If-Modified-Since), update
 * the stored headers, content-hash the body, and hand it to the AI with the
 * "parse this arbitrary body" prompt.
 *
 * The body can be JSON, HTML, or markdown — the AI identifies the shape from
 * the content itself. This replaces per-host transformers (see #342).
 */

import { sha256Hex } from "@releases/core-internal/hash";
import { AdapterError } from "@releases/lib/errors";
import type { Source } from "@buildinternet/releases-core/schema";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { getSourceMeta } from "@releases/adapters/source-meta";
import { extractFromBody } from "./extract-from-body.js";
import {
  DIRECT_FETCH_SYSTEM_PROMPT,
  mapEntries,
  type ExtractionGuidance,
  type MappedEntry,
} from "./shared.js";
import type { ExtractDeps } from "./types.js";

export interface DirectFetchOptions {
  fetchUrl: string;
  fetchEtag?: string;
  fetchLastModified?: string;
  guidance?: ExtractionGuidance;
  since?: Date;
  maxEntries?: number;
  /** Preview mode — skip persisting content hash/metadata side-effects. */
  dryRun?: boolean;
  /** Force full re-parse: skip 304 handling. */
  full?: boolean;
}

export interface DirectFetchResult {
  releases: MappedEntry[];
  /** True when the upstream responded 304 or content hash matched. */
  unchanged: boolean;
}

export async function runDirectFetchExtraction(
  source: Source,
  opts: DirectFetchOptions,
  deps: ExtractDeps,
): Promise<DirectFetchResult> {
  const { logger, repo } = deps;

  const headers: Record<string, string> = {
    "User-Agent": RELEASES_BOT_UA,
    Accept: "*/*",
  };
  if (!opts.full) {
    if (opts.fetchEtag) headers["If-None-Match"] = opts.fetchEtag;
    if (opts.fetchLastModified) headers["If-Modified-Since"] = opts.fetchLastModified;
  }

  logger.info(`Direct-fetch: GET ${opts.fetchUrl}`);
  const res = await fetch(opts.fetchUrl, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 304) {
    logger.info("Direct-fetch: 304 Not Modified");
    return { releases: [], unchanged: true };
  }
  if (!res.ok) {
    throw new AdapterError(
      "agent",
      `Direct-fetch returned ${res.status} ${res.statusText} for ${opts.fetchUrl}`,
    );
  }

  const body = await res.text();
  if (!body.trim()) {
    logger.warn("Direct-fetch returned empty body");
    return { releases: [], unchanged: true };
  }

  logger.info(`Direct-fetch returned ${body.length.toLocaleString()} chars`);

  // Persist new conditional-fetch headers BEFORE the content-hash short-circuit.
  // A 200 means the upstream's etag/last-modified changed (otherwise we'd have
  // hit 304), so storing them lets the next request re-attempt 304 instead of
  // pulling the body again.
  const newEtag = res.headers.get("etag") ?? undefined;
  const newLastModified = res.headers.get("last-modified") ?? undefined;
  const headerUpdates: Record<string, unknown> = {};
  if (newEtag) headerUpdates.fetchEtag = newEtag;
  if (newLastModified) headerUpdates.fetchLastModified = newLastModified;
  if (Object.keys(headerUpdates).length > 0 && !opts.dryRun) {
    await repo.updateSourceMeta(source, headerUpdates);
  }

  // Both checks are load-bearing: conditional headers don't catch upstream
  // re-renders that produce identical content (common with SSG rebuilds —
  // new etag, same payload).
  const contentHash = sha256Hex(body);
  if (await repo.peekContentHash(source, contentHash)) {
    logger.info("No changes detected (content hash unchanged)");
    return { releases: [], unchanged: true };
  }

  const result = await extractFromBody(
    {
      body,
      systemPrompt: DIRECT_FETCH_SYSTEM_PROMPT,
      userMessage: `Extract all changelog/release entries from this content (canonical source URL: ${source.url}, fetched from: ${opts.fetchUrl}):`,
      guidance: opts.guidance,
      sourceUrl: source.url,
      fetchUrl: opts.fetchUrl,
      useToolLoop:
        deps.extractToolLoopEnabled || getSourceMeta(source).extractStrategy === "toolloop",
    },
    deps,
  );

  await repo.logUsage({
    operation: "agent-ingest",
    model: result.modelUsed,
    inputTokens: result.totalInput,
    outputTokens: result.totalOutput,
    sourceId: source.id,
    sourceSlug: source.slug,
    releaseCount: result.entries.length,
    extractionMode: result.mode,
    toolRounds: result.toolRounds,
    toolChars: result.toolChars,
    fallbackReason: result.fallbackReason,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
  });

  logger.info(
    `Extract mode=${result.mode} rounds=${result.toolRounds ?? "-"} ` +
      `toolChars=${result.toolChars ?? "-"} cacheRead=${result.cacheReadTokens} ` +
      `cacheWrite=${result.cacheWriteTokens} entries=${result.entries.length}`,
  );
  logger.info(
    `Total: ${result.totalInput.toLocaleString()} input + ${result.totalOutput.toLocaleString()} output tokens`,
  );

  // Commit content hash only when extraction completed cleanly. On
  // max_tokens exhaustion we leave it unset so a fixed prompt can re-attempt
  // the same body — otherwise the next fetch would short-circuit on the hash
  // and lock us out of recovery until upstream changes.
  if (!result.hitMaxTokens && !opts.dryRun) {
    await repo.commitContentHash(source, contentHash);
  }

  let releases = mapEntries(result.entries, { sourceUrl: source.url });
  if (opts.since) {
    releases = releases.filter((r) => !r.publishedAt || r.publishedAt >= opts.since!);
  }
  if (opts.maxEntries) {
    releases = releases.slice(0, opts.maxEntries);
  }

  logger.info(`Extracted ${releases.length} release(s) via direct-fetch`);
  return { releases, unchanged: false };
}
