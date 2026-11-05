import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { count, gte, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsActive,
  sourcesActive,
  sourcesVisible,
  releasesVisible,
  productsActive,
  fetchLog,
  sourceReleaseStats,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { StatsResponseSchema } from "@buildinternet/releases-api-types";
import { withLatestCache } from "../lib/latest-cache.js";
import type { Env } from "../index.js";

export const statsRoutes = new Hono<Env>();

// Hybrid back-compat + new shape: flat counts (orgs/sources/releases/products)
// stay alongside the richer period + totals + sourceHealth + activity rollups.
statsRoutes.get(
  "/stats",
  describeRoute({
    tags: ["Stats"],
    summary: "Public registry rollup with per-source activity",
    description:
      "Returns a hybrid payload: the flat back-compat `orgs/sources/releases/products` counts (used by the web homepage banner) merged with the richer `StatsSummary` shape — `period`, `totals`, `sourceHealth`, `sourceActivity`, and the 20 most recent fetch-log entries. Counts use `*_active` / `*_visible` views, so soft-deleted and hidden rows are excluded.",
    parameters: [
      {
        name: "days",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, default: 30 },
        description:
          "Lookback window for `releasesInPeriod`, `sourceHealth.stale/upToDate`, and `sourceActivity.recentReleases`. Defaults to 30.",
      },
    ],
    responses: {
      200: {
        description: "Registry rollup",
        content: { "application/json": { schema: resolver(StatsResponseSchema) } },
      },
    },
  }),
  async (c) => {
    // Bad input (negative, zero, NaN) falls back to the documented default of
    // 30 rather than clamping silently to 1 — a typoed query string shouldn't
    // change the lookback window from what an unspecified param would give.
    const parsedDays = parseInt(c.req.query("days") ?? "30", 10);
    const days = Number.isFinite(parsedDays) && parsedDays >= 1 ? parsedDays : 30;

    // The default window is precomputed into KV by the hourly cron, so a burst
    // of cold-cache hits reads KV instead of running nine full-table queries
    // each against D1. Other windows are rare and compute live.
    if (days === STATS_DEFAULT_DAYS) {
      const { data } = await withLatestCache(
        c.env.LATEST_CACHE,
        STATS_ROLLUP_KEY,
        (p) => c.executionCtx.waitUntil(p),
        () => computeStats(c.env.DB, days),
        STATS_ROLLUP_TTL_SECONDS,
      );
      return c.json(data);
    }
    return c.json(await computeStats(c.env.DB, days));
  },
);

/** Default lookback window, and the only one the KV rollup holds. */
export const STATS_DEFAULT_DAYS = 30;

/**
 * KV key for the precomputed default-window rollup. Lives in the LATEST_CACHE
 * namespace under its own prefix. Bump `vN` if the response shape changes.
 */
export const STATS_ROLLUP_KEY = "stats:v1:days=30";

/**
 * Outlives the hourly cron refresh with margin, so the default rollup never
 * expires in prod. Without the cron (staging, local) the first request after
 * expiry recomputes it.
 */
export const STATS_ROLLUP_TTL_SECONDS = 70 * 60;

/**
 * Visible releases published since `cutoff`, per active source. The rollup's
 * only read of `releases`: `releasesInPeriod` and
 * `sourceActivity.recentReleases` are both derived from it, so the window is
 * read once per rollup instead of twice.
 *
 * `GROUP BY +source_id` stops SQLite from walking a source_id-leading index
 * end to end to skip the group-by sort. It range-seeks the covering
 * `idx_releases_published_source` instead, so it reads only the window's index
 * entries plus the coverage probe. The join to `sources_active` runs once per
 * group, not once per release. Exported for the query-plan test.
 */
export function recentReleasesBySourceSql(cutoff: string) {
  return sql`
    SELECT g.source_id, g.n
    FROM (
      SELECT source_id, COUNT(*) AS n
      FROM releases_visible
      WHERE published_at >= ${cutoff}
      GROUP BY +source_id
    ) g
    INNER JOIN sources_active s ON s.id = g.source_id
  `;
}

