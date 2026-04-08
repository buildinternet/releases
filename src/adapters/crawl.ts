import { config } from "../lib/config.js";
import { AdapterError, CrawlTimeoutError, CrawlJobError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parseChangelog } from "../ai/ingest.js";
import type { RawRelease, FetchOptions } from "./types.js";
import { CF_REJECT_RESOURCE_TYPES } from "./cloudflare.js";

// NOTE: The crawl flow is currently synchronous (poll until done). This is
// designed to be split into start/retrieve phases for background execution.
// See deferred items in the crawl integration spec.

interface CrawlOptions {
  includePatterns?: string[];
  limit?: number;
  modifiedSince?: number; // unix timestamp
  maxAge?: number;            // Cloudflare R2 cache TTL in seconds
  render?: boolean;           // false = skip headless browser rendering
  source?: "all" | "sitemaps" | "links"; // URL discovery method
}

interface CrawlPage {
  url: string;
  markdown: string;
  title?: string;
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "errored",
  "cancelled_due_to_timeout",
  "cancelled_due_to_limits",
  "cancelled_by_user",
]);

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

function cfHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.cloudflareApiToken()}`,
    "Content-Type": "application/json",
  };
}

function crawlBaseUrl(): string {
  const accountId = config.cloudflareAccountId();
  if (!accountId) {
    throw new AdapterError("crawl", "CLOUDFLARE_ACCOUNT_ID must be set");
  }
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/crawl`;
}

export async function startCrawl(url: string, options: CrawlOptions): Promise<string> {
  const body: Record<string, unknown> = {
    url,
    formats: ["markdown"],
    rejectResourceTypes: [...CF_REJECT_RESOURCE_TYPES],
    // Wait for JS-rendered pages to fully hydrate before extracting links/content
    gotoOptions: { waitUntil: "networkidle2" },
    // Declare crawl purposes per Cloudflare Content Signals policy.
    // "search" and "ai-input" — we index changelogs for search and AI summarization.
    // Explicitly excludes "ai_training" to respect site operator preferences.
    crawlPurposes: ["search", "ai-input"],
  };

  if (options.maxAge !== undefined) {
    body.maxAge = options.maxAge;
  }

  if (options.render === false) {
    body.render = false;
    // No need for gotoOptions when not rendering
    delete body.gotoOptions;
  }

  if (options.source) {
    body.source = options.source;
  }

  if (options.includePatterns?.length) {
    body.options = { includePatterns: options.includePatterns };
  }
  body.limit = options.limit ?? 20; // Conservative default — JS rendering eats browser time fast
  body.depth = 2; // Follow links one level deep from the starting page
  if (options.modifiedSince) {
    body.modifiedSince = options.modifiedSince;
  }

  const res = await fetch(crawlBaseUrl(), {
    method: "POST",
    headers: cfHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AdapterError("crawl", `Failed to start crawl: ${res.status} ${text}`);
  }

  const data = await res.json() as { success: boolean; result: string };
  if (!data.success || !data.result) {
    throw new AdapterError("crawl", "Crawl API returned unexpected response");
  }

  return data.result;
}

interface CrawlRecord {
  url: string;
  status: string;
  markdown?: string;
  metadata?: { title?: string; status?: number };
}

function recordsToPages(records: CrawlRecord[]): CrawlPage[] {
  return records
    .filter((r) => r.status === "completed" && r.markdown?.trim())
    .map((r) => ({ url: r.url, markdown: r.markdown!, title: r.metadata?.title }));
}

export async function pollCrawlResults(jobId: string): Promise<CrawlPage[]> {
  const url = `${crawlBaseUrl()}/${jobId}`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: cfHeaders() });
    if (!res.ok) {
      throw new AdapterError("crawl", `Failed to poll crawl ${jobId}: ${res.status}`);
    }

    const data = await res.json() as {
      success: boolean;
      result: {
        status: string;
        total?: number;
        finished?: number;
        records?: CrawlRecord[];
      };
      result_info?: { cursor?: string };
    };

    const jobStatus = data.result.status;
    logger.debug(`Crawl ${jobId}: ${jobStatus} (${data.result.finished ?? 0}/${data.result.total ?? "?"})`);

    if (TERMINAL_STATUSES.has(jobStatus)) {
      if (jobStatus !== "completed") {
        throw new CrawlJobError(jobId, jobStatus);
      }

      const pages = recordsToPages(data.result.records ?? []);

      // Paginate if the API returns a cursor
      if (data.result_info?.cursor) {
        const pageUrl = new URL(url);
        pageUrl.searchParams.set("status", "completed");
        let cursor: string | undefined = data.result_info.cursor;
        while (cursor) {
          pageUrl.searchParams.set("cursor", cursor);
          const pageRes = await fetch(pageUrl.toString(), { headers: cfHeaders() });
          if (!pageRes.ok) break;
          const pageData = await pageRes.json() as typeof data;
          pages.push(...recordsToPages(pageData.result.records ?? []));
          cursor = pageData.result_info?.cursor;
        }
      }

      return pages;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new CrawlTimeoutError(jobId, POLL_TIMEOUT_MS);
}

export async function parseCrawlPages(
  pages: CrawlPage[],
  sourceSlug: string,
  options?: FetchOptions,
): Promise<RawRelease[]> {
  if (pages.length === 0) return [];

  logger.info(`Parsing ${pages.length} crawled page(s) with AI...`);

  // Parse pages in parallel with concurrency limit of 5
  const CONCURRENCY = 5;
  const allReleases: RawRelease[] = [];

  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (page) => {
        logger.debug(`Parsing page: ${page.url} (${page.markdown.length} chars)`);
        const parsed = await parseChangelog(page.markdown, sourceSlug);
        return parsed.map((entry) => ({
          version: entry.version,
          title: entry.title,
          content: entry.content,
          url: page.url,
          publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
          isBreaking: entry.isBreaking,
          media: entry.media,
        } as RawRelease));
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        allReleases.push(...result.value);
      } else {
        logger.warn(`Failed to parse crawled page: ${result.reason}`);
      }
    }
  }

  // Apply filters after aggregation
  let filtered = allReleases;
  if (options?.since) {
    filtered = filtered.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    filtered = filtered.slice(0, options.maxEntries);
  }

  return filtered;
}
