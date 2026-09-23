import { eq, sql } from "drizzle-orm";
import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";
import type { BreakingLevel } from "@buildinternet/releases-core/breaking";
import { type Kind, isValidKind } from "@buildinternet/releases-core/kinds";
import { releaseWebUrl } from "@buildinternet/releases-core/release-slug";
import { buildFeedCursor, feedCursorSql } from "@releases/core-internal/feed-cursor";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
import { listLatestReleases } from "@releases/queries/releases";
import type { AnyDb } from "../db.js";
import { userFollows } from "../db/schema-follows.js";
import { parseReleaseMedia } from "../utils.js";

export type LatestReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  summary: string | null;
  title_generated: string | null;
  title_short: string | null;
  /** Breaking-change level (#1696/#1710). `"unknown"` is the fail-open default;
   *  NULL only on rows predating the column — mapped to `undefined` (absent) on
   *  the wire, never invented. */
  breaking: string | null;
  /** AI-scored release importance, 1–5. NULL when unscored. */
  importance: number | null;
  published_at: string | null;
  /** Selected for feed cursor encoding; not exposed on the wire. */
  fetched_at?: string;
  url: string | null;
  media: string | null;
  source_slug: string;
  source_name: string;
  source_type: string;
  org_slug: string | null;
  org_name: string | null;
  org_avatar_url: string | null;
  org_github_handle: string | null;
  product_slug: string | null;
  product_name: string | null;
  /** `sources.kind` — SDK/platform/docs classification, NULL when unset. */
  source_kind: string | null;
  /** `products.kind` — fallback classification when the source has no kind. */
  product_kind: string | null;
  type: string;
  coverage_count: number;
  content_chars: number | null;
  content_tokens: number | null;
};

export interface LatestReleasesFilter {
  /** Limit to a single source by id (mutually exclusive with orgId) */
  sourceId?: string;
  /** Limit to an org's sources by id (mutually exclusive with sourceId) */
  orgId?: string;
  /** Include coverage-side rows (hidden by default) */
  includeCoverage?: boolean;
  /** Include prereleases (hidden by default) */
  includePrereleases?: boolean;
  /**
   * Exclude releases whose source.type is in this list. Validated upstream
   * against the canonical `["github","scrape","feed","agent","appstore"]` set; we trust
   * the input here and bind it directly into a NOT IN clause.
   */
  excludeSourceTypes?: string[];
  /**
   * Canonical ISO bounds on `published_at` (resolved from any relative
   * shorthand upstream). `since` keeps rows at or after the bound; `until` at
   * or before. Both drop NULL-`published_at` rows.
   */
  since?: string;
  until?: string;
  /** Only include releases whose `importance` is at least this value (1–5). */
  minImportance?: number;
  limit: number;
}

/**
 * `GET /v1/releases/latest` rows. The query is `listLatestReleases` from
 * `@releases/queries/releases` (shared with MCP `get_latest_releases`); this
 * wrapper keeps the snake_case row shape the REST mappers read.
 */
export async function getLatestReleasesAcross(
  db: AnyDb,
  f: LatestReleasesFilter,
): Promise<LatestReleaseRow[]> {
  const rows = await listLatestReleases(db, {
    sourceIds: f.sourceId ? [f.sourceId] : undefined,
    orgId: f.sourceId ? undefined : f.orgId,
    includeCoverage: f.includeCoverage,
    includePrereleases: f.includePrereleases,
    excludeSourceTypes: f.excludeSourceTypes,
    since: f.since,
    until: f.until,
    minImportance: f.minImportance,
    limit: f.limit,
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    summary: r.summary,
    title_generated: r.titleGenerated,
    title_short: r.titleShort,
    breaking: r.breaking,
    importance: r.importance,
    published_at: r.publishedAt,
    fetched_at: r.fetchedAt,
    url: r.url,
    media: r.media,
    source_slug: r.sourceSlug,
    source_name: r.sourceName,
    source_type: r.sourceType,
    org_slug: r.orgSlug,
    org_name: r.orgName,
    org_avatar_url: r.orgAvatarUrl,
    org_github_handle: r.orgGithubHandle,
    product_slug: r.productSlug,
    product_name: r.productName,
    source_kind: r.sourceKind,
    product_kind: r.productKind,
    type: r.type,
    coverage_count: r.coverageCount,
    content_chars: r.contentChars,
    content_tokens: r.contentTokens,
  }));
}

// `releaseWebBase` (the WEB_BASE_URL → absolute-origin resolver) lives in
// `@buildinternet/releases-core/release-slug` so the API + MCP workers share
// one fallback origin. Re-exported here for the many API callers that import
// it from this module.
export { releaseWebBase } from "@buildinternet/releases-core/release-slug";

// Normalize a free-text `kind` column to the enum. A NULL (unset) or stray/unknown
// value maps to `undefined` — the field is omitted from the wire rather than shipping
// a null or a schema-invalid string, mirroring how `breaking` drops absent (#1710).
const normKind = (raw: string | null): Kind | undefined =>
  raw && isValidKind(raw) ? raw : undefined;

/**
 * Map a raw `LatestReleaseRow` (from D1 or bun:sqlite) to the wire-protocol
 * `ReleaseLatestItem` shape. Extracted so both the `/releases/latest` handler
 * and the personalized feed (`getFollowedReleases`) render identically.
 */
