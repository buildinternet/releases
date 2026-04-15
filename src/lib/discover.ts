import { logger } from "./logger.js";
import { config } from "./config.js";
import { discoverFeed } from "../adapters/feed.js";
import { parseNextLink } from "../adapters/github.js";
import { detectProvider, type DetectedProvider } from "./providers.js";
import { getAnthropicClient } from "../ai/client.js";
import { logUsage } from "./usage.js";

// ── Types ────────────────────────────────────────────────────────────

export type DiscoveredType = "github" | "feed" | "scrape";
export type DiscoveryMethod = "sitemap" | "feed" | "html-link" | "github-api" | "provider-hint" | "ai-verified" | "ai-suggested" | "well-known" | "link-rel";
export type Confidence = "high" | "medium" | "low";

export interface DiscoveredSource {
  url: string;
  type: DiscoveredType;
  method: DiscoveryMethod;
  confidence: Confidence;
  label?: string;
  provider?: string;
}

export interface DiscoverResult {
  sources: DiscoveredSource[];
  provider: DetectedProvider | null;
}

export interface DiscoverOptions {
  domain?: string;
  githubHandle?: string;
  verify?: boolean;
}

// ── Changelog URL patterns ───────────────────────────────────────────

// Patterns that indicate a changelog/release-notes page.
// These match against URL path segments — use word boundaries or path-segment
// anchors to avoid false positives on unrelated URLs like /rest-api/updates-*.
const CHANGELOG_PATTERNS = [
  /\/changelog(\/|$)/i,
  /\/releases(\/|$)/i,
  /\/whats-new(\/|$)/i,
  /\/what-s-new(\/|$)/i,
  /\/release-notes(\/|$)/i,
];

export function matchesChangelogPattern(url: string): boolean {
  return CHANGELOG_PATTERNS.some((re) => re.test(url));
}

// ── Sitemap discovery ────────────────────────────────────────────────

async function fetchText(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "User-Agent": "releases/0.1" },
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
export function parseSitemapUrlsFromRobots(robotsTxt: string, origin: string): string[] {
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
export function extractLocsFromSitemap(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1]);
  }
  return locs;
}

export function isSitemapIndex(xml: string): boolean {
  return xml.includes("<sitemapindex");
}

async function discoverFromSitemap(origin: string): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

  const robotsTxt = await fetchText(`${origin}/robots.txt`);
  const sitemapUrls = robotsTxt
    ? parseSitemapUrlsFromRobots(robotsTxt, origin)
    : [`${origin}/sitemap.xml`];

  const allPageUrls: string[] = [];

  for (const sitemapUrl of sitemapUrls) {
    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;

    if (isSitemapIndex(xml)) {
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

  // Cap to avoid processing huge sitemaps
  const capped = allPageUrls.length > 50_000 ? allPageUrls.slice(0, 50_000) : allPageUrls;
  const matchingUrls = capped.filter(matchesChangelogPattern);

  // Collapse individual entries to their parent directory.
  // If /changelog/2024-01-foo and /changelog/2024-02-bar both match,
  // return /changelog (the index) instead of every individual entry.
  // If /blog/changelog-april-2020 and /blog/changelog-may-2020 match,
  // return /blog as a candidate too.
  const dirCounts = new Map<string, number>();
  for (const url of matchingUrls) {
    try {
      const parsed = new URL(url);
      const lastSlash = parsed.pathname.lastIndexOf("/");
      const dir = lastSlash > 0 ? parsed.pathname.slice(0, lastSlash) : parsed.pathname;
      const dirUrl = `${parsed.origin}${dir}`;
      dirCounts.set(dirUrl, (dirCounts.get(dirUrl) ?? 0) + 1);
    } catch { /* skip */ }
  }

  // Emit collapsed parent directories (strong signal: multiple entries)
  const collapsedDirs = new Set<string>();
  for (const [dirUrl, count] of dirCounts) {
    if (count >= 2) {
      results.push({
        url: dirUrl,
        type: "scrape",
        method: "sitemap",
        confidence: "high",
        label: `${extractPathLabel(dirUrl)} (${count} entries in sitemap)`,
      });
      collapsedDirs.add(dirUrl);
    }
  }

  // Only include individual URLs that weren't collapsed into a parent
  for (const url of matchingUrls) {
    try {
      const parsed = new URL(url);
      const lastSlash = parsed.pathname.lastIndexOf("/");
      const dir = lastSlash > 0 ? parsed.pathname.slice(0, lastSlash) : parsed.pathname;
      const dirUrl = `${parsed.origin}${dir}`;
      if (!collapsedDirs.has(dirUrl)) {
        results.push({
          url,
          type: "scrape",
          method: "sitemap",
          confidence: "high",
          label: extractPathLabel(url),
        });
      }
    } catch { /* skip */ }
  }

  return dedup(results);
}

// ── Feed probing helper ──────────────────────────────────────────────

async function probeUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "releases/0.1" },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("text/html")
      || ct.includes("application/json")
      || ct.includes("xml")
      || ct.includes("rss")
      || ct.includes("atom");
  } catch {
    return false;
  }
}

