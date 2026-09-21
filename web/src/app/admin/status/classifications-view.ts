/**
 * Pure helpers for the Status Classifications tab. No React — bun:test covers
 * the range clamp, labels, and hrefs without rendering.
 */
import { releasePath } from "@buildinternet/releases-core/release-slug";
import type {
  ClassificationBucket,
  ClassificationChoiceSeriesPoint,
  ClassificationOrigin,
  ClassificationRecentResponse,
  ClassificationSummary,
} from "./classifications-types";

export type ClassificationDateRange = "today" | "week" | "month" | "all";

export type ClassificationViewState = "loading" | "empty" | "error" | "ready";

export interface ClassificationWindow {
  after: string;
  before: string;
  bucket: ClassificationBucket;
}

/** Analytics Engine retains about three months. Never send a null `after`. */
export const CLASSIFICATION_RETENTION_DAYS = 90;

export const DEFAULT_CLASSIFICATION_ORIGIN: ClassificationOrigin = "ingest";

export const CLASSIFICATION_ORIGIN_OPTIONS: readonly ClassificationOrigin[] = [
  "ingest",
  "manual",
  "eval",
  "all",
];

export const PROBABILITY_THRESHOLD_LABEL = "0.80 threshold";

export const EMPTY_MARK = "—";

export const CLASSIFICATIONS_EMPTY_COPY = "No classifications in this range.";

export const CLASSIFICATIONS_ERROR_COPY =
  "Classifications failed to load. The rest of Status is unaffected.";

export const CLASSIFICATIONS_LOADING_COPY = "Loading classifications…";

const DAY_MS = 24 * 60 * 60 * 1000;

export function classificationBucket(dateRange: ClassificationDateRange): ClassificationBucket {
  return dateRange === "today" || dateRange === "week" ? "hour" : "day";
}

export function classificationWindow(input: {
  dateRange: ClassificationDateRange;
  after: string | null;
  now?: Date;
}): ClassificationWindow {
  const now = input.now ?? new Date();
  const after =
    input.after ?? new Date(now.getTime() - CLASSIFICATION_RETENTION_DAYS * DAY_MS).toISOString();
  return {
    after,
    before: now.toISOString(),
    bucket: classificationBucket(input.dateRange),
  };
}

export function classificationSummaryUrl(
  range: ClassificationWindow,
  origin: ClassificationOrigin,
): string {
  const qs = new URLSearchParams({
    after: range.after,
    before: range.before,
    bucket: range.bucket,
    origin,
  });
  return `/api/proxy/admin/classifications/summary?${qs.toString()}`;
}

export function classificationRecentUrl(
  range: ClassificationWindow,
  origin: ClassificationOrigin,
  options?: { cursor?: string | null; limit?: number },
): string {
  const qs = new URLSearchParams({
    after: range.after,
    before: range.before,
    origin,
    limit: String(options?.limit ?? 50),
  });
  if (options?.cursor) qs.set("cursor", options.cursor);
  return `/api/proxy/admin/classifications/recent?${qs.toString()}`;
}

/**
 * Error hides the panels. Empty is only a loaded summary with nothing
 * classified — a still-loading or missing total stays on the loading line.
 */
export function classificationViewState(input: {
  loading: boolean;
  error: boolean;
  classified: number | null;
}): ClassificationViewState {
  if (input.error) return "error";
  if (input.loading || input.classified == null) return "loading";
  if (input.classified === 0) return "empty";
  return "ready";
}

/** `rate` is a 0–1 fraction. Null (no denominator) is an em dash, not 0%. */
export function formatSuppressionRate(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return EMPTY_MARK;
  const pct = Math.round(rate * 1000) / 10;
  const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  return `${text}%`;
}

/** Null and 0.8 must not collapse to the same mark. Two decimals keep 0.80. */
export function formatProbability(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return EMPTY_MARK;
  return value.toFixed(2);
}

