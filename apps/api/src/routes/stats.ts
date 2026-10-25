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

export async function computeStats(d1: D1Database, days: number) {
  const db = createDb(d1);
  const cutoff = daysAgoIso(days);

  const [
    [orgCount],
    [sourceCount],
    [releaseCount],
    [productCount],
    [recentReleaseCount],
    [neverFetched],
    [recentlyFetched],
  ] = await Promise.all([
    db.select({ n: count() }).from(organizationsActive),
    db.select({ n: count() }).from(sourcesActive),
    db
      .select({ n: count() })
      .from(releasesVisible)
      .innerJoin(sourcesActive, eq(releasesVisible.sourceId, sourcesActive.id)),
    db.select({ n: count() }).from(productsActive),
    db
      .select({ n: count() })
      .from(releasesVisible)
      .innerJoin(sourcesActive, eq(releasesVisible.sourceId, sourcesActive.id))
      .where(sql`${releasesVisible.publishedAt} >= ${cutoff}`),
    db
      .select({ n: count() })
      .from(sourcesActive)
      .where(sql`${sourcesActive.lastFetchedAt} IS NULL`),
    db.select({ n: count() }).from(sourcesActive).where(gte(sourcesActive.lastFetchedAt, cutoff)),
  ]);

  const staleCount = sourceCount.n - neverFetched.n - recentlyFetched.n;

  // Per-source activity (top sources by recent release count) and recent fetch
  // activity are independent of each other and of the counts above — run them
  // concurrently rather than back-to-back (#1800 finding 8).
  const [perSource, recentActivity] = await Promise.all([
    db
      .select({
        sourceName: sourcesVisible.name,
        sourceSlug: sourcesVisible.slug,
        sourceType: sourcesVisible.type,
        orgName: organizationsActive.name,
        lastFetchedAt: sourcesVisible.lastFetchedAt,
        totalReleases: sql<number>`COUNT(${releasesVisible.id})`,
        recentReleases: sql<number>`COUNT(CASE WHEN ${releasesVisible.publishedAt} >= ${cutoff} THEN 1 END)`,
      })
      .from(sourcesVisible)
      .leftJoin(releasesVisible, eq(releasesVisible.sourceId, sourcesVisible.id))
      .leftJoin(organizationsActive, eq(sourcesVisible.orgId, organizationsActive.id))
      .groupBy(sourcesVisible.id)
      .orderBy(desc(sql`COUNT(CASE WHEN ${releasesVisible.publishedAt} >= ${cutoff} THEN 1 END)`)),

    // Recent fetch activity — join sources + orgs so we can return name/slug/org
    db
      .select({
        sourceName: sourcesActive.name,
        sourceSlug: sourcesActive.slug,
        orgName: organizationsActive.name,
        releasesFound: fetchLog.releasesFound,
        releasesInserted: fetchLog.releasesInserted,
        totalReleases: sql<number>`(SELECT COUNT(*) FROM releases_visible r WHERE r.source_id = ${sourcesActive.id})`,
        status: fetchLog.status,
        durationMs: fetchLog.durationMs,
        error: fetchLog.error,
        createdAt: fetchLog.createdAt,
      })
      .from(fetchLog)
      .innerJoin(sourcesActive, eq(fetchLog.sourceId, sourcesActive.id))
      .leftJoin(organizationsActive, eq(sourcesActive.orgId, organizationsActive.id))
      .orderBy(desc(fetchLog.createdAt))
      .limit(20),
  ]);

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
      releasesInPeriod: recentReleaseCount.n,
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
