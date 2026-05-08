import type { RawRelease, FetchOptions } from "@releases/adapters/types";
import { logger } from "@buildinternet/releases-lib/logger";
import { FeedHttpError } from "@releases/lib/errors";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { parseFeed as libParseFeed } from "@rowanmanning/feed-parser";

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
export async function discoverFeed(pageUrl: string): Promise<DiscoveredFeed | null> {
  const fromHead = await discoverFromHead(pageUrl);
  if (fromHead) return fromHead;

  const base = new URL(pageUrl);

  // Step 2: sibling-path probes relative to the page URL's own path.
  // Skip when the page is the root (pathname "/" or empty) — those probes
  // would duplicate the origin-root well-known probes below.
  const trimmedPath = base.pathname.replace(/\/$/, "");
  if (trimmedPath && trimmedPath !== "") {
    const siblingResults = await Promise.allSettled(
      PAGE_SIBLING_SUFFIXES.map((suffix) => probeFeedPath(base.origin, `${trimmedPath}${suffix}`)),
    );
    for (const result of siblingResults) {
      if (result.status === "fulfilled" && result.value) return result.value;
    }
  }

  // Step 3: fall back to well-known origin-root paths.
  const results = await Promise.allSettled(
    WELL_KNOWN_PATHS.map((path) => probeFeedPath(base.origin, path)),
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

async function discoverFromHead(pageUrl: string): Promise<DiscoveredFeed | null> {
  try {
    const res = await fetch(pageUrl, {
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

async function probeFeedPath(origin: string, path: string): Promise<DiscoveredFeed | null> {
  const probeUrl = `${origin}${path}`;
  const res = await fetch(probeUrl, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": RELEASES_BOT_UA },
  });
  if (!res.ok) return null;

  const ct = res.headers.get("content-type") ?? "";
  const feedType = classifyFeedMime(ct);
  if (feedType) return { url: probeUrl, type: feedType };

  if (path.endsWith(".xml") || path.endsWith(".json") || path === "/feed" || path === "/rss") {
    const getRes = await fetch(probeUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": RELEASES_BOT_UA,
        Accept:
          "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml",
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

export async function fetchAndParseFeed(
  feedUrl: string,
  feedType: FeedType,
  options?: FetchOptions,
  headers?: Record<string, string>,
): Promise<{
  releases: RawRelease[];
  etag?: string;
  lastModified?: string;
  contentLength?: string;
}> {
  const reqHeaders: Record<string, string> = {
    "User-Agent": RELEASES_BOT_UA,
    Accept:
      "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml",
    ...headers,
  };

  const res = await fetch(feedUrl, { headers: reqHeaders, redirect: "follow" });

  if (res.status === 304) return { releases: [] };

  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      throw new FeedHttpError(res.status, feedUrl, res.statusText);
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
    releases = releases.slice(0, options.maxEntries);
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
): Promise<HeadCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = Date.now();

  try {
    const res = await fetch(url, {
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
): Promise<BodyHashCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const start = Date.now();

  try {
    const res = await fetch(url, {
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
export function parseRss(xml: string): RawRelease[] {
  const releases: RawRelease[] = [];
  for (const item of libParseFeed(xml).items) {
    if (!item.title) continue;
    const body = item.content ?? item.description ?? "";
    const dateRaw = item.updated ?? item.published;
    const categories = item.categories
      .map((c) => c.label ?? c.term)
      .filter((c): c is string => Boolean(c));
    releases.push({
      title: item.title,
      content: htmlToMarkdown(decodeHtmlEntities(body)),
      url: item.url ?? undefined,
      publishedAt: dateRaw ? new Date(dateRaw) : undefined,
      version: extractVersionFromTitle(item.title),
      isBreaking: detectBreaking(item.title, body),
      media: extractMedia(body),
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
      const html = item.content_html ?? item.summary ?? "";
      const dateStr = item.date_published ?? item.date_modified;
      const categories = (item.tags ?? []).filter((t): t is string => Boolean(t));
      return {
        title: item.title!,
        content: item.content_text ?? htmlToMarkdown(html),
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
    const isGif = url.toLowerCase().endsWith(".gif");
    media.push({ type: isGif ? "gif" : "image", url, alt });
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

/** Convert HTML to markdown, preserving images, links, and basic formatting. */
export function htmlToMarkdown(html: string): string {
  let md = html;

  md = md.replace(/ fve-[a-z0-9-]+="[^"]*"/g, "");

  md = md.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "![$1]($2)");
  md = md.replace(/<img[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "![]($1)");

  md = md.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    return isSafeLinkHref(href) ? `[${text}](${href})` : text;
  });

  md = md.replace(/<iframe[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi, (_, src) => {
    const videoUrl = iframeSrcToWatchUrl(src);
    return `\n[Video](${videoUrl})\n`;
  });

  md = md.replace(/<video[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/video>/gi, "\n[Video]($1)\n");
  md = md.replace(
    /<video[^>]*>[\s\S]*?<source[^>]*src=["']([^"']+)["'][^>]*\/?>/gi,
    "\n[Video]($1)\n",
  );

  md = md.replace(
    /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_, code) => `\n\`\`\`\n${decodeHtmlEntities(code)}\n\`\`\`\n`,
  );

  md = md.replace(/<(?:strong|b)(?:\s[^>]*)?>|<\/(?:strong|b)>/gi, "**");
  md = md.replace(/<(?:em|i)(?:\s[^>]*)?>|<\/(?:em|i)>/gi, "*");
  md = md.replace(/<code(?:\s[^>]*)?>|<\/code>/gi, "`");

  md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
    return `\n\n${"#".repeat(Number(level))} ${text}\n\n`;
  });

  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");

  md = md.replace(/<\/(?:p|div|blockquote|ul|ol)>/gi, "\n\n");
  md = md.replace(/<(?:p|div|blockquote|ul|ol)(?:\s[^>]*)?>/gi, "\n");
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<hr\s*\/?>/gi, "\n---\n");

  md = md.replace(/<[^>]+>/g, "");
  md = md.replace(/&nbsp;/g, " ");

  md = md.replace(/\n{3,}/g, "\n\n");

  return md.trim();
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
