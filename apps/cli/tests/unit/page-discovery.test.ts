import { describe, it, expect } from "bun:test";
import {
  parseSitemapLocs,
  extractSameHostLinks,
  filterDetailUrls,
  capCandidates,
  discoverCandidateUrls,
  MAX_CANDIDATES,
} from "../../src/lib/page-discovery.js";

// ── parseSitemapLocs ─────────────────────────────────────────────────────────

describe("parseSitemapLocs", () => {
  it("extracts <loc> URLs and decodes XML entities", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://ex.com/changelog/a</loc></url>
      <url><loc>https://ex.com/changelog/b?x=1&amp;y=2</loc></url>
    </urlset>`;
    const { locs, isIndex } = parseSitemapLocs(xml);
    expect(isIndex).toBe(false);
    expect(locs).toEqual(["https://ex.com/changelog/a", "https://ex.com/changelog/b?x=1&y=2"]);
  });

  it("flags a sitemap-index document", () => {
    const xml = `<sitemapindex xmlns="x"><sitemap><loc>https://ex.com/sm-1.xml</loc></sitemap></sitemapindex>`;
    const { locs, isIndex } = parseSitemapLocs(xml);
    expect(isIndex).toBe(true);
    expect(locs).toEqual(["https://ex.com/sm-1.xml"]);
  });
});

// ── extractSameHostLinks ─────────────────────────────────────────────────────

describe("extractSameHostLinks", () => {
  it("resolves relative hrefs, keeps same-host, drops fragments/mailto, dedupes hashes", () => {
    const html = `
      <a href="/changelog/v1">v1</a>
      <a href="https://ex.com/changelog/v2#top">v2</a>
      <a href="https://ex.com/changelog/v2#bottom">v2 again</a>
      <a href="https://other.com/x">offsite</a>
      <a href="#section">in-page</a>
      <a href="mailto:hi@ex.com">mail</a>`;
    const links = extractSameHostLinks(html, "https://ex.com/changelog");
    expect(links).toContain("https://ex.com/changelog/v1");
    expect(links).toContain("https://ex.com/changelog/v2");
    expect(links.filter((l) => l.includes("/changelog/v2"))).toHaveLength(1);
    expect(links.some((l) => l.includes("other.com"))).toBe(false);
    expect(links.some((l) => l.startsWith("mailto"))).toBe(false);
  });
});

// ── filterDetailUrls ─────────────────────────────────────────────────────────

describe("filterDetailUrls", () => {
  it("keeps strict path-children, excludes the index itself and cross-origin", () => {
    const out = filterDetailUrls("https://ex.com/changelog", [
      "https://ex.com/changelog", // the index itself
      "https://ex.com/changelog/", // index, trailing slash
      "https://ex.com/changelog/post-a",
      "https://ex.com/changelog/post-b",
      "https://ex.com/about", // sibling, not under path
      "https://other.com/changelog/x", // cross-origin
    ]);
    expect(out).toEqual(["https://ex.com/changelog/post-a", "https://ex.com/changelog/post-b"]);
  });

  it("returns nothing for a root source path (defaults to single-page)", () => {
    expect(filterDetailUrls("https://ex.com/", ["https://ex.com/anything"])).toEqual([]);
  });

  it("treats apex and www as the same site (the conductor.build redirect gotcha)", () => {
    // Source stored at the apex; sitemap lists www. URLs (or vice versa).
    expect(
      filterDetailUrls("https://conductor.build/changelog", [
        "https://www.conductor.build/changelog/0.61.0",
        "https://www.conductor.build/changelog/0.60.0",
      ]),
    ).toEqual([
      "https://www.conductor.build/changelog/0.61.0",
      "https://www.conductor.build/changelog/0.60.0",
    ]);
    expect(
      filterDetailUrls("https://www.acme.io/releases", ["https://acme.io/releases/v2"]),
    ).toEqual(["https://acme.io/releases/v2"]);
  });
});

// ── capCandidates ────────────────────────────────────────────────────────────

