import { z } from "zod";

/**
 * Per-source row in `GET /v1/sitemap`. `hasChangelog` and `hasHighlights`
 * are `.optional()` for backwards compatibility — older clients ignore the
 * fields, but the current handler always populates them (#875).
 */
export const SitemapSourceSchema = z.object({
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
});
