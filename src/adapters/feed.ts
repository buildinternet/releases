import type { Source } from "../db/schema.js";
import { updateSource } from "../db/queries.js";
import type { Adapter, RawRelease, FetchOptions, FetchResult } from "./types.js";
import { logger } from "../lib/logger.js";

// ── Feed types ──────────────────────────────────────────────────────

type FeedType = "rss" | "atom" | "jsonfeed";

interface DiscoveredFeed {
  url: string;
  type: FeedType;
}

export interface SourceMetadata {
  // Feed fields
  feedUrl?: string;
  feedType?: FeedType;
  feedDiscoveredAt?: string;
  feedEtag?: string;
  feedLastModified?: string;
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

  // Evaluation fields (from `released evaluate`)
  markdownUrl?: string;
  evaluatedMethod?: string;
  evaluatedAt?: string;

  // GitHub fields
  changelogUrl?: string;
  changelogDetectedAt?: string;

  // Content depth assessment
  feedContentDepth?: "full" | "summary-only";

  // Summary generation
  summarize?: boolean; // false = opt-out of AI summaries
}

// ── Feed discovery ──────────────────────────────────────────────────

const WELL_KNOWN_PATHS = [
  // JSON feeds first — preferred over XML when available
  "/feed.json",
  "/changelog/feed.json",
  "/changelog.json",
  // XML feeds
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
 * Discover a feed URL for a given page URL.
 * 1. Fetch the HTML and look for <link rel="alternate"> feed tags.
 * 2. Probe well-known feed paths in parallel.
 * Prefers JSON feeds over XML when multiple are available.
 */
export async function discoverFeed(pageUrl: string): Promise<DiscoveredFeed | null> {
  // Step 1: Check HTML <head> for feed links
  const fromHead = await discoverFromHead(pageUrl);
  if (fromHead) return fromHead;

  // Step 2: Probe well-known paths in parallel
  const base = new URL(pageUrl);
  const results = await Promise.allSettled(
    WELL_KNOWN_PATHS.map((path) => probeFeedPath(base.origin, path)),
  );

  // Return the first successful probe (array order = preference order)
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) return result.value;
  }

  return null;
}

