import { sql } from "drizzle-orm";
import type { SourceType } from "@buildinternet/releases-core/source-enums";
import type { AutoPausedSource } from "@buildinternet/releases-api-types";
import type { D1Db } from "../db.js";

const AUTO_PAUSE_REASONS = ["unproductive_drains", "extraction_errors"] as const;
type AutoPauseReason = (typeof AUTO_PAUSE_REASONS)[number];

/** Cap so the fetch_log lookup stays inside one D1 bind budget. */
const MAX_SOURCES = 100;

export interface AutoPausedSourcesOptions {
  /** How far back `paused_at` is included. Default 7. */
  days?: number;
  /** Clock for the window. Defaults to now. */
  now?: Date;
}

export interface AutoPausedSourcesResult {
  days: number;
  since: string;
  sources: AutoPausedSource[];
  truncated: boolean;
}

interface PausedRow {
  source_id: string;
  source_slug: string;
  name: string;
  type: string;
  url: string;
  org_slug: string | null;
  org_name: string | null;
  fetch_priority: string | null;
  paused_reason: string;
  paused_at: string;
  unproductive_drains: number | null;
  last_releases_found: number | null;
  last_releases_inserted: number | null;
  last_fetch_status: string | null;
  last_fetch_at: string | null;
}

function clampDays(days: number | undefined): number {
  if (days == null || !Number.isFinite(days)) return 7;
  return Math.max(1, Math.min(90, Math.floor(days)));
}

function isAutoReason(value: string): value is AutoPauseReason {
  return (AUTO_PAUSE_REASONS as readonly string[]).includes(value);
}

/**
 * Sources auto-paused within the last `days` days. A Friday digest (or the
 * operator status page) lists these without scanning every source: the row
 * carries `paused_reason` and `paused_at`, and the latest non-dry-run fetch
 * log supplies found/inserted.
 *
 * Manual pauses are excluded. A source un-paused since then is excluded too,
 * because leaving `paused` clears the reason and timestamp.
 */
export async function listAutoPausedSources(
  db: D1Db,
  opts: AutoPausedSourcesOptions = {},
): Promise<AutoPausedSourcesResult> {
  const days = clampDays(opts.days);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = await db.all<PausedRow>(sql`
    WITH paused AS (
      SELECT
        s.id AS source_id,
        s.slug AS source_slug,
        s.name AS name,
        s.type AS type,
        s.url AS url,
        o.slug AS org_slug,
        o.name AS org_name,
        s.fetch_priority AS fetch_priority,
        s.paused_reason AS paused_reason,
        s.paused_at AS paused_at,
        s.unproductive_drains AS unproductive_drains
      FROM sources s
      LEFT JOIN organizations_active o ON o.id = s.org_id
      WHERE s.deleted_at IS NULL
        AND s.fetch_priority = 'paused'
        AND s.paused_reason IN ('unproductive_drains', 'extraction_errors')
        AND s.paused_at >= ${since}
      ORDER BY s.paused_at DESC
      LIMIT ${MAX_SOURCES + 1}
    ),
    latest AS (
      SELECT
        fl.source_id AS source_id,
        fl.releases_found AS releases_found,
        fl.releases_inserted AS releases_inserted,
        fl.status AS status,
        fl.created_at AS created_at,
        ROW_NUMBER() OVER (
          PARTITION BY fl.source_id ORDER BY fl.created_at DESC, fl.id DESC
        ) AS rn
      FROM fetch_log fl
      WHERE fl.status != 'dry_run'
        AND fl.source_id IN (SELECT source_id FROM paused)
    )
    SELECT
      p.source_id AS source_id,
      p.source_slug AS source_slug,
      p.name AS name,
      p.type AS type,
      p.url AS url,
      p.org_slug AS org_slug,
      p.org_name AS org_name,
      p.fetch_priority AS fetch_priority,
      p.paused_reason AS paused_reason,
      p.paused_at AS paused_at,
      p.unproductive_drains AS unproductive_drains,
      l.releases_found AS last_releases_found,
      l.releases_inserted AS last_releases_inserted,
      l.status AS last_fetch_status,
      l.created_at AS last_fetch_at
    FROM paused p
    LEFT JOIN latest l ON l.source_id = p.source_id AND l.rn = 1
    ORDER BY p.paused_at DESC
  `);

  const truncated = rows.length > MAX_SOURCES;
  const page = truncated ? rows.slice(0, MAX_SOURCES) : rows;
  const sources: AutoPausedSource[] = [];
  for (const row of page) {
    if (!isAutoReason(row.paused_reason)) continue;
    sources.push({
      sourceId: row.source_id,
      sourceSlug: row.source_slug,
      name: row.name,
      type: row.type as SourceType,
      url: row.url,
      orgSlug: row.org_slug,
      orgName: row.org_name,
      fetchPriority: "paused",
      pausedReason: row.paused_reason,
      pausedAt: row.paused_at,
      unproductiveDrains: Number(row.unproductive_drains ?? 0),
      lastReleasesFound: row.last_releases_found == null ? null : Number(row.last_releases_found),
      lastReleasesInserted:
        row.last_releases_inserted == null ? null : Number(row.last_releases_inserted),
      lastFetchStatus: row.last_fetch_status,
      lastFetchAt: row.last_fetch_at,
    });
  }

  return { days, since, sources, truncated };
}
