import { sql } from "drizzle-orm";
import { getDb } from "./connection.js";
import { isRemoteMode } from "../lib/mode.js";
import { logger } from "@releases/lib/logger";
import type { SearchOrgHit, SearchProductHit, SearchSourceHit, SearchReleaseHit, RawSourceHit, MediaItem } from "../api/types.js";
import { foldSourcesIntoProducts } from "../api/types.js";
import { hydrateMediaUrls, resolveR2Url } from "../lib/media-url.js";

export interface FtsResult {
  id: string;
  sourceId: string;
  title: string;
  content: string;
  contentSummary: string | null;
  type: "feature" | "rollup";
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
        r.source_id as sourceId,
        r.title,
        r.content,
        r.content_summary as contentSummary,
        r.type,
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

interface RawLocalReleaseRow {
  id: string;
  sourceSlug: string;
  sourceName: string;
  sourceType: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  content: string;
  media: string | null;
  publishedAt: string | null;
}

function hydrateLocalRelease(row: RawLocalReleaseRow): SearchReleaseHit {
  const mediaOrigin = process.env.MEDIA_ORIGIN ?? "";
  type RawMediaRow = MediaItem & { r2Key?: string | null };
  let media: MediaItem[] = [];
  try {
    const parsed = JSON.parse(row.media ?? "[]");
    if (Array.isArray(parsed)) {
      media = parsed.map((m: RawMediaRow) => ({
        ...m,
        r2Url: resolveR2Url(m.r2Key, mediaOrigin),
      }));
    }
  } catch { /* malformed row — leave media empty */ }
  return {
    id: row.id,
    sourceSlug: row.sourceSlug,
    sourceName: row.sourceName,
    sourceType: row.sourceType,
    orgSlug: row.orgSlug,
    version: row.version,
    title: row.title,
    summary: row.summary,
    content: hydrateMediaUrls(row.content, mediaOrigin),
    media,
    publishedAt: row.publishedAt,
  };
}

export function unifiedSearchLocal(query: string, limit: number, offset: number): UnifiedSearchLocalResult {
  if (isRemoteMode()) {
    throw new Error("unifiedSearchLocal() is not available in remote mode");
  }
  const db = getDb();
  const pattern = `%${query}%`;

  const orgs = db.all(sql`
    SELECT DISTINCT o.slug, o.name, o.domain, NULL as avatarUrl, o.category
    FROM organizations o
    LEFT JOIN domain_aliases da ON da.org_id = o.id
    WHERE o.name LIKE ${pattern} OR o.slug LIKE ${pattern} OR o.domain LIKE ${pattern}
      OR da.domain LIKE ${pattern}
    ORDER BY o.name LIMIT ${limit}
  `) as SearchOrgHit[];

  const products = db.all(sql`
    SELECT DISTINCT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category
    FROM products p
    LEFT JOIN organizations o ON o.id = p.org_id
    LEFT JOIN domain_aliases da ON da.product_id = p.id
    WHERE p.name LIKE ${pattern} OR p.slug LIKE ${pattern} OR da.domain LIKE ${pattern}
    ORDER BY p.name LIMIT ${limit}
  `) as SearchProductHit[];

  const rawSources = db.all(sql`
    SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName,
           p.slug as productSlug, p.name as productName, p.category as productCategory
    FROM sources s
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (s.name LIKE ${pattern} OR s.slug LIKE ${pattern} OR s.url LIKE ${pattern})
    ORDER BY s.name LIMIT ${limit}
  `) as RawSourceHit[];

  const mergedProducts = foldSourcesIntoProducts(products, rawSources);

  let rawReleases: RawLocalReleaseRow[] = [];
  try {
    rawReleases = db.all(sql`
      SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
             o.slug as orgSlug,
             r.version, r.title,
             COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
             r.content as content,
             r.media as media,
             r.published_at as publishedAt
      FROM releases_fts
      JOIN releases r ON r.rowid = releases_fts.rowid
      JOIN sources s ON s.id = r.source_id
      LEFT JOIN organizations o ON o.id = s.org_id
      WHERE releases_fts MATCH ${query}
        AND (r.suppressed IS NULL OR r.suppressed = 0)
        AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      ORDER BY rank LIMIT ${limit} OFFSET ${offset}
    `) as RawLocalReleaseRow[];
  } catch (err) {
    logger.warn(`FTS search failed: ${err instanceof Error ? err.message : err}`);
  }

  // Cascading enrichment: show recent releases from matched orgs/products
  if (rawReleases.length === 0 && (orgs.length > 0 || mergedProducts.length > 0)) {
    const orgSlugs = orgs.map((o) => o.slug);
    const matchedProductSlugs = mergedProducts.filter((p) => p.kind !== "source").map((p) => p.slug);
    const conditions = [];
    if (orgSlugs.length > 0) conditions.push(sql`o.slug IN (${sql.join(orgSlugs.map((s) => sql`${s}`), sql`, `)})`);
    if (matchedProductSlugs.length > 0) conditions.push(sql`p.slug IN (${sql.join(matchedProductSlugs.map((s) => sql`${s}`), sql`, `)})`);
    if (conditions.length > 0) {
      rawReleases = db.all(sql`
        SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
               o.slug as orgSlug,
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
          AND (${sql.join(conditions, sql` OR `)})
        ORDER BY r.published_at DESC LIMIT ${limit}
      `) as RawLocalReleaseRow[];
    }
  }

  const releases = rawReleases.map(hydrateLocalRelease);
  return { orgs, products: mergedProducts, sources: [], releases };
}
