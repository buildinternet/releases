import { z } from "zod";

/**
 * Per-source row in `GET /v1/sitemap`. `hasChangelog` and `hasHighlights`
 * are `.optional()` for backwards compatibility — older clients ignore the
 * fields, but the current handler always populates them (#875).
 */
export const SitemapSourceSchema = z.object({
  /**
   * Source id. `.optional()` for backwards compatibility — added #1190 so the
   * web can route shadowed sources to `/sources/:id`; older/cached responses
   * may omit it and the web degrades to the bare URL.
   */
  id: z.string().optional(),
  orgSlug: z.string(),
  slug: z.string(),
  latestDate: z.string().nullable(),
  /**
   * Whether this source has a stored GitHub CHANGELOG file. Used by the web
   * sitemap to emit `/{org}/{src}/changelog` URLs only for sources where the
   * route resolves.
   */
  hasChangelog: z.boolean().optional(),
  /**
   * Whether this source has any rolling or monthly highlight summaries.
   * Drives `/{org}/{src}/highlights` sitemap emission.
   */
  hasHighlights: z.boolean().optional(),
});

/**
 * Bulk URL payload consumed by the web sitemap generator. Lists every
 * orgs/sources/products/collections slug paired with the timestamp the web
 * uses to drive `<lastmod>`. Soft-deleted / hidden / on_demand rows are
 * excluded.
 */
export const SitemapPayloadSchema = z.object({
  orgs: z.array(z.object({ slug: z.string(), lastActivity: z.string().nullable() })),
  sources: z.array(SitemapSourceSchema),
  products: z.array(z.object({ orgSlug: z.string(), slug: z.string() })),
  collections: z.array(z.object({ slug: z.string(), updatedAt: z.string() })),
  /**
   * Weekly collection digest permalinks (`/collections/:slug/digest/:week`),
   * with `generatedAt` driving `<lastmod>`. `.optional()` for backwards
   * compatibility with older cached responses. Small at 12 collections × 52
   * weeks/year, so no dedicated `/sitemap/digests` surface (unlike releases).
   */
  digests: z
    .array(
      z.object({
        collectionSlug: z.string(),
        weekStart: z.string(),
        generatedAt: z.string(),
      }),
    )
    .optional(),
});

/**
 * Per-release row previously returned by `GET /v1/sitemap/releases` (#1181,
 * scoped down). Carries what the web needed to build the slugged canonical
 * `/release/...` URL (`releasePath()` inputs) plus `fetchedAt` for `<lastmod>`.
 *
 * @deprecated The endpoint was retired in #2219 — its only consumer
 * (`sitemap-releases.xml`) was removed in #2218 when release pages went
 * `noindex`. Kept for one minor version per the deprecation lane; will be
 * removed in a future minor.
 */
export const SitemapReleaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleShort: z.string().nullable(),
  titleGenerated: z.string().nullable(),
  version: z.string().nullable(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
});

/**
 * Payload previously returned by the curated release sitemap endpoint.
 *
 * @deprecated The endpoint was retired in #2219 — its only consumer
 * (`sitemap-releases.xml`) was removed in #2218 when release pages went
 * `noindex`. Kept for one minor version per the deprecation lane; will be
 * removed in a future minor.
 */
export const SitemapReleasesPayloadSchema = z.object({
  releases: z.array(SitemapReleaseSchema),
});
