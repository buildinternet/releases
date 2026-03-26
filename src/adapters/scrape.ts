import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { Source } from "../db/schema.js";
import { sources } from "../db/schema.js";
import { getDb } from "../db/connection.js";
import type { Adapter, RawRelease, FetchOptions } from "./types.js";
import { config } from "../lib/config.js";
import { AdapterError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parseChangelog } from "../ai/ingest.js";
import { fetchViaFeed } from "./feed.js";
import { startCrawl, pollCrawlResults, parseCrawlPages } from "./crawl.js";
import { getSourceMeta, updateSourceMeta } from "./feed.js";
import { CrawlTimeoutError, CrawlJobError } from "../lib/errors.js";

export const scrape: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<RawRelease[]> {
    const meta = getSourceMeta(source);
    const crawlActive = options?.crawl === true || (options?.crawl !== false && meta.crawlEnabled);

    // ── Crawl path (multi-page, per-page AI parsing) ──────────
    if (crawlActive) {
      try {
        return await fetchViaCrawl(source, meta, options);
      } catch (err) {
        if (err instanceof CrawlTimeoutError) {
          logger.warn(`${err.message} — returning empty`);
          return [];
        }
        if (err instanceof CrawlJobError) {
          logger.warn(`${err.message} — falling back to single-page scrape`);
          // Fall through to single-page below
        } else {
          throw err;
        }
      }
    }

    // ── Feed path (fast, free, deterministic) ─────────────────
    if (!crawlActive) {
      try {
        const feedResult = await fetchViaFeed(source, options);
        if (feedResult !== null) {
          logger.info(`Feed returned ${feedResult.length} releases (no AI needed)`);
          return feedResult;
        }
      } catch (err) {
        logger.warn(`Feed fetch/parse failed, falling back to Cloudflare + AI: ${err}`);
      }
    }

    // ── Single-page Cloudflare + AI path ──────────────────────
    return fetchViaSinglePage(source, options);
  },
};

async function fetchViaCrawl(
  source: Source,
  meta: ReturnType<typeof getSourceMeta>,
  options?: FetchOptions,
): Promise<RawRelease[]> {
  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();

  if (!accountId || !apiToken) {
    throw new AdapterError(
      "scrape",
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set to use crawl mode.",
    );
  }

  const pattern = meta.crawlPattern ?? `${source.url.replace(/\/$/, "")}/**`;
  const modifiedSince = meta.lastCrawlAt
    ? Math.floor(new Date(meta.lastCrawlAt).getTime() / 1000)
    : undefined;

  logger.info(`Starting crawl for ${source.url} (pattern: ${pattern})...`);
  const jobId = await startCrawl(source.url, {
    includePatterns: [pattern],
    limit: options?.maxEntries,
    modifiedSince,
  });

  logger.info(`Crawl started (job ${jobId}), polling for results...`);
  const allPages = await pollCrawlResults(jobId);

  // Filter out the starting URL — we want sub-pages, not the index
  const startingUrl = source.url.replace(/\?.*$/, ""); // strip query params for comparison
  const pages = allPages.filter((p) => {
    const pageBase = p.url.replace(/\?.*$/, "");
    return pageBase !== startingUrl;
  });

  if (pages.length === 0 && allPages.length > 0) {
    // Only got the index page — fall back to parsing it (better than nothing)
    logger.info(`Crawl only returned the index page, parsing it directly`);
    const releases = await parseCrawlPages(allPages, source.slug, options);
    await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });
    return releases;
  }

  if (pages.length === 0) {
    logger.info(`Crawl returned no pages`);
    await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });
    return [];
  }

  logger.info(`Crawl returned ${pages.length} page(s), parsing...`);
  const releases = await parseCrawlPages(pages, source.slug, options);

  await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });

  logger.info(`Parsed ${releases.length} release(s) from crawl`);
  return releases;
}

async function fetchViaSinglePage(source: Source, options?: FetchOptions): Promise<RawRelease[]> {
  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();

  if (!accountId || !apiToken) {
    throw new AdapterError(
      "scrape",
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set to use the scrape adapter.",
    );
  }

  // Use /markdown endpoint — more reliable than /json for diverse changelog pages
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/markdown`;

  logger.info(`Fetching page via Cloudflare...`);
  const res: Response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: source.url }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new AdapterError(
      "scrape",
      `Cloudflare Browser Rendering API returned ${res.status} for ${source.url}: ${body}`,
    );
  }

  const data = await res.json() as { success: boolean; result: string; errors?: Array<{ message: string }> };

  if (!data.success) {
    const messages = data.errors?.map((e) => e.message).join("; ") ?? "unknown error";
    throw new AdapterError(
      "scrape",
      `Cloudflare Browser Rendering failed for ${source.url}: ${messages}`,
    );
  }

  const markdown = data.result;

  if (!markdown || markdown.trim().length === 0) {
    logger.warn(`Cloudflare returned empty markdown for ${source.url}`);
    return [];
  }

  logger.info(`Received ${markdown.length.toLocaleString()} chars of markdown`);

  // Re-fetch protection: hash the markdown and compare to stored hash
  const contentHash = createHash("sha256")
    .update(markdown)
    .digest("hex");

  if (source.lastContentHash === contentHash) {
    logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
    return [];
  }

  // Store the new hash on the source
  const db = getDb();
  await db
    .update(sources)
    .set({ lastContentHash: contentHash })
    .where(eq(sources.id, source.id));

  logger.info(`Parsing changelog with AI...`);
  let parsed;
  try {
    parsed = await parseChangelog(markdown, source.slug);
  } catch (error) {
    logger.warn(
      `AI parsing failed for ${source.url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }

  logger.info(`Parsed ${parsed.length} releases from ${source.url}`);

  let mapped: RawRelease[] = parsed.map((entry) => ({
    version: entry.version,
    title: entry.title,
    content: entry.content,
    publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
    isBreaking: entry.isBreaking,
  }));

  // Apply date and count limits
  if (options?.since) {
    mapped = mapped.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    mapped = mapped.slice(0, options.maxEntries);
  }

  return mapped;
}
