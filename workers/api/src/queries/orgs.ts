import { sql } from "drizzle-orm";
import type { ReleaseType } from "@buildinternet/releases-api-types";
import { nowIso } from "@buildinternet/releases-core/dates";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import type { D1Db } from "../db.js";
import type { OrgListRow, SourceWithStats } from "./shared.js";

export async function getOrgsWithStats(
  db: D1Db,
  cutoff30d: string,
  q?: string,
  pagination?: { limit: number; offset: number },
): Promise<OrgListRow[]> {
  const where = orgListSearchWhere(q);
  const page = pagination ? sql`LIMIT ${pagination.limit} OFFSET ${pagination.offset}` : sql``;

  return db.all<OrgListRow>(sql`
    SELECT
      o.id, o.slug, o.name, o.domain, o.description, o.category, o.avatar_url,
      COUNT(DISTINCT s.id) AS source_count,
      COUNT(r.id) AS release_count,
      MAX(CASE WHEN r.published_at IS NOT NULL THEN r.published_at END) AS last_activity,
      COUNT(CASE WHEN r.published_at >= ${cutoff30d} THEN 1 END) AS recent_release_count,
      (SELECT GROUP_CONCAT(p.name, '||') FROM (SELECT name FROM products_active WHERE org_id = o.id ORDER BY name LIMIT 3) p) AS top_products
    FROM organizations_active o
    LEFT JOIN sources_active s ON s.org_id = o.id
    LEFT JOIN releases_visible r ON r.source_id = s.id
    ${where}
    GROUP BY o.id, o.slug, o.name, o.domain, o.description, o.category, o.avatar_url
    ORDER BY o.name, o.id
    ${page}
  `);
}

export async function countOrgsForList(db: D1Db, q?: string): Promise<number> {
  const where = orgListSearchWhere(q);
  const [row] = await db.all<{ n: number }>(sql`
    SELECT COUNT(*) AS n
    FROM organizations_active o
    ${where}
  `);
  return Number(row?.n ?? 0);
}

function orgListSearchWhere(q?: string) {
  if (!q) return sql``;
  const lower = q.toLowerCase();
  return sql`WHERE (${likeContains(sql`lower(o.name)`, lower)} OR ${likeContains(sql`lower(o.slug)`, lower)})`;
}

export async function getOrgSourcesWithStats(db: D1Db, orgId: string): Promise<SourceWithStats[]> {
  // Version-by-X columns pack `sort_key || '|' || COALESCE(version, '')` so
  // MAX() surfaces the version of the latest-sorted row; we then split on '|'
  // and NULLIF back to null. Empty-string version becomes null, which matches
  // the old `ORDER BY ... LIMIT 1` behavior when the top row had no version.
  return db.all<SourceWithStats>(sql`
    SELECT
      s.id, s.slug, s.name, s.type, s.url, s.is_primary, s.is_hidden, s.discovery, s.fetch_priority,
      s.last_fetched_at, s.last_polled_at,
      p.slug AS product_slug, p.name AS product_name,
      COALESCE(stats.release_count, 0) AS release_count,
      stats.latest_date AS latest_date,
      stats.latest_added_at AS latest_added_at,
      CASE WHEN stats.pack_by_date IS NOT NULL
        THEN NULLIF(SUBSTR(stats.pack_by_date, INSTR(stats.pack_by_date, '|') + 1), '')
      END AS latest_version_by_date,
      CASE WHEN stats.pack_by_fetch IS NOT NULL
        THEN NULLIF(SUBSTR(stats.pack_by_fetch, INSTR(stats.pack_by_fetch, '|') + 1), '')
      END AS latest_version_by_fetch
    FROM sources_active s
    LEFT JOIN products_active p ON p.id = s.product_id
    LEFT JOIN (
      SELECT
        r.source_id,
        COUNT(*) AS release_count,
        MAX(CASE WHEN r.published_at IS NOT NULL THEN r.published_at END) AS latest_date,
        MAX(r.fetched_at) AS latest_added_at,
        MAX(CASE WHEN r.published_at IS NOT NULL THEN r.published_at || '|' || COALESCE(r.version, '') END) AS pack_by_date,
        MAX(CASE WHEN r.fetched_at IS NOT NULL THEN r.fetched_at || '|' || COALESCE(r.version, '') END) AS pack_by_fetch
      FROM releases_visible r
      INNER JOIN sources_active s2 ON s2.id = r.source_id
      WHERE s2.org_id = ${orgId}
      GROUP BY r.source_id
    ) stats ON stats.source_id = s.id
    WHERE s.org_id = ${orgId}
    ORDER BY s.name
  `);
}

