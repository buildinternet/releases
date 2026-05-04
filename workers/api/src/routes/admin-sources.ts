import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb, type D1Db } from "../db.js";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";
import { parseEnumParam } from "../utils.js";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import type { OrgsRollupResponse, OrgsRollupRow } from "@buildinternet/releases-api-types";
import { SOURCE_STALE_DAYS } from "../queries/sources.js";
import type { Env } from "../index.js";

export const adminSourcesRoutes = new Hono<Env>();

function getDb(c: any): D1Db {
  return c.get("db") ?? createDb(c.env.DB);
}

const ROLLUP_FILTERS = ["all", "stale", "dormant"] as const;
type RollupFilter = (typeof ROLLUP_FILTERS)[number];

interface OrgsRollupSqlRow {
  org_slug: string;
  source_count: number;
  stale_count: number;
  most_recent_release: string | null;
  total_filtered: number;
}

interface OrgsRollupMetaRow {
  total_orgs: number;
  dormant_orgs: number;
  any_stale_orgs: number;
}

adminSourcesRoutes.get("/admin/sources/orgs-rollup", async (c) => {
  const db = getDb(c);
  const url = new URL(c.req.url);
  const pagination = parseListPagination(url.searchParams, {
    defaultPageSize: 100,
    maxPageSize: 500,
  });
  const { page, pageSize: limit, offset } = pagination;

  const filter: RollupFilter = parseEnumParam(c.req.query("filter"), ROLLUP_FILTERS, "all");
  const queryText = c.req.query("q") ?? "";
  const cutoff = daysAgoIso(SOURCE_STALE_DAYS);

  const baseCte = sql`
    WITH source_latest AS (
      SELECT
        s.id AS source_id,
        s.org_id,
        MAX(r.published_at) AS latest_date
      FROM sources_visible s
      LEFT JOIN releases_visible r ON r.source_id = s.id
      GROUP BY s.id, s.org_id
    ),
    org_rollup AS (
      SELECT
        COALESCE(o.slug, '—') AS org_slug,
        COUNT(*) AS source_count,
        SUM(CASE WHEN sl.latest_date IS NULL OR sl.latest_date < ${cutoff} THEN 1 ELSE 0 END) AS stale_count,
        MAX(sl.latest_date) AS most_recent_release
      FROM source_latest sl
      LEFT JOIN organizations_active o ON o.id = sl.org_id
      GROUP BY COALESCE(o.slug, '—')
    )
  `;

  const filterPredicate = (() => {
    if (filter === "stale") return sql`stale_count > 0`;
    if (filter === "dormant") return sql`stale_count = source_count`;
    return null;
  })();

  const queryPredicate = queryText
    ? likeContains(sql`lower(org_slug)`, queryText.toLowerCase())
    : null;

  const where = (() => {
    if (filterPredicate && queryPredicate) {
      return sql`WHERE ${filterPredicate} AND ${queryPredicate}`;
    }
    if (filterPredicate) return sql`WHERE ${filterPredicate}`;
    if (queryPredicate) return sql`WHERE ${queryPredicate}`;
    return sql``;
  })();

  // Sort dormant orgs first so "needs attention" rows float up, then by
  // oldest release within each band.
  const rowsPromise = db.all<OrgsRollupSqlRow>(sql`
    ${baseCte}
    SELECT
      org_slug, source_count, stale_count, most_recent_release,
      COUNT(*) OVER () AS total_filtered
    FROM org_rollup
    ${where}
    ORDER BY
      CASE WHEN stale_count = source_count THEN 0 ELSE 1 END,
      most_recent_release IS NULL DESC,
      most_recent_release ASC,
      org_slug ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  // Meta is computed over the unfiltered rollup so the dashboard can render
  // bucket counts for each filter without re-fetching.
  const metaPromise = db.all<OrgsRollupMetaRow>(sql`
    ${baseCte}
    SELECT
      COUNT(*) AS total_orgs,
      SUM(CASE WHEN stale_count = source_count THEN 1 ELSE 0 END) AS dormant_orgs,
      SUM(CASE WHEN stale_count > 0 THEN 1 ELSE 0 END) AS any_stale_orgs
    FROM org_rollup
  `);

  const [rows, [metaRow]] = await Promise.all([rowsPromise, metaPromise]);

  // The window function only emits a count when there's at least one row;
  // when the filter eliminates everything, fall back to 0 (or the unfiltered
  // count if there's no filter).
  const totalItems =
    rows[0]?.total_filtered != null
      ? Number(rows[0].total_filtered)
      : !filterPredicate && !queryPredicate
        ? Number(metaRow?.total_orgs) || 0
        : 0;
  const now = Date.now();

  const items: OrgsRollupRow[] = rows.map((r) => {
    const sourceCount = Number(r.source_count) || 0;
    const staleCount = Number(r.stale_count) || 0;
    const mostRecent = r.most_recent_release;
    const ageDays = mostRecent
      ? Math.max(0, (now - new Date(mostRecent).getTime()) / 86400_000)
      : null;
    return {
      orgSlug: r.org_slug,
      sourceCount,
      staleCount,
      mostRecentRelease: mostRecent,
      mostRecentAgeDays: ageDays,
      allStale: sourceCount > 0 && staleCount === sourceCount,
    };
  });

  const envelope = buildListResponse(items, { page, pageSize: limit, offset }, totalItems);
  const response: OrgsRollupResponse = {
    ...envelope,
    meta: {
      staleDays: SOURCE_STALE_DAYS,
      totalOrgs: Number(metaRow?.total_orgs) || 0,
      dormantOrgs: Number(metaRow?.dormant_orgs) || 0,
      anyStaleOrgs: Number(metaRow?.any_stale_orgs) || 0,
    },
  };
  return c.json(response);
});
