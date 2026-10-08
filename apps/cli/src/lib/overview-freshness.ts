import { timeAgo } from "@buildinternet/releases-core/dates";
import { isOverviewStale, overviewAgeDays } from "@buildinternet/releases-core/overview";

/**
 * Timestamps that describe when an overview body was written.
 *
 * `generatedAt` is the original creation time and never moves on amend.
 * `updatedAt` is the last content write (initial generate or later amend).
 * Reader surfaces must use content freshness — not original generation —
 * for "how old is this overview?" signals.
 */
export interface OverviewFreshnessInput {
  generatedAt?: string | null;
  updatedAt?: string | null;
  releaseCount: number;
  citationCount?: number;
}

/**
 * Instant that reflects when the overview *content* was last written.
 * Prefers `updatedAt` (amend/write), falls back to `generatedAt`.
 */
export function overviewContentAt(overview: {
  generatedAt?: string | null;
  updatedAt?: string | null;
}): string | null {
  return overview.updatedAt ?? overview.generatedAt ?? null;
}

/** Age in whole days of the overview content (updatedAt, else generatedAt). */
export function overviewContentAgeDays(
  overview: { generatedAt?: string | null; updatedAt?: string | null },
  now: number = Date.now(),
): number | null {
  const at = overviewContentAt(overview);
  return at ? overviewAgeDays(at, now) : null;
}

/**
 * Whether the overview body is past the 30-day reader stale threshold.
 * Uses content write time, not original generation.
 */
export function isOverviewContentStale(
  overview: { generatedAt?: string | null; updatedAt?: string | null },
  now: number = Date.now(),
): boolean {
  const at = overviewContentAt(overview);
  return at ? isOverviewStale(at, now) : false;
}

function ageLabel(iso: string | null | undefined): string {
  return iso ? (timeAgo(iso) ?? "?") : "?";
}

/**
 * Compares overview timestamps by instant, falling back to raw value comparison
 * when either value is missing or cannot be parsed.
 */
export function timestampsDifferMeaningfully(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  if (!first || !second) return first !== second;

  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs) || !Number.isFinite(secondMs)) return first !== second;

  return firstMs !== secondMs;
}

/**
 * Builds the human-readable freshness line shown above an org overview.
 * When an overview has been amended, surfaces `updated` ahead of the original
 * `generated` time so readers don't treat a fresh amend as 3 months old.
 */
export function formatOverviewFreshnessLine(overview: OverviewFreshnessInput): string {
  const generatedLabel = ageLabel(overview.generatedAt);
  const releaseLabel = `${overview.releaseCount} releases contributing`;
  const citationLabel =
    overview.citationCount === undefined ? "" : ` · ${overview.citationCount} citations`;

  if (
    overview.updatedAt &&
    timestampsDifferMeaningfully(overview.updatedAt, overview.generatedAt)
  ) {
    return `updated ${ageLabel(overview.updatedAt)} · generated ${generatedLabel} · ${releaseLabel}${citationLabel}`;
  }

  return `generated ${generatedLabel} · ${releaseLabel}${citationLabel}`;
}

/**
 * Compact freshness hint for the org-get overview preview (no release count).
 */
export function formatOverviewFreshnessHint(overview: {
  generatedAt?: string | null;
  updatedAt?: string | null;
}): string | null {
  if (
    overview.updatedAt &&
    timestampsDifferMeaningfully(overview.updatedAt, overview.generatedAt)
  ) {
    return `updated ${ageLabel(overview.updatedAt)} · generated ${ageLabel(overview.generatedAt)}`;
  }
  if (overview.generatedAt || overview.updatedAt) {
    return `generated ${ageLabel(overviewContentAt(overview))}`;
  }
  return null;
}
