/**
 * Unit-tests the pure product + source entry builder that backs the web
 * sitemap. Mirrors the `bun:test` style of `tests/unit/sitemap.test.ts`, but
 * exercises the #1190 product-first / shadow-routing logic directly off a
 * hand-built `SitemapPayload` (no network / Next.js default export).
 */

import { describe, test, expect } from "bun:test";
import type { SitemapPayload } from "@buildinternet/releases-api-types";
import { buildEntitySitemapEntries } from "@/lib/sitemap-entries";

const BASE = "https://releases.sh";

function urls(payload: SitemapPayload): string[] {
  return buildEntitySitemapEntries(payload, BASE).map((e) => String(e.url));
}

describe("buildEntitySitemapEntries", () => {
  test("product emits a bare /[org]/[slug] URL (no /product/ segment)", () => {
    const payload: SitemapPayload = {
      orgs: [],
      products: [{ orgSlug: "vercel", slug: "turborepo" }],
      sources: [],
      collections: [],
    };

    const result = urls(payload);
    expect(result).toContain(`${BASE}/vercel/turborepo`);
    expect(result.some((u) => u.includes("/product/"))).toBe(false);
  });

  test("shadowed source (slug collides with a product, has id) → exactly one /sources/:id, no sub-tabs", () => {
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

    const sourceUrls = urls(payload).filter(
      (u) => u.startsWith(`${BASE}/sources/`) || u.includes("/vercel/turborepo"),
    );
    // The product owns the bare /vercel/turborepo URL; the shadowed source is
    // routed to /sources/:id and emits nothing else.
    expect(sourceUrls).toContain(`${BASE}/sources/src_abc123`);
    // Exactly one entry for the shadowed source's id.
    expect(sourceUrls.filter((u) => u === `${BASE}/sources/src_abc123`)).toHaveLength(1);
    // No sub-tabs for the shadowed source despite hasChangelog/hasHighlights.
    expect(urls(payload).some((u) => u.endsWith("/sources/src_abc123/changelog"))).toBe(false);
    expect(urls(payload).some((u) => u.endsWith("/sources/src_abc123/highlights"))).toBe(false);
    // And the shadowed source must NOT also claim the bare org/slug URL —
    // that one belongs to the product entry, which appears exactly once.
    expect(urls(payload).filter((u) => u === `${BASE}/vercel/turborepo`)).toHaveLength(1);
  });

  test("non-shadowed source with hasChangelog/hasHighlights → bare URL + both sub-tabs", () => {
    const payload: SitemapPayload = {
      orgs: [],
      products: [{ orgSlug: "orgX", slug: "some-product" }],
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

  test("shadowed source missing an id → degrades to bare URL + sub-tabs (no /sources/undefined)", () => {
    const payload: SitemapPayload = {
      orgs: [],
      products: [{ orgSlug: "vercel", slug: "turborepo" }],
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
