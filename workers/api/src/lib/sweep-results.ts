/**
 * Aggregates `fetch_log` rows for a sweep's dispatched sessions so the
 * daily email reports release counts per org instead of just dispatch
 * counts. Sessions with no rows yet are surfaced as "still running".
 */
import { fetchLog, sources, organizations } from "@buildinternet/releases-core/schema";
import { inArray, eq } from "drizzle-orm";

export type SweepOrgResult = {
  orgSlug: string;
  orgName: string;
  sourcesFetched: number;
  releasesFound: number;
  releasesInserted: number;
  errors: number;
};

export type SweepResults = {
  perOrg: SweepOrgResult[];
  /** Count of input session IDs that produced zero fetch_log rows. */
  sessionsWithNoActivity: number;
};

// `db` is typed `any` so this helper accepts both the production D1 drizzle
// instance and the bun:sqlite drizzle used in tests — the consuming workflow
// owns the concrete type. Matches the convention in the cron handlers.
export async function aggregateSweepResults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  sessionIds: string[],
): Promise<SweepResults> {
  if (sessionIds.length === 0) return { perOrg: [], sessionsWithNoActivity: 0 };

  const rows = await db
    .select({
      sessionId: fetchLog.sessionId,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      status: fetchLog.status,
    })
    .from(fetchLog)
    .leftJoin(sources, eq(sources.id, fetchLog.sourceId))
    .leftJoin(organizations, eq(organizations.id, sources.orgId))
    .where(inArray(fetchLog.sessionId, sessionIds));

  const perOrg = new Map<string, SweepOrgResult>();
  const sessionsSeen = new Set<string>();

  for (const r of rows) {
    if (r.sessionId) sessionsSeen.add(r.sessionId);

    // Orphaned fetch_log rows (source/org missing) are rare but possible;
    // bucket them under "(unknown)" rather than dropping them.
    const slug = r.orgSlug ?? "(unknown)";
    const name = r.orgName ?? "(unknown)";
    const isError = r.status === "error";
    const existing = perOrg.get(slug);
    if (existing) {
      existing.sourcesFetched += 1;
      existing.releasesFound += r.releasesFound;
      existing.releasesInserted += r.releasesInserted;
      if (isError) existing.errors += 1;
    } else {
      perOrg.set(slug, {
        orgSlug: slug,
        orgName: name,
        sourcesFetched: 1,
        releasesFound: r.releasesFound,
        releasesInserted: r.releasesInserted,
        errors: isError ? 1 : 0,
      });
    }
  }

  const perOrgArr = [...perOrg.values()].toSorted((a, b) => {
    if (b.releasesInserted !== a.releasesInserted) {
      return b.releasesInserted - a.releasesInserted;
    }
    return a.orgSlug.localeCompare(b.orgSlug);
  });

  const sessionsWithNoActivity = sessionIds.filter((id) => !sessionsSeen.has(id)).length;

  return { perOrg: perOrgArr, sessionsWithNoActivity };
}
