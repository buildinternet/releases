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
  fetch_priority: string | null;
  change_detected_at: string | null;
  org_slug: string | null;
  release_count: number;
  latest_version: string | null;
  latest_date: string | null;
};

export async function getSourcesWithStats(
  db: D1Db,
  whereClause?: SQL,
): Promise<SourceListRow[]> {
  return db.all<SourceListRow>(sql`
    SELECT
      sources.*,
      organizations.slug AS org_slug,
      (SELECT COUNT(*) FROM releases r WHERE r.source_id = sources.id AND (r.suppressed IS NULL OR r.suppressed = 0)) AS release_count,
      (SELECT r2.version FROM releases r2 WHERE r2.source_id = sources.id AND (r2.suppressed IS NULL OR r2.suppressed = 0) AND r2.published_at IS NOT NULL ORDER BY r2.published_at DESC LIMIT 1) AS latest_version,
      (SELECT r3.published_at FROM releases r3 WHERE r3.source_id = sources.id AND (r3.suppressed IS NULL OR r3.suppressed = 0) AND r3.published_at IS NOT NULL ORDER BY r3.published_at DESC LIMIT 1) AS latest_date
    FROM sources
    LEFT JOIN organizations ON organizations.id = sources.org_id
    ${whereClause ? sql`WHERE ${whereClause}` : sql``}
    ORDER BY sources.name
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
): Promise<SourceReleaseRow[]> {
  return db.all<SourceReleaseRow>(sql`
    SELECT id, version, title, content_summary, content, published_at, url, media
    FROM releases WHERE source_id = ${sourceId} AND (suppressed IS NULL OR suppressed = 0)
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
      FROM releases r
      WHERE
        r.source_id = ${sourceId}
        AND r.published_at IS NOT NULL
        AND (r.suppressed IS NULL OR r.suppressed = 0)
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