async function discoverFromHead(pageUrl: string): Promise<DiscoveredFeed | null> {
  try {
    const res = await fetch(pageUrl, {
      headers: { "Accept": "text/html", "User-Agent": "released/0.1" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) return null;

    // Stream only enough bytes to get the <head> section
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes("</head>") || html.length > 32_000) {
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
    headers: { "User-Agent": "released/0.1" },
  });
  if (!res.ok) return null;

  const ct = res.headers.get("content-type") ?? "";
  const feedType = classifyFeedMime(ct);
  if (feedType) return { url: probeUrl, type: feedType };

  // Some servers don't set proper content-type on HEAD — try GET for ambiguous paths
  if (path.endsWith(".xml") || path.endsWith(".json") || path === "/feed" || path === "/rss") {
    const getRes = await fetch(probeUrl, {
      redirect: "follow",
      headers: { "User-Agent": "released/0.1", "Accept": "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml" },
    });
    if (!getRes.ok) return null;
    const getCt = getRes.headers.get("content-type") ?? "";
    const body = await getRes.text();
    const detected = classifyFeedMime(getCt) ?? detectFeedTypeFromContent(body);
    if (detected) return { url: probeUrl, type: detected };
  }

  return null;
}

function parseFeedLinks(head: string, baseUrl: string): DiscoveredFeed | null {
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

  // Prefer JSON feed over XML
  return candidates.find((c) => c.type === "jsonfeed") ?? candidates[0];
}

/** Classify a MIME type or Content-Type header value as a feed type. */
function classifyFeedMime(ct: string): FeedType | null {
  ct = ct.toLowerCase();
  if (ct.includes("feed+json")) return "jsonfeed";
  if (ct.includes("rss")) return "rss";
  if (ct.includes("atom")) return "atom";
  // <link type="application/json"> in HTML head is acceptable as JSON feed
  if (ct === "application/json") return "jsonfeed";
  return null;
}

function detectFeedTypeFromContent(body: string): FeedType | null {
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
): Promise<{ releases: RawRelease[]; etag?: string; lastModified?: string }> {
  const reqHeaders: Record<string, string> = {
    "User-Agent": "released/0.1",
    "Accept": "application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml",
    ...headers,
  };

  const res = await fetch(feedUrl, { headers: reqHeaders, redirect: "follow" });

  if (res.status === 304) return { releases: [] };

  if (!res.ok) {
    throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.text();
  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;

  let releases: RawRelease[];
  switch (feedType) {
    case "rss": releases = parseRss(body); break;
    case "atom": releases = parseAtom(body); break;
    case "jsonfeed": releases = parseJsonFeed(body); break;
    default: {
      // Unrecognized feed type — try to detect from content
      const detected = detectFeedTypeFromContent(body);
      if (detected) {
        logger.info(`Feed type "${feedType}" unrecognized, detected ${detected} from content`);
        releases = detected === "rss" ? parseRss(body) : detected === "atom" ? parseAtom(body) : parseJsonFeed(body);
      } else {
        throw new Error(`Cannot parse feed: unrecognized type "${feedType}" and content detection failed`);
      }
    }
  }

  if (options?.since) {
    releases = releases.filter((r) => !r.publishedAt || r.publishedAt >= options.since!);
  }
  if (options?.maxEntries) {
    releases = releases.slice(0, options.maxEntries);
  }

  return { releases, etag, lastModified };
}

/**
 * Shared discovery → fetch → cache flow used by both the feed adapter and
 * the scrape adapter's feed-first optimization.
 *
 * Returns releases on success, null if no feed is available or discovery fails.
 */
export async function fetchViaFeed(
  source: Source,
  options?: FetchOptions,
): Promise<RawRelease[] | null> {
  const meta = getSourceMeta(source);
  const metaUpdates: Partial<SourceMetadata> = {};

  if (meta.noFeedFound) return null;

  let feedUrl = meta.feedUrl;
  let feedType = meta.feedType;

  // Discovery
  if (!feedUrl) {
    logger.info(`Checking for RSS/Atom/JSON feed...`);
    try {
      const discovered = await discoverFeed(source.url);
      if (!discovered) {
        await updateSourceMeta(source, { noFeedFound: true });
        return null;
      }
      feedUrl = discovered.url;
      feedType = discovered.type;
      Object.assign(metaUpdates, {
        feedUrl,
        feedType,
        feedDiscoveredAt: new Date().toISOString(),
        noFeedFound: false,
      });
      logger.info(`Discovered ${feedType} feed: ${feedUrl}`);
    } catch (err) {
      logger.debug(`Feed discovery failed: ${err}`);
      return null;
    }
  }

  // Conditional fetch headers
  const isFirstFetch = !meta.feedEtag && !meta.feedLastModified;
  const conditionalHeaders: Record<string, string> = {};
  if (meta.feedEtag) conditionalHeaders["If-None-Match"] = meta.feedEtag;
  if (meta.feedLastModified) conditionalHeaders["If-Modified-Since"] = meta.feedLastModified;

  // Fetch and parse
  logger.info(`Fetching ${feedType} feed: ${feedUrl}`);
  const { releases, etag, lastModified } = await fetchAndParseFeed(
    feedUrl,
    feedType!,
    options,
    Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
  );

  // Guard: if this is the first real fetch (no prior ETag) and we got 0 releases,
  // the feed URL is likely a non-standard format we can't parse. Clear it so the
  // scrape adapter can take over on the next fetch (or this one, by returning null).
  if (isFirstFetch && releases.length === 0) {
    logger.warn(`Feed returned 0 releases on first fetch — clearing feed URL as untrustworthy`);
    const cleanMeta = getSourceMeta(source);
    delete cleanMeta.feedUrl;
    delete cleanMeta.feedType;
    delete cleanMeta.feedEtag;
    delete cleanMeta.feedLastModified;
    delete cleanMeta.feedDiscoveredAt;
    cleanMeta.noFeedFound = true;
    await updateSource(source, { metadata: JSON.stringify(cleanMeta) });
    return null;
  }

  if (etag) metaUpdates.feedEtag = etag;
  if (lastModified) metaUpdates.feedLastModified = lastModified;

  // Write all metadata changes in a single update
  if (Object.keys(metaUpdates).length > 0) {
    await updateSourceMeta(source, metaUpdates);
  }

  if (releases.length === 0) {
    logger.info(`No new releases from feed (304 or empty)`);
  } else {
    logger.info(`Parsed ${releases.length} releases from feed`);
  }

  return releases;
}

// ── Feed parsers ────────────────────────────────────────────────────

function parseRss(xml: string): RawRelease[] {
  const releases: RawRelease[] = [];
  for (const item of extractAllBetween(xml, "<item>", "</item>")) {
    const title = extractText(item, "title");
    if (!title) continue;

    const description = extractText(item, "description") ?? extractText(item, "content:encoded") ?? "";
    const link = extractText(item, "link");
    const pubDate = extractText(item, "pubDate");

    releases.push({
      title,
      content: htmlToMarkdown(decodeHtmlEntities(description)),
      url: link ?? undefined,
      publishedAt: pubDate ? new Date(pubDate) : undefined,
      version: extractVersionFromTitle(title),
      isBreaking: detectBreaking(title, description),
      media: extractMedia(description),
    });
  }
  return releases;
}

function parseAtom(xml: string): RawRelease[] {
  const releases: RawRelease[] = [];
  for (const entry of extractAllBetween(xml, "<entry>", "</entry>")) {
    const title = extractText(entry, "title");
    if (!title) continue;

    const content = extractText(entry, "content") ?? extractText(entry, "summary") ?? "";
    const link = extractAtomLink(entry);
    const updated = extractText(entry, "updated") ?? extractText(entry, "published");

    releases.push({
      title,
      content: htmlToMarkdown(decodeHtmlEntities(content)),
      url: link ?? undefined,
      publishedAt: updated ? new Date(updated) : undefined,
      version: extractVersionFromTitle(title),
      isBreaking: detectBreaking(title, content),
      media: extractMedia(content),
    });
  }
  return releases;
}

function parseJsonFeed(json: string): RawRelease[] {
  const feed = JSON.parse(json);
  const items: Array<{
    title?: string;
    content_html?: string;
    content_text?: string;
    url?: string;
    date_published?: string;
  }> = feed.items ?? [];

  return items
    .filter((item) => item.title)
    .map((item) => ({
      title: item.title!,
      content: item.content_text ?? htmlToMarkdown(item.content_html ?? ""),
      url: item.url,
      publishedAt: item.date_published ? new Date(item.date_published) : undefined,
      version: extractVersionFromTitle(item.title!),
      isBreaking: detectBreaking(item.title!, item.content_text ?? item.content_html ?? ""),
      media: item.content_html ? extractMedia(item.content_html) : [],
    }));
}

// ── XML helpers (no external dependency) ────────────────────────────

function extractAllBetween(xml: string, openTag: string, closeTag: string): string[] {
  const results: string[] = [];
  let idx = 0;
  while (true) {
    const start = xml.indexOf(openTag, idx);
    if (start === -1) break;
    const end = xml.indexOf(closeTag, start + openTag.length);
    if (end === -1) break;
    results.push(xml.slice(start + openTag.length, end));
    idx = end + closeTag.length;
  }
  return results;
}

// Cache compiled regexes per tag name
const reCache = new Map<string, { cdata: RegExp; text: RegExp }>();

function getTagRegexes(tag: string) {
  let cached = reCache.get(tag);
  if (!cached) {
    cached = {
      cdata: new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, "i"),
      text: new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
    };
    reCache.set(tag, cached);
  }
  return cached;
}

function extractText(xml: string, tag: string): string | null {
  const re = getTagRegexes(tag);
  const cdataMatch = xml.match(re.cdata);
  if (cdataMatch) return cdataMatch[1].trim();
  const textMatch = xml.match(re.text);
  return textMatch ? textMatch[1].trim() : null;
}

function extractAtomLink(entry: string): string | null {
  const altMatch = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (altMatch) return altMatch[1];
  const hrefMatch = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return hrefMatch ? hrefMatch[1] : null;
}

function extractVersionFromTitle(title: string): string | undefined {
  const match = title.match(/v?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/);
  return match ? match[1] : undefined;
}

function detectBreaking(title: string, content: string): boolean {
  const text = `${title} ${content}`.toLowerCase();
  return text.includes("breaking change") || text.includes("breaking:") || text.includes("⚠");
}

/** Check if a URL has a safe scheme (http or https only). Decodes entities first. */
function isSafeMediaUrl(raw: string): boolean {
  const url = decodeHtmlEntities(raw).trim();
  return /^https?:\/\//i.test(url);
}

/** Check if a link href has an allowed scheme. Decodes entities first. */
function isSafeLinkHref(raw: string): boolean {
  const url = decodeHtmlEntities(raw).trim();
  return /^https?:\/\//i.test(url) || /^mailto:/i.test(url) || url.startsWith("/");
}

/** Extract structured media items from HTML content. */
function extractMedia(html: string): Array<{ type: "image" | "video" | "gif"; url: string; alt?: string }> {
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
function iframeSrcToWatchUrl(src: string): string {
  // YouTube: //www.youtube.com/embed/VIDEO_ID -> https://www.youtube.com/watch?v=VIDEO_ID
  const ytMatch = src.match(/youtube\.com\/embed\/([^?&"]+)/);
  if (ytMatch) return `https://www.youtube.com/watch?v=${ytMatch[1]}`;

  // Vimeo: //player.vimeo.com/video/VIDEO_ID -> https://vimeo.com/VIDEO_ID
  const vimeoMatch = src.match(/player\.vimeo\.com\/video\/([^?&"]+)/);
  if (vimeoMatch) return `https://vimeo.com/${vimeoMatch[1]}`;

  // Loom: //www.loom.com/embed/VIDEO_ID -> https://www.loom.com/share/VIDEO_ID
  const loomMatch = src.match(/loom\.com\/embed\/([^?&"]+)/);
  if (loomMatch) return `https://www.loom.com/share/${loomMatch[1]}`;

  // Fallback: return the embed URL as-is
  return src.startsWith("//") ? `https:${src}` : src;
}

/** Convert HTML to markdown, preserving images, links, and basic formatting. */
function htmlToMarkdown(html: string): string {
  let md = html;

  // Convert images before stripping other tags
  md = md.replace(/<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "![$1]($2)");
  md = md.replace(/<img[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "![]($1)");

  // Convert links (only safe schemes become markdown links)
  md = md.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    return isSafeLinkHref(href) ? `[${text}](${href})` : text;
  });

  // Convert iframes (YouTube, Vimeo embeds) to links
  md = md.replace(/<iframe[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/iframe>/gi, (_, src) => {
    const videoUrl = iframeSrcToWatchUrl(src);
    return `\n[Video](${videoUrl})\n`;
  });

  // Convert video elements to links
  md = md.replace(/<video[^>]*src=["']([^"']+)["'][^>]*>[\s\S]*?<\/video>/gi, "\n[Video]($1)\n");
  md = md.replace(/<video[^>]*>[\s\S]*?<source[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "\n[Video]($1)\n");

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, "");
  md = md.replace(/&nbsp;/g, " ");

  return md.trim();
}

function decodeHtmlEntities(text: string): string {
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

// ── Source metadata helpers ──────────────────────────────────────────

export function getSourceMeta(source: Source): SourceMetadata {
  try {
    return JSON.parse(source.metadata ?? "{}");
  } catch {
    return {};
  }
}

/** Merge partial source metadata into the source's metadata JSON column. */
export async function updateSourceMeta(source: Source, meta: Partial<SourceMetadata>): Promise<void> {
  const existing = getSourceMeta(source);
  const merged = { ...existing, ...meta };
  await updateSource(source, { metadata: JSON.stringify(merged) });
}

// ── Feed adapter (standalone, for "feed" source type) ───────────────

export const feed: Adapter = {
  async fetch(source: Source, options?: FetchOptions): Promise<FetchResult> {
    const releases = await fetchViaFeed(source, options);
    if (releases === null) {
      logger.warn(`No feed found for ${source.url}`);
      return { releases: [] };
    }

    return { releases };
  },
};
