/**
 * Source metadata types and helpers — extracted from feed.ts so that
 * modules which only need metadata parsing don't pull in the full
 * feed adapter (and transitively, bun:sqlite via queries.ts).
 */

import type { Source } from "@releases/core-internal/schema";

type FeedType = "rss" | "atom" | "jsonfeed";

export interface SourceMetadata {
  // Feed fields
  feedUrl?: string;
  feedType?: FeedType;
  feedDiscoveredAt?: string;
  feedEtag?: string;
  feedLastModified?: string;
  feedContentLength?: string;
  noFeedFound?: boolean;
  /**
   * Count of consecutive 4xx responses on the stored feedUrl. Reset on any
   * non-4xx feed response (success or 5xx). When the streak hits the
   * invalidation threshold, callers clear the feed metadata so rediscovery
   * can run on the next fetch. 4xx is evidence the URL is gone (renamed,
   * removed); 5xx is transient and ignored.
   */
  feed4xxStreak?: number;

  // Crawl fields
  crawlEnabled?: boolean;
  crawlPattern?: string;
  lastCrawlJobId?: string;
  lastCrawlAt?: string;
  crawlMaxAge?: number; // seconds — Cloudflare R2 cache TTL (default 86400, max 604800)
  crawlRender?: boolean; // false = skip headless browser, fast HTML-only fetch
  crawlSource?: "all" | "sitemaps" | "links"; // URL discovery method

  /** Agent/user override — true = always use headless browser, false = fast fetch OK, absent = use provider hint */
  renderRequired?: boolean;

  // Provider detection
  provider?: string;
  providerDetectedAt?: string;

  // Evaluation fields (from `releases admin discovery evaluate`)
  markdownUrl?: string;
  evaluatedMethod?: string;
  evaluatedAt?: string;

  // GitHub fields
  changelogUrl?: string;
  changelogDetectedAt?: string;

  // Content depth assessment — set during onboarding. If "summary-only",
  // prefer enabling crawlEnabled so per-release pages are fetched during parse.
  feedContentDepth?: "full" | "summary-only";

  // Per-source AI guidance
  parseInstructions?: string; // freeform text appended to AI parsing prompts

  // Summary generation
  summarize?: boolean; // false = opt-out of AI summaries

  // Page HEAD check fields (scrape sources without feeds)
  pageEtag?: string;
  pageLastModified?: string;
  pageContentLength?: string;
  headCheckUseless?: boolean; // server never returns useful headers
  headCheckSkips?: number; // times HEAD said unchanged and content hash agreed
  headCheckFalseNegatives?: number; // times HEAD said unchanged but content hash differed

  // Direct-fetch fields (agent adapter): conditional GET this URL and hand
  // the body to the AI, bypassing web_fetch / Cloudflare rendering.
  fetchUrl?: string;
  fetchEtag?: string;
  fetchLastModified?: string;
}

/** Parse the JSON metadata blob from a source row. */
export function getSourceMeta(source: Source): SourceMetadata {
  try {
    const raw = source.metadata ?? "{}";
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}
