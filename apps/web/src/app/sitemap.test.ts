/**
 * Unit-tests the pure product + source entry builder that backs the web
 * sitemap. Mirrors the `bun:test` style of `apps/api/test/sitemap.test.ts`, but
 * exercises the #1190 product-first / shadow-routing logic directly off a
 * hand-built `SitemapPayload` (no network / Next.js default export).
 */

import { describe, test, expect } from "bun:test";
import type { SitemapPayload } from "@buildinternet/releases-api-types";
import { buildProductSitemapEntries, buildOrgSitemapEntries } from "@/lib/sitemap-entries";
import { renderSitemapXml } from "@/lib/sitemap-xml";

const BASE = "https://releases.sh";

/** An org that clears the index bar (overview + enough releases). */
function indexedOrg(slug: string): SitemapPayload["orgs"][number] {
  return { slug, lastActivity: null, releaseCount: 50, hasOverview: true };
}

function urls(payload: SitemapPayload): string[] {
  return buildProductSitemapEntries(payload, BASE).map((e) => String(e.url));
}

describe("buildProductSitemapEntries", () => {
  test("product in a multi-product org emits a bare /[org]/[slug] URL (no /product/ segment)", () => {
    const payload: SitemapPayload = {
      orgs: [indexedOrg("vercel")],
      products: [
        { orgSlug: "vercel", slug: "turborepo" },
        { orgSlug: "vercel", slug: "next-js" },
      ],
      sources: [],
      collections: [],
    };

    const result = urls(payload);
    expect(result).toContain(`${BASE}/vercel/turborepo`);
    expect(result).toContain(`${BASE}/vercel/next-js`);
    expect(result.some((u) => u.includes("/product/"))).toBe(false);
  });

  test("product in a single-product org is omitted (org page is canonical; the bare URL 308-redirects)", () => {
    // Mirrors the page's `org.products.length <= 1` collapse redirect
    // (apps/web/src/app/[orgSlug]/[slug]/page.tsx): for a single-product org the
    // bare /[org]/[slug] URL permanently redirects to /[org], so listing it
    // would put a redirecting URL in the sitemap. The /[org] entry (emitted
    // by the org-entry builder in sitemap.ts) already covers the content.
    const payload: SitemapPayload = {
      orgs: [indexedOrg("vercel")],
      products: [{ orgSlug: "vercel", slug: "turborepo" }],
      sources: [],
      collections: [],
    };

    const result = urls(payload);
    expect(result).not.toContain(`${BASE}/vercel/turborepo`);
    // The single-product org contributes no product entries at all.
    expect(result).toEqual([]);
  });

  test("source pages are never listed (they are noindex inputs to org/product views)", () => {
    const payload: SitemapPayload = {
      orgs: [indexedOrg("orgX")],
      products: [
        { orgSlug: "orgX", slug: "some-product" },
        { orgSlug: "orgX", slug: "other-product" },
      ],
      sources: [
        {
          id: "src_def456",
          orgSlug: "orgX",
          slug: "sourceY",
          latestDate: null,
          hasChangelog: true,
          hasHighlights: true,
        },
      ],
      collections: [],
    };

    const result = urls(payload);
    expect(result.sort()).toEqual([`${BASE}/orgX/other-product`, `${BASE}/orgX/some-product`]);
    expect(result.some((u) => u.includes("sourceY"))).toBe(false);
  });
});

describe("buildProductSitemapEntries — org index bar", () => {
  const payload = (org: SitemapPayload["orgs"][number]): SitemapPayload => ({
    orgs: [org],
    products: [
      { orgSlug: org.slug, slug: "app" },
      { orgSlug: org.slug, slug: "api" },
    ],
    sources: [{ id: "src_1", orgSlug: org.slug, slug: "app-releases", latestDate: null }],
    collections: [],
  });

  test("an org with an overview and enough releases lists its products", () => {
    expect(urls(payload(indexedOrg("acme"))).sort()).toEqual([
      `${BASE}/acme/api`,
      `${BASE}/acme/app`,
    ]);
  });

  test("an org without an overview lists nothing", () => {
    const org = { slug: "acme", lastActivity: null, releaseCount: 500, hasOverview: false };
    expect(urls(payload(org))).toEqual([]);
  });

  test("an org below the release minimum lists nothing", () => {
    const org = { slug: "acme", lastActivity: null, releaseCount: 9, hasOverview: true };
    expect(urls(payload(org))).toEqual([]);
  });

  test("the release minimum is inclusive", () => {
    const org = { slug: "acme", lastActivity: null, releaseCount: 10, hasOverview: true };
    expect(urls(payload(org))).toHaveLength(2);
  });

  test("a payload without the index fields keeps the org (older API response)", () => {
    expect(urls(payload({ slug: "acme", lastActivity: null }))).toHaveLength(2);
  });
});

describe("buildOrgSitemapEntries", () => {
  test("each indexed org emits bare URL + overview, lastmod only from lastActivity", () => {
    const entries = buildOrgSitemapEntries(
      [{ ...indexedOrg("acme"), lastActivity: "2026-08-01T00:00:00Z" }, indexedOrg("quiet-co")],
      BASE,
    );
    expect(entries.map((e) => String(e.url))).toEqual([
      `${BASE}/acme`,
      `${BASE}/acme/overview`,
      `${BASE}/quiet-co`,
      `${BASE}/quiet-co/overview`,
    ]);
    expect(entries[0]?.lastModified).toEqual(new Date("2026-08-01T00:00:00Z"));
    // No fabricated `now` fallback for orgs without activity.
    expect(entries[2]?.lastModified).toBeUndefined();
  });

  test("orgs below the index bar are omitted; the sources tab is never listed", () => {
    const entries = buildOrgSitemapEntries(
      [
        indexedOrg("acme"),
        { slug: "thin", lastActivity: null, releaseCount: 3, hasOverview: true },
        { slug: "no-overview", lastActivity: null, releaseCount: 300, hasOverview: false },
      ],
      BASE,
    );
    expect(entries.map((e) => String(e.url))).toEqual([`${BASE}/acme`, `${BASE}/acme/overview`]);
  });
});

describe("renderSitemapXml", () => {
  test("serializes entries with optional fields and escapes the loc", () => {
    const xml = renderSitemapXml([
      {
        url: `${BASE}/a&b`,
        lastModified: new Date("2026-08-01T00:00:00Z"),
        changeFrequency: "daily",
        priority: 0.8,
      },
      { url: `${BASE}/plain` },
    ]);
    expect(xml).toContain("<loc>https://releases.sh/a&amp;b</loc>");
    expect(xml).toContain("<lastmod>2026-08-01T00:00:00.000Z</lastmod>");
    expect(xml).toContain("<changefreq>daily</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
    // Optional fields are omitted, not emitted empty.
    const plain = xml.slice(xml.indexOf("<loc>https://releases.sh/plain</loc>"));
    expect(plain).not.toContain("<lastmod>");
    expect(plain).not.toContain("<changefreq>");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});
