import type { RawRelease, FetchOptions } from "@releases/adapters/types";
import { logger } from "@buildinternet/releases-lib/logger";
import { FeedHttpError } from "@releases/lib/errors";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { classifyMediaType, isGifUrl } from "./media-classify.js";
import { parseFeed as libParseFeed } from "@rowanmanning/feed-parser";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

// Re-export source-meta helpers so consumers can pull everything feed-related
// from a single path.
export {
  getSourceMeta,
  isGitHubFetched,
  effectiveGitHubUrl,
  synthesizeReleaseUrl,
  type SourceMetadata,
} from "@releases/adapters/source-meta";
import type { SourceMetadata } from "@releases/adapters/source-meta";

/**
 * Count of consecutive 4xx responses on a stored feedUrl after which we
 * invalidate it. Picked conservatively: at the cron's 4-hour normal tier,
 * 5 strikes ≈ 20 hours — enough that a brief misconfiguration won't flush
 * the URL, but short enough that a renamed/removed feed self-heals well
 * before someone notices manually.
 */
export const FEED_4XX_INVALIDATE_THRESHOLD = 5;

/**
 * The metadata fields cleared together when feed state is reset — either
 * after persistent 4xx invalidation or via `--no-feed-url`. Centralized so
 * adding a new feed-tracking field doesn't silently leak past cleanup and
 * produce stale 304s on the next discovered feed.
 */
export const CLEARED_FEED_FIELDS: Partial<SourceMetadata> = {
  feedUrl: undefined,
  feedType: undefined,
  feedDiscoveredAt: undefined,
  feedEtag: undefined,
  feedLastModified: undefined,
  feedContentLength: undefined,
  feed4xxStreak: undefined,
};

// ── Feed types ──────────────────────────────────────────────────────

export type FeedType = "rss" | "atom" | "jsonfeed";

export interface DiscoveredFeed {
  url: string;
  type: FeedType;
}

// ── Feed discovery ──────────────────────────────────────────────────

const WELL_KNOWN_PATHS = [
  "/feed.json",
  "/changelog/feed.json",
  "/changelog.json",
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/changelog.rss",
  "/changelog/feed",
  "/changelog/rss",
  "/changelog.xml",
];

/**
 * Suffixes appended to the page's own path when probing for sibling feeds.
 * Ordered from most specific to most generic so the first hit wins cleanly.
 */
const PAGE_SIBLING_SUFFIXES = [
  "/rss.xml",
  "/feed.xml",
  "/feed",
  "/rss",
  "/atom.xml",
  ".rss",
  ".atom",
];

/**
 * Discover a feed URL for a given page URL.
 * 1. Fetch the HTML and look for <link rel="alternate"> feed tags.
 * 2. Probe sibling paths derived from the page URL's own path.
 * 3. Probe well-known feed paths at the origin root as a last resort.
 * Prefers JSON feeds over XML when multiple are available.
 */
export async function discoverFeed(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFeed | null> {
  const fromHead = await discoverFromHead(pageUrl, fetchImpl);
  if (fromHead) return fromHead;

  const base = new URL(pageUrl);

  // Step 2: sibling-path probes relative to the page URL's own path.
  // Skip when the page is the root (pathname "/" or empty) — those probes
  // would duplicate the origin-root well-known probes below.
  const trimmedPath = base.pathname.replace(/\/$/, "");
  if (trimmedPath && trimmedPath !== "") {
    const siblingResults = await Promise.allSettled(
      PAGE_SIBLING_SUFFIXES.map((suffix) =>
        probeFeedPath(base.origin, `${trimmedPath}${suffix}`, fetchImpl),
      ),
    );
    for (const result of siblingResults) {
      if (result.status === "fulfilled" && result.value) return result.value;
    }
  }

  // Step 3: fall back to well-known origin-root paths.
  const results = await Promise.allSettled(
    WELL_KNOWN_PATHS.map((path) => probeFeedPath(base.origin, path, fetchImpl)),
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) return result.value;
  }

  return null;
}

