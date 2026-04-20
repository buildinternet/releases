import type { RawRelease, FetchOptions } from "@releases/adapters/types";
import { logger } from "@buildinternet/releases-lib/logger";
import { FeedHttpError } from "@releases/lib/errors";

// Re-export source-meta helpers so consumers can pull everything feed-related
// from a single path.
export { getSourceMeta, type SourceMetadata } from "@releases/adapters/source-meta";
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
      headers: { Accept: "text/html", "User-Agent": "releases/0.1" },
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
    headers: { "User-Agent": "releases/0.1" },
  });
  if (!res.ok) return null;

  const ct = res.headers.get("content-type") ?? "";
  const feedType = classifyFeedMime(ct);
  if (feedType) return { url: probeUrl, type: feedType };

  if (path.endsWith(".xml") || path.endsWith(".json") || path === "/feed" || path === "/rss") {
    const getRes = await fetch(probeUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "releases/0.1",
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
    "User-Agent": "releases/0.1",
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

  let releases: RawRelease[];
  switch (feedType) {
    case "rss":
      releases = parseRss(body);
      break;
    case "atom":
      releases = parseAtom(body);
      break;
    case "jsonfeed":
      releases = parseJsonFeed(body);
      break;
    default: {
      const detected = detectFeedTypeFromContent(body);
      if (detected) {
        logger.info(`Feed type "${feedType}" unrecognized, detected ${detected} from content`);
        releases =
          detected === "rss"
            ? parseRss(body)
            : detected === "atom"
              ? parseAtom(body)
              : parseJsonFeed(body);
      } else {
        throw new Error(
          `Cannot parse feed: unrecognized type "${feedType}" and content detection failed`,
        );
      }
    }
  }

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
 * Send a HEAD request to a feed URL and compare response headers against
 * stored values to detect changes without downloading the feed body.
 */
export async function headCheckFeed(
  feedUrl: string,
  stored: { etag?: string; lastModified?: string; contentLength?: string },
): Promise<HeadCheckResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = Date.now();

  try {
    const res = await fetch(feedUrl, {
      method: "HEAD",
      headers: { "User-Agent": "releases/0.1" },
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

// ── Feed parsers ────────────────────────────────────────────────────

export function parseRss(xml: string): RawRelease[] {
  const releases: RawRelease[] = [];
  for (const item of extractAllBetween(xml, "<item>", "</item>")) {
    const title = extractText(item, "title");
    if (!title) continue;

    // Prefer <content:encoded> over <description>: RSS convention is that
    // content:encoded carries the full post body while description is a
    // short teaser. Several feeds (e.g. OpenAI Codex) put only the title in
    // description and the real markdown/HTML body in content:encoded — using
    // description meant we were storing stubs like "Codex app".
    const contentEncoded = extractText(item, "content:encoded");
    const description = extractText(item, "description");
    const body = contentEncoded ?? description ?? "";
    const link = extractText(item, "link");
    const pubDate = extractText(item, "pubDate");

    releases.push({
      title,
      content: htmlToMarkdown(decodeHtmlEntities(body)),
      url: link ?? undefined,
      publishedAt: pubDate ? new Date(pubDate) : undefined,
      version: extractVersionFromTitle(title),
      isBreaking: detectBreaking(title, body),
      media: extractMedia(body),
    });
  }
  return releases;
}

export function parseAtom(xml: string): RawRelease[] {
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
  }> = feed.items ?? [];

  return items
    .filter((item) => item.title)
    .map((item) => {
      const html = item.content_html ?? item.summary ?? "";
      const dateStr = item.date_published ?? item.date_modified;
      return {
        title: item.title!,
        content: item.content_text ?? htmlToMarkdown(html),
        url: item.url,
        publishedAt: dateStr ? new Date(dateStr) : undefined,
        version: extractVersionFromTitle(item.title!),
        isBreaking: detectBreaking(item.title!, item.content_text ?? html),
        media: html ? extractMedia(html) : [],
      };
    });
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
  const altMatch = entry.match(
    /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i,
  );
  if (altMatch) return altMatch[1];
  const hrefMatch = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return hrefMatch ? hrefMatch[1] : null;
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
