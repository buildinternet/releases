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
  // This describes the source's CONFIGURED strategy, not flag-gated poll
  // eligibility (e.g. scrape/agent sources only poll when SCRAPE_CHANGE_DETECT_ENABLED).
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