/**
 * Cap on bytes we read while looking for `</head>`. Modern static-site
 * generators (Gatsby, Next, Astro) inline preload directives, font-face
 * declarations, JSON-LD blobs, and critical CSS into `<head>` — pushing
 * past 100 KB on rich SEO setups is routine. PostHog's Gatsby-built
 * changelog page sits at 619 KB before `</head>`. The previous 32 KB cap
 * silently dropped the alternate-link tag and forced fallback to
 * well-known-path probing, which mis-discovered a 404 route as the feed.
 */
const HEAD_DISCOVERY_BYTE_CAP = 512_000;

async function discoverFromHead(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFeed | null> {
  try {
    const res = await fetchImpl(pageUrl, {
      headers: { Accept: "text/html", "User-Agent": RELEASES_BOT_UA },
      redirect: "follow",
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- streaming response body chunk by chunk until </head> found
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head>") || html.length > HEAD_DISCOVERY_BYTE_CAP) {
        reader.cancel();
        break;
      }
    }

    const headEnd = html.indexOf("</head>");
    const head = headEnd > -1 ? html.slice(0, headEnd) : html;
    return parseFeedLinks(head, pageUrl);
  } catch (err) {
    logger.debug(`Failed to fetch HTML for feed discovery: ${err}`);
    return null;
  }
}

async function probeFeedPath(
  origin: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredFeed | null> {
  const probeUrl = `${origin}${path}`;
  const res = await fetchImpl(probeUrl, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": RELEASES_BOT_UA },
  });
  if (!res.ok) return null;

  const ct = res.headers.get("content-type") ?? "";
  const feedType = classifyFeedMime(ct);
  if (feedType) return { url: probeUrl, type: feedType };

  if (path.endsWith(".xml") || path.endsWith(".json") || path === "/feed" || path === "/rss") {
    const getRes = await fetchImpl(probeUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": RELEASES_BOT_UA,
        Accept: FEED_ACCEPT,
      },
    });
    if (!getRes.ok) return null;
    const getCt = getRes.headers.get("content-type") ?? "";
    const body = await getRes.text();
    const detected = classifyFeedMime(getCt) ?? detectFeedTypeFromContent(body);
    if (detected) return { url: probeUrl, type: detected };
  }

  return null;
}

