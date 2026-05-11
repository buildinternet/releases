import { sql } from "drizzle-orm";
import type { Category } from "@buildinternet/releases-core/categories";
import { feedCursorSql, type AggregateReleaseRow, type FeedQueryRunner } from "./feed-cursor.js";

export type CategoryReleaseRow = AggregateReleaseRow;

/**
 * Aggregated release feed for all orgs/products with a given category.
 *
 * Effective category = `COALESCE(p.category, o.category)`. A product's own
 * category overrides its parent org's, so a multi-product org can distribute
 * its sources across categories — e.g. Vercel (cloud) → Next.js (framework).
 *
 * The predicate is expanded into `(p.category = ? OR (p.category IS NULL AND
 * o.category = ?))` rather than `COALESCE(p.category, o.category) = ?` so each
 * branch references a single indexed column, letting SQLite consider
 * `idx_products_category` / `idx_organizations_category` for sparse-category
 * lookups. `p.category IS NULL` correctly covers both "source has no product"
 * (LEFT JOIN null-pad) and "product row exists with NULL category" — the same
 * two cases COALESCE falls through.
 *
 * `category` is typed as `Category` so callers must narrow via
 * `isValidCategory` (or the `CATEGORIES` literal union) before invoking. The
 * route handler does this at its entry, eliminating the need for a runtime
 * guard here.
 */
export async function getCategoryReleasesFeed(
  db: FeedQueryRunner,
  category: Category,
  cursorParam: string | null,
  limit: number,
  opts: { includePrereleases?: boolean } = {},
): Promise<CategoryReleaseRow[]> {
  const cursor = feedCursorSql(cursorParam);
  const prereleaseWhere = opts.includePrereleases
    ? sql``
    : sql`AND (r.prerelease IS NULL OR r.prerelease = 0)`;

  return db.all<CategoryReleaseRow>(sql`
    SELECT r.id, r.version, r.title, r.content, r.summary,
           r.title_generated, r.title_short, r.type,
           r.published_at, r.fetched_at, r.url, r.media, r.prerelease,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug, o.name AS org_name,
           p.slug AS product_slug, p.name AS product_name
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    INNER JOIN organizations_public o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE (p.category = ${category} OR (p.category IS NULL AND o.category = ${category}))
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${prereleaseWhere}
      ${cursor}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ${limit}
  `);
}
