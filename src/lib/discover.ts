import { logger } from "./logger.js";
import { config } from "./config.js";
import { discoverFeed } from "../adapters/feed.js";
import { parseNextLink } from "../adapters/github.js";
import { detectProvider, type DetectedProvider } from "./providers.js";

// ── Types ────────────────────────────────────────────────────────────

export type DiscoveredType = "github" | "feed" | "scrape";
export type DiscoveryMethod = "sitemap" | "well-known" | "feed" | "html-link" | "github-api" | "provider-hint";
export type Confidence = "high" | "medium" | "low";

export interface DiscoveredSource {
  url: string;
  type: DiscoveredType;
  method: DiscoveryMethod;
  confidence: Confidence;
  label?: string;
  provider?: string; // detected hosting provider id (e.g. "mintlify", "readme")
}

export interface DiscoverResult {
  sources: DiscoveredSource[];
  provider: DetectedProvider | null;
}

export interface DiscoverOptions {
  domain?: string;
  githubHandle?: string;
}

// ── Changelog URL patterns ───────────────────────────────────────────

const CHANGELOG_PATTERNS = [
  /changelog/i,
  /releases/i,
  /updates/i,
  /whats-new/i,
  /what-s-new/i,
  /release-notes/i,
  /announcements/i,
];

const WELL_KNOWN_CHANGELOG_PATHS = [
  "/changelog",
  "/releases",
  "/updates",
  "/whats-new",
  "/blog/changelog",
  "/blog/releases",
  "/docs/releases",
  "/docs/changelog",
  "/release-notes",
];

const SUBDOMAIN_PREFIXES = ["docs", "developers", "status", "support", "help"];

function matchesChangelogPattern(url: string): boolean {
  return CHANGELOG_PATTERNS.some((re) => re.test(url));
}

// ── Sitemap discovery ────────────────────────────────────────────────

async function fetchText(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "User-Agent": "released/0.1" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Extract sitemap URLs from robots.txt */
function parseSitemapUrlsFromRobots(robotsTxt: string, origin: string): string[] {
  const urls: string[] = [];
  for (const line of robotsTxt.split("\n")) {
    const match = line.match(/^Sitemap:\s*(.+)/i);
    if (match) {
      const url = match[1].trim();
      try {
        urls.push(new URL(url, origin).toString());
      } catch { /* skip malformed */ }
    }
  }
  return urls.length > 0 ? urls : [`${origin}/sitemap.xml`];
}

/** Extract <loc> URLs from a sitemap or sitemap index */
function extractLocsFromSitemap(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1]);
  }
  return locs;
}

function isSitemapIndex(xml: string): boolean {
  return xml.includes("<sitemapindex");
}

async function discoverFromSitemap(origin: string): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

  // Step 1: Find sitemap URLs from robots.txt
  const robotsTxt = await fetchText(`${origin}/robots.txt`);
  const sitemapUrls = robotsTxt
    ? parseSitemapUrlsFromRobots(robotsTxt, origin)
    : [`${origin}/sitemap.xml`];

  // Step 2: Fetch and parse sitemaps (handle indexes)
  const allPageUrls: string[] = [];

  for (const sitemapUrl of sitemapUrls) {
    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;

    if (isSitemapIndex(xml)) {
      // It's a sitemap index — fetch child sitemaps in parallel
      const childUrls = extractLocsFromSitemap(xml);
      const childResults = await Promise.allSettled(
        childUrls.slice(0, 10).map((u) => fetchText(u)),
      );
      for (const r of childResults) {
        if (r.status === "fulfilled" && r.value) {
          allPageUrls.push(...extractLocsFromSitemap(r.value));
        }
      }
    } else {
      allPageUrls.push(...extractLocsFromSitemap(xml));
    }
  }

  // Step 3: Filter for changelog-like URLs (cap to avoid processing huge sitemaps)
  const capped = allPageUrls.length > 50_000 ? allPageUrls.slice(0, 50_000) : allPageUrls;
  for (const url of capped) {
    if (matchesChangelogPattern(url)) {
      results.push({
        url,
        type: "scrape",
        method: "sitemap",
        confidence: "high",
        label: extractPathLabel(url),
      });
    }
  }

  return dedup(results);
}

// ── Well-known path probing ──────────────────────────────────────────

async function probeUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "released/0.1" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") ?? "";
    // Accept HTML pages, JSON, and feed MIME types (for provider-hint feed probes)
    return ct.includes("text/html")
      || ct.includes("application/json")
      || ct.includes("xml")
      || ct.includes("rss")
      || ct.includes("atom");
  } catch {
    return false;
  }
}