export type OrgSparklineRow = {
  org_id: string;
  date: string;
  cnt: number;
};

export async function getOrgSparklines(
  db: D1Db,
  cutoff30d: string,
  orgIds?: string[],
): Promise<OrgSparklineRow[]> {
  if (orgIds && orgIds.length === 0) return [];
  if (!orgIds || orgIds.length <= 90) {
    return getOrgSparklinesChunk(db, cutoff30d, orgIds);
  }

  const chunks: string[][] = [];
  for (let i = 0; i < orgIds.length; i += 90) chunks.push(orgIds.slice(i, i + 90));
  const rows = await Promise.all(
    chunks.map((chunk) => getOrgSparklinesChunk(db, cutoff30d, chunk)),
  );
  return rows.flat();
}

function getOrgSparklinesChunk(
  db: D1Db,
  cutoff30d: string,
  orgIds?: string[],
): Promise<OrgSparklineRow[]> {
  const orgFilter = orgIds ? sql`AND s.org_id IN ${orgIds}` : sql``;
  return db.all<OrgSparklineRow>(sql`
    SELECT
      s.org_id,
      DATE(r.published_at) AS date,
      COUNT(*) AS cnt
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    WHERE
      r.published_at >= ${cutoff30d}
      AND r.published_at IS NOT NULL
      ${orgFilter}
    GROUP BY s.org_id, DATE(r.published_at)
    ORDER BY s.org_id, date
  `);
}

export type OrgActivityBucketRow = {
  source_id: string;
  week_start: string;
  cnt: number;
  earliest_version: string | null;
  latest_version: string | null;
};

export type OrgSourceStatsRow = {
  source_id: string;
  total: number;
  oldest: string | null;
  latest_date: string | null;
};

export type SourceVersionRow = {
  source_id: string;
  version: string | null;
};

export async function getOrgActivityData(
  db: D1Db,
  orgId: string,
  sourceIds: string[],
  from: string,
  toExclusive: string,
): Promise<{
  bucketRows: OrgActivityBucketRow[];
  statsRows: OrgSourceStatsRow[];
  latestVersionRows: SourceVersionRow[];
  earliestVersionRows: SourceVersionRow[];
}> {
  const [bucketRows, statsRows, latestVersionRows, earliestVersionRows] = await Promise.all([
    db.all<OrgActivityBucketRow>(sql`
      WITH bucketed AS (
        SELECT
          s.id AS source_id,
          s.slug AS source_slug,
          strftime('%Y-%m-%d', r.published_at, 'weekday 0', '-6 days') AS week_start,
          COUNT(*) AS cnt,
          MIN(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS earliest_tagged,
          MAX(CASE WHEN r.version IS NOT NULL THEN r.published_at || '|' || r.version END) AS latest_tagged
        FROM releases_visible r
        INNER JOIN sources_active s ON s.id = r.source_id
        WHERE
          s.org_id = ${orgId}
          AND r.published_at IS NOT NULL
          AND r.published_at >= ${from}
          AND r.published_at < ${toExclusive}
        GROUP BY s.id, week_start
      )
      SELECT source_id, week_start, cnt,
        CASE WHEN earliest_tagged IS NOT NULL
          THEN SUBSTR(earliest_tagged, INSTR(earliest_tagged, '|') + 1)
          ELSE NULL END AS earliest_version,
        CASE WHEN latest_tagged IS NOT NULL
          THEN SUBSTR(latest_tagged, INSTR(latest_tagged, '|') + 1)
          ELSE NULL END AS latest_version
      FROM bucketed
      ORDER BY source_slug, week_start
    `),

    db.all<OrgSourceStatsRow>(sql`
      SELECT
        s.id AS source_id,
        COUNT(*) AS total,
        MIN(r.published_at) AS oldest,
        MAX(r.published_at) AS latest_date
      FROM releases_visible r
      INNER JOIN sources_active s ON s.id = r.source_id
      WHERE
        s.org_id = ${orgId}
        AND r.published_at IS NOT NULL
        AND r.published_at >= ${from}
        AND r.published_at < ${toExclusive}
      GROUP BY s.id
    `),

    db.all<SourceVersionRow>(sql`
      SELECT r.source_id, r.version
      FROM releases_visible r
      INNER JOIN (
        SELECT source_id, MAX(published_at) AS max_date
        FROM releases_visible
        WHERE source_id IN ${sourceIds}
          AND published_at IS NOT NULL
          AND published_at >= ${from}
          AND published_at < ${toExclusive}
        GROUP BY source_id
      ) latest ON r.source_id = latest.source_id AND r.published_at = latest.max_date
    `),

    db.all<SourceVersionRow>(sql`
      SELECT r.source_id, r.version
      FROM releases_visible r
      INNER JOIN (
        SELECT source_id, MIN(published_at) AS min_date
        FROM releases_visible
        WHERE source_id IN ${sourceIds}
          AND published_at IS NOT NULL
          AND published_at >= ${from}
          AND published_at < ${toExclusive}
        GROUP BY source_id
      ) earliest ON r.source_id = earliest.source_id AND r.published_at = earliest.min_date
    `),
  ]);

  return { bucketRows, statsRows, latestVersionRows, earliestVersionRows };
}