// ── Feed discovery ───────────────────────────────────────────────────

async function discoverFeeds(
  origin: string,
  provider: DetectedProvider | null,
): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

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
        const bases = [origin, `${origin}/changelog`];
        for (const base of bases) {
          const feedUrl = `${base.replace(/\/$/, "")}${feedPath}`;
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

/**
 * Scan the origin page for changelog signals:
 * 1. <link rel="changelog|releases|release-notes"> in <head> (link-rel method)
 * 2. <a> links matching changelog URL/text patterns (html-link method)
 *
 * Fetches the page once, extracts both signal types from a single response.
 */
async function discoverFromHtmlLinks(origin: string): Promise<DiscoveredSource[]> {
  const results: DiscoveredSource[] = [];

  const html = await fetchText(origin);
  if (!html) return results;

  // ── Link relations from <head> ──
  const headEnd = html.indexOf("</head>");
  const head = headEnd > -1 ? html.slice(0, headEnd) : html.slice(0, 32_000);

  const linkRelRe = /<link\s[^>]*rel=["'](changelog|releases|release-notes)["'][^>]*>/gi;
  let lrMatch;
  while ((lrMatch = linkRelRe.exec(head)) !== null) {
    const tag = lrMatch[0];
    const rel = lrMatch[1].toLowerCase();
    const hrefMatch = tag.match(/href=["']([^"']+)["']/);
    if (!hrefMatch) continue;

    try {
      const url = new URL(hrefMatch[1], origin).toString();
      const typeMatch = tag.match(/type=["']([^"']+)["']/);
      const isLikelyFeed = typeMatch && /rss|atom|feed\+json/i.test(typeMatch[1]);

      results.push({
        url,
        type: isLikelyFeed ? "feed" : "scrape",
        method: "link-rel",
        confidence: "high",
        label: `<link rel="${rel}">`,
      });
    } catch { /* skip malformed URLs */ }
  }

  // ── Anchor links from <body> ──
  const anchorRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  const seen = new Set<string>(results.map((r) => r.url));

  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, "").trim();

    const hrefMatches = matchesChangelogPattern(href);
    const textMatches = matchesChangelogPattern(text);

    if (!hrefMatches && !textMatches) continue;

    try {
      const resolved = new URL(href, origin).toString();
      if (seen.has(resolved)) continue;
      seen.add(resolved);

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

// ── Well-known file discovery ───────────────────────────────────────

/**
 * Well-known changelog manifest schema (/.well-known/changelog.json).
 *
 * Simple case (single product):
 *   { "version": 1, "url": "https://example.com/changelog", "feed": "..." }
 *
 * Multi-product:
 *   { "version": 1, "changelogs": [{ "name": "...", "url": "...", "feed": "..." }] }
 */
interface WellKnownManifest {
  version?: number;
  url?: string;
  feed?: string;
  changelogs?: Array<{
    name?: string;
    url?: string;
    feed?: string;
  }>;
}

/** Text format keys (security.txt-style): "Changelog:", "Feed:" */
export function parseWellKnownText(text: string, origin: string): DiscoveredSource[] {
  const results: DiscoveredSource[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;

    const changelogMatch = trimmed.match(/^Changelog:\s*(.+)/i);
    if (changelogMatch) {
      try {
        const url = new URL(changelogMatch[1].trim(), origin).toString();
        results.push({
          url,
          type: "scrape",
          method: "well-known",
          confidence: "high",
          label: "well-known changelog",
        });
      } catch { /* skip malformed */ }
    }

    const feedMatch = trimmed.match(/^Feed:\s*(.+)/i);
    if (feedMatch) {
      try {
        const url = new URL(feedMatch[1].trim(), origin).toString();
        results.push({
          url,
          type: "feed",
          method: "well-known",
          confidence: "high",
          label: "well-known feed",
        });
      } catch { /* skip malformed */ }
    }
  }

  return results;
}

export function parseWellKnownJson(raw: string, origin: string): DiscoveredSource[] {
  let manifest: WellKnownManifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return [];
  }

  const results: DiscoveredSource[] = [];

  // Single-product shorthand
  if (manifest.url) {
    try {
      results.push({
        url: new URL(manifest.url, origin).toString(),
        type: "scrape",
        method: "well-known",
        confidence: "high",
        label: "well-known changelog",
      });
    } catch { /* skip */ }
  }
  if (manifest.feed) {
    try {
      results.push({
        url: new URL(manifest.feed, origin).toString(),
        type: "feed",
        method: "well-known",
        confidence: "high",
        label: "well-known feed",
      });
    } catch { /* skip */ }
  }

  // Multi-product array
  for (const entry of manifest.changelogs ?? []) {
    const name = entry.name ?? "changelog";
    if (entry.url) {
      try {
        results.push({
          url: new URL(entry.url, origin).toString(),
          type: "scrape",
          method: "well-known",
          confidence: "high",
          label: `well-known: ${name}`,
        });
      } catch { /* skip */ }
    }
    if (entry.feed) {
      try {
        results.push({
          url: new URL(entry.feed, origin).toString(),
          type: "feed",
          method: "well-known",
          confidence: "high",
          label: `well-known feed: ${name}`,
        });
      } catch { /* skip */ }
    }
  }

  return results;
}

/**
 * Extract changelog URLs from AGENTS.md or AGENTS.txt.
 * These files describe how AI agents should interact with a site and may
 * include references to changelogs, release notes, or feeds.
 */
export function parseAgentsFile(text: string, origin: string): DiscoveredSource[] {
  const results: DiscoveredSource[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Key-value format: "Changelog: https://..." or "Release-Notes: https://..."
    const kvMatch = trimmed.match(/^(?:Changelog|Release[- ]?Notes|Releases|Changes):\s*(.+)/i);
    if (kvMatch) {
      try {
        const url = new URL(kvMatch[1].trim(), origin).toString();
        results.push({
          url,
          type: "scrape",
          method: "well-known",
          confidence: "high",
          label: "AGENTS file changelog",
        });
      } catch { /* skip */ }
      continue;
    }

    // Markdown links containing changelog-related terms
    const mdLinkRe = /\[([^\]]*(?:changelog|release.?notes|releases|changes)[^\]]*)\]\(([^)]+)\)/gi;
    let mdMatch;
    while ((mdMatch = mdLinkRe.exec(trimmed)) !== null) {
      try {
        const url = new URL(mdMatch[2].trim(), origin).toString();
        results.push({
          url,
          type: "scrape",
          method: "well-known",
          confidence: "high",
          label: `AGENTS file: ${mdMatch[1].trim()}`,
        });
      } catch { /* skip */ }
    }

    // Bare URLs on changelog-related lines — only if the URL path itself matches
    const urlMatch = trimmed.match(/https?:\/\/[^\s)>"]+/);
    if (urlMatch && !results.some((r) => r.url === urlMatch[0]) && matchesChangelogPattern(urlMatch[0])) {
      try {
        const url = new URL(urlMatch[0], origin).toString();
        results.push({
          url,
          type: "scrape",
          method: "well-known",
          confidence: "medium",
          label: "AGENTS file URL",
        });
      } catch { /* skip */ }
    }
  }

  return results;
}