export async function computeStats(d1: D1Database, days: number) {
  const db = createDb(d1);
  const cutoff = daysAgoIso(days);

  const [
    [orgCount],
    [sourceCount],
    [releaseCount],
    [productCount],
    [neverFetched],
    [recentlyFetched],
    recentBySource,
    visibleSources,
    recentActivity,
  ] = await Promise.all([
    db.select({ n: count() }).from(organizationsActive),
    db.select({ n: count() }).from(sourcesActive),
    // Sums the trigger-maintained per-source rollup (one row per source)
    // instead of counting every visible release.
    db
      .select({ n: sql<number>`COALESCE(SUM(${sourceReleaseStats.releaseCount}), 0)` })
      .from(sourceReleaseStats)
      .innerJoin(sourcesActive, eq(sourceReleaseStats.sourceId, sourcesActive.id)),
    db.select({ n: count() }).from(productsActive),
    db
      .select({ n: count() })
      .from(sourcesActive)
      .where(sql`${sourcesActive.lastFetchedAt} IS NULL`),
    db.select({ n: count() }).from(sourcesActive).where(gte(sourcesActive.lastFetchedAt, cutoff)),
    db.all<{ source_id: string; n: number }>(recentReleasesBySourceSql(cutoff)),

    // Per-source activity: one row per visible source. Recent counts are
    // merged in from `recentBySource` below.
    db
      .select({
        sourceId: sourcesVisible.id,
        sourceName: sourcesVisible.name,
        sourceSlug: sourcesVisible.slug,
        sourceType: sourcesVisible.type,
        orgName: organizationsActive.name,
        lastFetchedAt: sourcesVisible.lastFetchedAt,
        totalReleases: sql<number>`COALESCE(${sourceReleaseStats.releaseCount}, 0)`,
      })
      .from(sourcesVisible)
      .leftJoin(sourceReleaseStats, eq(sourceReleaseStats.sourceId, sourcesVisible.id))
      .leftJoin(organizationsActive, eq(sourcesVisible.orgId, organizationsActive.id)),

    // Recent fetch activity — join sources + orgs so we can return name/slug/org
    db
      .select({
        sourceName: sourcesActive.name,
        sourceSlug: sourcesActive.slug,
        orgName: organizationsActive.name,
        releasesFound: fetchLog.releasesFound,
        releasesInserted: fetchLog.releasesInserted,
        totalReleases: sql<number>`COALESCE(${sourceReleaseStats.releaseCount}, 0)`,
        status: fetchLog.status,
        durationMs: fetchLog.durationMs,
        error: fetchLog.error,
        createdAt: fetchLog.createdAt,
      })
      .from(fetchLog)
      .innerJoin(sourcesActive, eq(fetchLog.sourceId, sourcesActive.id))
      .leftJoin(sourceReleaseStats, eq(sourceReleaseStats.sourceId, sourcesActive.id))
      .leftJoin(organizationsActive, eq(sourcesActive.orgId, organizationsActive.id))
      .orderBy(desc(fetchLog.createdAt))
      .limit(20),
  ]);

  const staleCount = sourceCount.n - neverFetched.n - recentlyFetched.n;

  // `recentBySource` covers every active source, hidden ones included, which
  // is what `releasesInPeriod` counts. `sourceActivity` lists visible sources
  // only, most recent releases first.
  const recentCounts = new Map<string, number>();
  let recentReleaseCount = 0;
  for (const row of recentBySource) {
    const n = Number(row.n);
    recentCounts.set(row.source_id, n);
    recentReleaseCount += n;
  }
  const perSource = visibleSources
    .map(({ sourceId, ...rest }) => ({ ...rest, recentReleases: recentCounts.get(sourceId) ?? 0 }))
    .toSorted((a, b) => b.recentReleases - a.recentReleases);

  return {
    // Legacy flat fields (back-compat)
    orgs: orgCount.n,
    sources: sourceCount.n,
    releases: releaseCount.n,
    products: productCount.n,
    // Full StatsSummary shape
    period: { days, cutoff },
    totals: {
      organizations: orgCount.n,
      sources: sourceCount.n,
      releases: releaseCount.n,
      releasesInPeriod: recentReleaseCount,
    },
    sourceHealth: {
      upToDate: recentlyFetched.n,
      stale: staleCount,
      neverFetched: neverFetched.n,
    },
    sourceActivity: perSource,
    recentActivity,
  };
}

export type StatsPayload = Awaited<ReturnType<typeof computeStats>>;

/**
 * Hourly cron: recompute the default-window rollup and overwrite the KV entry.
 * `compute` is injectable for tests.
 */
export async function refreshStatsRollup(
  env: { DB: D1Database; LATEST_CACHE?: Pick<KVNamespace, "put"> },
  compute: () => Promise<StatsPayload> = () => computeStats(env.DB, STATS_DEFAULT_DAYS),
): Promise<void> {
  if (!env.LATEST_CACHE) return;
  const data = await compute();
  await env.LATEST_CACHE.put(STATS_ROLLUP_KEY, JSON.stringify(data), {
    expirationTtl: STATS_ROLLUP_TTL_SECONDS,
  });
}
