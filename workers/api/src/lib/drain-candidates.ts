import { and, eq, isNotNull, ne, or, isNull, sql, asc, inArray } from "drizzle-orm";
import { sources, organizations } from "@buildinternet/releases-core/schema";

export type Candidate = {
  id: string;
  slug: string;
  type: "scrape" | "agent";
  orgId: string;
  orgSlug: string;
  orgName: string;
  changeDetectedAt: string;
};

export type CandidateQueryResult = {
  rows: Candidate[];
  skippedOverCap: number;
};

/**
 * Minimum spacing between successful drains of the same source (#1862). The
 * SourceActor re-notifies the OrgActor every poll tick (normal 4h / low 24h) as
 * long as a source stays flagged (`changeDetectedAt` set), and for a
 * permanently un-fetchable source that flag never clears — so without a cooldown
 * the OrgActor re-dispatched a no-op Haiku `/update` every 4h (~6×/day/org),
 * ~5× the old daily sweep's cadence for zero new releases. A successful dispatch
 * stamps `sources.last_drain_at`; `queryCandidates` excludes anything drained
 * within this window, collapsing the churn back to roughly the old sweep's
 * once-daily rhythm. A source with genuinely new content simply drains on the
 * next window (matching the pre-actor behavior), not in real time.
 */
export const DRAIN_COOLDOWN_MS = 20 * 60 * 60 * 1000;

/**
 * Query flagged scrape-no-feed and agent sources, most-stale first
 * (`lastFetchedAt ASC`). Returns up to `cap` rows; if more than `cap` matched,
 * runs a follow-up COUNT(*) to populate skippedOverCap. Most sweeps take the
 * fast path (no count query). Firecrawl-owned sources are excluded — their
 * monitor owns the fetch.
 *
 * Agent sources (#517) join the sweep once the change-detect cron pipeline
 * flags them. The /update dispatcher handles both types identically, so
 * widening the filter is safe.
 */
export async function queryCandidates(
  db: any,
  params: { cap: number; orgId?: string; drainCooldownMs?: number },
): Promise<CandidateQueryResult> {
  // Cooldown cutoff: sources drained (last_drain_at) more recently than this are
  // excluded (#1862). Pass drainCooldownMs=0 to disable (e.g. in tests). ISO-8601
  // UTC strings compare lexicographically, matching last_drain_at's format.
  const cooldownMs = params.drainCooldownMs ?? DRAIN_COOLDOWN_MS;
  const cooldownCutoff = new Date(Date.now() - cooldownMs).toISOString();
  const whereClause = and(
    inArray(sources.type, ["scrape", "agent"]),
    // NULL-safe paused filter: fetch_priority is nullable, and a bare
    // `!= 'paused'` evaluates to NULL (not TRUE) for NULL rows, which would
    // wrongly drop a NULL-priority (i.e. effectively "normal") stranded source
    // from the drain. Mirrors the COALESCE guard in queries/stuck-sources.ts.
    or(ne(sources.fetchPriority, "paused"), isNull(sources.fetchPriority)),
    isNotNull(sources.changeDetectedAt),
    // Drain cooldown (#1862): skip sources drained within the window so a
    // permanently-flagged source can't re-drain a no-op Haiku session every
    // poll tick. NULL last_drain_at (never drained) always passes.
    cooldownMs > 0
      ? or(isNull(sources.lastDrainAt), sql`${sources.lastDrainAt} < ${cooldownCutoff}`)
      : undefined,
    sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NULL OR ${sources.metadata} IS NULL)`,
    // Exclude Firecrawl-owned sources — their monitor fetches them, and the poll
    // cron drops them the same way (queryDueSources `notFirecrawl`). Without this
    // a source could be double-fetched by both the monitor and this sweep.
    sql`(json_extract(${sources.metadata}, '$.firecrawl.enabled') IS NULL OR json_extract(${sources.metadata}, '$.firecrawl.enabled') != 1)`,
    or(eq(sources.isHidden, false), isNull(sources.isHidden)),
    // Exclude sources whose org has fetch_paused = true (#1057).
    or(eq(organizations.fetchPaused, false), isNull(organizations.fetchPaused)),
    // Scope to a single org — used by the OrgActor drain (per-org DO), which
    // reuses this same filter instead of hand-rolling a second copy.
    params.orgId !== undefined ? eq(sources.orgId, params.orgId) : undefined,
  );

  const rows = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      type: sources.type,
      orgId: sources.orgId,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      changeDetectedAt: sources.changeDetectedAt,
    })
    .from(sources)
    .innerJoin(organizations, eq(organizations.id, sources.orgId))
    .where(whereClause)
    // Order by actual staleness — the source we've gone longest WITHOUT fetching
    // wins (never-fetched, i.e. NULL, sorts first in SQLite ASC), with
    // `changeDetectedAt` as a stable tiebreaker. Ordering by `changeDetectedAt`
    // instead starved any source whose change-validator flaps every poll: each
    // poll re-stamps `changeDetectedAt = now`, perpetually sorting it to the back
    // of a capped queue so it never drains (sweep-starvation incident 2026-05-31).
    .orderBy(asc(sources.lastFetchedAt), asc(sources.changeDetectedAt))
    .limit(params.cap + 1);

  let skippedOverCap = 0;
  let sliced = rows;
  if (rows.length > params.cap) {
    sliced = rows.slice(0, params.cap);
    const countResult = await db
      .select({ c: sql<number>`count(*)` })
      .from(sources)
      .innerJoin(organizations, eq(organizations.id, sources.orgId))
      .where(whereClause);
    const totalCount = Number(countResult?.[0]?.c ?? sliced.length);
    skippedOverCap = totalCount - params.cap;
  }

  return {
    rows: sliced.map((r: any) => ({
      id: r.id,
      slug: r.slug,
      type: r.type,
      orgId: r.orgId,
      orgSlug: r.orgSlug,
      orgName: r.orgName,
      changeDetectedAt: r.changeDetectedAt,
    })),
    skippedOverCap,
  };
}
