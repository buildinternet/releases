import type { Source } from "../db/schema.js";
import { checkContentHash, getKnownReleasesForSource } from "../db/queries.js";
import type { Adapter, RawRelease, FetchOptions, FetchResult } from "./types.js";
import { config } from "../lib/config.js";
import { AdapterError } from "../lib/errors.js";
import { CrawlTimeoutError, CrawlJobError } from "../lib/errors.js";
import { sha256Hex } from "../lib/hash.js";
import { logger } from "../lib/logger.js";
import { parseChangelog } from "../ai/ingest.js";
import { parseIncremental } from "../ai/incremental.js";
import { fetchViaFeed } from "./feed.js";
import { getSourceMeta, updateSourceMeta } from "./feed.js";
import { CF_REJECT_RESOURCE_TYPES } from "./cloudflare.js";
import { startCrawl, pollCrawlResults, parseCrawlPages } from "./crawl.js";

export const scrape: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<FetchResult> {
    const meta = getSourceMeta(source);
    const crawlActive = options?.crawl === true || (options?.crawl !== false && meta.crawlEnabled);

    // ── Crawl path (multi-page, per-page AI parsing) ──────────
    if (crawlActive) {
      try {
        return await fetchViaCrawl(source, meta, options);
      } catch (err) {
        if (err instanceof CrawlTimeoutError) {
          logger.warn(`${err.message} — returning empty`);
          return { releases: [] };
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
          return { releases: feedResult };
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
): Promise<FetchResult> {
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
    maxAge: meta.crawlMaxAge,
    render: meta.crawlRender,
    source: meta.crawlSource,
  });

  logger.info(`Crawl started (job ${jobId}), polling for results...`);
  const allPages = await pollCrawlResults(jobId);

  // Filter out the starting URL — we want sub-pages, not the index
  const startingUrl = source.url.replace(/\?.*$/, ""); // strip query params for comparison
  const pages = allPages.filter((p) => {
    const pageBase = p.url.replace(/\?.*$/, "");
    return pageBase !== startingUrl;
  });

  // Combine all page markdown for raw content storage
  const buildRawContent = (crawlPages: typeof allPages) =>
    crawlPages.map((p) => `<!-- URL: ${p.url} -->\n${p.markdown}`).join("\n\n---\n\n");

  if (pages.length === 0 && allPages.length > 0) {
    // Only got the index page — fall back to parsing it (better than nothing)
    logger.info(`Crawl only returned the index page, parsing it directly`);
    const releases = await parseCrawlPages(allPages, source.slug, options);
    await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });
    return { releases, rawContent: buildRawContent(allPages) };
  }

  if (pages.length === 0) {
    logger.info(`Crawl returned no pages`);
    await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });
    return { releases: [] };
  }

  logger.info(`Crawl returned ${pages.length} page(s), parsing...`);
  const releases = await parseCrawlPages(pages, source.slug, options);

  await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });

  logger.info(`Parsed ${releases.length} release(s) from crawl`);
  return { releases, rawContent: buildRawContent(pages) };
}

async function fetchViaSinglePage(source: Source, options?: FetchOptions): Promise<FetchResult> {
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
    body: JSON.stringify({
      url: source.url,
      rejectResourceTypes: [...CF_REJECT_RESOURCE_TYPES],
      gotoOptions: { waitUntil: "networkidle2" },
    }),
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
    return { releases: [] };
  }

  logger.info(`Received ${markdown.length.toLocaleString()} chars of markdown`);

  const contentHash = sha256Hex(markdown);
  if (await checkContentHash(source, contentHash)) {
    logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
    return { releases: [] };
  }

  // ── Incremental vs. bulk parsing decision ──
  const useIncremental = !options?.full;
  let parsed;

  if (useIncremental) {
    const knownReleases = await getKnownReleasesForSource(source.id, source.slug, 10);

    if (knownReleases.length > 0) {
      logger.info("Source has existing releases — trying incremental parse...");
      try {
        const result = await parseIncremental(markdown, source.id, source.slug, knownReleases);

        if (result.boundaryFound) {
          if (result.releases.length > 0) {
            logger.info(`Incremental parse found ${result.releases.length} new release(s)`);
          } else {
            logger.info("Incremental parse confirmed no new releases");
          }
          parsed = result.releases;
        } else {
          logger.info("Incremental parse could not find boundary — falling back to bulk");
        }
      } catch (error) {
        logger.warn(
          `Incremental parse failed, falling back to bulk: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Bulk fallback (or first-time fetch)
  if (!parsed) {
    logger.info("Parsing changelog with AI (bulk)...");
    try {
      parsed = await parseChangelog(markdown, source.slug, {
        onChunkComplete: options?.onParseProgress,
      });
    } catch (error) {
      logger.warn(
        `AI parsing failed for ${source.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { releases: [], rawContent: markdown };
    }
  }

  logger.info(`Parsed ${parsed.length} releases from ${source.url}`);

  let mapped: RawRelease[] = parsed.map((entry) => {
    // Generate a unique URL per entry so UNIQUE(source_id, url) doesn't collapse them
    const fragment = entry.version
      ? entry.version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      : entry.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    return {
      version: entry.version,
      title: entry.title,
      content: entry.content,
      url: `${source.url}#${fragment}`,
      publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
      isBreaking: entry.isBreaking,
    };
  });

  // Apply date and count limits
  if (options?.since) {
    mapped = mapped.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    mapped = mapped.slice(0, options.maxEntries);
  }

  return { releases: mapped, rawContent: markdown };
}
