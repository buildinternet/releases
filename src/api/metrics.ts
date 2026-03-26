import { eq, gte, count, min, and, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { releases, sources } from "../db/schema.js";
import { daysAgoIso } from "../lib/dates.js";

interface ActivityMetrics {
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
}

export function getSourceMetrics(sourceId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);
  const [recent] = db
    .select({ n: count() })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoff)))
    .all();
  const [totals] = db
    .select({ total: count(), oldest: min(releases.publishedAt) })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), sql`${releases.publishedAt} IS NOT NULL`))
    .all();
  return {
    releasesLast30Days: recent.n,
    avgReleasesPerWeek: computeAvgPerWeek(totals.total, totals.oldest),
  };
}

export function getOrgMetrics(orgId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);
  const orgSources = db.select({ id: sources.id }).from(sources).where(eq(sources.orgId, orgId)).all();
  if (orgSources.length === 0) return { releasesLast30Days: 0, avgReleasesPerWeek: 0 };
  const sourceIds = orgSources.map((s) => s.id);
  const inClause = sql`${releases.sourceId} IN (${sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  const [recent] = db
    .select({ n: count() })
    .from(releases)
    .where(and(inClause, gte(releases.publishedAt, cutoff)))
    .all();
  const [totals] = db
    .select({ total: count(), oldest: min(releases.publishedAt) })
    .from(releases)
    .where(and(inClause, sql`${releases.publishedAt} IS NOT NULL`))
    .all();
  return {
    releasesLast30Days: recent.n,
    avgReleasesPerWeek: computeAvgPerWeek(totals.total, totals.oldest),
  };
}

function computeAvgPerWeek(totalReleases: number, oldestPublishedAt: string | null): number {
  if (totalReleases === 0 || !oldestPublishedAt) return 0;
  const weeks = (Date.now() - new Date(oldestPublishedAt).getTime()) / (7 * 24 * 60 * 60 * 1000);
  if (weeks < 1) return totalReleases;
  return Math.round((totalReleases / weeks) * 10) / 10;
}
