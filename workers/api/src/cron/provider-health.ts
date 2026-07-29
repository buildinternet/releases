/**
 * Provider-health signal (#2168): detect when a source's most recent ingest
 * attempt failed because the AI provider itself is closed for business — a
 * spend cap or billing shutoff — rather than an ordinary transient failure.
 *
 * The 2026-07-23 outage went unnoticed for six days because nothing
 * distinguished "this source is flaky" from "every source is failing for the
 * same reason: the account is out of quota". `classifyProviderQuota` (added in
 * #2169) makes that distinction on the stored error TEXT, but nothing read it
 * back out of `fetch_log` for an operator-facing surface until now.
 *
 * Only each source's MOST RECENT non-`dry_run` `fetch_log` row is examined: a
 * quota error from three attempts ago that has since recovered is not
 * "broken" today, so it must not still show up here once a later attempt
 * succeeds (or fails for an unrelated reason). This is what makes the section
 * "lead with last-successful-evaluation" rather than "last release": a source
 * can go quiet (no new releases) forever and be perfectly healthy — the
 * digest's existing staleness sections already cover that axis — but this
 * section flags only the narrow, sharp signal of "we are currently unable to
 * even evaluate this source".
 *
 * `sources.last_fetched_at` — written on every SUCCESSFUL check, including a
 * `no_change` verdict (`recordNoChange`, #2185) — is that "we successfully
 * evaluated this source" timestamp; no new column is needed. (The one
 * exception is `delegateScrapeToUpdateWorkflow`'s synthetic `no_change`
 * handoff row, which deliberately leaves the column alone — it's a delegation
 * marker, not a completed check.) A source whose latest attempt classifies
 * as a provider quota shutoff is BROKEN regardless of how recent its releases
 * are; a source that simply has no new releases but whose latest attempt was
 * fine (success, no_change, or a non-quota error) is not broken and never
 * appears here.
 */
import { createDb } from "../db.js";
import { sql } from "drizzle-orm";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
import { logEvent } from "@releases/lib/log-event";
import { classifyProviderQuota, type QuotaProvider } from "@releases/lib/provider-quota";

/**
 * How far back the ranked window reaches. Without a lower bound, `ROW_NUMBER()`
 * partitions EVERY historical `fetch_log` row on every digest run just to keep
 * `rn = 1` — a scan that grows without limit as sources × polls accumulate, and
 * one that `idx_fetch_log_source_created` cannot help with.
 *
 * Narrowing is behavior-preserving for this signal: a source whose newest
 * attempt predates the cutoff is by definition not "currently failing to
 * ingest". 14 days is comfortably wider than the slowest poll cadence (the low
 * tier is 24h, plus smart-fetch backoff), so a live source always has a recent
 * row and a source with nothing inside the window has stopped being polled at
 * all — which the digest's existing staleness sections are what report.
 */
const RANKED_WINDOW_DAYS = 14;

export interface ProviderHealthEnv {
  DB: D1Database;
  CRON_ENABLED?: string;
  /** TEST-ONLY: bypass createDb(env.DB) and use the provided instance directly. */
  _drizzleOverride?: unknown;
}

/** One source whose most recent ingest attempt is a provider quota shutoff. */
export type ProviderHealthEntry = {
  sourceId: string;
  slug: string;
  orgSlug: string | null;
  orgName: string | null;
  provider: QuotaProvider;
  /** Last time this source was successfully evaluated (`sources.last_fetched_at`). */
  lastFetchedAt: string | null;
  /** When the failing attempt ran. */
  lastAttemptAt: string;
  /** ISO timestamp the provider says access returns, if it said one. */
  regainAccessAt: string | null;
  /** The provider's own error message, trimmed. */
  message: string;
};

export type ProviderHealthScanResult = {
  scanned: number;
  broken: number;
  entries: ProviderHealthEntry[];
};

const EMPTY: ProviderHealthScanResult = { scanned: 0, broken: 0, entries: [] };

/**
 * Scan every active source's latest ingest attempt and flag the ones whose
 * failure classifies as a provider quota/billing shutoff. Fails open: any
 * error scanning (bad DB handle, malformed row, etc.) is logged and degrades
 * to an empty result rather than blocking the rest of the staleness digest.
 */
