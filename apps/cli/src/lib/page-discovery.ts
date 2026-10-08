/**
 * Candidate page-URL discovery for the `--local` handoff.
 *
 * Given a source's display URL (and any `Sitemap:` URLs the Content-Signal
 * preflight surfaced), find the per-release detail pages a local-ingest run
 * would extract, and classify the page shape. This mirrors the skill's
 * approach: prefer `/sitemap.xml` filtered to the changelog path, otherwise
 * parse the index HTML for per-release links (see
 * `src/agent/skills/local-ingest/SKILL.md` Step 3).
 *
 * Nothing here extracts or calls AI — `fetch` + string parsing only. Every
 * network step is best-effort and total: a failed fetch degrades to the
 * single-page fallback rather than throwing.
 */

import { RELEASES_CLI_UA } from "./user-agent.js";

export type PageStructure = "single-page" | "index" | "unknown";

export interface DiscoveryResult {
  pageStructure: PageStructure;
  /** Where the candidate URLs came from. */
  via: "sitemap" | "index-html" | "source-url" | "none";
  /** The candidate page URLs (capped — see `truncated`/`totalFound`). */
  candidates: string[];
  /** Total detail URLs discovered before the cap. */
  totalFound: number;
  /** Whether the candidate list was capped below `totalFound`. */
  truncated: boolean;
  /** Human-readable window/skip note — never silently truncates. */
  note: string;
}

/** Cap surfaced candidate URLs — the skill works a ~25–50 most-recent window. */
export const MAX_CANDIDATES = 50;
/** At least this many path-children mark an index→detail page (vs. a stray sub-link). */
const INDEX_THRESHOLD = 2;
/** Bound the number of sitemap documents we fetch (incl. one level of sitemap-index). */
const MAX_SITEMAP_FETCHES = 4;
const FETCH_TIMEOUT_MS = 20_000;

type FetchImpl = typeof globalThis.fetch;

async function getText(url: string, fetchImpl: FetchImpl): Promise<string | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": RELEASES_CLI_UA },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Pull `<loc>` URLs out of a sitemap document and report whether it is a
 * sitemap-index (a sitemap of sitemaps) so the caller can recurse one level.
 * Tolerant of namespaces and whitespace; pure string parsing, no XML parser.
 */
export function parseSitemapLocs(xml: string): { locs: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)) {
    const url = decodeXmlEntities(m[1]!.trim());
    if (url) locs.push(url);
  }
  return { locs, isIndex };
}

/**
 * Same site, treating apex and `www.` as one host (scheme + port must match).
 * Sources are stored at the canonical URL a human lands on, which may be the
 * apex while the sitemap/links use `www.` (or vice versa) — the gotcha that
 * `conductor.build` 307s to `www.conductor.build`. Without this, path-children
 * on the other host would be wrongly dropped.
 */
function bareHost(u: URL): string {
  return u.hostname.replace(/^www\./i, "");
}
function sameSite(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.port === b.port && bareHost(a) === bareHost(b);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Extract same-host absolute URLs from anchor `href`s in an HTML document.
 * Relative hrefs resolve against `baseUrl`; fragments, mailto:, tel:, and
 * javascript: are dropped, and the hash is stripped so `#anchor` variants
 * dedupe. Pure.
 */
export function extractSameHostLinks(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1]!.trim();
    if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) continue;
    try {
      const u = new URL(raw, base);
      if (!sameSite(u, base)) continue;
      u.hash = "";
      out.add(u.toString());
    } catch {
      // skip unparseable href
    }
  }
  return [...out];
}

/**
 * Keep only URLs that are strict path-children of the source URL — same origin,
 * with a pathname nested under the source's path. The source URL itself and the
 * source's path prefix are excluded (they are the index, not a detail page).
 *
 * A root source path (`/`) yields no children: prefix matching at the domain
 * root would sweep in every page, so root URLs default to single-page. Pure.
 */
export function filterDetailUrls(sourceUrl: string, urls: string[]): string[] {
  let base: URL;
  try {
    base = new URL(sourceUrl);
  } catch {
    return [];
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath === "") return [];
  const prefix = basePath + "/";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!sameSite(u, base)) continue;
    const path = u.pathname.replace(/\/+$/, "");
    if (path === basePath || !path.startsWith(prefix)) continue;
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Apply the cap and build the window/skip note. Pure — the orchestrator decides
 * `pageStructure`/`via`/`anyFetchSucceeded`; this just enforces "no silent
 * truncation".
 */
