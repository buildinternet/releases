import { describe, it, expect } from "bun:test";
import {
  matchesChangelogPattern,
  parseSitemapUrlsFromRobots,
  extractLocsFromSitemap,
  isSitemapIndex,
  parseWellKnownText,
  parseWellKnownJson,
  parseAgentsFile,
  extractPathLabel,
  dedup,
  collapseChildren,
  confidenceRank,
  type DiscoveredSource,
} from "../../src/lib/discover.js";

// ── matchesChangelogPattern ─────────────────────────────────────────

describe("matchesChangelogPattern", () => {
  it("matches /changelog", () => {
    expect(matchesChangelogPattern("/changelog")).toBe(true);
  });

  it("matches /changelog/", () => {
    expect(matchesChangelogPattern("/changelog/")).toBe(true);
  });

  it("matches /releases", () => {
    expect(matchesChangelogPattern("/releases")).toBe(true);
  });

  it("matches /whats-new", () => {
    expect(matchesChangelogPattern("/whats-new")).toBe(true);
  });

  it("matches /what-s-new", () => {
    expect(matchesChangelogPattern("/what-s-new")).toBe(true);
  });

  it("matches /release-notes", () => {
    expect(matchesChangelogPattern("/release-notes")).toBe(true);
  });

  it("does not match /blog", () => {
    expect(matchesChangelogPattern("/blog")).toBe(false);
  });

  it("does not match /pricing", () => {
    expect(matchesChangelogPattern("/pricing")).toBe(false);
  });

  it("does not match /rest-api/updates (false-positive guard)", () => {
    expect(matchesChangelogPattern("/rest-api/updates")).toBe(false);
  });
});

// ── parseSitemapUrlsFromRobots ──────────────────────────────────────