export async function scanProviderHealth(
  env: ProviderHealthEnv,
  // Unused: unlike the other staleness scans, this signal doesn't compare
  // against "now" — it reads whether each source's LATEST attempt classifies
  // as a quota shutoff. Kept for signature parity with `scanStaleSources` /
  // `scanStaleFirecrawlSources` so `sendStalenessDigest` can call all three
  // identically, and so a future `now`-relative refinement (e.g. suppressing
  // an already-stale-by-days quota flag) has somewhere to land.
  _now: Date = new Date(),
): Promise<ProviderHealthScanResult> {
  if (env.CRON_ENABLED === "false") return EMPTY;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle override pattern; same as the other staleness scans
    const db: any = env._drizzleOverride ?? createDb(env.DB);

    // Latest non-dry-run fetch_log row per active, non-paused source, joined
    // back to the source + org for display. Sources with no attempts yet have
    // nothing to classify and are excluded by the join.
    interface Row {
      source_id: string;
      slug: string;
      org_slug: string | null;
      org_name: string | null;
      last_fetched_at: string | null;
      last_attempt_at: string;
      last_error: string | null;
      status: string;
    }

    const rankedSince = daysAgoIso(RANKED_WINDOW_DAYS);

    // The status filter lives in JS rather than SQL so `scanned` below counts
    // the population actually examined — active sources with a recent attempt —
    // instead of only the failures. A `scanned` that silently excluded every
    // healthy source would read during triage as a far smaller fleet than we run.
    const rows: Row[] = await db.all(sql`
      WITH ranked AS (
        SELECT
          fl.source_id,
          fl.status,
          fl.error,
          fl.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY fl.source_id ORDER BY fl.created_at DESC, fl.id DESC
          ) AS rn
        FROM fetch_log fl
        WHERE fl.status != 'dry_run'
          AND fl.created_at >= ${rankedSince}
      )
      SELECT
        s.id AS source_id,
        s.slug AS slug,
        o.slug AS org_slug,
        o.name AS org_name,
        s.last_fetched_at AS last_fetched_at,
        r.created_at AS last_attempt_at,
        r.error AS last_error,
        r.status AS status
      FROM ranked r
      JOIN sources s ON s.id = r.source_id
      LEFT JOIN organizations_active o ON o.id = s.org_id
      WHERE r.rn = 1
        AND s.deleted_at IS NULL
        AND COALESCE(s.fetch_priority, 'normal') != 'paused'
    `);

    let broken = 0;
    const entries: ProviderHealthEntry[] = [];
    for (const r of rows) {
      if (r.status !== "error") continue;
      const quota = classifyProviderQuota(r.last_error);
      if (!quota) continue;

      broken++;
      const regainAccessAt = quota.regainAccessAt ? quota.regainAccessAt.toISOString() : null;
      const entry: ProviderHealthEntry = {
        sourceId: r.source_id,
        slug: r.slug,
        orgSlug: r.org_slug,
        orgName: r.org_name,
        provider: quota.provider,
        lastFetchedAt: r.last_fetched_at,
        lastAttemptAt: r.last_attempt_at,
        regainAccessAt,
        message: quota.message,
      };
      entries.push(entry);
      logEvent("warn", {
        component: "provider-health",
        event: "provider-quota-source",
        sourceId: r.source_id,
        slug: r.slug,
        provider: quota.provider,
        lastFetchedAt: r.last_fetched_at,
        lastAttemptAt: r.last_attempt_at,
        regainAccessAt,
      });
    }

    // Oldest last-successful-evaluation first — the sources that have been
    // broken the longest are the most operator-urgent.
    entries.sort((a, b) => (a.lastFetchedAt ?? "").localeCompare(b.lastFetchedAt ?? ""));

    logEvent(broken > 0 ? "warn" : "info", {
      component: "provider-health",
      event: "scan-complete",
      scanned: rows.length,
      broken,
    });
    return { scanned: rows.length, broken, entries };
  } catch (err) {
    logEvent("warn", {
      component: "provider-health",
      event: "scan-error",
      err: err instanceof Error ? { name: err.name, message: err.message } : String(err),
    });
    return EMPTY;
  }
}
