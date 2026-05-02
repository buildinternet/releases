import { logger } from "@buildinternet/releases-lib/logger";
import { startCrawl, pollCrawlResults } from "./crawl.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";

/** Resource types to block when rendering pages via Cloudflare Browser Rendering. */
export const CF_REJECT_RESOURCE_TYPES = ["font", "stylesheet"] as const;

// CF Browser Rendering's /markdown converter strips fenced-code language hints
// (`<pre data-language="ts">` or `<code class="language-ts">` collapse to bare
// ``` blocks), so downstream Shiki highlighting can't tokenize them. Recovering
// them means fetching /content (HTML) and running our own HTML→markdown — see
// https://github.com/buildinternet/releases/issues/667.
async function fetchCloudflareRendered(
  url: string,
  accountId: string,
  apiToken: string,
  format: "content" | "markdown",
): Promise<string | null> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/${format}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "User-Agent": RELEASES_BOT_UA,
    },
    body: JSON.stringify({
      url,
      rejectResourceTypes: [...CF_REJECT_RESOURCE_TYPES],
      gotoOptions: { waitUntil: "networkidle2" },
    }),
  });

  if (!res.ok) {
    logger.debug(`Cloudflare /${format} returned ${res.status} for ${url}`);
    return null;
  }

  const data = (await res.json()) as { success: boolean; result: string };
  if (!data.success || !data.result?.trim()) return null;

  return data.result;
}

export function fetchCloudflareMarkdown(
  url: string,
  accountId: string,
  apiToken: string,
): Promise<string | null> {
  return fetchCloudflareRendered(url, accountId, apiToken, "markdown");
}

/**
 * Fetch markdown from a URL without headless browser rendering.
 * Reuses startCrawl/pollCrawlResults from crawl.ts with render: false.
 * Returns the first page's markdown, or null on any failure.
 */
export async function fetchCloudflareMarkdownFast(url: string): Promise<string | null> {
  try {
    const jobId = await startCrawl(url, { render: false, limit: 1 });
    const pages = await pollCrawlResults(jobId);
    return pages[0]?.markdown ?? null;
  } catch (err) {
    logger.debug(`Fast markdown fetch failed for ${url}: ${err}`);
    return null;
  }
}