export type OrgSourceSparklineRow = {
  source_id: string;
  date: string;
  cnt: number;
};

export async function getOrgSourceSparklines(
  db: D1Db,
  orgId: string,
  cutoff30d: string,
): Promise<OrgSourceSparklineRow[]> {
  return db.all<OrgSourceSparklineRow>(sql`
    SELECT
      s.id AS source_id,
      DATE(r.published_at) AS date,
      COUNT(*) AS cnt
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    WHERE
      s.org_id = ${orgId}
      AND r.published_at >= ${cutoff30d}
      AND r.published_at IS NOT NULL
    GROUP BY s.id, DATE(r.published_at)
    ORDER BY s.id, date
  `);
}

export type OrgHeatmapRow = {
  date: string;
  cnt: number;
};

export async function getOrgHeatmapData(
  db: D1Db,
  orgId: string,
  from: string,
  toExclusive: string,
): Promise<{ rows: OrgHeatmapRow[]; total: number }> {
  const rows = await db.all<OrgHeatmapRow>(sql`
    SELECT
      DATE(r.published_at) AS date,
      COUNT(*) AS cnt
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    WHERE
      s.org_id = ${orgId}
      AND r.published_at IS NOT NULL
      AND r.published_at >= ${from}
      AND r.published_at < ${toExclusive}
    GROUP BY DATE(r.published_at)
    ORDER BY date
  `);

  const total = rows.reduce((sum, r) => sum + r.cnt, 0);
  return { rows, total };
}

export type OrgReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  content: string;
  content_summary: string | null;
  published_at: string | null;
  fetched_at: string;
  url: string | null;
  media: string | null;
  prerelease: 0 | 1;
  source_slug: string;
  source_name: string;
  source_type: string;
  type: ReleaseType;
};

/** Uses raw D1 prepare/bind instead of Drizzle because cursor WHERE fragments are dynamic strings. */
export async function getOrgReleasesFeed(
  d1: D1Database,
  orgId: string,
  cursor: { cursorWhere: string; cursorBindings: string[] },
  limit: number,
  opts: {
    includeCoverage?: boolean;
    sourceTypes?: string[];
    includePrereleases?: boolean;
    /** FTS5 MATCH expression — pass through `toFtsMatchQuery` before calling. */
    ftsMatch?: string;
  } = {},
): Promise<OrgReleaseRow[]> {
  const releasesTable = opts.includeCoverage ? "releases" : "releases_visible";
  const filterBindings: string[] = [];
  let sourceTypeWhere = "";
  if (opts.sourceTypes && opts.sourceTypes.length > 0) {
    sourceTypeWhere = `AND s.type IN (${opts.sourceTypes.map(() => "?").join(",")})`;
    filterBindings.push(...opts.sourceTypes);
  }
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

  // Drop releases whose upstream-supplied date is in the future. Sources
  // occasionally publish a misdated entry (typo, scheduled-post slip);
  // without this, the row sticks at the top of the feed until the date
  // arrives. NULL published_at is preserved — those legitimately sort last.
  const cutoff = nowIso();

  const stmt = d1
    .prepare(
      `
    SELECT r.id, r.version, r.title, r.content, r.content_summary, r.type,
           r.published_at, r.fetched_at, r.url, r.media, r.prerelease,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type
    FROM ${releasesTable} r
    INNER JOIN sources_active s ON s.id = r.source_id
    WHERE s.org_id = ?
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (r.published_at IS NULL OR r.published_at <= ?)
      ${sourceTypeWhere}
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
    .bind(orgId, cutoff, ...filterBindings, ...cursor.cursorBindings, limit);

  const { results } = await stmt.all<OrgReleaseRow>();
  return results;
}

// Shared with the MCP worker's `get_collection_releases` tool — see
// @releases/core-internal/collection-feed.
export {
  getCollectionReleasesFeed,
  type CollectionReleaseRow,
} from "@releases/core-internal/collection-feed";
