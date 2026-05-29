/**
 * Resilience option A: detect Firecrawl-owned sources whose monitor has stopped
 * delivering — out of credits, account suspended, or the ingest workflow has
 * been failing repeatedly. A healthy monitor fires on its schedule and
 * `FirecrawlIngestWorkflow` writes `lastFetchedAt` on every run (even a
 * no_change run), so a stale `lastFetchedAt` on a `firecrawl.enabled` source
 * means the external monitor is no longer reaching us. The poll cron can't
 * catch this — those sources are deliberately excluded from it — so this scan
 * is the only signal. It emits warn-level events (alerting is via Workers Logs
 * / Axiom on the `firecrawl-staleness` component); it never fetches anything.
 */
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";

export interface FirecrawlStalenessEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /** Hours since the last successful run before a source is flagged. Default 48. */
  FIRECRAWL_STALE_HOURS?: string;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
}

const DEFAULT_STALE_HOURS = 48;

/**
 * Scan firecrawl-enabled sources and warn on any whose last run is older than
 * the staleness window. Returns counts for observability/testing.
 */
export async function scanStaleFirecrawlSources(
  env: FirecrawlStalenessEnv,
  now: Date = new Date(),
): Promise<{ scanned: number; stale: number }> {
  if (env.CRON_ENABLED === "false") return { scanned: 0, stale: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the workflows
  const db: any = env._drizzleOverride ?? drizzle(env.DB);
  const parsed = Number(env.FIRECRAWL_STALE_HOURS);
  const staleHours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_HOURS;
  const cutoff = new Date(now.getTime() - staleHours * 3600_000).toISOString();

  const rows: Array<{
    id: string;
    slug: string;
    orgId: string | null;
    lastFetchedAt: string | null;
    createdAt: string | null;
  }> = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      orgId: sources.orgId,
      lastFetchedAt: sources.lastFetchedAt,
      createdAt: sources.createdAt,
    })
    .from(sources)
    // json_extract returns the integer 1 for JSON `true`, NULL when absent.
    .where(sql`json_extract(${sources.metadata}, '$.firecrawl.enabled') = 1`);

  let stale = 0;
  for (const r of rows) {
    // A never-run source (lastFetchedAt null) uses createdAt as the clock, so a
    // freshly-enabled source isn't flagged until it's had a full window to fire.
    const last = r.lastFetchedAt ?? r.createdAt;
    if (!last || last >= cutoff) continue;
    stale++;
    logEvent("warn", {
      component: "firecrawl-staleness",
      event: "stale-source",
      sourceId: r.id,
      slug: r.slug,
      orgId: r.orgId,
      lastFetchedAt: r.lastFetchedAt,
      staleHours,
    });
  }

  logEvent(stale > 0 ? "warn" : "info", {
    component: "firecrawl-staleness",
    event: "scan-complete",
    scanned: rows.length,
    stale,
  });
  return { scanned: rows.length, stale };
}
