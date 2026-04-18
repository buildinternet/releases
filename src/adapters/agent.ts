/**
 * Agent adapter — thin wrapper that delegates to the extract strategies in
 * `packages/adapters/src/extract/`. Picks the direct-fetch strategy when
 * the source has a `metadata.fetchUrl` set, otherwise falls back to the
 * Anthropic `web_fetch` loop + Cloudflare rendering path.
 */

import type { Adapter, RawRelease, FetchOptions, FetchResult } from "@releases/adapters/types";
import type { Source } from "@buildinternet/releases-core/schema";
import { getSourceMeta } from "@releases/adapters/source-meta";
import { runDirectFetchExtraction, runAgentExtraction, type MappedEntry } from "@releases/adapters/extract";
import { buildLocalExtractDeps, loadGuidance } from "./extract-deps-local.js";
import { logger } from "@buildinternet/releases-lib/logger";

export const agent: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<FetchResult> {
    const deps = buildLocalExtractDeps();
    const meta = getSourceMeta(source);
    const guidance = await loadGuidance(source, meta.parseInstructions);
    if (guidance.playbookContext) {
      logger.info(
        `Loaded org playbook (${guidance.playbookContext.length.toLocaleString()} chars) for agent context`,
      );
    }

    if (meta.fetchUrl) {
      const result = await runDirectFetchExtraction(
        source,
        {
          fetchUrl: meta.fetchUrl,
          fetchEtag: meta.fetchEtag,
          fetchLastModified: meta.fetchLastModified,
          guidance,
          since: options?.since,
          maxEntries: options?.maxEntries,
          dryRun: options?.dryRun,
          full: options?.full,
        },
        deps,
      );
      return { releases: toRawReleases(result.releases) };
    }

    const result = await runAgentExtraction(
      source,
      {
        guidance,
        since: options?.since,
        maxEntries: options?.maxEntries,
        dryRun: options?.dryRun,
      },
      deps,
    );
    return { releases: toRawReleases(result.releases) };
  },
};

function toRawReleases(entries: MappedEntry[]): RawRelease[] {
  return entries.map((e) => ({
    title: e.title,
    content: e.content,
    url: e.url,
    version: e.version,
    publishedAt: e.publishedAt,
    isBreaking: e.isBreaking,
    type: e.type,
    media: e.media,
  }));
}