/**
 * Check if root-level changelog/releases files exist (e.g., /changelog.md, /releases.txt).
 * Analogous to robots.txt or security.txt — a simple file at a conventional path.
 * Uses lowercase paths only — web servers are typically case-insensitive for these.
 */
async function probeRootChangelog(origin: string): Promise<DiscoveredSource[]> {
  const paths = ["/changelog.md", "/changelog.txt", "/releases.md", "/releases.txt"];

  const results = await Promise.allSettled(
    paths.map(async (path) => {
      const url = `${origin}${path}`;
      const exists = await probeUrl(url);
      return exists ? { url, path } : null;
    }),
  );

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      return [{
        url: r.value.url,
        type: "scrape" as const,
        method: "well-known" as const,
        confidence: "high" as const,
        label: `root ${r.value.path}`,
      }];
    }
  }
  return [];
}

/**
 * Check well-known file locations for changelog manifests.
 *
 * Cascading — stops as soon as a tier produces results:
 * 1. /.well-known/ files (changelog.json, releases.json, changelog.txt — all parallel)
 * 2. /AGENTS.md, /AGENTS.txt (AI agent instruction files with changelog refs)
 * 3. /changelog.md, /changelog.txt, /releases.md, /releases.txt (root-level files)
 */
async function discoverFromWellKnown(origin: string): Promise<DiscoveredSource[]> {
  // Tier 1: All /.well-known/ paths in parallel (JSON preferred over text)
  const wellKnownResults = await Promise.allSettled([
    fetchText(`${origin}/.well-known/changelog.json`, 8_000).then(
      (body) => body ? parseWellKnownJson(body, origin) : [],
    ),
    fetchText(`${origin}/.well-known/releases.json`, 8_000).then(
      (body) => body ? parseWellKnownJson(body, origin) : [],
    ),
    fetchText(`${origin}/.well-known/changelog.txt`, 8_000).then(
      (body) => body ? parseWellKnownText(body, origin) : [],
    ),
  ]);
  // Prefer JSON over text — check in order
  for (const r of wellKnownResults) {
    if (r.status === "fulfilled" && r.value.length > 0) {
      logger.info(`Found well-known changelog manifest`);
      return r.value;
    }
  }

  // Tier 3: AGENTS files (may contain changelog refs among other instructions)
  const [agentsMdResult, agentsTxtResult] = await Promise.allSettled([
    fetchText(`${origin}/AGENTS.md`, 8_000).then(
      (body) => body ? parseAgentsFile(body, origin) : [],
    ),
    fetchText(`${origin}/AGENTS.txt`, 8_000).then(
      (body) => body ? parseAgentsFile(body, origin) : [],
    ),
  ]);
  const agentsSources: DiscoveredSource[] = [];
  for (const r of [agentsMdResult, agentsTxtResult]) {
    if (r.status === "fulfilled") agentsSources.push(...r.value);
  }
  if (agentsSources.length > 0) {
    logger.info(`Found changelog reference(s) in AGENTS file`);
    return dedup(agentsSources);
  }

  // Tier 4: Root changelog files (lowest signal — convention-based)
  const rootSources = await probeRootChangelog(origin);
  if (rootSources.length > 0) {
    logger.info(`Found root changelog file`);
    return rootSources;
  }

  return [];
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

    if (results.length >= 300) break;
  }

  return results;
}

