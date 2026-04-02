import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";
import { isRemoteMode } from "../lib/mode.js";
import { logger } from "../lib/logger.js";
import type { SearchOrgHit, SearchProductHit, SearchSourceHit, SearchReleaseHit } from "../api/types.js";

export interface FtsResult {
  id: string;
  title: string;
  content: string;
  contentSummary: string | null;
  rank: number;
}

export function searchReleases(query: string, limit = 20): FtsResult[] {
  if (isRemoteMode()) {
    throw new Error("searchReleases() is not available in remote mode — use searchReleasesRemote() from queries.ts instead");
  }
  const db = getDb();
  try {
    const results = db.all<FtsResult>(sql`
      SELECT
        r.id,
        r.title,
        r.content,
        r.content_summary as contentSummary,
        rank
      FROM releases_fts
      JOIN releases r ON r.rowid = releases_fts.rowid
      WHERE releases_fts MATCH ${query}
        AND (r.suppressed IS NULL OR r.suppressed = 0)
      ORDER BY rank
      LIMIT ${limit}
    `);
    return results;
  } catch (err) {
    logger.warn(`FTS search failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export interface UnifiedSearchLocalResult {
  orgs: SearchOrgHit[];
  products: SearchProductHit[];
  sources: SearchSourceHit[];
  releases: SearchReleaseHit[];
}

export function unifiedSearchLocal(query: string, limit: number, offset: number): UnifiedSearchLocalResult {
  if (isRemoteMode()) {
    throw new Error("unifiedSearchLocal() is not available in remote mode");
  }
  const db = getDb();
  const pattern = `%${query}%`;

  const orgs = db.all(sql`
    SELECT slug, name, domain, NULL as avatarUrl, category
    FROM organizations
    WHERE name LIKE ${pattern} OR slug LIKE ${pattern} OR domain LIKE ${pattern}
    ORDER BY name LIMIT ${limit}
  `) as SearchOrgHit[];

  const products = db.all(sql`
    SELECT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category
    FROM products p LEFT JOIN organizations o ON o.id = p.org_id
    WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern}
    ORDER BY p.name LIMIT ${limit}
  `) as SearchProductHit[];

  const sources = db.all(sql`
    SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName, p.slug as productSlug
    FROM sources s
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (s.name LIKE ${pattern} OR s.slug LIKE ${pattern} OR s.url LIKE ${pattern})
    ORDER BY s.name LIMIT ${limit}
  `) as SearchSourceHit[];

  let releases: SearchReleaseHit[] = [];
  try {
    releases = db.all(sql`
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
    `) as SearchReleaseHit[];
  } catch (err) {
    logger.warn(`FTS search failed: ${err instanceof Error ? err.message : err}`);
  }

  // Cascading enrichment: show recent releases from matched orgs/products
  if (releases.length === 0 && (orgs.length > 0 || products.length > 0)) {
    const orgSlugs = orgs.map((o) => o.slug);
    const productSlugs = products.map((p) => p.slug);
    const conditions = [];
    if (orgSlugs.length > 0) conditions.push(sql`o.slug IN (${sql.join(orgSlugs.map((s) => sql`${s}`), sql`, `)})`);
    if (productSlugs.length > 0) conditions.push(sql`p.slug IN (${sql.join(productSlugs.map((s) => sql`${s}`), sql`, `)})`);
    if (conditions.length > 0) {
      releases = db.all(sql`
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
      `) as SearchReleaseHit[];
    }
  }

  return { orgs, products, sources, releases };
}