export function parseFeedLinks(head: string, baseUrl: string): DiscoveredFeed | null {
  const linkRe = /<link\s[^>]*rel=["']alternate["'][^>]*>/gi;
  const candidates: DiscoveredFeed[] = [];
  let match;

  while ((match = linkRe.exec(head)) !== null) {
    const tag = match[0];
    const typeMatch = tag.match(/type=["']([^"']+)["']/);
    const hrefMatch = tag.match(/href=["']([^"']+)["']/);
    if (!typeMatch || !hrefMatch) continue;

    const feedType = classifyFeedMime(typeMatch[1]);
    if (!feedType) continue;

    candidates.push({ url: new URL(hrefMatch[1], baseUrl).toString(), type: feedType });
  }

  if (candidates.length === 0) return null;

  return candidates.find((c) => c.type === "jsonfeed") ?? candidates[0];
}

/** Classify a MIME type or Content-Type header value as a feed type. */
export function classifyFeedMime(ct: string): FeedType | null {
  ct = ct.toLowerCase();
  if (ct.includes("feed+json")) return "jsonfeed";
  if (ct.includes("rss")) return "rss";
  if (ct.includes("atom")) return "atom";
  if (ct === "application/json") return "jsonfeed";
  return null;
}

export function detectFeedTypeFromContent(body: string): FeedType | null {
  const trimmed = body.trimStart().slice(0, 500);
  if (trimmed.startsWith("{")) return "jsonfeed";
  if (trimmed.includes("<feed") && trimmed.includes("xmlns")) return "atom";
  if (trimmed.includes("<rss") || trimmed.includes("<channel>")) return "rss";
  return null;
}

// ── Feed fetching + parsing ─────────────────────────────────────────

/**
 * Feed-specific Accept header. Omits generic `application/xml` and `text/xml`
 * because some CDN/WAF stacks (e.g. Render) return 406 when those types are
 * present. Real feeds are always served under one of the feed-specific MIME
 * types, so dropping the generic tail is safe.
 */
const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/feed+json";

/**
 * Parse an HTTP `Retry-After` header to milliseconds. The header is either
 * delta-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns `undefined` when absent or unparseable; never negative.
 */
export function parseRetryAfterMs(headerVal: string | null): number | undefined {
  if (!headerVal) return undefined;
  const trimmed = headerVal.trim();
  if (trimmed === "") return undefined;
  const secs = Number(trimmed);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}

export async function fetchAndParseFeed(
  feedUrl: string,
  feedType: FeedType,
  options?: FetchOptions,
  headers?: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  releases: RawRelease[];
  etag?: string;
  lastModified?: string;
  contentLength?: string;
}> {
  const reqHeaders: Record<string, string> = {
    "User-Agent": RELEASES_BOT_UA,
    Accept: FEED_ACCEPT,
    ...headers,
  };

  let res = await fetchImpl(feedUrl, { headers: reqHeaders, redirect: "follow" });

  // Belt-and-braces: if the server returns 406 (Not Acceptable) — some
  // CDN/WAF stacks reject even feed-specific Accept types — retry once with
  // Accept: */* before giving up. This is a single fallback, not a loop.
  if (res.status === 406) {
    const fallbackHeaders = { ...reqHeaders, Accept: "*/*" };
    res = await fetchImpl(feedUrl, { headers: fallbackHeaders, redirect: "follow" });
  }

  if (res.status === 304) return { releases: [] };

  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      // Carry the server's Retry-After hint (429/408) so the caller can back
      // off for at least that long instead of guessing.
      const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
      throw new FeedHttpError(res.status, feedUrl, res.statusText, retryAfterMs);
    }
    throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.text();
  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;
  const contentLength = res.headers.get("content-length") ?? undefined;

  let effectiveType: FeedType = feedType;
  if (effectiveType !== "rss" && effectiveType !== "atom" && effectiveType !== "jsonfeed") {
    const detected = detectFeedTypeFromContent(body);
    if (!detected) {
      throw new Error(
        `Cannot parse feed: unrecognized type "${feedType}" and content detection failed`,
      );
    }
    logger.info(`Feed type "${feedType}" unrecognized, detected ${detected} from content`);
    effectiveType = detected;
  }
  let releases = effectiveType === "jsonfeed" ? parseJsonFeed(body) : parseRss(body);

  if (options?.since) {
    releases = releases.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    // A positional cap drops the newest entries on oldest-first feeds (e.g.
    // Hugo's default index.xml, which releases.1password.com serves). Sort
    // newest-first before truncating so the cap keeps the most recent
    // releases regardless of feed document order. Undated items sink last.
    releases = [...releases]
      .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
      .slice(0, options.maxEntries);
  }

  return { releases, etag, lastModified, contentLength };
}

export type ChangeStatus = "changed" | "unchanged" | "unknown";

export interface HeadCheckResult {
  status: ChangeStatus;
  etag?: string;
  lastModified?: string;
  contentLength?: string;
  responseMs: number;
}

/**
 * Send a HEAD request to a URL and compare response headers against stored
 * values to detect changes without downloading the body. The logic is generic
 * HTTP — feeds, plain HTML pages, or any other resource can share this probe.
 * Existing feed callers pass their feed URL; scrape-no-feed / agent callers
 * (#517) pass the source page URL with `page*` validators from metadata.
 */
