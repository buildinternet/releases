import type { Source } from "@releases/core/schema";
import { updateSource } from "../db/queries.js";
import type { Adapter, RawRelease, FetchOptions, FetchResult } from "@releases/adapters/types";
import { logger } from "@releases/lib/logger";
import {
  discoverFeed,
  fetchAndParseFeed,
  headCheckFeed,
  getSourceMeta,
  type SourceMetadata,
} from "@releases/adapters/feed";

// Re-export the pure feed surface so existing `src/adapters/feed.js` consumers
// keep working without reaching into @releases/adapters/feed directly.
export * from "@releases/adapters/feed";

// ── Source metadata helpers (DB-coupled) ────────────────────────────

/** Merge partial source metadata into the source's metadata JSON column. */
export async function updateSourceMeta(source: Source, meta: Partial<SourceMetadata>): Promise<void> {
  const existing = getSourceMeta(source);
  const merged = { ...existing, ...meta };
  const serialized = JSON.stringify(merged);
  await updateSource(source, { metadata: serialized });
  // Keep the in-memory source in sync so subsequent reads within the same
  // process see the updated metadata (fixes #238).
  source.metadata = serialized;
}

// ── fetchViaFeed (DB-coupled orchestration) ─────────────────────────

/**
 * Shared discovery → fetch → cache flow used by both the feed adapter and
 * the scrape adapter's feed-first optimization.
 *
 * Returns releases on success, null if no feed is available or discovery fails.
 */
export async function fetchViaFeed(
  source: Source,
  options?: FetchOptions,
): Promise<RawRelease[] | null> {
  const meta = getSourceMeta(source);
  const metaUpdates: Partial<SourceMetadata> = {};

  if (meta.noFeedFound) return null;
  if (meta.feedContentDepth === "summary-only") return null;

  let feedUrl = meta.feedUrl;
  let feedType = meta.feedType;

  if (!feedUrl) {
    logger.info(`Checking for RSS/Atom/JSON feed...`);
    try {
      const discovered = await discoverFeed(source.url);
      if (!discovered) {
        await updateSourceMeta(source, { noFeedFound: true });
        return null;
      }
      feedUrl = discovered.url;
      feedType = discovered.type;
      Object.assign(metaUpdates, {
        feedUrl,
        feedType,
        feedDiscoveredAt: new Date().toISOString(),
        noFeedFound: false,
      });
      logger.info(`Discovered ${feedType} feed: ${feedUrl}`);
    } catch (err) {
      logger.debug(`Feed discovery failed: ${err}`);
      return null;
    }
  }

  // Conditional fetch headers — skip on first real fetch so we don't 304 on
  // ETags that were stored by `poll` before any releases were ingested.
  const isFirstFetch = !source.lastFetchedAt;
  const conditionalHeaders: Record<string, string> = {};
  if (!isFirstFetch) {
    if (meta.feedEtag) conditionalHeaders["If-None-Match"] = meta.feedEtag;
    if (meta.feedLastModified) conditionalHeaders["If-Modified-Since"] = meta.feedLastModified;
  }

  const hasStoredHeaders = meta.feedEtag || meta.feedLastModified || meta.feedContentLength;
  if (hasStoredHeaders && !options?.full && !isFirstFetch) {
    const headResult = await headCheckFeed(feedUrl, {
      etag: meta.feedEtag,
      lastModified: meta.feedLastModified,
      contentLength: meta.feedContentLength,
    });

    if (headResult.contentLength) metaUpdates.feedContentLength = headResult.contentLength;
    if (headResult.etag) metaUpdates.feedEtag = headResult.etag;
    if (headResult.lastModified) metaUpdates.feedLastModified = headResult.lastModified;

    if (headResult.status === "unchanged") {
      logger.info(`HEAD check: feed unchanged, skipping full fetch`);
      if (Object.keys(metaUpdates).length > 0) {
        await updateSourceMeta(source, metaUpdates);
      }
      return [];
    }

    logger.info(`HEAD check: ${headResult.status}, proceeding to full fetch`);
  }

  logger.info(`Fetching ${feedType} feed: ${feedUrl}`);
  const { releases, etag, lastModified, contentLength } = await fetchAndParseFeed(
    feedUrl,
    feedType!,
    options,
    Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
  );

  // Guard: if this is the first real fetch (no prior ETag) and we got 0 releases,
  // the feed URL is likely a non-standard format we can't parse. Clear it so the
  // scrape adapter can take over on the next fetch (or this one, by returning null).
  if (isFirstFetch && releases.length === 0) {
    logger.warn(`Feed returned 0 releases on first fetch — clearing feed URL as untrustworthy`);
    const cleanMeta = getSourceMeta(source);
    delete cleanMeta.feedUrl;
    delete cleanMeta.feedType;
    delete cleanMeta.feedEtag;
    delete cleanMeta.feedLastModified;
    delete cleanMeta.feedDiscoveredAt;
    cleanMeta.noFeedFound = true;
    await updateSource(source, { metadata: JSON.stringify(cleanMeta) });
    return null;
  }

  // Guard: if every item has empty/trivial content (title-only feeds like Notion,
  // Apollo, LangChain, LaunchDarkly), mark as summary-only and return null so the
  // scrape adapter falls through to crawl/single-page (#234).
  if (releases.length > 0) {
    const MIN_CONTENT_LENGTH = 20;
    const allEmpty = releases.every((r) => !r.content || r.content.trim().length < MIN_CONTENT_LENGTH);
    if (allEmpty) {
      logger.warn(
        `Feed returned ${releases.length} items but all have empty/trivial content — marking as summary-only`,
      );
      metaUpdates.feedContentDepth = "summary-only";
      await updateSourceMeta(source, metaUpdates);
      return null;
    }
  }

  if (etag) metaUpdates.feedEtag = etag;
  if (lastModified) metaUpdates.feedLastModified = lastModified;
  if (contentLength) metaUpdates.feedContentLength = contentLength;

  if (Object.keys(metaUpdates).length > 0) {
    await updateSourceMeta(source, metaUpdates);
  }

  if (releases.length === 0) {
    logger.info(`No new releases from feed (304 or empty)`);
  } else {
    logger.info(`Parsed ${releases.length} releases from feed`);
  }

  return releases;
}

// ── Feed adapter (standalone, for "feed" source type) ───────────────

export const feed: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<FetchResult> {
    const releases = await fetchViaFeed(source, options);
    if (releases === null) {
      logger.warn(`No feed found for ${source.url}`);
      return { releases: [] };
    }

    return { releases };
  },
};
