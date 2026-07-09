/**
 * Shared lexical (FTS5) release search — single production implementation for
 * `/v1/search` and MCP `search` (mode=lexical). Hybrid RRF keeps a separate
 * ID-only MATCH in `hybrid-search-worker.ts` (rehydrate after fusion).
 *
 * Closed MATCH ownership: docs/architecture/storage-portability.md →
 * Lexical search ownership; packages/core/src/fts.ts.
 */

import { sql } from "drizzle-orm";
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";
import { IN_ARRAY_CHUNK_SIZE } from "@buildinternet/releases-core/d1-limits";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
import type { ReleaseType } from "@buildinternet/releases-api-types";
import type { D1Db } from "@releases/lib/db";

/**
 * Raw release row returned by the search queries. `content` (when requested)
 * and `media` still need media-URL hydration + JSON parsing — the API route
 * does that so SQL helpers stay thin. MCP maps a display subset.
 */
export interface RawSearchReleaseRow {
  id: string;
  sourceSlug: string;
  sourceName: string;
  sourceType: string;
  /** Raw source.metadata JSON — parsed into the App Store icon/platform (#1206). */
  sourceMetadata?: string | null;
  orgSlug: string | null;
  orgName: string | null;
  /** Owning product's slug (for product-aware byline links); null for orphan sources. */
  productSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  /**
   * Raw markdown with media URLs not yet rewritten through MEDIA_ORIGIN.
   * Absent unless the caller passed `includeContent: true` — list hits ship
   * summary + media by default to keep the payload small.
   */
  content?: string | null;
  /** JSON-encoded MediaItem[] or null. */
  media: string | null;
  publishedAt: string | null;
  /** Release type — "feature" (default) or "rollup". */
  type: ReleaseType;
  titleGenerated: string | null;
  titleShort: string | null;
  /** Breaking-change level (#1696/#1710). `"unknown"` fail-open default; NULL
   *  only on rows predating the column. Optional because the hybrid (Vectorize)
   *  hit-builder path constructs rows without it. */
  breaking?: string | null;
  /** Number of demoted siblings rolling up via `release_coverage` (0 when standalone). */
  coverageCount: number;
}

/**
 * Optional `orgId` narrows the result set to a single organization.
 * `kind` filters via COALESCE(source.kind, product.kind).
 * `since` / `until` are canonical ISO bounds on `published_at` (both drop
 * NULL published_at). `sourceIds` is a product-scope ceiling — capped at
 * `IN_ARRAY_CHUNK_SIZE`, not chunk-unioned (a product owning more than that
 * many sources is not a served shape).
 * `includeContent` opts into selecting `r.content` (default off).
 */
export type SearchReleasesFtsOpts = {
  orgId?: string;
  includeEmpty?: boolean;
  kind?: string;
  since?: string;
  until?: string;
  sourceIds?: string[];
  includeCoverage?: boolean;
  includeContent?: boolean;
};

/**
 * Build an `IN (...)` value list from a `sourceIds` scope. Callers guard the
 * empty-array case before reaching here (an empty product returns no hits, not
 * `IN ()`).
 *
 * This is a deliberate **product-scope ceiling**, not a silently-lossy bug:
 * the list is *capped* at `IN_ARRAY_CHUNK_SIZE` rather than chunked-and-unioned.
 */
function sourceIdInList(sourceIds: string[]) {
  return sql`(${sql.join(
    sourceIds.slice(0, IN_ARRAY_CHUNK_SIZE).map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

/**
 * Lexical FTS5 search over releases. Joins `sources_active` / `*_active` so
 * soft-deleted orgs/products/sources never surface; always excludes
 * `is_hidden` sources and suppressed releases; coverage siblings excluded
 * unless `includeCoverage`.
 */
export async function searchReleasesFts(
  db: D1Db,
  query: string,
  limit: number,
  offset: number,
  opts: SearchReleasesFtsOpts = {},
): Promise<RawSearchReleaseRow[]> {
  // When sourceIds is an empty array the caller has a product with no sources;
  // short-circuit to avoid an invalid `IN ()` clause and return no hits.
  if (opts.sourceIds && opts.sourceIds.length === 0) return [];
  const sourceIdClause =
    opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND r.source_id IN ${sourceIdInList(opts.sourceIds)}`
      : sql``;
  const ftsQuery = toFtsMatchQuery(query);
  const contentSelect = opts.includeContent ? sql`r.content as content,` : sql``;
  return db.all<RawSearchReleaseRow>(sql`
    SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
           s.metadata as sourceMetadata,
           o.slug as orgSlug, o.name as orgName, p.slug as productSlug,
           r.version, r.title,
           COALESCE(r.summary, SUBSTR(r.content, 1, 150)) as summary,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.breaking as breaking,
           ${contentSelect}
           r.media as media,
           r.published_at as publishedAt,
           r.type as type,
           ${sql.raw(COVERAGE_COUNT_EXPR)} as coverageCount
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE releases_fts MATCH ${ftsQuery}
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${opts.includeCoverage ? sql`` : sql`AND r.id IN (SELECT id FROM releases_visible)`}
      ${opts.orgId ? sql`AND s.org_id = ${opts.orgId}` : sql``}
      ${sourceIdClause}
      ${opts.kind ? sql`AND COALESCE(s.kind, p.kind) = ${opts.kind}` : sql``}
      ${opts.since ? sql`AND r.published_at >= ${opts.since}` : sql``}
      ${opts.until ? sql`AND r.published_at <= ${opts.until}` : sql``}
    ORDER BY rank LIMIT ${limit} OFFSET ${offset}
  `);
}