async function discoverFromWellKnownPaths(
  origin: string,
  provider: DetectedProvider | null,
): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

  // Build candidate URLs: root domain + subdomains
  const candidates: string[] = [];
  const allPaths = [...WELL_KNOWN_CHANGELOG_PATHS];

  // Add provider-specific changelog paths
  if (provider?.hints.changelogPaths) {
    for (const path of provider.hints.changelogPaths) {
      if (!allPaths.includes(path)) allPaths.push(path);
    }
  }

  for (const path of allPaths) {
    candidates.push(`${origin}${path}`);
  }

  const host = new URL(origin).hostname;
  for (const prefix of SUBDOMAIN_PREFIXES) {
    const subOrigin = `https://${prefix}.${host}`;
    for (const path of ["/changelog", "/releases", "/updates", "/whats-new"]) {
      candidates.push(`${subOrigin}${path}`);
    }
  }

  // Probe all in parallel
  const probeResults = await Promise.allSettled(
    candidates.map(async (url) => ({ url, ok: await probeUrl(url) })),
  );

  for (const r of probeResults) {
    if (r.status === "fulfilled" && r.value.ok) {
      const isProviderHint = provider?.hints.changelogPaths?.some((p) =>
        r.value.url.endsWith(p),
      );
      results.push({
        url: r.value.url,
        type: provider?.hints.preferredType ?? "scrape",
        method: isProviderHint ? "provider-hint" : "well-known",
        confidence: isProviderHint ? "high" : "medium",
        label: extractPathLabel(r.value.url),
        provider: provider?.id,
      });
    }
  }

  return results;
}

// ── Feed discovery ───────────────────────────────────────────────────

async function discoverFeeds(
  origin: string,
  provider: DetectedProvider | null,
): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

  // Try feed discovery on the root and known changelog paths
  const urlsToProbe = [
    origin,
    `${origin}/changelog`,
    `${origin}/blog`,
  ];

  const probeResults = await Promise.allSettled(
    urlsToProbe.map(async (url) => {
      const feed = await discoverFeed(url);
      return feed ? { pageUrl: url, feed } : null;
    }),
  );

  for (const r of probeResults) {
    if (r.status === "fulfilled" && r.value) {
      results.push({
        url: r.value.feed.url,
        type: "feed",
        method: "feed",
        confidence: "high",
        label: `${r.value.feed.type} feed (from ${new URL(r.value.pageUrl).pathname || "/"})`,
        provider: provider?.id,
      });
    }
  }

  // Provider-specific feed paths (probe directly if discoverFeed missed them)
  if (provider?.hints.feedPaths) {
    const providerProbes = await Promise.allSettled(
      provider.hints.feedPaths.map(async (feedPath) => {
        // Try the feed path on root and on /changelog
        const bases = [origin, `${origin}/changelog`];
        for (const base of bases) {
          const feedUrl = `${base.replace(/\/$/, "")}${feedPath}`;
          // Skip if already found
          if (results.some((r) => r.url === feedUrl)) continue;
          const ok = await probeUrl(feedUrl);
          if (ok) return { feedUrl, feedPath };
        }
        return null;
      }),
    );

    for (const r of providerProbes) {
      if (r.status === "fulfilled" && r.value) {
        results.push({
          url: r.value.feedUrl,
          type: "feed",
          method: "provider-hint",
          confidence: "high",
          label: `${provider.name} feed (${r.value.feedPath})`,
          provider: provider.id,
        });
      }
    }
  }

  return results;
}

// ── HTML link analysis ───────────────────────────────────────────────

async function discoverFromHtmlLinks(origin: string): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

  const html = await fetchText(origin);
  if (!html) return results;

  // Extract <a> tags with changelog-related hrefs or text
  const linkRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const seen = new Set<string>();

  while ((match = linkRe.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();

    const hrefMatches = matchesChangelogPattern(href);
    const textMatches = matchesChangelogPattern(text);

    if (!hrefMatches && !textMatches) continue;

    try {
      const resolved = new URL(href, origin).toString();
      if (seen.has(resolved)) continue;
      seen.add(resolved);

      // Only include links to the same domain or subdomains
      const linkHost = new URL(resolved).hostname;
      const originHost = new URL(origin).hostname;
      if (!linkHost.endsWith(originHost) && !originHost.endsWith(linkHost)) continue;

      results.push({
        url: resolved,
        type: "scrape",
        method: "html-link",
        confidence: hrefMatches && textMatches ? "high" : "medium",
        label: text || extractPathLabel(resolved),
      });
    } catch { /* skip malformed URLs */ }
  }

  return results;
}

