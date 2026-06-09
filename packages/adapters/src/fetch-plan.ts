/**
 * Pure resolver describing HOW and HOW OFTEN a source is fetched. Single source
 * of truth for the poll cron's tier intervals (imported back into poll-fetch.ts)
 * and the dev-only fetch-plan endpoint. No I/O — operates on a Source row.
 */

import type { Source } from "@buildinternet/releases-core/schema";
import {
  getSourceMeta,
  isGitHubFetched,
  isAppStoreFetched,
  isVideoFetched,
  type SourceMetadata,
} from "./source-meta.js";

/** Hours between polls per fetch-priority tier. `paused` is never polled. */
export const TIER_INTERVALS = { normal: 4, low: 24 } as const;

/** Default Firecrawl monitor cadence when `metadata.firecrawl.schedule` is unset. */
export const FIRECRAWL_DEFAULT_SCHEDULE = "every 6 hours";

export type FetchStrategy =
  | "github"
  | "feed"
  | "appstore"
  | "video"
  | "crawl"
  | "scrape"
  | "agent"
  | "firecrawl";

export interface FetchPlan {
  strategy: FetchStrategy;
  strategyLabel: string;
  /** Base poll interval in hours; null for firecrawl (external cadence) and paused. */
  intervalHours: number | null;
  /** Human-readable cadence: "every 4 hours", a firecrawl schedule, or "paused". */
  intervalLabel: string;
  cadence: "poll" | "firecrawl-webhook";
  paused: boolean;
  /** Present only when strategy === "firecrawl". */
  firecrawlSchedule?: string;
}

export interface FetchState {
  lastPolledAt: string | null;
  /** ISO time the source is next eligible to poll; null for firecrawl & paused. */
  nextDueAt: string | null;
  /** True when smart-fetch backoff (nextFetchAfter) pushes the next poll past the tier interval. */
  backedOff: boolean;
  paused: boolean;
}

const FEED_LABELS: Record<string, string> = {
  rss: "RSS feed",
  atom: "Atom feed",
  jsonfeed: "JSON Feed",
};

function resolveStrategy(source: Source, meta: SourceMetadata): FetchStrategy {
  // Precedence mirrors queryDueSources / the fetch dispatcher in poll-fetch.ts.
  // This describes the source's CONFIGURED strategy, not poll eligibility
  // (which source types `queryDueSources` admits to the poll).
  if (isGitHubFetched(source, meta)) return "github";
  if (isAppStoreFetched(source)) return "appstore";
  if (isVideoFetched(source)) return "video";
  if (meta.feedUrl) return "feed";
  if (meta.crawlEnabled) return "crawl";
  if (source.type === "agent") return "agent";
  return "scrape";
}

function strategyLabel(strategy: FetchStrategy, meta: SourceMetadata): string {
  switch (strategy) {
    case "github":
      return "GitHub API";
    case "appstore":
      return "App Store";
    case "video":
      return "Video feed";
    case "feed":
      return FEED_LABELS[meta.feedType ?? "rss"] ?? "RSS feed";
    case "crawl":
      return "Multi-page crawl";
    case "agent":
      return "Agent extraction";
    case "firecrawl":
      return "Firecrawl";
    case "scrape":
      return "Browser scrape";
  }
}

function tierHours(priority: Source["fetchPriority"]): number | null {
  if (priority === "normal") return TIER_INTERVALS.normal;
  if (priority === "low") return TIER_INTERVALS.low;
  return null; // paused
}

function formatInterval(hours: number): string {
  return `every ${hours} hours`;
}

export function describeFetchPlan(source: Source): FetchPlan {
  const meta = getSourceMeta(source);
  const paused = source.fetchPriority === "paused";

  // Firecrawl wins: these sources are excluded from the poll cron and run on
  // their own external schedule (ingested via the inbound webhook + workflow).
  if (meta.firecrawl?.enabled) {
    const schedule = meta.firecrawl.schedule ?? FIRECRAWL_DEFAULT_SCHEDULE;
    return {
      strategy: "firecrawl",
      strategyLabel: "Firecrawl",
      intervalHours: null,
      intervalLabel: schedule,
      cadence: "firecrawl-webhook",
      paused,
      firecrawlSchedule: schedule,
    };
  }

  const strategy = resolveStrategy(source, meta);
  const hours = paused ? null : tierHours(source.fetchPriority);
  return {
    strategy,
    strategyLabel: strategyLabel(strategy, meta),
    intervalHours: hours,
    intervalLabel: paused ? "paused" : hours == null ? "—" : formatInterval(hours),
    cadence: "poll",
    paused,
  };
}

