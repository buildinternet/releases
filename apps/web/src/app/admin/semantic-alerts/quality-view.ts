/**
 * Pure helpers for the admin interest-alert quality panel. No React.
 */
import type { SemanticAlertSummary } from "@buildinternet/releases-api-types";

export type SemanticAlertQualityRange = "day" | "week" | "month";
export type SemanticAlertQualityState = "loading" | "empty" | "error" | "ready";

export const SEMANTIC_ALERT_QUALITY_RANGES: readonly {
  value: SemanticAlertQualityRange;
  label: string;
}[] = [
  { value: "day", label: "24h" },
  { value: "week", label: "7d" },
  { value: "month", label: "30d" },
];

export const SEMANTIC_ALERT_QUALITY_EMPTY = "No interest-alert decisions in this range.";
export const SEMANTIC_ALERT_QUALITY_ERROR = "Match quality failed to load.";
export const SEMANTIC_ALERT_QUALITY_LOADING = "Loading match quality…";

const DAY_MS = 24 * 60 * 60 * 1000;
const AE_QUERY_NAMES = new Set(["totals", "series", "histogram", "failures"]);

export const SEMANTIC_ALERT_DAILY_SPEND_APL = `['releases-cloudflare-logs']
| where ['body'] contains '"event":"ai_usage"'
| extend p = parse_json(['body'])
| where tostring(p['lane']) == 'semantic-alert-match'
| extend cost = todouble(p['costUsd']), questions = toint(p['questionCount']), releaseId = tostring(p['releaseId'])
| summarize costUsd = sum(cost), calls = count(), questions = sum(questions), releases = dcount(releaseId) by bin(_time, 1d)
| sort by _time desc`;

export const SEMANTIC_ALERT_WEEKLY_SPEND_APL = SEMANTIC_ALERT_DAILY_SPEND_APL.replace(
  "bin(_time, 1d)",
  "bin(_time, 7d)",
);

export function semanticAlertQualityWindow(
  range: SemanticAlertQualityRange,
  now = new Date(),
): { after: string; before: string; bucket: SemanticAlertSummary["bucket"] } {
  const days = range === "day" ? 1 : range === "week" ? 7 : 30;
  return {
    after: new Date(now.getTime() - days * DAY_MS).toISOString(),
    before: now.toISOString(),
    bucket: range === "day" ? "hour" : "day",
  };
}

export function semanticAlertSummaryUrl(window: {
  after: string;
  before: string;
  bucket: string;
}): string {
  const qs = new URLSearchParams({
    after: window.after,
    before: window.before,
    bucket: window.bucket,
  });
  return `/api/proxy/admin/semantic-alerts/summary?${qs.toString()}`;
}

export function semanticAlertQualityState(input: {
  loading: boolean;
  error: boolean;
  attempts: number | null;
}): SemanticAlertQualityState {
  if (input.error) return "error";
  if (input.loading || input.attempts == null) return "loading";
  if (input.attempts === 0) return "empty";
  return "ready";
}

/** `rate` is a 0–1 fraction. Null (nothing scored) is an em dash, not 0%. */
export function formatMatchRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "—";
  const pct = Math.round(rate * 1000) / 10;
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${text}%`;
}

export function formatQualityCount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export function formatQualityBucket(ts: string, bucket: SemanticAlertSummary["bucket"]): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "—";
  if (bucket === "day") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    timeZone: "UTC",
  });
}

export function semanticAlertFailureNote(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const record = error as { code?: unknown; details?: unknown };
  if (record.code !== "ae_query_failed" || !record.details || typeof record.details !== "object") {
    return null;
  }
  const details = record.details as { query?: unknown; status?: unknown };
  if (typeof details.query !== "string" || !AE_QUERY_NAMES.has(details.query)) return null;
  if (typeof details.status === "number" && Number.isInteger(details.status)) {
    return `Analytics Engine rejected the ${details.query} query (${details.status}).`;
  }
  return `Analytics Engine rejected the ${details.query} query.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Incomplete payloads are errors. The panel does not invent zeroed totals. */
export function readSemanticAlertSummary(value: unknown): SemanticAlertSummary | null {
  if (!isRecord(value) || !isRecord(value.totals) || !isRecord(value.probability)) return null;
  if (!isRecord(value.meta)) return null;
  if (typeof value.totals.scored !== "number" || typeof value.totals.matched !== "number") {
    return null;
  }
  if (typeof value.totals.failed !== "number" || typeof value.totals.belowThreshold !== "number") {
    return null;
  }
  if (value.totals.matchRate !== null && typeof value.totals.matchRate !== "number") return null;
  if (value.bucket !== "hour" && value.bucket !== "day") return null;
  if (!Array.isArray(value.series) || !Array.isArray(value.failures)) return null;
  if (!Array.isArray(value.probability.bins)) return null;
  if (value.meta.costLane !== "semantic-alert-match") return null;
  return value as SemanticAlertSummary;
}
