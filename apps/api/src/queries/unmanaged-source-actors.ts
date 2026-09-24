/**
 * Active sources whose SourceActor is not driving a live alarm (#2286).
 *
 * The D1 `metadata.sourceActor` mirror is observational, but it is also the
 * only fleet-wide view of whether a DO alarm is armed. A source that hit
 * `noReschedule` (paused / org-paused / firecrawl) writes `managed:false` and
 * deletes its alarm; if nothing later calls `ensureScheduled`, it stays quiet.
 * This query is the detection + sweep input for those rows.
 *
 * "Should still be polling" matches `queryDueSources` eligibility (not paused,
 * not firecrawl-owned, org not fetch-paused, has a normal/low cadence) but
 * ignores last-polled / backoff — an unmanaged source that was just fetched
 * still needs an alarm for its next interval.
 */

import { sql, and, eq, or } from "drizzle-orm";
import { organizations, sourcesActive } from "@buildinternet/releases-core/schema";
import type { Source } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../db.js";
import { locallyFetchedSql } from "./source-fetch-routing.js";

/**
 * A `nextAlarmAt` this far in the past means the scheduled tick never wrote a
 * new mirror — the alarm is dead even if `managed` is still true.
 */
export const UNMANAGED_ALARM_STALE_MS = 5 * 60 * 1000;

function pausedOrgIds(db: D1Db) {
  return db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.fetchPaused, true));
}

function unmanagedWhere(now: Date) {
  const staleCutoff = new Date(now.getTime() - UNMANAGED_ALARM_STALE_MS).toISOString();

  const hasCadence = or(
    eq(sourcesActive.fetchPriority, "normal"),
    eq(sourcesActive.fetchPriority, "low"),
  );

  return (db: D1Db) =>
    and(
      hasCadence,
      sql`${sourcesActive.orgId} NOT IN (${pausedOrgIds(db)})`,
      locallyFetchedSql(sourcesActive.metadata),
      sql`(
        json_extract(${sourcesActive.metadata}, '$.sourceActor.managed') IS NULL
        OR json_extract(${sourcesActive.metadata}, '$.sourceActor.managed') = 0
        OR json_extract(${sourcesActive.metadata}, '$.sourceActor.nextAlarmAt') IS NULL
        OR json_extract(${sourcesActive.metadata}, '$.sourceActor.nextAlarmAt') < ${staleCutoff}
      )`,
    );
}

/** Active sources that should be polling but have no live SourceActor alarm. */
export async function queryUnmanagedActiveSources(
  db: D1Db,
  now: Date = new Date(),
  opts?: { limit?: number },
): Promise<Source[]> {
  const where = unmanagedWhere(now)(db);
  const q = db.select().from(sourcesActive).where(where);
  return opts?.limit != null ? q.limit(opts.limit) : q;
}

/** Cheap COUNT for the admin health signal — same predicate as the list. */
export async function countUnmanagedActiveSources(
  db: D1Db,
  now: Date = new Date(),
): Promise<number> {
  const where = unmanagedWhere(now)(db);
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(sourcesActive)
    .where(where);
  return Number(row?.n) || 0;
}