export function mapLatestRowToReleaseItem(
  r: LatestReleaseRow,
  mediaOrigin: string,
  webBase?: string,
): ReleaseLatestItem {
  // Grouping identity the web feed keys SDK/package rollups on (#1234): product
  // when the source is bound to one, else the source itself.
  const groupSlug = r.product_slug ?? r.source_slug;
  const groupName = r.product_name ?? r.source_name;
  return {
    id: r.id,
    version: r.version,
    type: r.type,
    title: r.title,
    summary: r.summary,
    titleGenerated: r.title_generated,
    titleShort: r.title_short,
    // NULL (pre-column row) → field absent on the wire; never invent a value (#1710).
    breaking: (r.breaking as BreakingLevel | null) ?? undefined,
    importance: r.importance,
    publishedAt: r.published_at,
    url: r.url,
    webUrl: webBase
      ? releaseWebUrl(webBase, {
          id: r.id,
          titleShort: r.title_short,
          titleGenerated: r.title_generated,
          title: r.title,
          version: r.version,
        })
      : undefined,
    media: parseReleaseMedia(r.media, mediaOrigin),
    source: {
      slug: r.source_slug,
      name: r.source_name,
      type: r.source_type,
      orgSlug: r.org_slug,
      orgName: r.org_name,
      orgAvatarUrl: r.org_avatar_url,
      orgGithubHandle: r.org_github_handle,
      kind: normKind(r.source_kind),
    },
    product: r.product_slug
      ? {
          slug: r.product_slug,
          name: r.product_name ?? r.product_slug,
          kind: normKind(r.product_kind),
        }
      : null,
    groupSlug,
    groupName,
    coverageCount: r.coverage_count,
    contentChars: r.content_chars,
    contentTokens: r.content_tokens,
  } as ReleaseLatestItem;
}

/** Encode a followed-feed row into the shared `publishedAt|fetchedAt|id` cursor. */
export function feedCursorFromLatestRow(row: LatestReleaseRow): string {
  return buildFeedCursor({
    published_at: row.published_at,
    fetched_at: row.fetched_at ?? row.published_at ?? "",
    id: row.id,
  });
}

export interface FollowedReleasesParams {
  limit: number;
  /** Opaque cursor from a previous page's `pagination.nextCursor`. */
  cursor?: string | null;
  /**
   * Exclusive lower bound on INGEST time: only releases with fetched_at > this.
   * Digest delivery windows on ingest, not publish, so a post we saw late is still
   * delivered once. `fetched_at` is NOT NULL and never rewritten by either release
   * upsert, so it is a stable first-seen watermark.
   */
  fetchedAfter?: string | null;
  /** Inclusive upper bound on ingest time: only releases with fetched_at <= this ISO string. */
  fetchedBefore?: string | null;
  /**
   * Guard rail, not a window: drop rows published long before the window opened, so
   * a history backfill (old posts, fresh fetched_at) can't flood one digest. Rows
   * with no publish date are kept — undated is not evidence of age.
   */
  publishedFloor?: string | null;
}

/**
 * Releases from everything a user follows, newest first. "Follow an org =
 * everything" is encoded by matching `s.org_id` against org follows or
 * `s.product_id` against product follows. The follow list is resolved once per
 * subquery (materialized IN-list) instead of correlated EXISTS per release row.
 * Visibility filters mirror `getLatestReleasesAcross`.
 *
 * The SELECT omits feed-unused columns (coverage count, github handle, content
 * metrics) so the following surface avoids per-row correlated subqueries.
 *
 * Rows are SELECTED on `fetched_at` (the digest's delivery window) but ORDERED by
 * `published_at` — a post is delivered exactly once, on the run after we ingested
 * it, yet still reads newest-first by its own publish date.
 */
export async function getFollowedReleases(
  db: AnyDb,
  userId: string,
  params: FollowedReleasesParams,
): Promise<LatestReleaseRow[]> {
  const hasFollows = await db
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(eq(userFollows.userId, userId))
    .limit(1)
    .get();
  if (!hasFollows) return [];

  return db.all<LatestReleaseRow>(sql`
    SELECT r.id, r.version, r.title, r.summary, r.title_generated, r.title_short, r.breaking,
           r.importance, r.type,
           r.published_at, r.fetched_at, r.url, r.media,
           NULL AS content_chars, NULL AS content_tokens,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug, o.name AS org_name, o.avatar_url AS org_avatar_url,
           NULL AS org_github_handle,
           p.slug AS product_slug, p.name AS product_name,
           s.kind AS source_kind, p.kind AS product_kind,
           0 AS coverage_count
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (o.is_hidden = 0 OR o.is_hidden IS NULL)
      AND (o.deleted_at IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (r.prerelease IS NULL OR r.prerelease = 0)
      ${params.fetchedAfter ? sql`AND r.fetched_at > ${params.fetchedAfter}` : sql``}
      ${params.fetchedBefore ? sql`AND r.fetched_at <= ${params.fetchedBefore}` : sql``}
      ${params.publishedFloor ? sql`AND (r.published_at IS NULL OR r.published_at > ${params.publishedFloor})` : sql``}
      AND (
        s.org_id IN (SELECT uf.target_id FROM user_follows uf
                     WHERE uf.user_id = ${userId} AND uf.target_type = 'org')
        OR s.product_id IN (SELECT uf.target_id FROM user_follows uf
                           WHERE uf.user_id = ${userId} AND uf.target_type = 'product')
      )
      ${feedCursorSql(params.cursor ?? null)}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ${params.limit}
  `);
}
