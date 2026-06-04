import type { Source, ReleaseType } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "./types.js";
import { RELEASES_BOT_UA } from "./user-agent.js";
import { htmlToMarkdown } from "./feed.js";
import { getSourceMeta } from "./source-meta.js";

/**
 * Help-center API adapter. A `type: "feed"` source whose `metadata.helpCenter`
 * is set has its `feedUrl` pointed at a vendor Help Center JSON API rather than
 * an RSS/Atom feed; the feed dispatcher (`fetchOne`) routes here instead of
 * `fetchAndParseFeed`. Today the only provider is Zendesk Guide, which exposes a
 * public Content API listing a section's articles as JSON with the full HTML
 * body, dates, and a canonical `html_url` — far more reliable than scraping the
 * JS-rendered section index, and there is no working RSS feed. One article → one
 * release; the HTML body is converted with the same `htmlToMarkdown` the feed
 * adapter uses so steady-state output matches a locally-seeded backlog.
 *
 * Zendesk API shape:
 *   GET <feedUrl> (…/api/v2/help_center/<locale>/sections/<id>/articles.json)
 *   → { articles: [{ title, html_url, body, created_at, … }], next_page: string|null }
 */

/** One article from a Zendesk Help Center Content API page. Only consumed fields are typed. */
export interface ZendeskArticle {
  id: number;
  title: string;
  html_url: string;
  body: string;
  created_at: string;
  edited_at?: string;
}

const DEFAULT_MAX_PAGES = 50;

/** Resolve a root-relative ("/foo") href/src against the site origin. */
function absolutize(value: string, baseUrl: string): string {
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("/")) return `${baseUrl}${value}`;
  return value;
}

/** Rewrite root-relative href/src attributes in an HTML body to absolute URLs. */
function absolutizeHtml(html: string, baseUrl: string): string {
  return html
    .replace(/(href|src)="\/(?!\/)/g, `$1="${baseUrl}/`)
    .replace(/(href|src)='\/(?!\/)/g, `$1='${baseUrl}/`);
}

/** Pull the first `<img>` out of an HTML body as the hero/thumbnail, absolutized. */
function firstImage(
  html: string,
  baseUrl: string,
): { type: "image"; url: string; alt?: string } | null {
  const tag = html.match(/<img\b[^>]*>/i);
  if (!tag) return null;
  const src = tag[0].match(/\bsrc=["']([^"']+)["']/i);
  if (!src) return null;
  const alt = tag[0].match(/\balt=["']([^"']*)["']/i);
  const media: { type: "image"; url: string; alt?: string } = {
    type: "image",
    url: absolutize(src[1], baseUrl),
  };
  if (alt && alt[1]) media.alt = alt[1];
  return media;
}

/**
 * Map Zendesk Help Center articles into RawReleases. Pure — no I/O. `baseUrl`
 * (the site origin) absolutizes root-relative links; `releaseType` classifies
 * every article (e.g. `rollup` for digest sections).
 */
export function mapZendeskArticles(
  articles: ZendeskArticle[],
  opts: { baseUrl: string; releaseType?: "feature" | "rollup" },
): RawRelease[] {
  const out: RawRelease[] = [];
  for (const a of articles) {
    const title = (a.title ?? "").trim();
    if (!title) continue;
    const html = absolutizeHtml(a.body ?? "", opts.baseUrl);
    const rel: RawRelease = {
      title,
      content: htmlToMarkdown(html),
      url: a.html_url,
    };
    const published = a.created_at ? new Date(a.created_at) : undefined;
    if (published && !Number.isNaN(published.getTime())) rel.publishedAt = published;
    if (opts.releaseType) rel.type = opts.releaseType as ReleaseType;
    const hero = firstImage(html, opts.baseUrl);
    if (hero) rel.media = [hero];
    out.push(rel);
  }
  return out;
}

/**
 * Fetch a Zendesk articles.json `feedUrl`, following `next_page` pagination.
 * Never throws: on a non-2xx page or a network/parse error it returns whatever
 * was collected so far (so a transient blip mid-pagination degrades to a partial
 * fetch rather than bumping the source's error counter). `maxPages` bounds the
 * loop — 1 page (newest-first) is enough for steady-state; the full walk is for
 * a one-time backfill.
 */
export async function fetchZendeskArticles(
  feedUrl: string,
  opts?: { maxPages?: number },
): Promise<ZendeskArticle[]> {
  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  const out: ZendeskArticle[] = [];
  let url: string | null = feedUrl;
  let pages = 0;
  try {
    while (url && pages < maxPages) {
      // oxlint-disable-next-line no-await-in-loop -- pages are strictly sequential; each next_page URL comes from the prior response
      const res: Response = await fetch(url, { headers: { "User-Agent": RELEASES_BOT_UA } });
      if (!res.ok) break;
      // oxlint-disable-next-line no-await-in-loop -- body read for the page just fetched above
      const json = (await res.json()) as { articles?: ZendeskArticle[]; next_page?: string | null };
      for (const a of json.articles ?? []) out.push(a);
      url = json.next_page ?? null;
      pages++;
    }
  } catch {
    // network / JSON error — return what we have
  }
  return out;
}

/**
 * Fetch + map a help-center source straight from its row. Reads `feedUrl` (the
 * vendor API endpoint) and `metadata.helpCenter` (provider + releaseType).
 * `full` (default false) walks every page for a backfill; otherwise a single
 * newest-first page surfaces new articles for steady-state polling. Returns []
 * for a non-help-center source, an unknown provider, or a missing feedUrl.
 */
export async function fetchHelpCenter(
  source: Source,
  opts?: { full?: boolean; maxEntries?: number },
): Promise<RawRelease[]> {
  const meta = getSourceMeta(source);
  const hc = meta.helpCenter;
  if (!hc?.provider || !meta.feedUrl || hc.provider !== "zendesk") return [];
  const baseUrl = new URL(meta.feedUrl).origin;
  const articles = await fetchZendeskArticles(meta.feedUrl, {
    maxPages: opts?.full ? DEFAULT_MAX_PAGES : 1,
  });
  const releases = mapZendeskArticles(articles, { baseUrl, releaseType: hc.releaseType });
  return opts?.maxEntries ? releases.slice(0, opts.maxEntries) : releases;
}