export async function headCheckUrl(
  url: string,
  stored: { etag?: string; lastModified?: string; contentLength?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HeadCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = Date.now();

  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      headers: { "User-Agent": RELEASES_BOT_UA },
      signal: controller.signal,
      redirect: "follow",
    });

    const responseMs = Date.now() - start;
    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;
    const contentLength = res.headers.get("content-length") ?? undefined;

    if (!res.ok) {
      return { status: "unknown", etag, lastModified, contentLength, responseMs };
    }

    const hasStored = stored.etag || stored.lastModified || stored.contentLength;
    if (!hasStored) {
      return { status: "unknown", etag, lastModified, contentLength, responseMs };
    }

    const result = { etag, lastModified, contentLength, responseMs };
    let anyCompared = false;

    if (etag && stored.etag) {
      anyCompared = true;
      if (etag !== stored.etag) return { status: "changed", ...result };
    }
    if (lastModified && stored.lastModified) {
      anyCompared = true;
      if (lastModified !== stored.lastModified) return { status: "changed", ...result };
    }
    if (contentLength && stored.contentLength) {
      anyCompared = true;
      if (contentLength !== stored.contentLength) return { status: "changed", ...result };
    }

    return { status: anyCompared ? "unchanged" : "unknown", ...result };
  } catch {
    return { status: "unknown", responseMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

export interface BodyHashCheckResult {
  status: ChangeStatus;
  /** SHA-256 hex digest of the downloaded body, or `undefined` on failure. */
  contentHash?: string;
  responseMs: number;
}

/**
 * Strip volatile markup that churns per-request on SSR pages — `<script>`,
 * `<style>`, `<link>`, `<meta>`, and HTML comments — before hashing. Pure
 * regex sweep; no DOM parser. Inputs identical except for stripped elements
 * produce identical output.
 *
 * Targets the `body-hash-filtered` detector (#789): Next.js / Vercel / Astro
 * SSR pages whose article markup is stable but whose `<head>` and inline
 * scripts (hydration tokens, chunk URLs, nonces) differ on every render.
 */
export function stripVolatileMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<link\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*\/?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/**
 * GET a URL, SHA-256 the body, and compare against a stored hash. Used by
 * the `body-hash` change detector (#517) for pages whose HEAD returns no
 * stable validator. Pays full-body bandwidth per poll — reserve for sources
 * that need it, not as a default.
 *
 * `opts.filter` runs the body through `stripVolatileMarkup` before hashing,
 * for the `body-hash-filtered` detector (#789). Same `pageContentHash`
 * storage; sources switching from `body-hash` will see one `unknown`
 * outcome on the first probe before settling.
 */
export async function bodyHashCheck(
  url: string,
  storedHash: string | undefined,
  opts?: { filter?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<BodyHashCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const start = Date.now();

  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": RELEASES_BOT_UA },
      signal: controller.signal,
      redirect: "follow",
    });
    const responseMs = Date.now() - start;
    if (!res.ok) return { status: "unknown", responseMs };

    const rawBody = await res.text();
    const body = opts?.filter ? stripVolatileMarkup(rawBody) : rawBody;
    const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const contentHash = Array.from(new Uint8Array(hashBytes))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (!storedHash) return { status: "unknown", contentHash, responseMs };
    return {
      status: contentHash === storedHash ? "unchanged" : "changed",
      contentHash,
      responseMs,
    };
  } catch {
    return { status: "unknown", responseMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Feed parsers ────────────────────────────────────────────────────

/**
 * Parse RSS or Atom XML via `@rowanmanning/feed-parser`. The library handles
 * namespace declarations, attribute-bearing tags (`<entry xml:lang="en">` —
 * see #700), CDATA, and the `content:encoded` ↔ `<description>` precedence
 * (#319: feeds like OpenAI Codex put a stub in description and the real body
 * in content:encoded). We still apply our own `htmlToMarkdown` + `extractMedia`
 * since the library returns HTML bodies and `<media:*>` enclosures, not markdown.
 *
 * `parseAtom` is an alias kept so callers can self-document which format they
 * have. The library doesn't parse JSON Feed — that path is `parseJsonFeed`.
 */
/**
 * Pick a stable URL for the release row. Prefer the RSS `<link>` / Atom
 * `<link href>` (`item.url`). When that's missing — auth0's changelog, for
 * example, ships only `<guid>` fragment-hashes — fall back to `item.id` if
 * it parses as a URL. Without this fallback, `releases.url` ends up NULL and
 * the `UNIQUE(source_id, url)` dedup constraint never fires (SQLite treats
 * each NULL as distinct), so every poll re-inserts the same items.
 */
function feedItemUrl(item: { url?: string | null; id?: string | null }): string | undefined {
  if (item.url) return item.url;
  if (item.id) {
    try {
      new URL(item.id);
      return item.id;
    } catch {
      // item.id is a tag URI or opaque token — leaving url undefined is the
      // existing behavior; downstream is the right place to add a more
      // permissive dedup key if a real source needs it.
    }
  }
  return undefined;
}

export function parseRss(xml: string): RawRelease[] {
  const releases: RawRelease[] = [];
  for (const item of libParseFeed(xml).items) {
    if (!item.title) continue;
    const hasDistinctBody = Boolean(item.content && item.content.trim().length > 0);
    const body = item.content ?? item.description ?? "";
    const dateRaw = item.updated ?? item.published;
    const categories = item.categories
      .map((c) => c.label ?? c.term)
      .filter((c): c is string => Boolean(c));
    releases.push({
      title: item.title,
      content: htmlToMarkdown(body),
      contentFromSummary: !hasDistinctBody,
      url: feedItemUrl(item),
      publishedAt: dateRaw ? new Date(dateRaw) : undefined,
      version: extractVersionFromTitle(item.title),
      isBreaking: detectBreaking(item.title, body),
      // Some feeds put raw markdown in content:encoded (see htmlToMarkdown);
      // the HTML-tag extractor misses markdown `![alt](url)` images there.
      media: containsHtmlTags(body) ? extractMedia(body) : extractMediaFromMarkdown(body),
      categories: categories.length > 0 ? categories : undefined,
    });
  }
  return releases;
}

export const parseAtom = parseRss;

/**
 * Keep only items whose `categories` intersect `allow` (case-insensitive).
 * Items with no categories are dropped, since this is intended for feeds
 * that tag every entry. Empty `allow` short-circuits to passthrough.
 */
export function filterByCategoryAllow(
  items: RawRelease[],
  allow: readonly string[],
): { kept: RawRelease[]; dropped: number } {
  if (allow.length === 0) return { kept: items, dropped: 0 };
  const allowSet = new Set(allow.map((c) => c.toLowerCase()));
  const kept: RawRelease[] = [];
  let dropped = 0;
  for (const item of items) {
    const match = item.categories?.some((c) => allowSet.has(c.toLowerCase())) ?? false;
    if (match) kept.push(item);
    else dropped++;
  }
  return { kept, dropped };
}

/**
 * Keep only items whose `title` or `url` contains any allowed keyword
 * (case-insensitive substring). Built for mixed-topic feeds that carry no
 * usable `<category>` tags but encode the section in the title or the URL
 * slug — e.g. Discord's blog feed, where changelog/patch-notes posts live at
 * `…/discord-patch-notes-…` and `…-changelog` alongside marketing posts.
 * Complements `filterByCategoryAllow` (which needs real categories). Empty
 * `allow` short-circuits to passthrough.
 */
export function filterByKeywordAllow(
  items: RawRelease[],
  allow: readonly string[],
): { kept: RawRelease[]; dropped: number } {
  const needles = allow.map((k) => k.toLowerCase().trim()).filter(Boolean);
  if (needles.length === 0) return { kept: items, dropped: 0 };
  const kept: RawRelease[] = [];
  let dropped = 0;
  for (const item of items) {
    const haystack = `${item.title} ${item.url ?? ""}`.toLowerCase();
    if (needles.some((n) => haystack.includes(n))) kept.push(item);
    else dropped++;
  }
  return { kept, dropped };
}

/**
 * Compile a denylist of pattern strings into case-insensitive regexes,
 * defensively: blank/whitespace entries are skipped and an uncompilable pattern
 * is dropped (a single malformed rule must never wipe a whole feed). Shared by
 * `filterByUrlDeny` (list filter) and `isUrlDenied` (single-URL predicate) so
 * both compile patterns the same way, exactly once per call.
 */
function compileDenyPatterns(deny: readonly string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const raw of deny) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      patterns.push(new RegExp(trimmed, "i"));
    } catch {
      // Skip an uncompilable pattern: a malformed rule must not drop everything.
    }
  }
  return patterns;
}

