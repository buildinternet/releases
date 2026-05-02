import { sql } from "drizzle-orm";
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";
import type { D1Db } from "../db.js";
import type {
  SearchOrgHit,
  SearchCatalogHit,
  RawSourceHit,
} from "@buildinternet/releases-api-types";

/**
 * Raw release row returned by the search queries. `content` and `media`
 * still need media-URL hydration + JSON parsing — the route does that so
 * SQL helpers stay thin.
 */
export interface RawSearchReleaseRow {
  id: string;
  sourceSlug: string;
  sourceName: string;
  sourceType: string;
  orgSlug: string | null;
  orgName: string | null;
  version: string | null;
  title: string;
  summary: string;
  /** Raw markdown with media URLs not yet rewritten through MEDIA_ORIGIN. */
  content: string;
  /** JSON-encoded MediaItem[] or null. */
  media: string | null;
  publishedAt: string | null;
}

export async function searchOrgs(
  db: D1Db,
  pattern: string,
  limit: number,
): Promise<SearchOrgHit[]> {
  return db.all<SearchOrgHit>(sql`
    SELECT DISTINCT o.slug, o.name, o.domain, NULL as avatarUrl, o.category
    FROM organizations o
    LEFT JOIN domain_aliases da ON da.org_id = o.id
    WHERE o.name LIKE ${pattern} OR o.slug LIKE ${pattern} OR o.domain LIKE ${pattern}
      OR da.domain LIKE ${pattern}
    ORDER BY o.name LIMIT ${limit}
  `);
}

export async function searchProducts(
  db: D1Db,
  pattern: string,
  limit: number,
): Promise<SearchCatalogHit[]> {
  return db.all<SearchCatalogHit>(sql`
    SELECT DISTINCT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category,
           'product' as kind
    FROM products p
    LEFT JOIN organizations o ON o.id = p.org_id
    LEFT JOIN domain_aliases da ON da.product_id = p.id
    WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern} OR da.domain LIKE ${pattern}
    ORDER BY p.name LIMIT ${limit}
  `);
}

export async function searchSources(
  db: D1Db,
  pattern: string,
  limit: number,
): Promise<RawSourceHit[]> {
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

/**
 * Local to this file: raw SQL aliases releases as `r`, so we can't reuse
 * `shared.notCoverageFilterSql` (which references `releases.id` unaliased).
 */
const coverageCondition = (includeCoverage?: boolean) =>
  includeCoverage
    ? sql``
    : sql`AND NOT EXISTS (SELECT 1 FROM release_coverage WHERE release_coverage.coverage_id = r.id)`;

export async function searchReleasesFts(
  db: D1Db,
  query: string,
  limit: number,
  offset: number,
  opts: { includeCoverage?: boolean } = {},
): Promise<RawSearchReleaseRow[]> {
  const ftsQuery = toFtsMatchQuery(query);
  return db.all<RawSearchReleaseRow>(sql`
    SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
           o.slug as orgSlug, o.name as orgName,
           r.version, r.title,
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
           r.content as content,
           r.media as media,
           r.published_at as publishedAt
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    WHERE releases_fts MATCH ${ftsQuery}
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      ${coverageCondition(opts.includeCoverage)}
    ORDER BY rank LIMIT ${limit} OFFSET ${offset}
  `);
}

export async function searchReleasesFromMatchedEntities(
  db: D1Db,
  orgSlugs: string[],
  productSlugs: string[],
  limit: number,
  opts: { includeCoverage?: boolean } = {},
): Promise<RawSearchReleaseRow[]> {
  const conditions = [];
  if (orgSlugs.length > 0)
    conditions.push(
      sql`o.slug IN (${sql.join(
        orgSlugs.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (productSlugs.length > 0)
    conditions.push(
      sql`p.slug IN (${sql.join(
        productSlugs.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (conditions.length === 0) return [];

  return db.all<RawSearchReleaseRow>(sql`
    SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
           o.slug as orgSlug, o.name as orgName,
           r.version, r.title,
           COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
           r.content as content,
           r.media as media,
           r.published_at as publishedAt
    FROM releases r
    JOIN sources s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (r.suppressed IS NULL OR r.suppressed = 0)
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      ${coverageCondition(opts.includeCoverage)}
      AND (${sql.join(conditions, sql` OR `)})
    ORDER BY r.published_at DESC LIMIT ${limit}
  `);
}
