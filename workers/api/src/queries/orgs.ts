import { sql } from "drizzle-orm";
import type { ReleaseType } from "@buildinternet/releases-api-types";
import { nowIso } from "@buildinternet/releases-core/dates";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
import type { D1Db } from "../db.js";
import type { OrgListRow, SourceWithStats } from "./shared.js";

export async function getOrgsWithStats(
  db: D1Db,
  cutoff30d: string,
  q?: string,
  pagination?: { limit: number; offset: number },
  opts: { includeEmpty?: boolean } = {},
): Promise<OrgListRow[]> {
  const where = orgListWhere(q);
  const page = pagination ? sql`LIMIT ${pagination.limit} OFFSET ${pagination.offset}` : sql``;
  // Drop orgs that haven't produced any visible releases yet (#746). Applied
  // post-aggregate via HAVING so the search-term filter still matches the
  // same set of rows whether or not empties are included.
  const having = opts.includeEmpty ? sql`` : sql`HAVING COUNT(r.id) > 0`;

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
    ${having}
    ORDER BY o.name, o.id
    ${page}
  `);
}

/**
 * Visible / empty split for the orgs list (#746). Returns the count the
 * pagination envelope cares about (`totalItems`, scoped to the current
 * `includeEmpty` setting) plus the empty-org count for the toggle-CTA meta,
 * in one round-trip.
 */
export async function countOrgsForList(
  db: D1Db,
  q?: string,
  opts: { includeEmpty?: boolean } = {},
): Promise<{ totalItems: number; emptyOrgCount: number }> {
  const where = orgListWhere(q);
  // Two SUMs over the same per-org aggregate: orgs WITH ≥1 visible release vs
  // orgs WITHOUT. `totalItems` picks whichever bucket(s) match the current
  // filter; `emptyOrgCount` is always the empty bucket so the toggle CTA can
  // label itself even when empties are excluded.
  const [row] = await db.all<{ with_releases: number; without_releases: number }>(sql`
    SELECT
      SUM(CASE WHEN per_org.release_count > 0 THEN 1 ELSE 0 END) AS with_releases,
      SUM(CASE WHEN per_org.release_count = 0 THEN 1 ELSE 0 END) AS without_releases
    FROM (
      SELECT o.id, COUNT(r.id) AS release_count
      FROM organizations_active o
      LEFT JOIN sources_active s ON s.org_id = o.id
      LEFT JOIN releases_visible r ON r.source_id = s.id
      ${where}
      GROUP BY o.id
    ) AS per_org
  `);
  const withReleases = Number(row?.with_releases ?? 0);
  const withoutReleases = Number(row?.without_releases ?? 0);
  return {
    totalItems: opts.includeEmpty ? withReleases + withoutReleases : withReleases,
    emptyOrgCount: withoutReleases,
  };
}

function orgListWhere(q?: string) {
  // Hidden orgs ("don't feature") never appear in the directory listing,
  // regardless of the empty-org toggle. is_hidden is NOT NULL so `= 0` is safe.
  const hidden = sql`o.is_hidden = 0`;
  if (!q) return sql`WHERE ${hidden}`;
  const lower = q.toLowerCase();
  return sql`WHERE ${hidden} AND (${likeContains(sql`lower(o.name)`, lower)} OR ${likeContains(sql`lower(o.slug)`, lower)})`;
}

export async function getOrgSourcesWithStats(db: D1Db, orgId: string): Promise<SourceWithStats[]> {
  // Version-by-X columns pack `sort_key || '|' || COALESCE(version, '')` so
  // MAX() surfaces the version of the latest-sorted row; we then split on '|'
  // and NULLIF back to null. Empty-string version becomes null, which matches
  // the old `ORDER BY ... LIMIT 1` behavior when the top row had no version.
  return db.all<SourceWithStats>(sql`
    SELECT
      s.id, s.slug, s.name, s.type, s.url, s.is_primary, s.is_hidden, s.discovery, s.fetch_priority,
      s.last_fetched_at, s.last_polled_at, s.kind, s.metadata,
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
          MIN(CASE WHEN r.version IS NOT NULL AND (r.prerelease IS NULL OR r.prerelease = 0)
                   THEN r.published_at || '|' || r.version END) AS earliest_tagged,
          MAX(CASE WHEN r.version IS NOT NULL AND (r.prerelease IS NULL OR r.prerelease = 0)
                   THEN r.published_at || '|' || r.version END) AS latest_tagged
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
          AND (prerelease IS NULL OR prerelease = 0)
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
          AND (prerelease IS NULL OR prerelease = 0)
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

/**
 * Same shape as `getOrgActivityData` but scoped to a product's sources via
 * `product_id`. The caller resolves the sourceIds list first and passes it in.
 */
export async function getProductActivityData(
  db: D1Db,
  productId: string,
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
          MIN(CASE WHEN r.version IS NOT NULL AND (r.prerelease IS NULL OR r.prerelease = 0)
                   THEN r.published_at || '|' || r.version END) AS earliest_tagged,
          MAX(CASE WHEN r.version IS NOT NULL AND (r.prerelease IS NULL OR r.prerelease = 0)
                   THEN r.published_at || '|' || r.version END) AS latest_tagged
        FROM releases_visible r
        INNER JOIN sources_active s ON s.id = r.source_id
        WHERE
          s.product_id = ${productId}
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
        s.product_id = ${productId}
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
          AND (prerelease IS NULL OR prerelease = 0)
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
          AND (prerelease IS NULL OR prerelease = 0)
        GROUP BY source_id
      ) earliest ON r.source_id = earliest.source_id AND r.published_at = earliest.min_date
    `),
  ]);

  return { bucketRows, statsRows, latestVersionRows, earliestVersionRows };
}

export async function getProductHeatmapData(
  db: D1Db,
  productId: string,
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
      s.product_id = ${productId}
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
  summary: string | null;
  title_generated: string | null;
  title_short: string | null;
  published_at: string | null;
  fetched_at: string;
  url: string | null;
  media: string | null;
  prerelease: 0 | 1;
  source_slug: string;
  source_name: string;
  source_type: string;
  type: ReleaseType;
  coverage_count: number;
  content_chars: number | null;
  content_tokens: number | null;
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
    /**
     * Filter by resolved entity kind: COALESCE(source.kind, product.kind).
     * Mirrors `resolveSourceKind` from @buildinternet/releases-core/kinds.
     */
    kind?: string;
    /** Restrict to sources under one product (resolved id). */
    productId?: string;
    /**
     * Canonical ISO bounds on `published_at` (resolved from any relative
     * shorthand upstream). `since` keeps rows at or after the bound; `until`
     * at or before. Both drop NULL-`published_at` rows.
     */
    since?: string;
    until?: string;
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
  // COALESCE resolves the source's effective kind: source.kind, falling back to
  // the parent product's kind when source.kind is NULL. Mirrors resolveSourceKind().
  let kindWhere = "";
  if (opts.kind) {
    kindWhere = "AND COALESCE(s.kind, p.kind) = ?";
    filterBindings.push(opts.kind);
  }
  let productWhere = "";
  if (opts.productId) {
    productWhere = "AND s.product_id = ?";
    filterBindings.push(opts.productId);
  }

  // Time window on published_at. `>=`/`<=` on the ISO text column drop
  // NULL-dated rows, which is the intended semantics for a windowed feed.
  let windowWhere = "";
  if (opts.since) {
    windowWhere += " AND r.published_at >= ?";
    filterBindings.push(opts.since);
  }
  if (opts.until) {
    windowWhere += " AND r.published_at <= ?";
    filterBindings.push(opts.until);
  }

  // Drop releases whose upstream-supplied date is in the future. Sources
  // occasionally publish a misdated entry (typo, scheduled-post slip);
  // without this, the row sticks at the top of the feed until the date
  // arrives. NULL published_at is preserved — those legitimately sort last.
  const cutoff = nowIso();

  const stmt = d1
    .prepare(
      `
    SELECT r.id, r.version, r.title, r.content, r.summary,
           r.title_generated, r.title_short, r.type,
           r.published_at, r.fetched_at, r.url, r.media, r.prerelease,
           r.content_chars, r.content_tokens,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           ${COVERAGE_COUNT_EXPR} AS coverage_count
    FROM ${releasesTable} r
    INNER JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE s.org_id = ?
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (r.published_at IS NULL OR r.published_at <= ?)
      ${sourceTypeWhere}
      ${prereleaseWhere}
      ${ftsWhere}
      ${kindWhere}
      ${productWhere}
      ${windowWhere}
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