/**
 * True when `url` matches any deny pattern (case-insensitive). The single-URL
 * complement of `filterByUrlDeny`, for write paths that insert one release at a
 * time (the single-release insert endpoint, #1335). An empty `url` or an empty/
 * all-invalid denylist is never a match.
 */
export function isUrlDenied(url: string, deny: readonly string[]): boolean {
  if (!url) return false;
  return compileDenyPatterns(deny).some((re) => re.test(url));
}

/**
 * Drop items whose `url` matches any deny pattern (case-insensitive regex).
 * Built for feeds that publish localized translations of a post under a
 * locale-suffixed URL — ClickHouse's RSS carries both `/blog/gala` and its
 * Japanese twin `/blog/gala-jp`. A translation duplicate shares no other
 * dedup key with its source post (`UNIQUE(source_id, url)` sees two distinct
 * URLs), so the URL slug is the only reliable discriminator. The complement
 * of `filterByKeywordAllow`: an allowlist keeps matches, this denylist drops
 * them. Items with no `url` are kept — a deny rule can only fire on a positive
 * match. Patterns are compiled defensively (see `compileDenyPatterns`).
 * Empty `deny` (or all-invalid) short-circuits to passthrough.
 *
 * Generic over any item carrying a `url` so the same denylist can run on both
 * the parsed-feed path (`RawRelease`) and the release-insert write boundary
 * (the `/releases/batch` payload shape) — see #1335, where the filter is
 * applied server-side at insert time so it can't be bypassed by the
 * managed-agent fetch path.
 */
