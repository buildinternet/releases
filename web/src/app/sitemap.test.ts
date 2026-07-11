/**
 * Unit-tests the pure product + source entry builder that backs the web
 * sitemap. Mirrors the `bun:test` style of `tests/unit/sitemap.test.ts`, but
 * exercises the #1190 product-first / shadow-routing logic directly off a
 * hand-built `SitemapPayload` (no network / Next.js default export).
 */

import { describe, test, expect } from "bun:test";
import type { SitemapPayload } from "@buildinternet/releases-api-types";
import { buildEntitySitemapEntries, buildUpdatesSitemapEntries } from "@/lib/sitemap-entries";

const BASE = "https://releases.sh";

function urls(payload: SitemapPayload): string[] {
  return buildEntitySitemapEntries(payload, BASE).map((e) => String(e.url));
}

describe("buildEntitySitemapEntries", () => {
  test("product in a multi-product org emits a bare /[org]/[slug] URL (no /product/ segment)", () => {
    const payload: SitemapPayload = {
      orgs: [],
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
    // (web/src/app/[orgSlug]/[slug]/page.tsx): for a single-product org the
    // bare /[org]/[slug] URL permanently redirects to /[org], so listing it
    // would put a redirecting URL in the sitemap. The /[org] entry (emitted
    // by the org-entry builder in sitemap.ts) already covers the content.
    const payload: SitemapPayload = {
      orgs: [],
      products: [{ orgSlug: "vercel", slug: "turborepo" }],
      sources: [],
      collections: [],
    };

    const result = urls(payload);
    expect(result).not.toContain(`${BASE}/vercel/turborepo`);
    // The single-product org contributes no product entries at all.
    expect(result).toEqual([]);
  });

  test("shadowed source in a multi-product org (slug collides, has id) → exactly one /sources/:id, no sub-tabs", () => {
    const payload: SitemapPayload = {
      orgs: [],
      products: [
        { orgSlug: "vercel", slug: "turborepo" },
        { orgSlug: "vercel", slug: "next-js" },
      ],
      sources: [
        {
          id: "src_abc123",
          orgSlug: "vercel",
          slug: "turborepo",
          latestDate: "2026-03-15T00:00:00Z",
          hasChangelog: true,
          hasHighlights: true,
        },
      ],
      collections: [],
    };

    const result = urls(payload);
    // The product owns the bare /vercel/turborepo URL; the shadowed source is
    // routed to /sources/:id and emits nothing else.
    expect(result).toContain(`${BASE}/sources/src_abc123`);
    // Exactly one entry for the shadowed source's id.
    expect(result.filter((u) => u === `${BASE}/sources/src_abc123`)).toHaveLength(1);
    // No sub-tabs for the shadowed source despite hasChangelog/hasHighlights.
    expect(result.some((u) => u.endsWith("/sources/src_abc123/changelog"))).toBe(false);
    expect(result.some((u) => u.endsWith("/sources/src_abc123/highlights"))).toBe(false);
    // The product (multi-product org) still claims the bare org/slug URL exactly once.
    expect(result.filter((u) => u === `${BASE}/vercel/turborepo`)).toHaveLength(1);
  });

  test("shadowed source in a SINGLE-product org → still routed to /sources/:id even though the product entry is filtered", () => {
    // Regression guard for the single-product filter: shadow detection
    // (`productKeys`) must be built from the FULL product set, not the
    // filtered/emitted set. Otherwise filtering the single product would
    // un-shadow its colliding source, which would then wrongly claim the bare
    // /[org]/[slug] URL — the same URL that resolves product-first and
    // 308-redirects at runtime.
    const payload: SitemapPayload = {
      orgs: [],
      products: [{ orgSlug: "vercel", slug: "turborepo" }],
      sources: [
        {
          id: "src_abc123",
          orgSlug: "vercel",
          slug: "turborepo",
          latestDate: "2026-03-15T00:00:00Z",
          hasChangelog: true,
          hasHighlights: true,
        },
      ],
      collections: [],
    };

    const result = urls(payload);
    // Source is still shadowed → /sources/:id (a real, non-redirecting page).
    expect(result).toContain(`${BASE}/sources/src_abc123`);
    // The product entry is filtered AND the source does not fall back to the
    // bare URL, so the redirecting /vercel/turborepo never appears.
    expect(result.some((u) => u === `${BASE}/vercel/turborepo`)).toBe(false);
    // No sub-tabs for the shadowed source.
    expect(result).toEqual([`${BASE}/sources/src_abc123`]);
  });

  test("non-shadowed source with hasChangelog/hasHighlights → bare URL + both sub-tabs", () => {
    const payload: SitemapPayload = {
      orgs: [],
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
    expect(result).toContain(`${BASE}/orgX/sourceY`);
    expect(result).toContain(`${BASE}/orgX/sourceY/highlights`);
    expect(result).toContain(`${BASE}/orgX/sourceY/changelog`);
    // Never routed to /sources/:id since it isn't shadowed.
    expect(result.some((u) => u.startsWith(`${BASE}/sources/`))).toBe(false);
  });

  test("orphan source (no matching product) → bare URL", () => {
    const payload: SitemapPayload = {
      orgs: [],
      products: [],
      sources: [
        {
          id: "src_orphan",
          orgSlug: "solo",
          slug: "only-source",
          latestDate: null,
          hasChangelog: false,
          hasHighlights: false,
        },
      ],
      collections: [],
    };

    const result = urls(payload);
    expect(result).toEqual([`${BASE}/solo/only-source`]);
  });

  test("shadowed source in a multi-product org missing an id → degrades to bare URL + sub-tabs (no /sources/undefined)", () => {
    const payload: SitemapPayload = {
      orgs: [],
      products: [
        { orgSlug: "vercel", slug: "turborepo" },
        { orgSlug: "vercel", slug: "next-js" },
      ],
      sources: [
        {
          // id omitted — simulates a stale/cached payload from an older worker.
          orgSlug: "vercel",
          slug: "turborepo",
          latestDate: null,
          hasChangelog: true,
          hasHighlights: false,
        },
      ],
      collections: [],
    };

    const result = urls(payload);
    // Never emit /sources/undefined.
    expect(result.some((u) => u.includes("/sources/"))).toBe(false);
    // Falls back to the bare URL + the flagged sub-tab. (Two bare /vercel/turborepo
    // entries are fine: one from the product, one from the degraded source.)
    expect(result).toContain(`${BASE}/vercel/turborepo`);
    expect(result).toContain(`${BASE}/vercel/turborepo/changelog`);
    expect(result.some((u) => u.endsWith("/highlights"))).toBe(false);
  });
});

describe("buildUpdatesSitemapEntries", () => {
  test("multiple releases on the same day collapse to one /updates/<date> entry", () => {
    // Regression guard: the naive per-release map used to emit one duplicate
    // /updates/<date> URL per release (~43 duplicates in the live sitemap).
    const entries = buildUpdatesSitemapEntries(
      ["2026-07-01T10:00:00Z", "2026-07-01T14:00:00Z", "2026-07-01T18:00:00Z"],
      BASE,
    );
    expect(entries.map((e) => String(e.url))).toEqual([`${BASE}/updates/2026-07-01`]);
  });

  test("distinct days each get their own entry, still no duplicates", () => {
    const entries = buildUpdatesSitemapEntries(
      ["2026-07-01T10:00:00Z", "2026-07-02T10:00:00Z", "2026-07-01T18:00:00Z"],
      BASE,
    );
    const urls = entries.map((e) => String(e.url));
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.sort()).toEqual([`${BASE}/updates/2026-07-01`, `${BASE}/updates/2026-07-02`]);
  });

  test("null / malformed publishedAt values are dropped, not sitemapped as bogus dates", () => {
    const entries = buildUpdatesSitemapEntries([null, undefined, "", "not-a-date"], BASE);
    expect(entries).toEqual([]);
  });
});

describe("sitemap uniqueness (full-entry-list assertion)", () => {
  test("buildEntitySitemapEntries + buildUpdatesSitemapEntries together never emit a duplicate <loc>", () => {
    // Simulates the same mixed payload the default sitemap() export would
    // assemble (entity entries + updates entries), asserting the combined
    // URL list — the shape the acceptance criteria call out — has no dupes.
    const payload: SitemapPayload = {
      orgs: [],
      products: [{ orgSlug: "acme", slug: "widgets" }],
      sources: [
        {
          id: "src_1",
          orgSlug: "acme",
          slug: "widgets-feed",
          latestDate: "2026-07-01T00:00:00Z",
          hasChangelog: false,
          hasHighlights: false,
        },
      ],
      collections: [],
    };
    const entityUrls = urls(payload);
    const updatesUrls = buildUpdatesSitemapEntries(
      ["2026-07-01T10:00:00Z", "2026-07-01T14:00:00Z"],
      BASE,
    ).map((e) => String(e.url));

    const all = [...entityUrls, ...updatesUrls];
    expect(new Set(all).size).toBe(all.length);
  });
});
