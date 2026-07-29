import { sql } from "drizzle-orm";
import type { D1Db } from "../db.js";
import type { ProviderHealthSource } from "@buildinternet/releases-api-types";

/** A source is "overdue" once its last successful check is older than this many days. */
export const PROVIDER_HEALTH_OVERDUE_DAYS = 3;

export interface ProviderHealthOptions {
  /** Overdue threshold in days. Default {@link PROVIDER_HEALTH_OVERDUE_DAYS}. */
  overdueDays?: number;
  /** Page size for the overdue-sources list. Default 100, capped at 500. */
  limit?: number;
  /** Offset for pagination. Default 0. */
  offset?: number;
}

export interface ProviderHealthResult {
  items: ProviderHealthSource[];
  totalItems: number;
  overdueThresholdDays: number;
  totalActiveSources: number;
  overdueSources: number;
  overdueOrgs: number;
  totalOrgs: number;
}

interface ProviderHealthSqlRow {
  source_id: string;
  source_slug: string;
  name: string;
  type: string;
  org_slug: string | null;
  org_name: string | null;
  fetch_priority: string | null;
  is_primary: number;
  last_fetched_at: string | null;
  reference_at: string;
  days_since_fetched: number;
  total_items: number;
}

interface ProviderHealthMetaRow {
  total_active_sources: number;
  overdue_sources: number;
  overdue_orgs: number;
  total_orgs: number;
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (v == null || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

/**
 * Lead indicator for "ingest / the AI provider has stopped working", as
 * distinct from "this org just hasn't shipped in a while". Every active
 * (non-paused, non-deleted) source is compared against
 * `sources.last_fetched_at` — the timestamp a *completed* check writes,
 * including a `recordNoChange` no-change verdict (#2185) — rather than
 * against its latest release date. A source with a fresh `last_fetched_at`
 * and no new release is healthy-but-quiet; a source whose `last_fetched_at`
 * has stopped moving is broken, regardless of how its release history looks.
 * (The one exception: `delegateScrapeToUpdateWorkflow`'s synthetic `no_change`
 * handoff row deliberately leaves `last_fetched_at` alone — it marks a crawl
 * delegated to a managed-agent session, not a finished check; the session's
 * own fetch_log row stamps the column when the real check completes.)
 *
 * `daysSinceFetched` for a never-fetched source is measured from
 * `sources.created_at` (its onboarding time) so a brand-new source isn't
 * immediately flagged as overdue before its first scheduled poll has even had
 * a chance to run.
 *
 * Paused sources are excluded — they're expected to sit still. Hidden sources
 * (e.g. paused mobile-app discovery candidates, #1907) are excluded entirely,
 * matching the public `sources_visible` containment rule used elsewhere —
 * they aren't operator-facing inventory this scan should page anyone about.
 */
export async function getProviderHealth(
  db: D1Db,
  opts: ProviderHealthOptions = {},
): Promise<ProviderHealthResult> {
  const overdueDays = clampInt(opts.overdueDays, PROVIDER_HEALTH_OVERDUE_DAYS, 1, 365);
  const limit = clampInt(opts.limit, 100, 1, 500);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const baseCte = sql`
    WITH active_sources AS (
      SELECT
        s.id AS source_id,
        s.slug AS source_slug,
        s.name AS name,
        s.type AS type,
        o.slug AS org_slug,
        o.name AS org_name,
        s.fetch_priority AS fetch_priority,
        s.is_primary AS is_primary,
        s.last_fetched_at AS last_fetched_at,
        -- Never-fetched sources use their onboarding time as the clock, so a
        -- brand-new source isn't flagged overdue before its first poll runs.
        COALESCE(s.last_fetched_at, s.created_at) AS reference_at,
        CAST((julianday('now') - julianday(COALESCE(s.last_fetched_at, s.created_at))) AS INTEGER)
          AS days_since_fetched
      FROM sources s
      LEFT JOIN organizations_active o ON o.id = s.org_id
      WHERE s.deleted_at IS NULL
        AND s.is_hidden = 0
        AND COALESCE(s.fetch_priority, 'normal') != 'paused'
    )
  `;

  const rowsPromise = db.all<ProviderHealthSqlRow>(sql`
    ${baseCte}
    SELECT
      source_id, source_slug, name, type, org_slug, org_name, fetch_priority,
      is_primary, last_fetched_at, reference_at, days_since_fetched,
      COUNT(*) OVER () AS total_items
    FROM active_sources
    WHERE days_since_fetched > ${overdueDays}
    ORDER BY days_since_fetched DESC, source_id ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const metaPromise = db.all<ProviderHealthMetaRow>(sql`
    ${baseCte}
    SELECT
      COUNT(*) AS total_active_sources,
      SUM(CASE WHEN days_since_fetched > ${overdueDays} THEN 1 ELSE 0 END) AS overdue_sources,
      COUNT(DISTINCT CASE WHEN days_since_fetched > ${overdueDays} THEN org_slug END) AS overdue_orgs,
      COUNT(DISTINCT org_slug) AS total_orgs
    FROM active_sources
  `);

  const [rows, [metaRow]] = await Promise.all([rowsPromise, metaPromise]);

  const items: ProviderHealthSource[] = rows.map((r) => ({
    sourceId: r.source_id,
    sourceSlug: r.source_slug,
    name: r.name,
    type: r.type as ProviderHealthSource["type"],
    orgSlug: r.org_slug,
    orgName: r.org_name,
    fetchPriority: (r.fetch_priority ?? "normal") as ProviderHealthSource["fetchPriority"],
    isPrimary: r.is_primary === 1,
    lastFetchedAt: r.last_fetched_at,
    daysSinceFetched: Number(r.days_since_fetched),
  }));

  const totalItems = rows.length > 0 ? Number(rows[0].total_items) : 0;

  return {
    items,
    totalItems,
    overdueThresholdDays: overdueDays,
    totalActiveSources: Number(metaRow?.total_active_sources) || 0,
    overdueSources: Number(metaRow?.overdue_sources) || 0,
    overdueOrgs: Number(metaRow?.overdue_orgs) || 0,
    totalOrgs: Number(metaRow?.total_orgs) || 0,
  };
}
