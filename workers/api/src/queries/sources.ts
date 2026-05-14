import { sql, type SQL } from "drizzle-orm";
import type { ReleaseType } from "@buildinternet/releases-api-types";
import { daysAgoIso, nowIso } from "@buildinternet/releases-core/dates";
import { SOURCE_STALE_DAYS } from "@buildinternet/releases-core/sources";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
import type {
  SourceType,
  SourceDiscovery,
  SourceFetchPriority,
} from "@buildinternet/releases-core/source-enums";
import type { D1Db } from "../db.js";

export { SOURCE_STALE_DAYS };

export type SourceListRow = {
  id: string;
  slug: string;
  name: string;
  type: SourceType;
  url: string;
  org_id: string | null;
  product_id: string | null;
  is_primary: number | null;
  is_hidden: number | null;
  discovery: SourceDiscovery | null;
  metadata: string | null;
  last_fetched_at: string | null;
  last_polled_at: string | null;
  fetch_priority: SourceFetchPriority | null;
  change_detected_at: string | null;
  consecutive_no_change: number | null;
  consecutive_errors: number | null;
  next_fetch_after: string | null;
  median_gap_days: number | null;
  last_retiered_at: string | null;
  org_slug: string | null;
  org_name: string | null;
  product_slug: string | null;
  product_name: string | null;
  release_count: number;
  latest_version: string | null;
  latest_date: string | null;
};

// Raw SQL queries alias the view to `sources` so column references like
// `sources.X`, `organizations.X`, `products.X` keep working without changes.
// `includeHidden` selects sources_active (shows hidden rows) vs. the default
// sources_visible (hides them). Both views already filter deleted_at.

export interface SourceListFilterOpts {
  includeHidden?: boolean;
  staleOnly?: boolean;
  /**
   * When true, only include sources that have NO row in `source_changelog_files`.
   * Used by the admin "find candidates for a CHANGELOG.md attach" workflow.
   */
  missingChangelog?: boolean;
  /**
   * When set, only include sources whose 30-day visible release count is at
   * least this value. Used to focus the missing-CHANGELOG list on active
   * sources where attaching a file is worth the effort.
   */
  minReleasesLast30Days?: number;
}

/** AND a list of optional clauses, dropping nulls. Returns null when empty. */
function andWhere(clauses: (SQL | null | undefined)[]): SQL | null {
  const present = clauses.filter((c): c is SQL => c != null);
  if (present.length === 0) return null;
  return present.reduce((acc, cur) => sql`${acc} AND ${cur}`);
}

function changelogActivityJoinAndWhere(opts: SourceListFilterOpts): {
  join: SQL;
  where: SQL | null;
} {
  const needsChangelogJoin = opts.missingChangelog === true;
  const needsActivityJoin = opts.minReleasesLast30Days != null && opts.minReleasesLast30Days > 0;

  const changelogJoin = needsChangelogJoin
    ? sql`LEFT JOIN (SELECT DISTINCT source_id FROM source_changelog_files) scf ON scf.source_id = sources.id`
    : sql``;
  const activityJoin = needsActivityJoin
    ? sql`LEFT JOIN (
        SELECT r.source_id, COUNT(*) AS cnt
        FROM releases_visible r
        WHERE r.published_at IS NOT NULL AND r.published_at >= ${daysAgoIso(30)}
        GROUP BY r.source_id
      ) rcl ON rcl.source_id = sources.id`
    : sql``;

  const where = andWhere([
    needsChangelogJoin ? sql`scf.source_id IS NULL` : null,
    needsActivityJoin ? sql`COALESCE(rcl.cnt, 0) >= ${opts.minReleasesLast30Days!}` : null,
  ]);

  return { join: sql`${changelogJoin} ${activityJoin}`, where };
}

export async function countSourcesForList(
  db: D1Db,
  whereClause?: SQL,
  opts: SourceListFilterOpts = {},
): Promise<number> {
  const fromView = opts.includeHidden ? sql`sources_active` : sql`sources_visible`;
  const staleJoin = opts.staleOnly
    ? sql`LEFT JOIN (SELECT r.source_id, MAX(r.published_at) AS latest_date FROM releases_visible r GROUP BY r.source_id) rs ON rs.source_id = sources.id`
    : sql``;
  const staleWhere = opts.staleOnly
    ? sql`(rs.latest_date IS NULL OR rs.latest_date < ${daysAgoIso(SOURCE_STALE_DAYS)})`
    : null;
  const filterExtras = changelogActivityJoinAndWhere(opts);
  const combinedWhere = andWhere([whereClause, staleWhere, filterExtras.where]);
  const rows = await db.all<{ total: number }>(sql`
    SELECT COUNT(*) AS total
    FROM ${fromView} sources
    LEFT JOIN organizations_active organizations ON organizations.id = sources.org_id
    LEFT JOIN products_active products ON products.id = sources.product_id
    ${staleJoin}
    ${filterExtras.join}
    ${combinedWhere ? sql`WHERE ${combinedWhere}` : sql``}
  `);
  return rows[0]?.total ?? 0;
}

