/**
 * First-party staleness signal (#1528): flag sources that keep getting polled
 * but have quietly stopped producing new releases. A client-rendered scrape
 * source can silently go stale — the cron's render reaches an empty shell, or a
 * change-detector probe never trips — and the only prior signal was an external
 * Firecrawl monitor. This scan makes that signal first-party so Firecrawl is a
 * hedge, not a requirement.
 *
 * The signal is deliberately conservative to keep warn volume low:
 *
 *   - Only sources with an *established cadence* (`medianGapDays != null`, set by
 *     the daily retier from ≥3 releases of history) are eligible. A new/sparse
 *     source has no baseline to call "overdue" against, so it's never flagged.
 *   - Only sources we're *actively monitoring* (a `lastPolledAt`/`lastFetchedAt`
 *     within the recency window) count. A source we've stopped polling is a
 *     different failure (force-drain's job), not "stale despite fetching".
 *   - The overdue window is `max(SOURCE_STALE_FLOOR_DAYS, medianGapDays × MULT)`
 *     so a fast cadence gets a tight window and a slow (e.g. monthly) one isn't
 *     false-flagged. The floor is the minimum patience before we warn.
 *
 * Firecrawl-owned sources are excluded — {@link scanStaleFirecrawlSources}
 * already watches those on a monitor-cadence basis. Emits warn-level events on
 * the `source-staleness` component (alerting is via Workers Logs / Axiom).
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { releases, sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { parsePositiveInt } from "./feed-enrich.js";

export interface SourceStalenessEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /**
   * Minimum days a source may go without a new release before it can be flagged,
   * regardless of how fast its cadence is. Default 14. The per-source window is
   * raised above this for slow cadences but never lowered below it.
   */
  SOURCE_STALE_FLOOR_DAYS?: string;
  /**
   * Multiplier applied to a source's median release gap to size its overdue
   * window. Default 3 — a source that normally ships every ~7 days is flagged
   * after ~21 quiet days. Headroom so a single skipped cycle never trips it.
   */
  SOURCE_STALE_MULTIPLIER?: string;
  /**
   * How recently a source must have been polled/fetched to count as actively
   * monitored. Default 3 days — covers the low (24h) tier plus smart-fetch
   * backoff (up to 48h) with margin. Older → not actively monitored, skipped.
   */
  SOURCE_STALE_POLL_RECENCY_DAYS?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
}

const DEFAULT_FLOOR_DAYS = 14;
const DEFAULT_MULTIPLIER = 3;
const DEFAULT_POLL_RECENCY_DAYS = 3;
const DAY_MS = 86_400_000;

/**
 * Scan established-cadence, actively-monitored, non-Firecrawl sources and warn
 * on any whose newest release is older than its overdue window. Returns counts
 * for observability/testing.
 */
export async function scanStaleSources(
  env: SourceStalenessEnv,
  now: Date = new Date(),
): Promise<{ scanned: number; stale: number }> {
  if (env.CRON_ENABLED === "false") return { scanned: 0, stale: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the firecrawl scan
  const db: any = env._drizzleOverride ?? drizzle(env.DB);
  const floorDays = parsePositiveInt(env.SOURCE_STALE_FLOOR_DAYS, DEFAULT_FLOOR_DAYS);
  const multiplier = parsePositiveInt(env.SOURCE_STALE_MULTIPLIER, DEFAULT_MULTIPLIER);
  const recencyDays = parsePositiveInt(
    env.SOURCE_STALE_POLL_RECENCY_DAYS,
    DEFAULT_POLL_RECENCY_DAYS,
  );
  const recencyCutoff = new Date(now.getTime() - recencyDays * DAY_MS).toISOString();

  // One grouped aggregate: each eligible source plus the date of its newest
  // non-suppressed release. `MAX(CASE …)` ignores suppressed rows (a suppressed
  // release isn't "new output") and falls back to created_at when published_at
  // is null. Eligibility (established cadence, not deleted, not Firecrawl) is
  // filtered in SQL so the scanned set stays small; paused/recency/overdue
  // checks run in JS to sidestep three-valued NULL comparisons.
  const rows: Array<{
    id: string;
    slug: string;
    orgId: string | null;
    type: string;
    medianGapDays: number | null;
    fetchPriority: string | null;
    lastPolledAt: string | null;
    lastFetchedAt: string | null;
    createdAt: string | null;
    newestRelease: string | null;
  }> = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      orgId: sources.orgId,
      type: sources.type,
      medianGapDays: sources.medianGapDays,
      fetchPriority: sources.fetchPriority,
      lastPolledAt: sources.lastPolledAt,
      lastFetchedAt: sources.lastFetchedAt,
      createdAt: sources.createdAt,
      newestRelease: sql<
        string | null
      >`MAX(CASE WHEN ${releases.suppressed} = 0 THEN COALESCE(${releases.publishedAt}, ${releases.fetchedAt}) END)`,
    })
    .from(sources)
    .leftJoin(releases, eq(releases.sourceId, sources.id))
    .where(
      and(
        isNull(sources.deletedAt),
        isNotNull(sources.medianGapDays),
        // Firecrawl sources are covered by scanStaleFirecrawlSources. json_extract
        // returns 1 for JSON `true`; `IS NOT 1` keeps NULL (absent) rows in.
        sql`json_extract(${sources.metadata}, '$.firecrawl.enabled') IS NOT 1`,
      ),
    )
    .groupBy(sources.id);

  let stale = 0;
  for (const r of rows) {
    if (r.fetchPriority === "paused") continue;
    // medianGapDays is guaranteed non-null by the SQL WHERE above.
    const medianGapDays = r.medianGapDays!;

    // Actively monitored? The most recent poll OR fetch must be within the
    // recency window — otherwise this isn't "stale despite fetching".
    const lastSeen =
      [r.lastPolledAt, r.lastFetchedAt]
        .filter((v): v is string => !!v)
        .toSorted()
        .at(-1) ?? null;
    if (!lastSeen || lastSeen < recencyCutoff) continue;

    // Overdue window, in days. A never-produced source uses createdAt as the
    // clock so it isn't flagged until a full window has elapsed since onboarding.
    const windowDays = Math.max(floorDays, medianGapDays * multiplier);
    const reference = r.newestRelease ?? r.createdAt;
    if (!reference) continue;
    const overdueCutoff = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
    if (reference >= overdueCutoff) continue;

    stale++;
    const daysSince = Math.round((now.getTime() - new Date(reference).getTime()) / DAY_MS);
    logEvent("warn", {
      component: "source-staleness",
      event: "stale-source",
      sourceId: r.id,
      slug: r.slug,
      orgId: r.orgId,
      sourceType: r.type,
      medianGapDays,
      windowDays: Math.round(windowDays),
      daysSinceNewest: daysSince,
      newestRelease: r.newestRelease,
      lastSeenAt: lastSeen,
    });
  }

  logEvent(stale > 0 ? "warn" : "info", {
    component: "source-staleness",
    event: "scan-complete",
    scanned: rows.length,
    stale,
  });
  return { scanned: rows.length, stale };
}
