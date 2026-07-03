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
  /**
   * @deprecated Cloudflare's `includePatterns` matcher silently rejects every
   * discovered URL regardless of pattern shape — see issue #929. Kept for
   * back-compat; not passed to Cloudflare. Use `crawlExcludePatterns` instead.
   */
  crawlPattern?: string;
  /**
   * URL globs to exclude from the crawl. Cloudflare's exclude matcher works as
   * documented (unlike `includePatterns` — see #929). Use full-URL globs, e.g.
   * `["https://example.com/humans/**", "https://example.com/login"]`.
   * `excludePatterns` has strictly higher priority than `includePatterns` at
   * Cloudflare's matcher.
   */
  crawlExcludePatterns?: string[];
  /** Per-source override for the default `includeExternalLinks: false`. Set true to allow off-domain crawl discovery. Rare. */
  crawlIncludeExternal?: boolean;
  /**
   * Pathname prefix the post-filter keeps after `pollCrawlResults`. Pages
   * whose `new URL(page.url).pathname` does not start with this prefix are
   * dropped from the markdown the extractor sees. The prefix is matched
   * against the origin of `source.url`; cross-origin pages are always dropped.
   *
   * Does NOT reclaim Cloudflare's render-page budget — the crawler still
   * fetches the dropped pages. The budget can still exhaust on unrelated nav
   * links before reaching matching ones (#1009); combine with
   * `crawlExcludePatterns` to fence the crawler off from unwanted paths up
   * front. When the filter drops every page, the caller falls back to
   * `fetchCloudflareMarkdown` on `source.url`.
   */
  crawlIncludePathPrefix?: string;
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
  // "anchor-fragment" means the feed's item URLs are all #section anchors on one
  // shared page; enrichment cannot isolate entries, so it must not be attempted.
  feedContentDepth?: "full" | "summary-only" | "anchor-fragment";

  /**
   * Enrichment circuit-breaker state. Stored here (not a schema column) so it
   * survives source-metadata updates without a migration. The counter is
   * incremented on each all-fail cron fire and reset to 0 on any success.
   * When `consecutiveFailures` >= `ENRICH_CONSECUTIVE_FAILURE_LIMIT` the
   * enricher skips the source entirely.
   */
  enrichment?: {
    consecutiveFailures: number;
  };

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

  /**
   * Optional allowlist of keywords matched case-insensitively as substrings
   * against each feed item's `title` or `url`. When present, the cron keeps
   * only items where at least one keyword appears in the title or URL slug;
   * all others are dropped. Complements `categoryAllow` for mixed-topic feeds
   * that carry no usable `<category>` tags but encode the section in the slug
   * — e.g. Discord's blog feed, where the changelog/patch-notes posts live at
   * `…/discord-patch-notes-…` and `…-changelog` among marketing posts.
   */
  feedKeywordAllow?: string[];

  /**
   * Optional denylist of regex patterns matched case-insensitively against
   * each feed item's `url`. Items whose URL matches any pattern are dropped
   * before insert. Built to suppress localized translation duplicates that
   * reuse a source post's content under a locale-suffixed URL — ClickHouse's
   * RSS publishes every post twice, `…/blog/gala` and `…/blog/gala-jp`, and
   * the `-jp` variant shares no other dedup key with the English original
   * (`UNIQUE(source_id, url)` sees two distinct URLs). Set `["-jp$"]` to drop
   * Japanese translations; add `-de$`, `-fr$`, etc. for other locales. The
   * deny complement of `feedKeywordAllow`; applied after the allow filters.
   * Patterns that fail to compile are ignored (a bad rule can't wipe a feed).
   *
   * Enforced at every ingest write boundary, not just the cron feed path
   * (#1335): the HTTP `/releases/batch` + single-insert handlers and the shared
   * in-process `ingestRawReleases` helper all run `filterByUrlDeny`, so the
   * managed-agent fetch, scrape-delegation, Firecrawl, and backfill paths drop
   * matching URLs too.
   */
  feedUrlDeny?: string[];

  /**
   * When true, run each newly-parsed item through a Haiku classifier before
   * insert; items classified as marketing are inserted with `suppressed=true`
   * and `suppressedReason="marketing_classifier:<slug>"` so they stay out of
   * read paths, publish, and embed but remain queryable for audit and easy
   * `unsuppress`. Opt-in only — flip on for vendor blogs that mix product
   * news with case studies / newsletters / event recaps (ClickHouse blog,
   * Snowflake blog, etc.). Default fail-open: classifier errors fall back to
   * inserting visibly. See `@releases/ai-internal/marketing-classifier`.
   */
  marketingFilter?: boolean;

  /**
   * Free-form hint appended to the marketing-classifier system prompt. Use to
   * give the model org-specific context the URL/title alone can't carry —
   * e.g. "This blog also publishes monthly newsletters with slug
   * `YYYYMM-newsletter`." Ignored when `marketingFilter` is false.
   */
  marketingFilterHint?: string;

  // Per-source AI guidance
  parseInstructions?: string; // freeform text appended to AI parsing prompts

  /**
   * Per-source opt-out from AI content generation (`title_generated` /
   * `title_short` / `summary`). Set `false` to skip a source even when its org
   * has `auto_generate_content = true` — useful for App Store apps and similar
   * sources whose release notes are always boilerplate ("Bug fixes and
   * improvements"). Absent / `true` keeps the source eligible. Enforced in the
   * row-selection queries via `summarizeNotOptedOut`
   * (`@releases/core-internal/eligibility`), shared by the live cron path
   * (`generateContentForReleases`) and the batch path (`fetchEligibleReleases`).
   */
  summarize?: boolean;

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

  // GitHub tag filtering

  /**
   * GitHub-tag deny-list. Tag names whose prefix matches any entry in this
   * array are skipped during ingestion. Case-sensitive — matches the upstream
   * `tag_name` verbatim. Useful for excluding CI / internal sub-tool tags from
   * a monorepo source (e.g. PostHog's `agent-skills-`, `hog-`, `phrocs-`).
   *
   * Ignored when `tagAllowPatterns` is non-empty — the allow-list takes
   * precedence (see `tagAllowPatterns`).
   */
  tagDenyPrefixes?: string[];

  /**
   * GitHub-tag allow-list expressed as regex source strings. When set, only
   * tags matching at least one expression are ingested; all others are skipped.
   * Useful when a monorepo's signal is concentrated in one specific tag prefix
   * (e.g. only ingest `^v\d+` version tags).
   *
   * Mutually exclusive with `tagDenyPrefixes`: when `tagAllowPatterns` is
   * non-empty, deny-prefix filtering is bypassed entirely.
   */
  tagAllowPatterns?: string[];

  /**
   * App Store listing routing + cached listing metadata (#appstore). Present
   * only on `type: "appstore"` sources. `trackId` is the iTunes lookup key;
   * `platform` selects the lookup `entity` (macos → macSoftware). `artworkUrl`
   * is the last-seen icon, used to skip no-op product-avatar refreshes.
   */
  appStore?: {
    trackId: string;
    bundleId?: string;
    storefront: string;
    platform: "ios" | "macos";
    firstPublishedAt?: string;
    minOsVersion?: string;
    artworkUrl?: string;
  };

  /**
   * Video source routing + provider identity (#video). Present only on
   * `type: "video"` sources. `feedUrl`/`feedType` (above) hold the provider's
   * Atom/RSS endpoint so polling reuses the feed machinery; this block carries
   * the provider discriminator and resolved channel identity for display.
   */
  video?: {
    provider: "youtube" | "vimeo" | "wistia";
    channel?: {
      id?: string;
      handle?: string;
      title?: string;
      playlistId?: string;
      playlistTitle?: string;
    };
  };

  /**
   * Firecrawl monitoring opt-in. Present on sources whose fetch is delegated
   * to Firecrawl's external scrape + change-detection (anti-bot escape hatch
   * for sources our own pipeline can't reach). Desired-state source of truth;
   * the monitor spec is derived from this + source.url. See
   * docs/superpowers/specs/2026-05-29-firecrawl-monitoring-integration-design.md
   */
  firecrawl?: {
    enabled: boolean; // opt-in master switch
    monitorId?: string; // stamped after create; cleared on delete
    schedule?: string; // cron or natural-language; default "every 6 hours"
    proxy?: "basic" | "enhanced" | "auto"; // default "auto"
    goal?: string; // natural-language judge goal
    judgeEnabled?: boolean; // default true; false = always extract (gate off)
    /**
     * Monitor target type. `"scrape"` (default) watches the single `source.url`.
     * `"crawl"` watches a multi-page changelog: Firecrawl runs a full crawl of
     * `source.url` on each check and reports each discovered per-entry page's own
     * URL, so each new/changed page is ingested attributed to its own canonical
     * URL (dedup-clean against existing crawl-ingested rows). The target type is
     * set at monitor-create only and is dashboard-authoritative after — switching
     * an existing monitor between scrape and crawl requires disable + re-enable
     * (delete + recreate), not a PATCH. See docs/architecture/firecrawl-monitoring.md.
     */
    target?: "scrape" | "crawl";
    /**
     * Crawl-target tuning, applied only when `target === "crawl"` at create time.
     * `includePaths`/`excludePaths` are Firecrawl path-regexes (NOT the Cloudflare
     * URL-glob patterns used by the in-repo crawl adapter). Defaults mirror the
     * crawl adapter's intent: a modest page `limit` and shallow `maxDiscoveryDepth`.
     */
    crawl?: {
      limit?: number;
      maxDiscoveryDepth?: number;
      includePaths?: string[];
      excludePaths?: string[];
      sitemap?: "skip" | "include" | "only";
    };
    lastCheckId?: string; // observability
    lastChangeAt?: string; // observability (ISO)
  };

  /**
   * Help-center API routing. A `type: "feed"` source whose `feedUrl` points at a
   * vendor Help Center API (not RSS/Atom) carries this block so the feed
   * dispatcher routes the fetch to the matching deterministic parser instead of
   * `fetchAndParseFeed`. `provider` selects the parser (`zendesk` →
   * `/api/v2/help_center/.../sections/<id>/articles.json`, one article → one
   * release). `releaseType` classifies every article from the source — set
   * `"rollup"` for periodic-digest sections (weekly release notes, monthly
   * "what's new"); omit for per-feature sections. See
   * `packages/adapters/src/helpcenter.ts`.
   */
  helpCenter?: {
    provider: "zendesk";
    releaseType?: "feature" | "rollup";
  };

  /**
   * SHA-256 of the crawled markdown body that most recently FAILED extraction
   * (maxed the output-token cap — `hitMaxTokens`, never committed a content
   * hash). When the next crawl produces byte-identical markdown, the crawl
   * path skips re-running the (expensive, deterministically-doomed)
   * extraction rather than re-billing an identical failure every cron cycle
   * (#1852 follow-up). Deliberately stored SEPARATELY from
   * `lastContentHash`/`commitContentHash` — that column is reserved for
   * successful extractions so a body that later extracts cleanly (after a
   * prompt/model fix) is never locked out.
   *
   * Cleared (never left stale) on: (1) any extraction that completes cleanly
   * (natural recovery — the crawl path clears it right after a successful
   * `extractFromBody` call), or (2) the source being un-paused via `PATCH
   * .../sources/:slug { fetchPriority }` (the operator's manual "try again"
   * signal after a fix, since #1852 auto-pauses sources stuck on this path).
   */
  lastFailedExtractHash?: string;

  /**
   * Write-through observability mirror written by the SourceActor DO on each
   * alarm tick. Absent on sources not managed by the actor, or after the actor
   * has handed the source back to the cron (`managed: false`). Used by the dev
   * fetch-plan panel to show actor-managed sources and their exact next alarm.
   * Never used for routing or scheduling — purely observational.
   */
  sourceActor?: {
    /** ISO timestamp of the actor's next scheduled alarm; null while idle. */
    nextAlarmAt: string | null;
    /** ISO timestamp of the most recent alarm execution. */
    lastAlarmAt: string;
    /** True while the actor is driving this source; false when handed back. */
    managed: boolean;
  };
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
 * True when a source is fetched via the Apple App Store adapter. Unlike
 * `isGitHubFetched`, there's no metadata-override form — the type is the
 * only signal.
 */