export const SOURCE_SORT_FIELDS = [
  "name",
  "org",
  "type",
  "latest_date",
  "last_fetched_at",
  "fetch_priority",
  "median_gap_days",
] as const;
export type SourceSortField = (typeof SOURCE_SORT_FIELDS)[number];
export type SortDir = "asc" | "desc";

// NULLs float to the bottom regardless of direction so blank values don't
// dominate the page the user is looking at.
function sourceOrderBy(sort: SourceSortField, dir: SortDir): SQL {
  const d = dir === "asc" ? sql`ASC` : sql`DESC`;
  switch (sort) {
    case "name":
      return sql`sources.name ${d}`;
    case "org":
      return sql`organizations.name IS NULL, organizations.name ${d}, sources.name ASC`;
    case "type":
      return sql`sources.type ${d}, sources.name ASC`;
    case "latest_date":
      return sql`rs.latest_date IS NULL, rs.latest_date ${d}, sources.name ASC`;
    case "last_fetched_at":
      return sql`sources.last_fetched_at IS NULL, sources.last_fetched_at ${d}, sources.name ASC`;
    case "fetch_priority":
      return sql`sources.fetch_priority IS NULL, sources.fetch_priority ${d}, sources.name ASC`;
    case "median_gap_days":
      return sql`sources.median_gap_days IS NULL, sources.median_gap_days ${d}, sources.name ASC`;
  }
}

export async function getSourcesWithStats(
  db: D1Db,
  whereClause?: SQL,
  opts?: SourceListFilterOpts & {
    limit?: number;
    offset?: number;
    sort?: SourceSortField;
    dir?: SortDir;
  },
): Promise<SourceListRow[]> {
  const limitClause = opts?.limit != null ? sql`LIMIT ${opts.limit}` : sql``;
  const offsetClause = opts?.offset != null && opts.offset > 0 ? sql`OFFSET ${opts.offset}` : sql``;
  const orderBy = sourceOrderBy(opts?.sort ?? "name", opts?.dir ?? "asc");
  const fromView = opts?.includeHidden ? sql`sources_active` : sql`sources_visible`;
  const staleWhere = opts?.staleOnly
    ? sql`(rs.latest_date IS NULL OR rs.latest_date < ${daysAgoIso(SOURCE_STALE_DAYS)})`
    : null;
  const filterExtras = changelogActivityJoinAndWhere(opts ?? {});
  const combinedWhere = andWhere([whereClause, staleWhere, filterExtras.where]);
  return db.all<SourceListRow>(sql`
    SELECT
      sources.*,
      organizations.slug AS org_slug,
      organizations.name AS org_name,
      products.slug AS product_slug,
      products.name AS product_name,
      COALESCE(rs.release_count, 0) AS release_count,
      rs.latest_version AS latest_version,
      rs.latest_date AS latest_date
    FROM ${fromView} sources
    LEFT JOIN organizations_active organizations ON organizations.id = sources.org_id
    LEFT JOIN products_active products ON products.id = sources.product_id
    LEFT JOIN (
      SELECT
        r.source_id,
        COUNT(*) AS release_count,
        MAX(r.published_at) AS latest_date,
        NULLIF(
          SUBSTR(
            MAX(CASE WHEN r.published_at IS NOT NULL THEN r.published_at || '|' || COALESCE(r.version, '') END),
            INSTR(MAX(CASE WHEN r.published_at IS NOT NULL THEN r.published_at || '|' || COALESCE(r.version, '') END), '|') + 1
          ),
          ''
        ) AS latest_version
      FROM releases_visible r
      GROUP BY r.source_id
    ) rs ON rs.source_id = sources.id
    ${filterExtras.join}
    ${combinedWhere ? sql`WHERE ${combinedWhere}` : sql``}
    ORDER BY ${orderBy}
    ${limitClause} ${offsetClause}
  `);
}

export type SourceReleaseRow = {
  id: string;
  version: string | null;
  type: ReleaseType;
  title: string;
  summary: string | null;
  title_generated: string | null;
  title_short: string | null;
  content: string;
  published_at: string | null;
  // Needed so the source-detail SSR cursor can be built in the
  // `publishedAt|fetchedAt|id` shape that `buildFeedCursor` / `parseFeedCursor`
  // expect — without it the SSR falls back to the legacy 2-part cursor and
  // same-`publishedAt` rows lose tie-break ordering on first "Load more".
  fetched_at: string;
  url: string | null;
  media: string | null;
  coverage_count: number;
};

export async function getSourceReleasesPaginated(
  db: D1Db,
  sourceId: string,
  pageSize: number,
  offset: number,
  opts: { includeCoverage?: boolean } = {},
): Promise<SourceReleaseRow[]> {
  const releasesTable = opts.includeCoverage ? "releases" : "releases_visible";
  return db.all<SourceReleaseRow>(sql`
    SELECT r.id, r.version, r.type, r.title, r.summary, r.title_generated, r.title_short,
           r.content, r.published_at, r.fetched_at, r.url, r.media,
           ${sql.raw(COVERAGE_COUNT_EXPR)} AS coverage_count
    FROM ${sql.raw(releasesTable)} r
    WHERE r.source_id = ${sourceId}
      AND (r.suppressed IS NULL OR r.suppressed = 0)
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC, r.fetched_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `);
}

