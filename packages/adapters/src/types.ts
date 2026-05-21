import type { Source, ReleaseType } from "@buildinternet/releases-core/schema";

export interface RawRelease {
  version?: string;
  title: string;
  content: string;
  url?: string;
  publishedAt?: Date;
  isBreaking?: boolean;
  type?: ReleaseType;
  media?: Array<{ type: "image" | "video" | "gif"; url: string; alt?: string }>;
  /**
   * Whether this is a pre-release (beta, rc, nightly, preview, etc.). Set
   * authoritatively by adapters with first-class signals (GitHub releases
   * API exposes `prerelease`); other adapters leave it undefined and let
   * the upsert path fall back to a version-pattern heuristic via
   * `isPrereleaseVersion()`.
   */
  prerelease?: boolean;
  /**
   * Source-supplied category labels (e.g. RSS `<category>` terms or JSON
   * Feed `tags`). Used by the per-source `categoryAllow` filter in poll-fetch
   * to drop noise from mixed-topic feeds without paying for an agent pass.
   */
  categories?: string[];
  /**
   * True when `content` was derived from the item's short `<description>` /
   * JSON-feed `summary` because no distinct `content:encoded` / `content_html`
   * body was present. Drives summary-only feed detection (`assessFeedDepth`).
   * Transient — never persisted on the release row.
   */
  contentFromSummary?: boolean;
}

export interface FetchOptions {
  /** Only fetch releases published after this date */
  since?: Date;
  /** Maximum number of releases to fetch */
  maxEntries?: number;
  /** --crawl (true) / --no-crawl (false) / unset (use persisted setting) */
  crawl?: boolean;
  /** Force full re-parse, bypassing incremental optimization */
  full?: boolean;
  /** Preview mode — avoid persisting side-effects like content hashes */
  dryRun?: boolean;
  /** Bypass upstream caches (e.g. Cloudflare crawl R2 cache). Set by --force. */
  bustCache?: boolean;
  /** Called when a parsing chunk completes (for progress reporting) */
  onParseProgress?: (completed: number, total: number) => void;
}

export interface FetchResult {
  releases: RawRelease[];
  /** Raw content from the upstream source (e.g. Cloudflare markdown). Saved to fetchLog for re-processing. */
  rawContent?: string;
}

export interface Adapter {
  fetch(source: Source, options?: FetchOptions): Promise<FetchResult>;
}

export interface CrawlPage {
  url: string;
  markdown: string;
  title?: string;
}
