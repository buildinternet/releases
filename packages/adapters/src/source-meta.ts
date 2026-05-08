/**
 * Source metadata types and helpers — extracted from feed.ts so that
 * modules which only need metadata parsing don't pull in the full
 * feed adapter (and transitively, bun:sqlite via queries.ts).
 */

import type { Source } from "@buildinternet/releases-core/schema";

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

  /**
   * Fetch override — when set, the ingest path treats this source as a GitHub
   * coordinate even though `source.type` may be `scrape`. `source.url` stays
   * the human-readable docs URL; `metadata.githubUrl` carries the repo URL the
   * worker actually hits. See `docs/architecture/remote-mode.md` —
   * "Display URL vs. fetch routing".
   */
  githubUrl?: string;
  /**
   * Optional release-URL template applied when fetching via `githubUrl`.
   * Supports `${sourceUrl}`, `${version}`, and `${versionDashed}` placeholders.
   * Default: `${sourceUrl}#${versionDashed}` (Mintlify anchor convention).
   */
  releaseUrlTemplate?: string;

  // Content depth assessment — set during onboarding. If "summary-only",
  // prefer enabling crawlEnabled so per-release pages are fetched during parse.
  feedContentDepth?: "full" | "summary-only";

  /**
   * Optional allowlist of feed `<category>` values (or JSON-feed `tags`).
   * When present, the cron keeps only items whose categories intersect this
   * list (case-insensitive on label, falling back to term). Items without
   * any category are also dropped, since this is meant for feeds that tag
   * every entry. Useful on mixed-topic feeds where the upstream tags are
   * reliable — e.g. OpenAI News tags entries `Product`, `Research`,
   * `B2B Story`, etc.
   */
  categoryAllow?: string[];

  // Per-source AI guidance
  parseInstructions?: string; // freeform text appended to AI parsing prompts

  // Summary generation
  summarize?: boolean; // false = opt-out of AI summaries

  // Page HEAD / body-hash change-detection fields for scrape-no-feed and
  // agent sources (#517). Validator choice is driven by the playbook's
  // `fetchQuirks` entry (#516). Only populated on sources whose playbook
  // opts them into a change detector.
  pageEtag?: string;
  pageLastModified?: string;
  pageContentLength?: string;
  /** SHA-256 of the full response body. Used by the `body-hash` detector. */
  pageContentHash?: string;
  headCheckUseless?: boolean; // server never returns useful headers
  headCheckSkips?: number; // times HEAD said unchanged and content hash agreed
  headCheckFalseNegatives?: number; // times HEAD said unchanged but content hash differed

  // Direct-fetch fields (agent adapter): conditional GET this URL and hand
  // the body to the AI, bypassing web_fetch / Cloudflare rendering.
  fetchUrl?: string;
  fetchEtag?: string;
  fetchLastModified?: string;

  /**
   * Force the extract path: `"toolloop"` to run tool-use extraction even when
   * the body is small; omitted to use the default threshold-based gate.
   */
  extractStrategy?: "toolloop";
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

/**
 * True when the source is fetched from GitHub: either declared as
 * `type: "github"` or a `scrape`/`feed` source with a `metadata.githubUrl`
 * fetch override (#831). Single helper so dispatcher branches stay aligned.
 */
export function isGitHubFetched(source: Source, meta?: SourceMetadata): boolean {
  if (source.type === "github") return true;
  const m = meta ?? getSourceMeta(source);
  return typeof m.githubUrl === "string" && m.githubUrl.length > 0;
}

/**
 * Returns the URL the GitHub fetch path should hit. Prefers the metadata
 * override when set; otherwise falls back to `source.url`.
 */
export function effectiveGitHubUrl(source: Source, meta?: SourceMetadata): string {
  const m = meta ?? getSourceMeta(source);
  return m.githubUrl ?? source.url;
}

/**
 * Synthesize a release URL from a template. Defaults to the Mintlify-style
 * anchor convention used by most static doc generators (`#1-2-3`). Custom
 * templates may interpolate `${sourceUrl}`, `${version}`, and
 * `${versionDashed}` (dots → dashes).
 */
export function synthesizeReleaseUrl(args: {
  sourceUrl: string;
  version: string;
  template?: string;
}): string {
  const versionDashed = args.version.replaceAll(".", "-");
  if (!args.template) {
    return `${args.sourceUrl}#${versionDashed}`;
  }
  return args.template
    .replaceAll("${sourceUrl}", args.sourceUrl)
    .replaceAll("${versionDashed}", versionDashed)
    .replaceAll("${version}", args.version);
}