export function filterByUrlDeny<T extends { url?: string | null }>(
  items: T[],
  deny: readonly string[],
): { kept: T[]; dropped: number } {
  const patterns = compileDenyPatterns(deny);
  if (patterns.length === 0) return { kept: items, dropped: 0 };
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    const url = item.url ?? "";
    if (url && patterns.some((re) => re.test(url))) dropped++;
    else kept.push(item);
  }
  return { kept, dropped };
}

export function parseJsonFeed(json: string): RawRelease[] {
  const feed = JSON.parse(json);
  const items: Array<{
    title?: string;
    content_html?: string;
    content_text?: string;
    summary?: string;
    url?: string;
    date_published?: string;
    date_modified?: string;
    tags?: string[];
  }> = feed.items ?? [];

  return items
    .filter((item) => item.title)
    .map((item) => {
      const hasDistinctBody = Boolean(item.content_html && item.content_html.trim().length > 0);
      const html = item.content_html ?? item.summary ?? "";
      const dateStr = item.date_published ?? item.date_modified;
      const categories = (item.tags ?? []).filter((t): t is string => Boolean(t));
      return {
        title: item.title!,
        content: item.content_text ?? htmlToMarkdown(html),
        contentFromSummary: !hasDistinctBody && !item.content_text,
        url: item.url,
        publishedAt: dateStr ? new Date(dateStr) : undefined,
        version: extractVersionFromTitle(item.title!),
        isBreaking: detectBreaking(item.title!, item.content_text ?? html),
        media: html ? extractMedia(html) : [],
        categories: categories.length > 0 ? categories : undefined,
      };
    });
}

export function extractVersionFromTitle(title: string): string | undefined {
  const match = title.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/);
  return match ? match[1] : undefined;
}

export function detectBreaking(title: string, content: string): boolean {
  const text = `${title} ${content}`.toLowerCase();
  return text.includes("breaking change") || text.includes("breaking:") || text.includes("⚠");
}

function isSafeMediaUrl(raw: string): boolean {
  const url = decodeHtmlEntities(raw).trim();
  return /^https?:\/\//i.test(url);
}

function isSafeLinkHref(raw: string): boolean {
  const url = decodeHtmlEntities(raw).trim();
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url) || url.startsWith("/");
}

/** Extract structured media items from HTML content. */
export function extractMedia(
  html: string,
): Array<{ type: "image" | "video" | "gif"; url: string; alt?: string }> {
  const media: Array<{ type: "image" | "video" | "gif"; url: string; alt?: string }> = [];

  const imgRe = /<img[^>]*src=["']([^"']+)["'](?:[^>]*alt=["']([^"']*)["'])?[^>]*\/?>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const url = m[1];
    if (!isSafeMediaUrl(url)) continue;
    const alt = m[2] || undefined;
    media.push({ type: isGifUrl(url) ? "gif" : "image", url, alt });
  }

  const iframeRe = /<iframe[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    const src = m[1];
    if (!isSafeMediaUrl(src)) continue;
    if (/youtube|vimeo|loom/i.test(src)) {
      media.push({ type: "video", url: iframeSrcToWatchUrl(src) });
    }
  }

  const videoRe = /<video[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((m = videoRe.exec(html)) !== null) {
    if (!isSafeMediaUrl(m[1])) continue;
    media.push({ type: "video", url: m[1] });
  }

  return media;
}