describe("capCandidates", () => {
  it("classifies index and caps with an explicit skip note (no silent truncation)", () => {
    const many = Array.from({ length: MAX_CANDIDATES + 7 }, (_, i) => `https://ex.com/c/${i}`);
    const r = capCandidates(many, "sitemap", "https://ex.com/c", true);
    expect(r.pageStructure).toBe("index");
    expect(r.candidates).toHaveLength(MAX_CANDIDATES);
    expect(r.totalFound).toBe(MAX_CANDIDATES + 7);
    expect(r.truncated).toBe(true);
    expect(r.note).toContain(`${7} not shown`);
  });

  it("classifies single-page when no children and a fetch succeeded", () => {
    const r = capCandidates([], "source-url", "https://ex.com/changelog", true);
    expect(r.pageStructure).toBe("single-page");
    expect(r.candidates).toEqual(["https://ex.com/changelog"]);
  });

  it("classifies unknown when every fetch failed", () => {
    const r = capCandidates([], "source-url", "https://ex.com/changelog", false);
    expect(r.pageStructure).toBe("unknown");
    expect(r.via).toBe("none");
    expect(r.candidates).toEqual(["https://ex.com/changelog"]);
  });
});

// ── discoverCandidateUrls (routed mock fetch) ────────────────────────────────

function routedFetch(routes: Record<string, { body: string; status?: number }>): typeof fetch {
  return (async (url: string) => {
    const hit = routes[String(url)];
    if (!hit) return new Response("", { status: 404 });
    return new Response(hit.body, { status: hit.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe("discoverCandidateUrls", () => {
  it("uses the robots-surfaced sitemap, filtered to the changelog path", async () => {
    const sitemap = `<urlset>
      <url><loc>https://ex.com/changelog/a</loc></url>
      <url><loc>https://ex.com/changelog/b</loc></url>
      <url><loc>https://ex.com/about</loc></url>
    </urlset>`;
    const r = await discoverCandidateUrls({
      sourceUrl: "https://ex.com/changelog",
      sitemaps: ["https://ex.com/news-sitemap.xml"],
      fetchImpl: routedFetch({ "https://ex.com/news-sitemap.xml": { body: sitemap } }),
    });
    expect(r.pageStructure).toBe("index");
    expect(r.via).toBe("sitemap");
    expect(r.candidates).toEqual(["https://ex.com/changelog/a", "https://ex.com/changelog/b"]);
  });

  it("walks a sitemap-index one level deep", async () => {
    const index = `<sitemapindex><sitemap><loc>https://ex.com/sm-posts.xml</loc></sitemap></sitemapindex>`;
    const child = `<urlset>
      <url><loc>https://ex.com/changelog/x</loc></url>
      <url><loc>https://ex.com/changelog/y</loc></url>
    </urlset>`;
    const r = await discoverCandidateUrls({
      sourceUrl: "https://ex.com/changelog",
      fetchImpl: routedFetch({
        "https://ex.com/sitemap.xml": { body: index },
        "https://ex.com/sm-posts.xml": { body: child },
      }),
    });
    expect(r.candidates).toEqual(["https://ex.com/changelog/x", "https://ex.com/changelog/y"]);
  });

  it("falls back to parsing the index HTML when the sitemap has no usable children", async () => {
    const html = `<html><body>
      <a href="/changelog/post-1">1</a>
      <a href="/changelog/post-2">2</a>
    </body></html>`;
    const r = await discoverCandidateUrls({
      sourceUrl: "https://ex.com/changelog",
      fetchImpl: routedFetch({
        // sitemap.xml 404s; only the source page resolves
        "https://ex.com/changelog": { body: html },
      }),
    });
    expect(r.pageStructure).toBe("index");
    expect(r.via).toBe("index-html");
    expect(r.candidates).toEqual([
      "https://ex.com/changelog/post-1",
      "https://ex.com/changelog/post-2",
    ]);
  });

  it("classifies single-page when the page has no per-release children", async () => {
    const html = `<html><body><h1>Changelog</h1><p>All in one page</p>
      <a href="/about">about</a></body></html>`;
    const r = await discoverCandidateUrls({
      sourceUrl: "https://ex.com/changelog",
      fetchImpl: routedFetch({ "https://ex.com/changelog": { body: html } }),
    });
    expect(r.pageStructure).toBe("single-page");
    expect(r.candidates).toEqual(["https://ex.com/changelog"]);
  });

  it("classifies unknown when sitemap and index page both fail to fetch", async () => {
    const r = await discoverCandidateUrls({
      sourceUrl: "https://ex.com/changelog",
      fetchImpl: routedFetch({}), // everything 404s
    });
    expect(r.pageStructure).toBe("unknown");
    expect(r.candidates).toEqual(["https://ex.com/changelog"]);
  });
});
