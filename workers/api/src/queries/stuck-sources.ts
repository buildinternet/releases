import { sql } from "drizzle-orm";
import type { D1Db } from "../db.js";
import type { StuckSource } from "@buildinternet/releases-api-types";

export interface StuckSourcesOptions {
  /** Recent non-`dry_run` attempts examined per source. Default 5. */
  window?: number;
  /** Minimum attempts in the window required to flag a source. Default 3. */
  minAttempts?: number;
  /** Include sources already set to `fetchPriority = paused`. Default false. */
  includePaused?: boolean;
  /** Page size. Default 100, capped at 500. */
  limit?: number;
  /** Offset for pagination. Default 0. */
  offset?: number;
}

export interface StuckSourcesResult {
  items: StuckSource[];
  totalItems: number;
  /** Resolved knobs, echoed so the route can surface them in `meta`. */
  window: number;
  minAttempts: number;
  includePaused: boolean;
}

interface StuckSourceSqlRow {
  source_id: string;
  source_slug: string;
  name: string;
  type: string;
  url: string;
  kind: string | null;
  org_slug: string | null;
  org_name: string | null;
  fetch_priority: string | null;
  is_primary: number;
  is_hidden: number;
  recent_attempts: number;
  recent_errors: number;
  last_attempt_at: string | null;
  last_error: string | null;
  last_error_category: string | null;
  last_success_at: string | null;
  last_fetched_at: string | null;
  source_created_at: string | null;
  total_items: number;
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  // Callers pass in-range defaults; only a provided value needs clamping.
  if (v == null || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

/**
 * Find sources whose recent fetch history is all errors with no reachability —
 * pause candidates. A source is "stuck" when, within its last `window`
 * non-`dry_run` fetch_log rows, every one is an `error` (zero `success` /
 * `no_change`) and there are at least `minAttempts` of them.
 *
 * Keys off the fetch_log error streak rather than `sources.consecutive_errors`:
 * the scrape/agent fetch path never bumps that column, so a source can fail for
 * days with `consecutive_errors = 0` (Firebase's release-notes did exactly this).
 * `lastSuccessAt` is computed over the source's full history, so a source that
 * succeeded once long ago but has since filled the window with errors is still
 * flagged — with its true last-reachable timestamp.
 */
export async function getStuckSources(
  db: D1Db,
  opts: StuckSourcesOptions = {},
): Promise<StuckSourcesResult> {
  const window = clampInt(opts.window, 5, 1, 50);
  const minAttempts = Math.min(clampInt(opts.minAttempts, 3, 1, 50), window);
  const limit = clampInt(opts.limit, 100, 1, 500);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const includePaused = opts.includePaused ?? false;

  // COALESCE keeps the comparison NULL-safe: fetch_priority is nullable, and a
  // bare `!= 'paused'` evaluates to NULL (not TRUE) for NULL rows, which would
  // wrongly drop a NULL-priority stuck source from the default view.
  const pausedPredicate = includePaused
    ? sql``
    : sql`AND COALESCE(s.fetch_priority, 'normal') != 'paused'`;

  const rows = await db.all<StuckSourceSqlRow>(sql`
    WITH attempts AS (
      SELECT
        fl.source_id,
        fl.status,
        fl.error,
        fl.error_category,
        fl.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY fl.source_id ORDER BY fl.created_at DESC, fl.id DESC
        ) AS rn
      FROM fetch_log fl
      WHERE fl.status != 'dry_run'
    ),
    windowed AS (
      SELECT * FROM attempts WHERE rn <= ${window}
    ),
    agg AS (
      SELECT
        source_id,
        COUNT(*) AS recent_attempts,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS recent_errors,
        SUM(CASE WHEN status IN ('success', 'no_change') THEN 1 ELSE 0 END) AS recent_ok,
        MAX(CASE WHEN rn = 1 THEN created_at END) AS last_attempt_at,
        MAX(CASE WHEN rn = 1 THEN error END) AS last_error,
        MAX(CASE WHEN rn = 1 THEN error_category END) AS last_error_category
      FROM windowed
      GROUP BY source_id
    ),
    last_ok AS (
      SELECT source_id, MAX(created_at) AS last_success_at
      FROM fetch_log
      WHERE status IN ('success', 'no_change')
      GROUP BY source_id
    )
    SELECT
      s.id AS source_id,
      s.slug AS source_slug,
      s.name AS name,
      s.type AS type,
      s.url AS url,
      s.kind AS kind,
      o.slug AS org_slug,
      o.name AS org_name,
      s.fetch_priority AS fetch_priority,
      s.is_primary AS is_primary,
      s.is_hidden AS is_hidden,
      a.recent_attempts AS recent_attempts,
      a.recent_errors AS recent_errors,
      a.last_attempt_at AS last_attempt_at,
      a.last_error AS last_error,
      a.last_error_category AS last_error_category,
      lo.last_success_at AS last_success_at,
      s.last_fetched_at AS last_fetched_at,
      s.created_at AS source_created_at,
      COUNT(*) OVER () AS total_items
    FROM agg a
    JOIN sources s ON s.id = a.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN last_ok lo ON lo.source_id = a.source_id
    WHERE s.deleted_at IS NULL
      AND a.recent_ok = 0
      AND a.recent_attempts >= ${minAttempts}
      ${pausedPredicate}
    ORDER BY
      (lo.last_success_at IS NULL) DESC,
      a.recent_errors DESC,
      lo.last_success_at ASC,
      s.created_at ASC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const items: StuckSource[] = rows.map((r) => ({
    sourceId: r.source_id,
    sourceSlug: r.source_slug,
    name: r.name,
    type: r.type as StuckSource["type"],
    url: r.url,
    kind: r.kind,
    orgSlug: r.org_slug,
    orgName: r.org_name,
    fetchPriority: (r.fetch_priority ?? "normal") as StuckSource["fetchPriority"],
    isPrimary: r.is_primary === 1,
    isHidden: r.is_hidden === 1,
    recentAttempts: Number(r.recent_attempts),
    recentErrors: Number(r.recent_errors),
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    lastErrorCategory: r.last_error_category,
    lastSuccessAt: r.last_success_at,
    lastFetchedAt: r.last_fetched_at,
    sourceCreatedAt: r.source_created_at,
  }));

  const totalItems = rows.length > 0 ? Number(rows[0].total_items) : 0;
  return { items, totalItems, window, minAttempts, includePaused };
}