export type SourceFeedReleaseRow = SourceReleaseRow & {
  fetched_at: string;
  prerelease: 0 | 1;
};

/**
 * Cursor-based source release feed used by the inline filter UI on the source
 * page. Mirrors {@link getOrgReleasesFeed} — same cursor shape, same FTS join
 * pattern — so the two endpoints stay aligned.
 */
export async function getSourceReleasesFeed(
  d1: D1Database,
  sourceId: string,
  cursor: { cursorWhere: string; cursorBindings: string[] },
  limit: number,
  opts: {
    includeCoverage?: boolean;
    includePrereleases?: boolean;
    /** FTS5 MATCH expression — pass through `toFtsMatchQuery` before calling. */
    ftsMatch?: string;
  } = {},
): Promise<SourceFeedReleaseRow[]> {
  const releasesTable = opts.includeCoverage ? "releases" : "releases_visible";
  const filterBindings: string[] = [];
  const prereleaseWhere = opts.includePrereleases
    ? ""
    : "AND (r.prerelease IS NULL OR r.prerelease = 0)";
  let ftsWhere = "";
  if (opts.ftsMatch) {
    // `releases_visible` is a view, so it doesn't expose `rowid` — map FTS
    // rowid → release id through the underlying `releases` table.
    ftsWhere =
      "AND r.id IN (SELECT releases.id FROM releases_fts JOIN releases ON releases.rowid = releases_fts.rowid WHERE releases_fts MATCH ?)";
    filterBindings.push(opts.ftsMatch);
  }

  // See {@link getOrgReleasesFeed} for the future-dated guardrail rationale.
  const cutoff = nowIso();

  const stmt = d1
    .prepare(
      `
    SELECT r.id, r.version, r.type, r.title, r.summary, r.title_generated,
           r.title_short, r.content,
           r.published_at, r.fetched_at, r.url, r.media, r.prerelease,
           ${COVERAGE_COUNT_EXPR} AS coverage_count
    FROM ${releasesTable} r
    WHERE r.source_id = ?
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (r.published_at IS NULL OR r.published_at <= ?)
      ${prereleaseWhere}
      ${ftsWhere}
      ${cursor.cursorWhere}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ?
  `,
    )
    .bind(sourceId, cutoff, ...filterBindings, ...cursor.cursorBindings, limit);

  const { results } = await stmt.all<SourceFeedReleaseRow>();
  return results;
}

export type ActivityBucketRow = {
  week_start: string;
  cnt: number;
  earliest_version: string | null;
  latest_version: string | null;
};

export async function getSourceActivityBuckets(
  db: D1Db,
  sourceId: string,
  from: string,
  toExclusive: string,
): Promise<ActivityBucketRow[]> {
  return db.all<ActivityBucketRow>(sql`
    WITH bucketed AS (
      SELECT
        strftime('%Y-%m-%d', r.published_at, 'weekday 0', '-6 days') AS week_start,
        COUNT(*) AS cnt,
        MIN(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS earliest_tagged,
        MAX(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS latest_tagged
      FROM releases_visible r
      WHERE
        r.source_id = ${sourceId}
        AND r.published_at IS NOT NULL
        AND r.published_at >= ${from}
        AND r.published_at < ${toExclusive}
      GROUP BY week_start
    )
    SELECT week_start, cnt,
      CASE WHEN earliest_tagged IS NOT NULL
        THEN SUBSTR(earliest_tagged, INSTR(earliest_tagged, '|') + 1)
        ELSE NULL END AS earliest_version,
      CASE WHEN latest_tagged IS NOT NULL
        THEN SUBSTR(latest_tagged, INSTR(latest_tagged, '|') + 1)
        ELSE NULL END AS latest_version
    FROM bucketed
    ORDER BY week_start
  `);
}

export type SourceHeatmapRow = {
  date: string;
  cnt: number;
};

export async function getSourceHeatmapData(
  db: D1Db,
  sourceId: string,
  from: string,
  toExclusive: string,
): Promise<{ rows: SourceHeatmapRow[]; total: number }> {
  const rows = await db.all<SourceHeatmapRow>(sql`
    SELECT
      DATE(r.published_at) AS date,
      COUNT(*) AS cnt
    FROM releases_visible r
    WHERE
      r.source_id = ${sourceId}
      AND r.published_at IS NOT NULL
      AND r.published_at >= ${from}
      AND r.published_at < ${toExclusive}
    GROUP BY DATE(r.published_at)
    ORDER BY date
  `);

  const total = rows.reduce((sum, r) => sum + r.cnt, 0);
  return { rows, total };
}