// ── AI verification ──────────────────────────────────────────────────

const VERIFY_TOOL = {
  name: "report_results" as const,
  description: "Report which candidate URLs are valid changelog pages and suggest any additional changelog URLs discovered.",
  input_schema: {
    type: "object" as const,
    properties: {
      verified: {
        type: "array" as const,
        description: "Candidate URLs confirmed to be changelog or release note pages",
        items: {
          type: "object" as const,
          properties: {
            url: { type: "string" as const },
            label: { type: "string" as const, description: "Brief description of what this page contains" },
          },
          required: ["url", "label"],
        },
      },
      rejected: {
        type: "array" as const,
        description: "Candidate URLs that are NOT changelog pages (404, homepage redirect, unrelated content)",
        items: {
          type: "object" as const,
          properties: {
            url: { type: "string" as const },
            reason: { type: "string" as const },
          },
          required: ["url", "reason"],
        },
      },
      suggested: {
        type: "array" as const,
        description: "Additional changelog/release-note URLs discovered that were not in the candidate list",
        items: {
          type: "object" as const,
          properties: {
            url: { type: "string" as const },
            type: { type: "string" as const, enum: ["feed", "scrape"] },
            label: { type: "string" as const },
          },
          required: ["url", "type", "label"],
        },
      },
    },
    required: ["verified", "rejected", "suggested"],
  },
};