/**
 * Under a dollar, keep cents. Under a cent, keep enough digits that a real
 * cost does not round to $0.
 */
export function formatClassificationCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return EMPTY_MARK;
  const sign = usd < 0 ? "-" : "";
  const abs = Math.abs(usd);
  if (abs === 0) return "$0.00";
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  const digits = Math.min(8, Math.max(4, Math.ceil(-Math.log10(abs))));
  const fixed = abs.toFixed(digits);
  if (Number(fixed) === 0) return `${sign}$${abs.toExponential(2)}`;
  return `${sign}$${fixed}`;
}

/**
 * 0.80 is the start of its bin. The previous bin's end is exclusive, so the
 * threshold is not inside 0.7–0.8.
 */
export function thresholdBinIndex(
  bins: readonly { start: number; end: number }[],
  threshold: number,
): number {
  const byStart = bins.findIndex((bin) => bin.start === threshold);
  if (byStart >= 0) return byStart;
  return bins.findIndex((bin) => threshold >= bin.start && threshold < bin.end);
}

/** Blank and all-zero choices are omitted from the distribution chart. */
export function visibleChoiceKeys(
  series: readonly Pick<ClassificationChoiceSeriesPoint, "choices">[],
): string[] {
  const totals = new Map<string, number>();
  for (const point of series) {
    for (const [choice, count] of Object.entries(point.choices)) {
      if (!choice || typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
      totals.set(choice, (totals.get(choice) ?? 0) + count);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([choice]) => choice);
}

export function sourceHref(item: {
  orgSlug?: string | null;
  sourceSlug?: string | null;
}): string | null {
  const org = item.orgSlug?.trim();
  const slug = item.sourceSlug?.trim();
  if (org && slug) return `/${org}/${slug}`;
  if (slug) return `/source/${slug}`;
  return null;
}

export function sourceLabel(item: {
  sourceName?: string | null;
  sourceSlug?: string | null;
}): string {
  const name = item.sourceName?.trim();
  if (name) return name;
  const slug = item.sourceSlug?.trim();
  if (slug) return slug;
  return EMPTY_MARK;
}

export function releaseHref(item: {
  releaseId?: string | null;
  releaseTitle?: string | null;
}): string | null {
  const id = item.releaseId?.trim();
  const title = item.releaseTitle?.trim();
  if (!id || !title) return null;
  return releasePath({ id, title });
}

/** No id → em dash. A title without an id is not linked and not shown as one. */
export function releaseLabel(item: {
  releaseId?: string | null;
  releaseTitle?: string | null;
}): string {
  if (!item.releaseId?.trim()) return EMPTY_MARK;
  return item.releaseTitle?.trim() || EMPTY_MARK;
}

export function decisionReason(item: {
  reason?: string | null;
  failureCategory?: string | null;
}): string {
  const reason = item.reason?.trim();
  if (reason) return reason;
  const failure = item.failureCategory?.trim();
  if (failure) return failure;
  return EMPTY_MARK;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Incomplete payloads are errors. The tab does not invent zeroed panels. */
export function readClassificationSummary(value: unknown): ClassificationSummary | null {
  if (!isRecord(value) || !isRecord(value.totals) || !isRecord(value.probability)) return null;
  const selected = value.probability.selected;
  const confidence = value.probability.confidence;
  if (typeof value.totals.classified !== "number") return null;
  if (value.bucket !== "hour" && value.bucket !== "day") return null;
  if (!Array.isArray(value.series)) return null;
  if (!isRecord(selected) || !Array.isArray(selected.bins)) return null;
  if (!isRecord(confidence) || !Array.isArray(confidence.bins)) return null;
  return value as ClassificationSummary;
}

export function readClassificationRecent(value: unknown): ClassificationRecentResponse | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const nextCursor = value.nextCursor;
  return {
    items: value.items as ClassificationRecentResponse["items"],
    nextCursor: typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null,
  };
}