/**
 * A scrape/agent source flagged for the managed sweep but not fetched within
 * this many hours is treated as "starved" — surfaced so an operator can check
 * its config. The sweep runs daily, so 48h means it has sat through ~2 sweeps
 * without draining.
 */
export const SWEEP_STARVED_THRESHOLD_HOURS = 48;

export interface SweepHealth {
  /** True for scrape/agent-no-feed sources that depend on the managed sweep. */
  sweepDriven: boolean;
  /** `changeDetectedAt` — set means the source is queued for the next sweep. */
  flaggedAt: string | null;
  /** ISO time of the last successful fetch (null = never fetched). */
  lastFetchedAt: string | null;
  /** Hours since the last fetch (or createdAt when never fetched); null if unparseable. */
  staleHours: number | null;
  /**
   * Queued for the sweep (`flaggedAt` set) yet not fetched within
   * `SWEEP_STARVED_THRESHOLD_HOURS`. A strong hint the sweep isn't draining it —
   * e.g. a change-validator that flaps every poll (so the flag is perpetually
   * re-stamped to "now") or a binding session cap — so the source likely needs
   * a config change (a stabler detector, Firecrawl, or a feed URL).
   */
  starved: boolean;
}

/**
 * Pure sweep-health resolver for the dev fetch-plan panel. Distinguishes a
 * source that's merely queued from one that's queued-and-stuck, the latter
 * being the actionable "needs configuration" signal.
 */
export function computeSweepHealth(source: Source, plan: FetchPlan, now: Date): SweepHealth {
  const sweepDriven = !plan.paused && (plan.strategy === "scrape" || plan.strategy === "agent");
  const flaggedAt = source.changeDetectedAt ?? null;
  const lastFetchedAt = source.lastFetchedAt ?? null;

  // Never-fetched sources fall back to createdAt as the clock so a freshly
  // added source isn't reported starved before it's had a chance to drain.
  const clock = lastFetchedAt ?? source.createdAt;
  const parsedMs = clock ? Date.parse(clock) : NaN;
  const staleHours = Number.isFinite(parsedMs) ? (now.getTime() - parsedMs) / 3_600_000 : null;

  const starved =
    sweepDriven &&
    flaggedAt != null &&
    staleHours != null &&
    staleHours > SWEEP_STARVED_THRESHOLD_HOURS;

  return { sweepDriven, flaggedAt, lastFetchedAt, staleHours, starved };
}

export function computeFetchState(source: Source, plan: FetchPlan, now: Date): FetchState {
  const lastPolledAt = source.lastPolledAt ?? null;

  // No local cadence to project for firecrawl (webhook-driven) or paused sources.
  if (plan.paused || plan.cadence === "firecrawl-webhook" || plan.intervalHours == null) {
    return { lastPolledAt, nextDueAt: null, backedOff: false, paused: plan.paused };
  }

  // Guard against malformed timestamps: a NaN from Date.parse would make
  // new Date(nextDueMs).toISOString() throw and 500 the whole response.
  const parsedLastPolledMs = lastPolledAt ? Date.parse(lastPolledAt) : NaN;
  const tierBaseMs = Number.isFinite(parsedLastPolledMs) ? parsedLastPolledMs : now.getTime();
  const tierDueMs = tierBaseMs + plan.intervalHours * 3_600_000;

  const parsedBackoffMs = source.nextFetchAfter ? Date.parse(source.nextFetchAfter) : NaN;
  const backoffMs = Number.isFinite(parsedBackoffMs) ? parsedBackoffMs : null;
  const backedOff = backoffMs != null && backoffMs > tierDueMs;
  const nextDueMs = backedOff ? backoffMs : tierDueMs;

  return {
    lastPolledAt,
    nextDueAt: new Date(nextDueMs).toISOString(),
    backedOff,
    paused: false,
  };
}
