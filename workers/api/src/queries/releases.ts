import { eq, sql } from "drizzle-orm";
import type { ReleaseLatestItem } from "@buildinternet/releases-api-types";
import type { BreakingLevel } from "@buildinternet/releases-core/breaking";
import { releaseWebUrl } from "@buildinternet/releases-core/release-slug";
import { buildFeedCursor, feedCursorSql } from "@releases/core-internal/feed-cursor";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
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
  limit: number;
}

export async function getLatestReleasesAcross(
  d1: D1Database,
  f: LatestReleasesFilter,
): Promise<LatestReleaseRow[]> {
  const releasesTable = f.includeCoverage ? "releases" : "releases_visible";
  const wheres: string[] = [
    "(s.is_hidden = 0 OR s.is_hidden IS NULL)",
    "(o.is_hidden = 0 OR o.is_hidden IS NULL)",
    // Drop releases whose org is soft-deleted. A tombstoned org keeps its row
    // (slug mangled to "<slug>--<id>") and its sources are normally tombstoned
    // alongside it, but the two can diverge — the sweep-tombstones cron flags
    // orgs that still have active children. `sources_active` already sheds
    // tombstoned sources; this guards the org side. On a LEFT-join miss
    // (genuine orphan source, no org row) `o.deleted_at` is NULL, so orphans
    // still pass with a NULL org_slug exactly as before.
    "(o.deleted_at IS NULL)",
    "(r.suppressed IS NULL OR r.suppressed = 0)",
  ];
  // Matches the source-feed, org-feed, and MCP `get_latest_releases` defaults
  // so every read surface returns the same canonical-only shape unless the
  // caller opts in via `?include_prereleases=true`.
  if (!f.includePrereleases) {
    wheres.push("(r.prerelease IS NULL OR r.prerelease = 0)");
  }
  const bindings: (string | number)[] = [];

  if (f.sourceId) {
    wheres.push("s.id = ?");
    bindings.push(f.sourceId);
  } else if (f.orgId) {
    wheres.push("s.org_id = ?");
    bindings.push(f.orgId);
  }

  if (f.excludeSourceTypes && f.excludeSourceTypes.length > 0) {
    const placeholders = f.excludeSourceTypes.map(() => "?").join(", ");
    wheres.push(`s.type NOT IN (${placeholders})`);
    bindings.push(...f.excludeSourceTypes);
  }

  // Time window on published_at — string comparison is correct for the ISO
  // text column, and `>=`/`<=` naturally drop NULL-dated rows.
  if (f.since) {
    wheres.push("r.published_at >= ?");
    bindings.push(f.since);
  }
  if (f.until) {
    wheres.push("r.published_at <= ?");
    bindings.push(f.until);
  }

  const whereSql = wheres.join(" AND ");
  bindings.push(f.limit);

  const stmt = d1
    .prepare(
      `
    SELECT r.id, r.version, r.title, r.summary, r.title_generated, r.title_short, r.breaking, r.type,
           r.published_at, r.url, r.media,
           r.content_chars, r.content_tokens,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug, o.name AS org_name, o.avatar_url AS org_avatar_url,
           (SELECT handle FROM org_accounts
              WHERE org_id = o.id AND platform = 'github'
              ORDER BY created_at, id LIMIT 1) AS org_github_handle,
           p.slug AS product_slug, p.name AS product_name,
           ${COVERAGE_COUNT_EXPR} AS coverage_count
    FROM ${releasesTable} r
    INNER JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE ${whereSql}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ?
  `,
    )
    .bind(...bindings);

  const { results } = await stmt.all<LatestReleaseRow>();
  return results;
}

// `releaseWebBase` (the WEB_BASE_URL → absolute-origin resolver) lives in
// `@buildinternet/releases-core/release-slug` so the API + MCP workers share
// one fallback origin. Re-exported here for the many API callers that import
// it from this module.
export { releaseWebBase } from "@buildinternet/releases-core/release-slug";

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
    },
    product: r.product_slug
      ? { slug: r.product_slug, name: r.product_name ?? r.product_slug }
      : null,
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
  /** Inclusive-exclusive lower bound: only releases with published_at > this ISO string. */
  publishedAfter?: string | null;
  /** Upper bound: only releases with published_at <= this ISO string. */
  publishedBefore?: string | null;
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
    SELECT r.id, r.version, r.title, r.summary, r.title_generated, r.title_short, r.breaking, r.type,
           r.published_at, r.fetched_at, r.url, r.media,
           NULL AS content_chars, NULL AS content_tokens,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug, o.name AS org_name, o.avatar_url AS org_avatar_url,
           NULL AS org_github_handle,
           p.slug AS product_slug, p.name AS product_name,
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
      ${params.publishedAfter ? sql`AND r.published_at > ${params.publishedAfter}` : sql``}
      ${params.publishedBefore ? sql`AND r.published_at <= ${params.publishedBefore}` : sql``}
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
