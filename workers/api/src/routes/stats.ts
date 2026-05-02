import { Hono } from "hono";
import { count, gte, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsActive,
  sourcesActive,
  sourcesVisible,
  releases,
  productsActive,
  fetchLog,
} from "@buildinternet/releases-core/schema";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import type { Env } from "../index.js";

export const statsRoutes = new Hono<Env>();

// Simple public counts — kept for back-compat (web homepage banner, etc.)
statsRoutes.get("/stats", async (c) => {
  const db = createDb(c.env.DB);
  const days = parseInt(c.req.query("days") ?? "30", 10);
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
      .from(releases)
      .innerJoin(sourcesActive, eq(releases.sourceId, sourcesActive.id))
      .where(sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`),
    db.select({ n: count() }).from(productsActive),
    db
      .select({ n: count() })
      .from(releases)
      .innerJoin(sourcesActive, eq(releases.sourceId, sourcesActive.id))
      .where(
        sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) AND ${releases.publishedAt} >= ${cutoff}`,
      ),
    db
      .select({ n: count() })
      .from(sourcesActive)
      .where(sql`${sourcesActive.lastFetchedAt} IS NULL`),
    db.select({ n: count() }).from(sourcesActive).where(gte(sourcesActive.lastFetchedAt, cutoff)),
  ]);

  const staleCount = sourceCount.n - neverFetched.n - recentlyFetched.n;

  // Per-source activity (top sources by recent release count, all visible sources).
  const perSource = await db
    .select({
      sourceName: sourcesVisible.name,
      sourceSlug: sourcesVisible.slug,
      sourceType: sourcesVisible.type,
      orgName: organizationsActive.name,
      lastFetchedAt: sourcesVisible.lastFetchedAt,
      totalReleases: sql<number>`COUNT(CASE WHEN (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) THEN 1 END)`,
      recentReleases: sql<number>`COUNT(CASE WHEN (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) AND ${releases.publishedAt} >= ${cutoff} THEN 1 END)`,
    })
    .from(sourcesVisible)
    .leftJoin(releases, eq(releases.sourceId, sourcesVisible.id))
    .leftJoin(organizationsActive, eq(sourcesVisible.orgId, organizationsActive.id))
    .groupBy(sourcesVisible.id)
    .orderBy(
      desc(
        sql`COUNT(CASE WHEN (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) AND ${releases.publishedAt} >= ${cutoff} THEN 1 END)`,
      ),
    );

  // Recent fetch activity — join sources + orgs so we can return name/slug/org
  const recentActivity = await db
    .select({
      sourceName: sourcesActive.name,
      sourceSlug: sourcesActive.slug,
      orgName: organizationsActive.name,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      totalReleases: sql<number>`(SELECT COUNT(*) FROM releases r WHERE r.source_id = ${sourcesActive.id} AND (r.suppressed IS NULL OR r.suppressed = 0))`,
      status: fetchLog.status,
      durationMs: fetchLog.durationMs,
      error: fetchLog.error,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .innerJoin(sourcesActive, eq(fetchLog.sourceId, sourcesActive.id))
    .leftJoin(organizationsActive, eq(sourcesActive.orgId, organizationsActive.id))
    .orderBy(desc(fetchLog.createdAt))
    .limit(20);

  return c.json({
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
  });
});
