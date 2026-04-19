import { eq, min, and, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { releases, sources } from "@releases/core-internal/schema";
import { daysAgoIso } from "@releases/core-internal/dates";

interface ActivityMetrics {
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  /** Earliest release publishedAt — use for trackingSince. */
  oldestPublishedAt: string | null;
}

const ROLLING_WINDOW_DAYS = 90;

export function getSourceMetrics(sourceId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);
  const cutoff90d = daysAgoIso(ROLLING_WINDOW_DAYS);
  const [metrics] = db
    .select({
      oldest: min(releases.publishedAt),
      recent: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 END)`,
      recent90d: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff90d} THEN 1 END)`,
    })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), sql`${releases.publishedAt} IS NOT NULL`))
    .all();
  return {
    releasesLast30Days: metrics.recent,
    avgReleasesPerWeek: computeAvgPerWeek(metrics.recent90d, metrics.oldest),
    oldestPublishedAt: metrics.oldest,
  };
}

export function getOrgMetrics(orgId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);
  const cutoff90d = daysAgoIso(ROLLING_WINDOW_DAYS);
  const orgSources = db
    .select({ id: sources.id })
    .from(sources)
    .where(eq(sources.orgId, orgId))
    .all();
  if (orgSources.length === 0)
    return { releasesLast30Days: 0, avgReleasesPerWeek: 0, oldestPublishedAt: null };
  const sourceIds = orgSources.map((s) => s.id);
  const inClause = sql`${releases.sourceId} IN (${sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  const [metrics] = db
    .select({
      oldest: min(releases.publishedAt),
      recent: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff} THEN 1 END)`,
      recent90d: sql<number>`COUNT(CASE WHEN ${releases.publishedAt} >= ${cutoff90d} THEN 1 END)`,
    })
    .from(releases)
    .where(and(inClause, sql`${releases.publishedAt} IS NOT NULL`))
    .all();
  return {
    releasesLast30Days: metrics.recent,
    avgReleasesPerWeek: computeAvgPerWeek(metrics.recent90d, metrics.oldest),
    oldestPublishedAt: metrics.oldest,
  };
}

/** Avg releases/week over a rolling 90-day window, or the actual span if shorter. */
function computeAvgPerWeek(releasesInWindow: number, oldestPublishedAt: string | null): number {
  if (releasesInWindow === 0 || !oldestPublishedAt) return 0;
  const ageMs = Date.now() - new Date(oldestPublishedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const effectiveDays = Math.min(ROLLING_WINDOW_DAYS, ageDays);
  const weeks = effectiveDays / 7;
  if (weeks < 1) return releasesInWindow;
  return Math.round((releasesInWindow / weeks) * 10) / 10;
}
