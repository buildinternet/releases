import { sql, type SQL } from "drizzle-orm";
import type { D1Db } from "../db.js";

export type SourceListRow = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  org_id: string | null;
  product_id: string | null;
  is_primary: number | null;
  is_hidden: number | null;
  metadata: string | null;
  last_fetched_at: string | null;
  last_polled_at: string | null;
  fetch_priority: string | null;
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

export async function countSourcesForList(
  db: D1Db,
  whereClause?: SQL,
  opts: { includeHidden?: boolean } = {},
): Promise<number> {
  const fromView = opts.includeHidden ? sql`sources_active` : sql`sources_visible`;
  const rows = await db.all<{ total: number }>(sql`
    SELECT COUNT(*) AS total
    FROM ${fromView} sources
    LEFT JOIN organizations_active organizations ON organizations.id = sources.org_id
    LEFT JOIN products_active products ON products.id = sources.product_id
    ${whereClause ? sql`WHERE ${whereClause}` : sql``}
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
  opts?: {
    limit?: number;
    offset?: number;
    sort?: SourceSortField;
    dir?: SortDir;
    includeHidden?: boolean;
  },
): Promise<SourceListRow[]> {
  const limitClause = opts?.limit != null ? sql`LIMIT ${opts.limit}` : sql``;
  const offsetClause = opts?.offset != null && opts.offset > 0 ? sql`OFFSET ${opts.offset}` : sql``;
  const orderBy = sourceOrderBy(opts?.sort ?? "name", opts?.dir ?? "asc");
  const fromView = opts?.includeHidden ? sql`sources_active` : sql`sources_visible`;
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
    ${whereClause ? sql`WHERE ${whereClause}` : sql``}
    ORDER BY ${orderBy}
    ${limitClause} ${offsetClause}
  `);
}

export type SourceReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  content_summary: string | null;
  content: string;
  published_at: string | null;
  url: string | null;
  media: string | null;
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
    SELECT id, version, title, content_summary, content, published_at, url, media
    FROM ${sql.raw(releasesTable)}
    WHERE source_id = ${sourceId}
      AND (suppressed IS NULL OR suppressed = 0)
    ORDER BY
      CASE WHEN published_at IS NOT NULL THEN 0 ELSE 1 END,
      published_at DESC, fetched_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `);
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