export function capCandidates(
  detailUrls: string[],
  via: DiscoveryResult["via"],
  sourceUrl: string,
  anyFetchSucceeded: boolean,
): DiscoveryResult {
  if (detailUrls.length >= INDEX_THRESHOLD) {
    const totalFound = detailUrls.length;
    const truncated = totalFound > MAX_CANDIDATES;
    const candidates = detailUrls.slice(0, MAX_CANDIDATES);
    const note = truncated
      ? `Index → detail: ${totalFound} candidate URLs found; showing the first ${candidates.length} (${totalFound - candidates.length} not shown — backfill the rest in a later window, re-runs are idempotent).`
      : `Index → detail: ${candidates.length} candidate URL(s) found.`;
    return { pageStructure: "index", via, candidates, totalFound, truncated, note };
  }

  // Fewer than the index threshold of child URLs.
  if (!anyFetchSucceeded) {
    return {
      pageStructure: "unknown",
      via: "none",
      candidates: [sourceUrl],
      totalFound: 0,
      truncated: false,
      note: "Could not fetch a sitemap or the index page — page shape unknown. Treat as single-page and have the skill confirm.",
    };
  }
  return {
    pageStructure: "single-page",
    via: "source-url",
    candidates: [sourceUrl],
    totalFound: detailUrls.length,
    truncated: false,
    note: "Single-page changelog — extract all releases from this one URL.",
  };
}

/**
 * Discover candidate detail URLs for a source. Tries sitemaps first (those
 * surfaced by robots.txt, plus the conventional `/sitemap.xml`), filtered to
 * the source's changelog path; falls back to parsing the index HTML. Always
 * resolves (best-effort) — degrades to single-page / unknown rather than
 * throwing.
 */
export async function discoverCandidateUrls(args: {
  sourceUrl: string;
  sitemaps?: string[];
  fetchImpl?: FetchImpl;
}): Promise<DiscoveryResult> {
  const { sourceUrl } = args;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  let anyFetchSucceeded = false;

  // 1) Sitemap path — robots-surfaced sitemaps first, then the conventional one.
  const sitemapQueue: string[] = [];
  const enqueue = (u: string) => {
    if (u && !sitemapQueue.includes(u)) sitemapQueue.push(u);
  };
  for (const s of args.sitemaps ?? []) enqueue(s);
  try {
    enqueue(`${new URL(sourceUrl).origin}/sitemap.xml`);
  } catch {
    // sourceUrl unparseable — sitemap discovery is impossible; fall through.
  }

  const sitemapLocs: string[] = [];
  let fetches = 0;
  for (const sm of sitemapQueue) {
    if (fetches >= MAX_SITEMAP_FETCHES) break;
    // oxlint-disable-next-line no-await-in-loop -- bounded sequential sitemap walk (≤MAX_SITEMAP_FETCHES)
    const xml = await getText(sm, fetchImpl);
    fetches++;
    if (xml === null) continue;
    anyFetchSucceeded = true;
    const { locs, isIndex } = parseSitemapLocs(xml);
    if (isIndex) {
      // One level of recursion: a sitemap-index points at child sitemaps. Walk
      // the ones whose own URL sits under the changelog path when we can tell,
      // else the first few, staying within the fetch budget.
      const childOrder = [
        ...filterDetailUrls(sourceUrl, locs),
        ...locs.filter((l) => !filterDetailUrls(sourceUrl, [l]).length),
      ];
      for (const child of childOrder) {
        if (fetches >= MAX_SITEMAP_FETCHES) break;
        // oxlint-disable-next-line no-await-in-loop -- bounded sequential sitemap walk
        const childXml = await getText(child, fetchImpl);
        fetches++;
        if (childXml === null) continue;
        anyFetchSucceeded = true;
        sitemapLocs.push(...parseSitemapLocs(childXml).locs);
      }
    } else {
      sitemapLocs.push(...locs);
    }
  }

  const sitemapDetail = filterDetailUrls(sourceUrl, sitemapLocs);
  if (sitemapDetail.length >= INDEX_THRESHOLD) {
    return capCandidates(sitemapDetail, "sitemap", sourceUrl, true);
  }

  // 2) Index-HTML fallback — parse the source page for per-release links.
  const html = await getText(sourceUrl, fetchImpl);
  if (html !== null) {
    anyFetchSucceeded = true;
    const htmlDetail = filterDetailUrls(sourceUrl, extractSameHostLinks(html, sourceUrl));
    if (htmlDetail.length >= INDEX_THRESHOLD) {
      return capCandidates(htmlDetail, "index-html", sourceUrl, true);
    }
  }

  // 3) Nothing index-shaped — single-page (or unknown if every fetch failed).
  return capCandidates([], "source-url", sourceUrl, anyFetchSucceeded);
}
