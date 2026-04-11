import { eq, gte, count, min, and, sql } from "drizzle-orm";
import { getDb } from "../db/connection.js";
import { releases, sources } from "../db/schema.js";
import { daysAgoIso } from "../lib/dates.js";

interface ActivityMetrics {
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  /** Earliest release publishedAt — use for trackingSince. */
  oldestPublishedAt: string | null;
}

export function getSourceMetrics(sourceId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);
  const cutoff90d = daysAgoIso(90);
  const [recent] = db
    .select({ n: count() })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoff)))
    .all();
  const [windowed] = db
    .select({ n: count() })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), gte(releases.publishedAt, cutoff90d)))
    .all();
  const [totals] = db
    .select({ oldest: min(releases.publishedAt) })
    .from(releases)
    .where(and(eq(releases.sourceId, sourceId), sql`${releases.publishedAt} IS NOT NULL`))
    .all();
  return {
    releasesLast30Days: recent.n,
    avgReleasesPerWeek: computeAvgPerWeek(windowed.n, totals.oldest),
    oldestPublishedAt: totals.oldest,
  };
}

export function getOrgMetrics(orgId: string): ActivityMetrics {
  const db = getDb();
  const cutoff = daysAgoIso(30);
  const cutoff90d = daysAgoIso(90);
  const orgSources = db.select({ id: sources.id }).from(sources).where(eq(sources.orgId, orgId)).all();
  if (orgSources.length === 0) return { releasesLast30Days: 0, avgReleasesPerWeek: 0, oldestPublishedAt: null };
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
  const [windowed] = db
    .select({ n: count() })
    .from(releases)
    .where(and(inClause, gte(releases.publishedAt, cutoff90d)))
    .all();
  const [totals] = db
    .select({ oldest: min(releases.publishedAt) })
    .from(releases)
    .where(and(inClause, sql`${releases.publishedAt} IS NOT NULL`))
    .all();
  return {
    releasesLast30Days: recent.n,
    avgReleasesPerWeek: computeAvgPerWeek(windowed.n, totals.oldest),
    oldestPublishedAt: totals.oldest,
  };
}

/**
 * Compute average releases per week over a rolling window (default 90 days).
 * If the source has less history than the window, use the actual span instead.
 */
function computeAvgPerWeek(
  releasesInWindow: number,
  oldestPublishedAt: string | null,
  windowDays = 90,
): number {
  if (releasesInWindow === 0 || !oldestPublishedAt) return 0;
  const ageMs = Date.now() - new Date(oldestPublishedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const effectiveDays = Math.min(windowDays, ageDays);
  const weeks = effectiveDays / 7;
  if (weeks < 1) return releasesInWindow;
  return Math.round((releasesInWindow / weeks) * 10) / 10;
}
