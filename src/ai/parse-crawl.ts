import { logger } from "../lib/logger.js";
import { parseChangelog } from "./ingest.js";
import type { CrawlPage } from "../adapters/crawl.js";
import type { RawRelease, FetchOptions } from "@releases/adapters/types";

export async function parseCrawlPages(
  pages: CrawlPage[],
  sourceSlug: string,
  options?: FetchOptions,
  parseInstructions?: string,
): Promise<RawRelease[]> {
  if (pages.length === 0) return [];

  logger.info(`Parsing ${pages.length} crawled page(s) with AI...`);

  const CONCURRENCY = 5;
  const allReleases: RawRelease[] = [];

  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const batch = pages.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (page) => {
        logger.debug(`Parsing page: ${page.url} (${page.markdown.length} chars)`);
        const parsed = await parseChangelog(page.markdown, sourceSlug, { parseInstructions });
        return parsed.map((entry) => ({
          version: entry.version,
          title: entry.title,
          content: entry.content,
          url: page.url,
          publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : undefined,
          isBreaking: entry.isBreaking,
          type: entry.type,
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

  let filtered = allReleases;
  if (options?.since) {
    filtered = filtered.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    filtered = filtered.slice(0, options.maxEntries);
  }

  return filtered;
}
