import { Hono } from "hono";
import { count, gte, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, sources, releases, products, fetchLog } from "@buildinternet/releases-core/schema";
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
    db.select({ n: count() }).from(organizations),
    db.select({ n: count() }).from(sources),
    db.select({ n: count() }).from(releases).where(sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`),
    db.select({ n: count() }).from(products),
    db
      .select({ n: count() })
      .from(releases)
      .where(
        sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) AND ${releases.publishedAt} >= ${cutoff}`,
      ),
    db
      .select({ n: count() })
      .from(sources)
      .where(sql`${sources.lastFetchedAt} IS NULL`),
    db
      .select({ n: count() })
      .from(sources)
      .where(gte(sources.lastFetchedAt, cutoff)),
  ]);

  const staleCount = sourceCount.n - neverFetched.n - recentlyFetched.n;

  // Per-source activity (top sources by recent release count, all visible sources)
  const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;

  const perSource = await db
    .select({
      sourceName: sources.name,
      sourceSlug: sources.slug,
      sourceType: sources.type,
      orgName: organizations.name,
      lastFetchedAt: sources.lastFetchedAt,
      totalReleases: sql<number>`COUNT(CASE WHEN (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) THEN 1 END)`,
      recentReleases: sql<number>`COUNT(CASE WHEN (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) AND ${releases.publishedAt} >= ${cutoff} THEN 1 END)`,
    })
    .from(sources)
    .leftJoin(releases, eq(releases.sourceId, sources.id))
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
    .where(notDisabled)
    .groupBy(sources.id)
    .orderBy(
      desc(sql`COUNT(CASE WHEN (${releases.suppressed} IS NULL OR ${releases.suppressed} = 0) AND ${releases.publishedAt} >= ${cutoff} THEN 1 END)`),
    );

  // Recent fetch activity — join sources + orgs so we can return name/slug/org
  const recentActivity = await db
    .select({
      sourceName: sources.name,
      sourceSlug: sources.slug,
      orgName: organizations.name,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      totalReleases: sql<number>`(SELECT COUNT(*) FROM releases r WHERE r.source_id = ${sources.id} AND (r.suppressed IS NULL OR r.suppressed = 0))`,
      status: fetchLog.status,
      durationMs: fetchLog.durationMs,
      error: fetchLog.error,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
    .leftJoin(organizations, eq(sources.orgId, organizations.id))
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