// ── GitHub org repos ─────────────────────────────────────────────────

async function discoverFromGitHub(handle: string): Promise<DiscoveredSource[]> {
  const token = config.githubToken();
  if (!token) {
    logger.warn("No GITHUB_TOKEN set — skipping GitHub repo discovery");
    return [];
  }

  const results: DiscoveredSource[] = [];
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };

  let url: string | null =
    `https://api.github.com/orgs/${handle}/repos?per_page=100&sort=updated&direction=desc`;

  while (url) {
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch {
      break;
    }

    if (res.status === 404) {
      // Try as a user instead
      if (url.includes("/orgs/")) {
        url = `https://api.github.com/users/${handle}/repos?per_page=100&sort=updated&direction=desc`;
        continue;
      }
      break;
    }

    if (!res.ok) {
      logger.warn(`GitHub API returned ${res.status} for ${handle}`);
      break;
    }

    const repos: Array<{
      full_name: string;
      html_url: string;
      name: string;
      fork: boolean;
      archived: boolean;
    }> = await res.json();

    // Check which repos have releases
    const releaseChecks = await Promise.allSettled(
      repos
        .filter((r) => !r.fork && !r.archived)
        .map(async (repo) => {
          const relRes = await fetch(
            `https://api.github.com/repos/${repo.full_name}/releases?per_page=1`,
            { headers },
          );
          if (!relRes.ok) return null;
          const rels: unknown[] = await relRes.json();
          return rels.length > 0 ? repo : null;
        }),
    );

    for (const r of releaseChecks) {
      if (r.status === "fulfilled" && r.value) {
        results.push({
          url: r.value.html_url,
          type: "github",
          method: "github-api",
          confidence: "high",
          label: r.value.name,
        });
      }
    }

    url = parseNextLink(res.headers.get("link"));

    // Cap at 300 repos to avoid excessive API calls
    if (results.length >= 300) break;
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractPathLabel(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname === "/" ? "Home" : pathname;
  } catch {
    return url;
  }
}

function dedup(sources: DiscoveredSource[]): DiscoveredSource[] {
  const seen = new Map<string, DiscoveredSource>();
  for (const s of sources) {
    const existing = seen.get(s.url);
    if (!existing || confidenceRank(s.confidence) > confidenceRank(existing.confidence)) {
      seen.set(s.url, s);
    }
  }
  return Array.from(seen.values());
}

function confidenceRank(c: Confidence): number {
  switch (c) {
    case "high": return 3;
    case "medium": return 2;
    case "low": return 1;
  }
}

// ── Main discovery pipeline ──────────────────────────────────────────

export async function discover(options: DiscoverOptions): Promise<DiscoverResult> {
  const all: DiscoveredSource[] = [];
  let provider: DetectedProvider | null = null;

  if (options.domain) {
    const origin = options.domain.startsWith("http")
      ? new URL(options.domain).origin
      : `https://${options.domain}`;

    logger.info(`Scanning ${origin} for changelog sources...`);

    // Detect provider first — its hints guide the rest of discovery
    provider = await detectProvider(origin);
    if (provider) {
      logger.info(`Detected provider: ${provider.name}`);
    }

    // Run all domain-based discovery methods in parallel
    const [sitemapResults, wellKnownResults, feedResults, htmlResults] = await Promise.allSettled([
      discoverFromSitemap(origin),
      discoverFromWellKnownPaths(origin, provider),
      discoverFeeds(origin, provider),
      discoverFromHtmlLinks(origin),
    ]);

    for (const r of [sitemapResults, wellKnownResults, feedResults, htmlResults]) {
      if (r.status === "fulfilled") all.push(...r.value);
    }

    // Tag all domain-discovered sources with the provider
    if (provider) {
      for (const s of all) {
        if (!s.provider) s.provider = provider.id;
      }
    }
  }

  if (options.githubHandle) {
    logger.info(`Scanning GitHub for ${options.githubHandle} repos with releases...`);
    const ghResults = await discoverFromGitHub(options.githubHandle);
    all.push(...ghResults);
  }

  // Deduplicate and sort by confidence then method
  const deduped = dedup(all);
  deduped.sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));

  return { sources: deduped, provider };
}
