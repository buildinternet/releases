/**
 * Source metadata types and helpers — extracted from feed.ts so that
 * modules which only need metadata parsing don't pull in the full
 * feed adapter (and transitively, bun:sqlite via queries.ts).
 */

import type { Source } from "../db/schema.js";

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

  // Crawl fields
  crawlEnabled?: boolean;
  crawlPattern?: string;
  lastCrawlJobId?: string;
  lastCrawlAt?: string;
  crawlMaxAge?: number;       // seconds — Cloudflare R2 cache TTL (default 86400, max 604800)
  crawlRender?: boolean;      // false = skip headless browser, fast HTML-only fetch
  crawlSource?: "all" | "sitemaps" | "links"; // URL discovery method

  // Provider detection
  provider?: string;
  providerDetectedAt?: string;

  // Evaluation fields (from `releases evaluate`)
  markdownUrl?: string;
  evaluatedMethod?: string;
  evaluatedAt?: string;

  // GitHub fields
  changelogUrl?: string;
  changelogDetectedAt?: string;

  // Content depth assessment
  feedContentDepth?: "full" | "summary-only";
  autoEnrich?: boolean;  // true = auto-enrich new releases after feed fetch (for summary-only feeds)

  // Per-source AI guidance
  parseInstructions?: string;  // freeform text appended to AI parsing prompts

  // Summary generation
  summarize?: boolean; // false = opt-out of AI summaries

  // Page HEAD check fields (scrape sources without feeds)
  pageEtag?: string;
  pageLastModified?: string;
  pageContentLength?: string;
  headCheckUseless?: boolean;      // server never returns useful headers
  headCheckSkips?: number;         // times HEAD said unchanged and content hash agreed
  headCheckFalseNegatives?: number; // times HEAD said unchanged but content hash differed
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
