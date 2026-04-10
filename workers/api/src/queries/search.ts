import { sql } from "drizzle-orm";
import type { D1Db } from "../db.js";
import type {
  SearchOrgHit,
  SearchProductHit,
  SearchReleaseHit,
  RawSourceHit,
} from "../../../../src/api/types.js";

export async function searchOrgs(db: D1Db, pattern: string, limit: number): Promise<SearchOrgHit[]> {
  return db.all<SearchOrgHit>(sql`
    SELECT DISTINCT o.slug, o.name, o.domain, NULL as avatarUrl, o.category
    FROM organizations o
    LEFT JOIN domain_aliases da ON da.org_id = o.id
    WHERE o.name LIKE ${pattern} OR o.slug LIKE ${pattern} OR o.domain LIKE ${pattern}
      OR da.domain LIKE ${pattern}
    ORDER BY o.name LIMIT ${limit}
  `);
}

export async function searchProducts(db: D1Db, pattern: string, limit: number): Promise<SearchProductHit[]> {
  return db.all<SearchProductHit>(sql`
    SELECT DISTINCT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category
    FROM products p
    LEFT JOIN organizations o ON o.id = p.org_id
    LEFT JOIN domain_aliases da ON da.product_id = p.id
    WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern} OR da.domain LIKE ${pattern}
    ORDER BY p.name LIMIT ${limit}
  `);
}

export async function searchSources(db: D1Db, pattern: string, limit: number): Promise<RawSourceHit[]> {
  return db.all<RawSourceHit>(sql`
    SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName,
           p.slug as productSlug, p.name as productName, p.category as productCategory
    FROM sources s
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (s.name LIKE ${pattern} OR s.slug LIKE ${pattern} OR s.url LIKE ${pattern})
    ORDER BY s.name LIMIT ${limit}
  `);
}

export async function searchReleasesFts(
  db: D1Db,
  query: string,
  limit: number,
  offset: number,
): Promise<SearchReleaseHit[]> {
  return db.all<SearchReleaseHit>(sql`
    SELECT s.slug as sourceSlug, s.name as sourceName, o.slug as orgSlug,
           r.version, r.title,
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
           r.published_at as publishedAt
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE releases_fts MATCH ${query}
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
    ORDER BY rank LIMIT ${limit} OFFSET ${offset}
  `);
}

export async function searchReleasesFromMatchedEntities(
  db: D1Db,
  orgSlugs: string[],
  productSlugs: string[],
  limit: number,
): Promise<SearchReleaseHit[]> {
  const conditions = [];
  if (orgSlugs.length > 0) conditions.push(sql`o.slug IN (${sql.join(orgSlugs.map((s) => sql`${s}`), sql`, `)})`);
  if (productSlugs.length > 0) conditions.push(sql`p.slug IN (${sql.join(productSlugs.map((s) => sql`${s}`), sql`, `)})`);
  if (conditions.length === 0) return [];

  return db.all<SearchReleaseHit>(sql`
    SELECT s.slug as sourceSlug, s.name as sourceName, o.slug as orgSlug,
           r.version, r.title,
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
           r.published_at as publishedAt
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (r.suppressed IS NULL OR r.suppressed = 0)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (${sql.join(conditions, sql` OR `)})
    ORDER BY r.published_at DESC LIMIT ${limit}
  `);
}
