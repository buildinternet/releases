import { config } from "@releases/lib/config";
import { AdapterError, CrawlTimeoutError, CrawlJobError } from "@releases/lib/errors";
import { logger } from "@buildinternet/releases-lib/logger";
import type { CrawlPage } from "@releases/adapters/types";
/** Resource types to block when rendering (duplicated from cloudflare.ts to avoid circular import). */
const REJECT_RESOURCE_TYPES = ["font", "stylesheet"] as const;

// NOTE: The crawl flow is currently synchronous (poll until done). This is
// designed to be split into start/retrieve phases for background execution.
// See deferred items in the crawl integration spec.

interface CrawlOptions {
  includePatterns?: string[];
  limit?: number;
  modifiedSince?: number; // unix timestamp
  maxAge?: number; // Cloudflare R2 cache TTL in seconds
  render?: boolean; // false = skip headless browser rendering
  source?: "all" | "sitemaps" | "links"; // URL discovery method
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
    rejectResourceTypes: [...REJECT_RESOURCE_TYPES],
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
    // Browser-only options are invalid when not rendering
    delete body.gotoOptions;
    delete body.rejectResourceTypes;
  }

  // Default to "links" so the crawler follows links from the starting page in
  // DOM order (which on most changelog index pages is newest-first). Two
  // reasons this matters: (1) Cloudflare's own default is sitemaps-only, which
  // silently returns just the starting page on sites whose sitemaps don't
  // enumerate the changelog (e.g. langfuse.com). (2) "all" discovers via
  // sitemap first, which on many sites means oldest-first — a limited crawl
  // (`--max 30`) then captures ancient history instead of the latest posts.
  // Per-source metadata can still override via `crawlSource`.
  body.source = options.source ?? "links";

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

  const data = (await res.json()) as { success: boolean; result: string };
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
  // Request completed records explicitly. The default response mixes up to 50 records
  // of any status (completed, skipped, errored) with no cursor when the total fits in
  // one page — so a crawl with many skipped URLs can drop all but the first completed
  // page. Filtering to `status=completed` makes the records list contain only the pages
  // we actually want markdown for. Job-level status (`result.status`) is unaffected.
  const url = `${crawlBaseUrl()}/${jobId}?status=completed`;
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- crawl polling loop; each iteration checks job status before next poll
    const res = await fetch(url, { headers: cfHeaders() });
    if (!res.ok) {
      throw new AdapterError("crawl", `Failed to poll crawl ${jobId}: ${res.status}`);
    }

    // oxlint-disable-next-line no-await-in-loop -- crawl polling loop; reading JSON body from same response
    const data = (await res.json()) as {
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
    logger.debug(
      `Crawl ${jobId}: ${jobStatus} (${data.result.finished ?? 0}/${data.result.total ?? "?"})`,
    );

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
          // oxlint-disable-next-line no-await-in-loop -- crawl result pagination; next cursor comes from prior response
          const pageRes = await fetch(pageUrl.toString(), { headers: cfHeaders() });
          if (!pageRes.ok) break;
          // oxlint-disable-next-line no-await-in-loop -- crawl result pagination; reading JSON body from same paged response
          const pageData = (await pageRes.json()) as typeof data;
          pages.push(...recordsToPages(pageData.result.records ?? []));
          cursor = pageData.result_info?.cursor;
        }
      }

      return pages;
    }

    // oxlint-disable-next-line no-await-in-loop -- crawl polling; deliberate sleep between status checks
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new CrawlTimeoutError(jobId, POLL_TIMEOUT_MS);
}
