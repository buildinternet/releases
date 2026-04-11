/** Cadence classification and product color utilities for release timeline visualization. */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** Default fetch cap per source — counts at this value are likely truncated. */
export const FETCH_CAP = 200;

export function fmtWeek(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export type CadenceKey = "daily" | "weekly" | "biweekly" | "monthly" | "sparse";

export interface CadenceInfo {
  label: string;
  key: CadenceKey;
}

/**
 * Classify release cadence from average releases per week.
 * Thresholds align with the playground's day-gap logic converted to weekly rates.
 */
export function getCadenceInfo(avgPerWeek: number): CadenceInfo {
  if (avgPerWeek >= 2.3) return { label: "Daily", key: "daily" };
  if (avgPerWeek >= 0.7) return { label: "Weekly", key: "weekly" };
  if (avgPerWeek >= 0.35) return { label: "Biweekly", key: "biweekly" };
  if (avgPerWeek >= 0.15) return { label: "Monthly", key: "monthly" };
  return { label: "Sparse", key: "sparse" };
}

/**
 * Product color palette — CSS custom property references.
 * These map to --color-product-N defined in globals.css.
 */
export const PRODUCT_COLORS = [
  "var(--color-product-0)",
  "var(--color-product-1)",
  "var(--color-product-2)",
  "var(--color-product-3)",
  "var(--color-product-4)",
  "var(--color-product-5)",
  "var(--color-product-6)",
  "var(--color-product-7)",
] as const;

export function getProductColor(index: number): string {
  return PRODUCT_COLORS[index % PRODUCT_COLORS.length];
}

/** Format an interval in days to a human-readable string with hours resolution. */
export function fmtInterval(days: number): string {
  const hours = days * 24;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (days < 2) return `${Math.round(hours)}h`;
  return `${Math.round(days)}d`;
}

/** Format a version string — prepend "v" only for semver-ish versions (starting with a digit). */
export function fmtVersion(v: string): string {
  return /^\d/.test(v) ? `v${v}` : v;
}

/** Bucket release dates into weekly counts for sparklines and overview charts. */
export interface WeeklyBucket {
  weekStart: Date;
  count: number;
  earliestVersion?: string | null;
  latestVersion?: string | null;
}

/** Parse raw weekly bucket data from API into WeeklyBucket objects. */
export function parseBuckets(raw: Array<{ weekStart: string; count: number; earliestVersion?: string | null; latestVersion?: string | null }>): WeeklyBucket[] {
  return raw.map((b) => ({
    weekStart: new Date(b.weekStart),
    count: b.count,
    earliestVersion: b.earliestVersion ?? null,
    latestVersion: b.latestVersion ?? null,
  }));
}

export function bucketByWeek(
  dates: Date[],
  rangeStart: Date,
  rangeEnd: Date,
): WeeklyBucket[] {
  const weekMs = WEEK_MS;
  const totalMs = rangeEnd.getTime() - rangeStart.getTime();
  const bucketCount = Math.max(1, Math.ceil(totalMs / weekMs));
  const buckets: WeeklyBucket[] = [];

  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      weekStart: new Date(rangeStart.getTime() + i * weekMs),
      count: 0,
    });
  }

  for (const date of dates) {
    const idx = Math.min(
      Math.floor((date.getTime() - rangeStart.getTime()) / weekMs),
      bucketCount - 1,
    );
    if (idx >= 0) buckets[idx].count++;
  }

  return buckets;
}