/**
 * Extract structured media items from markdown content.
 *
 * Handles:
 * - Markdown image syntax: `![alt](url)` and `![alt](url "title")`
 * - HTML `<img src="...">` tags embedded in markdown
 * - HTML `<video src="...">` tags embedded in markdown
 *
 * Only `https://` URLs pass through. Type is inferred by file extension
 * (`.gif` -> "gif", `.mp4`/`.webm`/`.mov` -> "video", else -> "image").
 */
export function extractMediaFromMarkdown(
  markdown: string,
): Array<{ type: "image" | "video" | "gif"; url: string; alt?: string }> {
  const items: Array<{ type: "image" | "video" | "gif"; url: string; alt?: string }> = [];

  // Markdown image syntax: ![alt text](url) or ![alt text](url "title")
  const mdImgPattern = /!\[([^\]]*)\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = mdImgPattern.exec(markdown)) !== null) {
    const url = match[2];
    if (!isSafeMediaUrl(url)) continue;
    const alt = match[1] || undefined;
    items.push({ type: classifyMediaType(url), url, alt });
  }

  // HTML img tags
  const htmlImgPattern = /<img[^>]*src=["']([^"']+)["'](?:[^>]*alt=["']([^"']*)["'])?[^>]*\/?>/gi;
  while ((match = htmlImgPattern.exec(markdown)) !== null) {
    const url = match[1];
    if (!isSafeMediaUrl(url)) continue;
    const alt = match[2] || undefined;
    items.push({ type: classifyMediaType(url), url, alt });
  }

  // HTML video tags
  const htmlVideoPattern = /<video[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlVideoPattern.exec(markdown)) !== null) {
    if (!isSafeMediaUrl(match[1])) continue;
    items.push({ type: "video", url: match[1] });
  }

  return items;
}

