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
import { fetchCloudflareMarkdown } from "./cloudflare.js";
import { startCrawl, pollCrawlResults, parseCrawlPages } from "./crawl.js";

function toFragmentUrl(baseUrl: string, version: string | undefined, title: string): string {
  const raw = version ?? title;
  const fragment = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${baseUrl}#${fragment}`;
}

export const scrape: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<FetchResult> {
    const meta = getSourceMeta(source);
    const crawlActive = options?.crawl === true || (options?.crawl !== false && meta.crawlEnabled);
    const crawlForced = options?.crawl === true;

    // ── Feed path (fast, free, deterministic) ─────────────────
    // Try feed first even when crawl is enabled — it's cheaper and faster.
    // Only skip feed when crawl is explicitly forced via --crawl flag.
    if (!crawlForced) {
      try {
        const feedResult = await fetchViaFeed(source, options);
        if (feedResult !== null) {
          logger.info(`Feed returned ${feedResult.length} releases (no AI needed)`);
          return { releases: feedResult };
        }
      } catch (err) {
        logger.warn(`Feed fetch/parse failed, falling back to crawl/scrape: ${err}`);
      }
    }

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

    // ── Markdown path (direct fetch, no Cloudflare needed) ────
    if (meta.markdownUrl) {
      try {
        const mdResult = await fetchViaMarkdown(source, meta.markdownUrl, meta, options);
        if (mdResult !== null) return mdResult;
      } catch (err) {
        logger.warn(`Markdown fetch failed, falling back to Cloudflare: ${err}`);
      }
    }

    // ── Single-page Cloudflare + AI path ──────────────────────
    return fetchViaSinglePage(source, meta, options);
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
    const releases = await parseCrawlPages(allPages, source.slug, options, meta.parseInstructions);
    await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });
    return { releases, rawContent: buildRawContent(allPages) };
  }

  if (pages.length === 0) {
    logger.info(`Crawl returned no pages`);
    await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });
    return { releases: [] };
  }

  logger.info(`Crawl returned ${pages.length} page(s), parsing...`);
  const releases = await parseCrawlPages(pages, source.slug, options, meta.parseInstructions);

  await updateSourceMeta(source, { lastCrawlJobId: jobId, lastCrawlAt: new Date().toISOString() });

  logger.info(`Parsed ${releases.length} release(s) from crawl`);
  return { releases, rawContent: buildRawContent(pages) };
}

async function fetchViaMarkdown(
  source: Source,
  markdownUrl: string,
  meta: ReturnType<typeof getSourceMeta>,
  options?: FetchOptions,
): Promise<FetchResult | null> {
  logger.info(`Fetching markdown directly from ${markdownUrl}...`);
  const res = await fetch(markdownUrl, {
    headers: { "User-Agent": "releases/0.1 (+https://releases.sh)" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    logger.warn(`Markdown URL returned ${res.status}`);
    return null;
  }

  const markdown = await res.text();
  if (!markdown.trim()) {
    logger.warn("Markdown URL returned empty content");
    return null;
  }

  logger.info(`Got ${markdown.length.toLocaleString()} chars of markdown (no Cloudflare needed)`);

  const contentHash = sha256Hex(markdown);
  if (await checkContentHash(source, contentHash, { dryRun: options?.dryRun })) {
    logger.info("No changes detected (content hash unchanged)");
    return { releases: [] };
  }

  // Use the same parsing pipeline as Cloudflare-rendered content
  const knownReleases = await getKnownReleasesForSource(source.id, source.slug);
  if (knownReleases.length > 0 && !options?.full) {
    const incremental = await parseIncremental(markdown, source.id, source.slug, knownReleases, meta.parseInstructions);
    if (incremental.boundaryFound) {
      return {
        releases: incremental.releases.map((r) => ({
          title: r.title,
          content: r.content,
          url: toFragmentUrl(source.url, r.version, r.title),
          version: r.version,
          publishedAt: r.publishedAt ? new Date(r.publishedAt) : undefined,
          isBreaking: r.isBreaking,
          media: r.media,
        })),
      };
    }
  }

  const parsed = await parseChangelog(markdown, source.slug, {
    onChunkComplete: options?.onParseProgress,
    parseInstructions: meta.parseInstructions,
  });
  return {
    releases: parsed.map((r) => ({
      title: r.title,
      content: r.content,
      url: toFragmentUrl(source.url, r.version, r.title),
      version: r.version,
      publishedAt: r.publishedAt ? new Date(r.publishedAt) : undefined,
      isBreaking: r.isBreaking,
      media: r.media,
    })),
  };
}

async function fetchViaSinglePage(source: Source, meta: ReturnType<typeof getSourceMeta>, options?: FetchOptions): Promise<FetchResult> {
  const accountId = config.cloudflareAccountId();
  const apiToken = config.cloudflareApiToken();

  if (!accountId || !apiToken) {
    throw new AdapterError(
      "scrape",
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set to use the scrape adapter.",
    );
  }

  logger.info(`Fetching page via Cloudflare...`);
  const markdown = await fetchCloudflareMarkdown(source.url, accountId, apiToken);

  if (!markdown) {
    throw new AdapterError(
      "scrape",
      `Cloudflare Browser Rendering returned no content for ${source.url}`,
    );
  }

  logger.info(`Received ${markdown.length.toLocaleString()} chars of markdown`);

  const contentHash = sha256Hex(markdown);
  if (await checkContentHash(source, contentHash, { dryRun: options?.dryRun })) {
    logger.info(`No changes detected for ${source.url} (content hash unchanged)`);
    // Only meaningful when poll has stored HEAD headers — tracks how many renders could be avoided
    if (meta.pageEtag || meta.pageLastModified) {
      const skips = (meta.headCheckSkips ?? 0) + 1;
      logger.info(`HEAD pre-check could have saved this render for ${source.slug} (${skips} skippable renders so far)`);
      await updateSourceMeta(source, { headCheckSkips: skips });
    }
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
        const result = await parseIncremental(markdown, source.id, source.slug, knownReleases, meta.parseInstructions);

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
        parseInstructions: meta.parseInstructions,
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
    return {
      version: entry.version,
      title: entry.title,
      content: entry.content,
      url: toFragmentUrl(source.url, entry.version, entry.title),
      publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
      isBreaking: entry.isBreaking,
      media: entry.media,
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
