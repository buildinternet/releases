/**
 * Resilience option A: detect Firecrawl-owned sources whose monitor has stopped
 * delivering — out of credits, account suspended, or the ingest workflow has
 * been failing repeatedly. A healthy monitor fires on its schedule and
 * `FirecrawlIngestWorkflow` writes `lastFetchedAt` on every run (even a
 * no_change run), so a stale `lastFetchedAt` on a `firecrawl.enabled` source
 * means the external monitor is no longer reaching us. The poll cron can't
 * catch this — those sources are deliberately excluded from it — so this scan
 * is the only signal. It emits warn-level events (alerting is via Workers Logs
 * / Axiom on the `firecrawl-staleness` component).
 *
 * The staleness window is `max(FIRECRAWL_STALE_HOURS, 2× the monitor's actual
 * cadence)`. The fixed value is a *floor*: it stays correct for fast cadences,
 * and the monitor's live schedule (read via `getMonitor`, since the Firecrawl
 * dashboard is a second writer and the stored `metadata.firecrawl.schedule` can
 * be stale) only ever *raises* the threshold so a slow (e.g. weekly) monitor
 * isn't false-flagged. A source within the floor window needs no schedule read
 * at all, so the only `getMonitor` calls are for sources already past the floor.
 */
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";
import { createFirecrawlClient, type FirecrawlClient } from "@releases/adapters/firecrawl.js";

type SecretBinding = { get(): Promise<string> };

export interface FirecrawlStalenessEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /**
   * Floor for the staleness window, in hours. Default 48. A monitor's live
   * schedule can only RAISE the per-source threshold above this, never lower it.
   */
  FIRECRAWL_STALE_HOURS?: string;
  /**
   * Used to read each monitor's live schedule so a slow cadence isn't
   * false-flagged at the floor. Absent (e.g. unbound) → every source uses the
   * floor, i.e. the original fixed-window behavior.
   */
  FIRECRAWL_API_KEY?: SecretBinding;
  /** TEST-ONLY: bypass drizzle(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
  /** TEST-ONLY: inject a Firecrawl client instead of building one from the key. */
  _firecrawlClientOverride?: FirecrawlClient;
}

const DEFAULT_STALE_HOURS = 48;

/**
 * Approximate the firing interval (in hours) of a normalized 5-field cron, for
 * sizing the staleness threshold. Firecrawl returns the normalized `cron` on
 * read; we only need a coarse cadence (the 2× threshold is forgiving), so this
 * recognizes the handful of shapes Firecrawl emits and returns `null` for
 * anything unexpected (the caller then falls back to the fixed floor).
 * Deliberately NOT a general cron parser.
 */
export function cronIntervalHours(cron: string | undefined | null): number | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, , dow] = parts;

  // "*/N * * * *" — every N minutes.
  const everyMin = /^\*\/(\d+)$/.exec(min);
  if (everyMin && hour === "*") return Math.max(1, Number(everyMin[1])) / 60;

  // "M * * * *" — hourly (any minute, every hour).
  if (hour === "*") return 1;

  // "M */N * * *" — every N hours.
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  if (everyHour) return Math.max(1, Number(everyHour[1]));

  // Fixed minute+hour from here down. A restricted day-of-week → weekly cadence;
  // a restricted day-of-month → ~monthly; otherwise it fires once a day.
  if (dow !== "*") return 24 * 7;
  if (dom !== "*") return 24 * 30;
  return 24;
}

/**
 * Per-source threshold: the floor, raised to 2× the monitor's live cadence when
 * we can read it. Any failure (no client, no monitor id, getMonitor error,
 * unparseable cron) falls back to the floor — we never *suppress* a staleness
 * warning just because the schedule couldn't be read.
 */
async function thresholdHours(
  client: FirecrawlClient | undefined,
  monitorId: string | null | undefined,
  floorHours: number,
): Promise<{ hours: number; basis: "schedule" | "floor" }> {
  if (!client || !monitorId) return { hours: floorHours, basis: "floor" };
  try {
    const monitor = await client.getMonitor(monitorId);
    const interval = cronIntervalHours(monitor.schedule?.cron);
    if (interval == null) return { hours: floorHours, basis: "floor" };
    // 2× headroom so one late/missed run doesn't flag; never below the floor.
    return { hours: Math.max(floorHours, interval * 2), basis: "schedule" };
  } catch {
    return { hours: floorHours, basis: "floor" };
  }
}

/**
 * Scan firecrawl-enabled sources and warn on any whose last run is older than
 * its staleness window. Returns counts for observability/testing.
 */
export async function scanStaleFirecrawlSources(
  env: FirecrawlStalenessEnv,
  now: Date = new Date(),
): Promise<{ scanned: number; stale: number }> {
  if (env.CRON_ENABLED === "false") return { scanned: 0, stale: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the workflows
  const db: any = env._drizzleOverride ?? drizzle(env.DB);
  const parsed = Number(env.FIRECRAWL_STALE_HOURS);
  const floorHours = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_HOURS;
  const floorCutoff = new Date(now.getTime() - floorHours * 3600_000).toISOString();

  const rows: Array<{
    id: string;
    slug: string;
    orgId: string | null;
    lastFetchedAt: string | null;
    createdAt: string | null;
    monitorId: string | null;
  }> = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      orgId: sources.orgId,
      lastFetchedAt: sources.lastFetchedAt,
      createdAt: sources.createdAt,
      monitorId: sql<string | null>`json_extract(${sources.metadata}, '$.firecrawl.monitorId')`,
    })
    .from(sources)
    // json_extract returns the integer 1 for JSON `true`, NULL when absent.
    .where(sql`json_extract(${sources.metadata}, '$.firecrawl.enabled') = 1`);

  // Resolve the client once. Absent key → schedule reads are skipped and every
  // source falls back to the floor (the original fixed-window behavior).
  let client = env._firecrawlClientOverride;
  if (!client && env.FIRECRAWL_API_KEY) {
    const apiKey = await getSecret(env.FIRECRAWL_API_KEY);
    if (apiKey) client = createFirecrawlClient({ apiKey });
  }

  let stale = 0;
  for (const r of rows) {
    // A never-run source (lastFetchedAt null) uses createdAt as the clock, so a
    // freshly-enabled source isn't flagged until it's had a full window to fire.
    const last = r.lastFetchedAt ?? r.createdAt;
    if (!last) continue;
    // Fresh against the floor → fresh against any schedule-derived (≥ floor)
    // threshold, so skip without a (paid) getMonitor call. This is the common
    // case; reads only happen for sources already past the floor.
    if (last >= floorCutoff) continue;

    // Past the floor — see whether the monitor's actual cadence rescues it
    // (e.g. a weekly monitor that's legitimately only fired 4 days ago).
    // eslint-disable-next-line no-await-in-loop -- sequential per-source; only runs for the rare past-floor source
    const { hours, basis } = await thresholdHours(client, r.monitorId, floorHours);
    const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
    if (last >= cutoff) continue;

    stale++;
    logEvent("warn", {
      component: "firecrawl-staleness",
      event: "stale-source",
      sourceId: r.id,
      slug: r.slug,
      orgId: r.orgId,
      lastFetchedAt: r.lastFetchedAt,
      staleHours: hours,
      thresholdBasis: basis,
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