/** Convert iframe embed URLs to user-facing watch URLs. */
export function iframeSrcToWatchUrl(src: string): string {
  const ytMatch = src.match(/youtube\.com\/embed\/([^?&"]+)/);
  if (ytMatch) return `https://www.youtube.com/watch?v=${ytMatch[1]}`;

  const vimeoMatch = src.match(/player\.vimeo\.com\/video\/([^?&"]+)/);
  if (vimeoMatch) return `https://vimeo.com/${vimeoMatch[1]}`;

  const loomMatch = src.match(/loom\.com\/embed\/([^?&"]+)/);
  if (loomMatch) return `https://www.loom.com/share/${loomMatch[1]}`;

  return src.startsWith("//") ? `https:${src}` : src;
}

/**
 * Re-encode angle brackets that appear as text inside `<code>` and bare
 * `<pre>` blocks. `@rowanmanning/feed-parser` decodes the five XML entities
 * (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&apos;`) inside CDATA on its way out,
 * which leaves literal `<` characters in places where the original feed had
 * `&lt;` — typically PHP snippets like `<?php` or inline HTML examples
 * inside docstrings. The HTML5 parser (linkedom, browser DOMParser, our old
 * regex stripper) all treat `<?` as a bogus comment that eats through the
 * next `>`, which gobbles whole function bodies (see rel_t9fAnizXt0rM0vPDC48ds).
 *
 * Idempotent: properly-encoded input (e.g. JSON Feed content_html) parses
 * unchanged, since `&lt;` matches the known-entity negative lookahead.
 */
function reencodeCodeText(html: string): string {
  let out = html.replace(/(<code\b[^>]*>)([\s\S]*?)(<\/code>)/gi, (_, open, inner, close) => {
    return `${open}${escapeForCode(inner)}${close}`;
  });
  out = out.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (match, attrs, inner) => {
    if (/<code\b/i.test(inner)) return match; // already handled above
    return `<pre${attrs}>${escapeForCode(inner)}</pre>`;
  });
  return out;
}

function escapeForCode(text: string): string {
  return text
    .replace(/&(?!#?[a-z0-9]+;)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

let turndownInstance: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    fence: "```",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
    hr: "---",
    br: "  ",
  });

  // Unsafe schemes (javascript:, data:, …) collapse to bare text so a feed
  // can't smuggle a clickable XSS payload into stored markdown.
  td.addRule("safeLink", {
    filter: (node) => node.nodeName === "A" && node.getAttribute("href") !== null,
    replacement: (content, node) => {
      const href = (node as Element).getAttribute("href") ?? "";
      if (!isSafeLinkHref(href)) return content;
      return `[${content}](${href})`;
    },
  });

  // Turndown's built-in fencedCodeBlock rule only fires on <pre><code>. WP's
  // syntaxhighlighter shortcode (and older Tumblr exports) emit bare <pre>
  // with the language on the class — fence those too.
  td.addRule("preWithoutCode", {
    filter: (node) => node.nodeName === "PRE" && !(node as Element).querySelector("code"),
    replacement: (_content, node) => {
      const text = (node as Element).textContent ?? "";
      return `\n\n\`\`\`\n${text.replace(/^\n+|\n+$/g, "")}\n\`\`\`\n\n`;
    },
  });

  td.addRule("iframeVideo", {
    filter: "iframe",
    replacement: (_content, node) => {
      const src = (node as Element).getAttribute("src");
      if (!src) return "";
      // Validate the resolved URL — `iframeSrcToWatchUrl` only normalizes
      // protocol-relative `//host/...` for known providers, so an iframe
      // with `src="javascript:..."` would otherwise pass through verbatim.
      const url = iframeSrcToWatchUrl(src);
      if (!isSafeMediaUrl(url)) return "";
      return `\n[Video](${url})\n`;
    },
  });

  td.addRule("videoLink", {
    filter: "video",
    replacement: (_content, node) => {
      const el = node as Element;
      const src = el.getAttribute("src") ?? el.querySelector("source")?.getAttribute("src");
      if (!src || !isSafeMediaUrl(src)) return "";
      return `\n[Video](${src})\n`;
    },
  });

  // WP glossary tooltips: the visible term lives in the outer span, the inner
  // .glossary-item-hidden-content holds the full definition. Drop the hidden
  // span so we don't inline the entire glossary entry into prose.
  td.addRule("wpGlossaryHidden", {
    filter: (node) => {
      if (node.nodeName !== "SPAN") return false;
      const cls = (node as Element).getAttribute("class") ?? "";
      return cls.includes("glossary-item-hidden-content");
    },
    replacement: () => "",
  });

  turndownInstance = td;
  return td;
}

/**
 * Real HTML always carries at least one element tag. Some feeds violate the
 * RSS `content:encoded` contract (which reserves the field for HTML) and stuff
 * raw **markdown** in there instead — OpenAI's Codex changelog is one. Running
 * Turndown over markdown escapes every `#`, `[`, `*`, `` ` `` and collapses the
 * hard-wrapped newlines into a single wall of text (see
 * rel_HOLmi6zZTBBzrOqy5C4ig). Detecting the absence of tags lets us pass such
 * content through untouched instead of mangling it.
 */
function containsHtmlTags(s: string): boolean {
  return /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i.test(s);
}

/** nbsp→space, collapse 3+ newlines, trim — the tail every feed-markdown path shares. */
function normalizeFeedMarkdown(md: string): string {
  return md
    .replace(/ /g, " ") // nbsp→space
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert HTML to markdown via Turndown over a linkedom DOM. See
 * `reencodeCodeText` for why the body is pre-processed before parsing.
 *
 * If the input has no HTML tags it is already markdown (or plain text), so it
 * is returned as-is — only nbsp-normalized and trimmed — rather than escaped
 * and whitespace-collapsed by Turndown.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || !html.trim()) return "";
  if (!containsHtmlTags(html)) return normalizeFeedMarkdown(html);
  const safe = reencodeCodeText(html);
  const { document } = parseHTML(`<!doctype html><html><body>${safe}</body></html>`);
  // linkedom's HTMLBodyElement is structurally compatible with the DOM
  // HTMLElement @types/turndown expects but not nominally identical, so the
  // double cast satisfies TS without lying about a single hop.
  const md = getTurndown().turndown(document.body as unknown as HTMLElement);
  return normalizeFeedMarkdown(
    md
      .replace(/ /g, " ") // nbsp→space before the list-indent fixes below
      .replace(/^([-*+])   /gm, "$1 ") // collapse Turndown's 4-char list indent at root
      .replace(/^(\d+)\.  /gm, "$1. "),
  );
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}