export function isAppStoreFetched(source: Source): boolean {
  return source.type === "appstore";
}

/**
 * True when a source is fetched via the video adapter. Like `isAppStoreFetched`,
 * the type is the only signal — there's no metadata-override form.
 */
export function isVideoFetched(source: Source): boolean {
  return source.type === "video";
}

/**
 * Video provider tag from a source's `metadata` JSON. Returns null for
 * non-`video` sources or when no provider is recorded. Mirrors
 * `appStoreSourceInfo`; the search package keeps its own copy to avoid a dep.
 *
 * `metadata.video.channel.*` is stored but intentionally not threaded onto this
 * wire shape yet (the thumbnail and watch URL reuse the release's existing
 * `media[]` / `url`); widen `VideoSourceInfoSchema` and this return type
 * together when a consumer needs the channel identity.
 */
export function videoSourceInfo(
  type: string,
  metadataJson: string | null,
): { provider: "youtube" | "vimeo" | "wistia" } | null {
  if (type !== "video") return null;
  try {
    const block = (JSON.parse(metadataJson ?? "{}") as { video?: { provider?: unknown } } | null)
      ?.video;
    const provider = block?.provider;
    if (provider === "youtube" || provider === "vimeo" || provider === "wistia") {
      return { provider };
    }
  } catch {
    // fall through
  }
  return null;
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
 * anchor convention used by most static doc generators: a leading `v` is
 * stripped (GitHub tags commonly have one; doc-page heading slugs almost
 * never do), then dots become dashes (e.g. tag `v2.1.136` → `#2-1-136`).
 *
 * Custom templates may interpolate `${sourceUrl}`, `${version}` (raw, e.g.
 * `v2.1.136`), or `${versionDashed}` (raw with dots → dashes, e.g.
 * `v2-1-136`). To opt out of the default `v` strip, write the template
 * explicitly: `${sourceUrl}#${versionDashed}` keeps the prefix.
 */
export function synthesizeReleaseUrl(args: {
  sourceUrl: string;
  version: string;
  template?: string;
}): string {
  const versionDashed = args.version.replaceAll(".", "-");
  if (!args.template) {
    const stripped = args.version.replace(/^v/i, "");
    const strippedDashed = stripped.replaceAll(".", "-");
    return `${args.sourceUrl}#${strippedDashed}`;
  }
  return args.template
    .replaceAll("${sourceUrl}", args.sourceUrl)
    .replaceAll("${versionDashed}", versionDashed)
    .replaceAll("${version}", args.version);
}