async function verifyWithAI(
  candidates: DiscoveredSource[],
  domain: string,
  provider: DetectedProvider | null,
): Promise<DiscoveredSource[]> {
  const client = getAnthropicClient();

  const candidateList = candidates.map((c) =>
    `- ${c.url} (found via ${c.method}, type: ${c.type}${c.label ? `, label: ${c.label}` : ""})`
  ).join("\n");

  const providerNote = provider
    ? `\nThe site appears to use ${provider.name} as its documentation/content platform.`
    : "";

  const response = await client.messages.create({
    model: config.ingestModel(),
    max_tokens: 4096,
    system: [
      "You verify whether candidate URLs are actual changelog or release-note pages.",
      "For each candidate URL, determine if it is a real changelog/release-notes page or a false positive (404, redirect to homepage, unrelated content).",
      "Also look for changelog URLs that the automated discovery may have missed — check common patterns like support sites, blog posts tagged as releases, or documentation subdomains.",
      "Be thorough but only suggest URLs you are confident exist based on the domain structure and provider type.",
    ].join("\n"),
    tools: [VERIFY_TOOL],
    tool_choice: { type: "tool", name: "report_results" },
    messages: [
      {
        role: "user",
        content: [
          `Domain: ${domain}${providerNote}`,
          "",
          candidates.length > 0 ? `Candidate URLs to verify:\n${candidateList}` : "No candidates were found by automated discovery.",
          "",
          "Please verify each candidate and suggest any additional changelog/release-note URLs for this domain that automated discovery may have missed.",
          "Consider: support sites (support.domain.com), documentation sites (docs.domain.com), blog release categories, and known provider patterns.",
        ].join("\n"),
      },
    ],
  });

  await logUsage({
    operation: "discover-verify",
    model: config.ingestModel(),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  const toolBlock = response.content.find((block) => block.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    logger.warn("AI verification did not return tool results — returning candidates as-is");
    return candidates;
  }

  const input = toolBlock.input as {
    verified?: Array<{ url: string; label: string }>;
    rejected?: Array<{ url: string; reason: string }>;
    suggested?: Array<{ url: string; type: string; label: string }>;
  };

  // Build verified set from AI response
  const verifiedUrls = new Set((input.verified ?? []).map((v) => v.url));
  const verifiedLabels = new Map((input.verified ?? []).map((v) => [v.url, v.label]));

  // Log rejections
  for (const r of input.rejected ?? []) {
    logger.info(`Rejected: ${r.url} — ${r.reason}`);
  }

  // Keep only verified candidates, upgrade their confidence
  const results: DiscoveredSource[] = [];

  for (const candidate of candidates) {
    if (verifiedUrls.has(candidate.url)) {
      results.push({
        ...candidate,
        confidence: "high",
        method: "ai-verified",
        label: verifiedLabels.get(candidate.url) ?? candidate.label,
      });
    }
  }

  // Add AI-suggested URLs
  for (const suggestion of input.suggested ?? []) {
    // Skip if already in results
    if (results.some((r) => r.url === suggestion.url)) continue;

    results.push({
      url: suggestion.url,
      type: suggestion.type === "feed" ? "feed" : "scrape",
      method: "ai-suggested",
      confidence: "medium",
      label: suggestion.label,
    });
  }

  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function extractPathLabel(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    return pathname === "/" ? "Home" : pathname;
  } catch {
    return url;
  }
}

export function dedup(sources: DiscoveredSource[]): DiscoveredSource[] {
  const seen = new Map<string, DiscoveredSource>();
  for (const s of sources) {
    const existing = seen.get(s.url);
    if (!existing || confidenceRank(s.confidence) > confidenceRank(existing.confidence)) {
      seen.set(s.url, s);
    }
  }
  return Array.from(seen.values());
}

/** Remove URLs that are children of other discovered URLs.
 *  e.g., if /changelog is in the list, drop /changelog/2024-01-foo */
export function collapseChildren(sources: DiscoveredSource[]): DiscoveredSource[] {
  const urls = new Set(sources.map((s) => s.url));
  return sources.filter((s) => {
    try {
      const parsed = new URL(s.url);
      // Walk up the path to check if any parent is also in the result set
      const segments = parsed.pathname.split("/").filter(Boolean);
      for (let i = segments.length - 1; i >= 1; i--) {
        const parentPath = "/" + segments.slice(0, i).join("/");
        const parentUrl = `${parsed.origin}${parentPath}`;
        if (urls.has(parentUrl) && parentUrl !== s.url) return false;
      }
    } catch { /* keep */ }
    return true;
  });
}

export function confidenceRank(c: Confidence): number {
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

    // Run evidence-based discovery methods in parallel
    // Well-known files checked alongside existing methods; link relations
    // are extracted from the same page fetch as HTML link analysis
    const [wellKnownResults, sitemapResults, feedResults, htmlResults] = await Promise.allSettled([
      discoverFromWellKnown(origin),
      discoverFromSitemap(origin),
      discoverFeeds(origin, provider),
      discoverFromHtmlLinks(origin),
    ]);

    for (const r of [wellKnownResults, sitemapResults, feedResults, htmlResults]) {
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

  // Deduplicate, collapse children, and sort by confidence
  let deduped = collapseChildren(dedup(all));
  deduped.sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));

  // AI verification pass — validates candidates and suggests additional URLs
  if (options.verify && options.domain) {
    logger.info("Verifying results with AI...");
    try {
      deduped = await verifyWithAI(deduped, options.domain, provider);
      deduped = dedup(deduped);
      deduped.sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));
    } catch (err) {
      logger.warn(`AI verification failed, returning unverified results: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { sources: deduped, provider };
}
