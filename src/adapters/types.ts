import type { Source } from "../db/schema.js";

export interface RawRelease {
  version?: string;
  title: string;
  content: string;
  url?: string;
  publishedAt?: Date;
  isBreaking?: boolean;
}

export interface FetchOptions {
  /** Only fetch releases published after this date */
  since?: Date;
  /** Maximum number of releases to fetch */
  maxEntries?: number;
  /** --crawl (true) / --no-crawl (false) / unset (use persisted setting) */
  crawl?: boolean;
}

export interface FetchResult {
  releases: RawRelease[];
  /** Raw content from the upstream source (e.g. Cloudflare markdown). Saved to fetchLog for re-processing. */
  rawContent?: string;
}

export interface Adapter {
  fetch(source: Source, options?: FetchOptions): Promise<FetchResult>;
}