describe("parseSitemapUrlsFromRobots", () => {
  it("extracts Sitemap: lines from robots.txt", () => {
    const robots = `User-agent: *\nDisallow: /admin\nSitemap: https://example.com/sitemap.xml`;
    const urls = parseSitemapUrlsFromRobots(robots, "https://example.com");
    expect(urls).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("returns origin/sitemap.xml when no Sitemap: directives found", () => {
    const robots = `User-agent: *\nDisallow: /admin`;
    const urls = parseSitemapUrlsFromRobots(robots, "https://example.com");
    expect(urls).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("handles multiple Sitemap: entries", () => {
    const robots = [
      "Sitemap: https://example.com/sitemap1.xml",
      "Sitemap: https://example.com/sitemap2.xml",
    ].join("\n");
    const urls = parseSitemapUrlsFromRobots(robots, "https://example.com");
    expect(urls).toHaveLength(2);
    expect(urls).toContain("https://example.com/sitemap1.xml");
    expect(urls).toContain("https://example.com/sitemap2.xml");
  });

  it("skips non-Sitemap lines", () => {
    const robots = `User-agent: Googlebot\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\nAllow: /`;
    const urls = parseSitemapUrlsFromRobots(robots, "https://example.com");
    expect(urls).toEqual(["https://example.com/sitemap.xml"]);
  });
});

// ── extractLocsFromSitemap ──────────────────────────────────────────

describe("extractLocsFromSitemap", () => {
  it("extracts URLs from <loc> tags", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;
    const locs = extractLocsFromSitemap(xml);
    expect(locs).toEqual(["https://example.com/page1", "https://example.com/page2"]);
  });

  it("handles whitespace around URLs", () => {
    const xml = `<urlset><url><loc>  https://example.com/page  </loc></url></urlset>`;
    const locs = extractLocsFromSitemap(xml);
    expect(locs).toEqual(["https://example.com/page"]);
  });

  it("returns empty array for non-XML", () => {
    const locs = extractLocsFromSitemap("this is not xml at all");
    expect(locs).toEqual([]);
  });
});

// ── isSitemapIndex ──────────────────────────────────────────────────

describe("isSitemapIndex", () => {
  it("returns true for sitemapindex content", () => {
    const xml = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap1.xml</loc></sitemap>
</sitemapindex>`;
    expect(isSitemapIndex(xml)).toBe(true);
  });

  it("returns false for regular sitemap", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page</loc></url>
</urlset>`;
    expect(isSitemapIndex(xml)).toBe(false);
  });
});

// ── parseWellKnownText ──────────────────────────────────────────────

describe("parseWellKnownText", () => {
  it("parses Changelog: lines into scrape sources", () => {
    const text = "Changelog: https://example.com/changelog";
    const results = parseWellKnownText(text, "https://example.com");
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/changelog");
    expect(results[0].type).toBe("scrape");
    expect(results[0].method).toBe("well-known");
  });

  it("parses Feed: lines into feed sources", () => {
    const text = "Feed: https://example.com/feed.xml";
    const results = parseWellKnownText(text, "https://example.com");
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/feed.xml");
    expect(results[0].type).toBe("feed");
  });

  it("skips comments and blank lines", () => {
    const text = [
      "# This is a comment",
      "",
      "Changelog: https://example.com/changelog",
      "# Another comment",
      "",
    ].join("\n");
    const results = parseWellKnownText(text, "https://example.com");
    expect(results).toHaveLength(1);
  });

  it("resolves relative URLs against origin", () => {
    const text = "Changelog: /changelog\nFeed: /feed.xml";
    const results = parseWellKnownText(text, "https://example.com");
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe("https://example.com/changelog");
    expect(results[1].url).toBe("https://example.com/feed.xml");
  });
});

// ── parseWellKnownJson ──────────────────────────────────────────────

describe("parseWellKnownJson", () => {
  it("parses single-product format (url + feed)", () => {
    const json = JSON.stringify({
      version: 1,
      url: "https://example.com/changelog",
      feed: "https://example.com/feed.xml",
    });
    const results = parseWellKnownJson(json, "https://example.com");
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("scrape");
    expect(results[0].url).toBe("https://example.com/changelog");
    expect(results[1].type).toBe("feed");
    expect(results[1].url).toBe("https://example.com/feed.xml");
  });

  it("parses multi-product format (changelogs array)", () => {
    const json = JSON.stringify({
      version: 1,
      changelogs: [
        { name: "Product A", url: "https://example.com/a/changelog", feed: "https://example.com/a/feed.xml" },
        { name: "Product B", url: "https://example.com/b/changelog" },
      ],
    });
    const results = parseWellKnownJson(json, "https://example.com");
    // Product A: url + feed = 2, Product B: url = 1
    expect(results).toHaveLength(3);
    expect(results[0].label).toBe("well-known: Product A");
    expect(results[2].label).toBe("well-known: Product B");
  });

  it("returns empty for invalid JSON", () => {
    const results = parseWellKnownJson("not json {{{", "https://example.com");
    expect(results).toEqual([]);
  });

  it("resolves relative URLs", () => {
    const json = JSON.stringify({ version: 1, url: "/changelog", feed: "/feed.xml" });
    const results = parseWellKnownJson(json, "https://example.com");
    expect(results[0].url).toBe("https://example.com/changelog");
    expect(results[1].url).toBe("https://example.com/feed.xml");
  });
});

// ── parseAgentsFile ─────────────────────────────────────────────────

describe("parseAgentsFile", () => {
  it("extracts Changelog: key-value lines", () => {
    const text = "Changelog: https://example.com/changelog";
    const results = parseAgentsFile(text, "https://example.com");
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/changelog");
    expect(results[0].label).toBe("AGENTS file changelog");
  });

  it("extracts Release-Notes: key-value lines", () => {
    const text = "Release-Notes: https://example.com/release-notes";
    const results = parseAgentsFile(text, "https://example.com");
    expect(results).toHaveLength(1);
    expect(results[0].url).toBe("https://example.com/release-notes");
  });

  it("extracts markdown links with changelog text", () => {
    const text = "Check our [changelog](https://example.com/changelog) for updates.";
    const results = parseAgentsFile(text, "https://example.com");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const mdResult = results.find((r) => r.label?.startsWith("AGENTS file:"));
    expect(mdResult).toBeDefined();
    expect(mdResult!.url).toBe("https://example.com/changelog");
  });

  it("extracts bare URLs that match changelog patterns", () => {
    const text = "Visit https://example.com/changelog for the latest updates.";
    const results = parseAgentsFile(text, "https://example.com");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const bareResult = results.find((r) => r.label === "AGENTS file URL");
    expect(bareResult).toBeDefined();
    expect(bareResult!.confidence).toBe("medium");
  });

  it("ignores unrelated content", () => {
    const text = [
      "# Agent Instructions",
      "This product helps developers build apps.",
      "Contact: support@example.com",
      "Documentation: https://docs.example.com",
    ].join("\n");
    const results = parseAgentsFile(text, "https://example.com");
    expect(results).toHaveLength(0);
  });
});

// ── extractPathLabel ────────────────────────────────────────────────

describe("extractPathLabel", () => {
  it("returns pathname from URL", () => {
    expect(extractPathLabel("https://example.com/changelog")).toBe("/changelog");
  });

  it("returns Home for root path", () => {
    expect(extractPathLabel("https://example.com/")).toBe("Home");
  });

  it("handles invalid URLs gracefully", () => {
    const label = extractPathLabel("not-a-url");
    expect(typeof label).toBe("string");
  });
});

// ── dedup ───────────────────────────────────────────────────────────

describe("dedup", () => {
  it("removes duplicate URLs, keeping highest confidence", () => {
    const sources: DiscoveredSource[] = [
      { url: "https://example.com/changelog", type: "scrape", method: "sitemap", confidence: "low" },
      { url: "https://example.com/changelog", type: "scrape", method: "html-link", confidence: "high" },
      { url: "https://example.com/releases", type: "scrape", method: "sitemap", confidence: "medium" },
    ];
    const result = dedup(sources);
    expect(result).toHaveLength(2);
    const changelog = result.find((s) => s.url === "https://example.com/changelog");
    expect(changelog!.confidence).toBe("high");
  });

  it("preserves order of first occurrence", () => {
    const sources: DiscoveredSource[] = [
      { url: "https://example.com/a", type: "scrape", method: "sitemap", confidence: "high" },
      { url: "https://example.com/b", type: "scrape", method: "sitemap", confidence: "high" },
    ];
    const result = dedup(sources);
    expect(result[0].url).toBe("https://example.com/a");
    expect(result[1].url).toBe("https://example.com/b");
  });
});

// ── collapseChildren ────────────────────────────────────────────────

describe("collapseChildren", () => {
  it("removes child URLs when parent exists", () => {
    const sources: DiscoveredSource[] = [
      { url: "https://example.com/changelog", type: "scrape", method: "sitemap", confidence: "high" },
      { url: "https://example.com/changelog/2024-01", type: "scrape", method: "sitemap", confidence: "high" },
      { url: "https://example.com/changelog/2024-02", type: "scrape", method: "sitemap", confidence: "high" },
    ];
    const result = collapseChildren(sources);
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://example.com/changelog");
  });

  it("keeps URLs without parents", () => {
    const sources: DiscoveredSource[] = [
      { url: "https://example.com/changelog", type: "scrape", method: "sitemap", confidence: "high" },
      { url: "https://example.com/releases", type: "scrape", method: "sitemap", confidence: "high" },
    ];
    const result = collapseChildren(sources);
    expect(result).toHaveLength(2);
  });
});

// ── confidenceRank ──────────────────────────────────────────────────

describe("confidenceRank", () => {
  it("ranks high as 3", () => {
    expect(confidenceRank("high")).toBe(3);
  });

  it("ranks medium as 2", () => {
    expect(confidenceRank("medium")).toBe(2);
  });

  it("ranks low as 1", () => {
    expect(confidenceRank("low")).toBe(1);
  });
});
