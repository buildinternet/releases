/**
 * Compose the version-bounded slice of a source's releases for the
 * `whats_changed` upgrade-intelligence endpoint (#1697). Given a source's
 * releases and a `{ from, to }` version pair, return the ordered subset in the
 * half-open range `(from, to]` — `from` exclusive (you already have it), `to`
 * inclusive (the version you're upgrading to).
 *
 * Pure and runtime-neutral (core is zod-free): inputs in, structured result
 * out. No DB, no fetch — the caller loads already-ingested releases and passes
 * them in. Mirrors the style of `changelog-slice.ts`.
 *
 * Bounding strategy:
 *   - **version-bounded (primary):** when both `from` and `to` parse to a
 *     {@link computeVersionSort} key, filter to releases whose `versionSort` is
 *     in `(fromSort, toSort]` and sort ascending (oldest→newest in the range,
 *     the natural upgrade-path reading order). Releases with a null
 *     `versionSort` (purely-alphabetic versions) can't be placed on the version
 *     axis and are excluded from this path.
 *   - **date-bounded (fallback):** when `from` or `to` is NOT a numeric version
 *     (e.g. an alphabetic codename), locate the `from`/`to` releases by exact
 *     `version` match and bound the rest by `publishedAt` in
 *     `(fromDate, toDate]`, ascending.
 *   - otherwise → empty (a valid answer, never an error).
 */

import { computeVersionSort } from "./version-sort";

export interface UpgradeRangeEntry {
  version: string | null;
  /** Lexicographically-sortable key from {@link computeVersionSort}; null for non-numeric versions. */
  versionSort: string | null;
  /** ISO-8601 timestamp; used for the date-bounded fallback + tiebreak. */
  publishedAt: string | null;
}

/** ASC string compare — versionSort keys and ISO timestamps both sort lexically. */
function asc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Return the releases in `(from, to]`, ordered oldest→newest. Generic over the
 * entry shape so callers get their own rows back (with summary/breaking/url/…
 * intact), filtered and sorted. Empty array when nothing falls in range or the
 * bounds can't be resolved — never throws.
 */
export function resolveUpgradeRange<T extends UpgradeRangeEntry>(
  releases: readonly T[],
  range: { from: string; to: string },
): T[] {
  const fromSort = computeVersionSort(range.from);
  const toSort = computeVersionSort(range.to);

  // Primary: version-bounded via the lexicographic versionSort key.
  if (fromSort !== null && toSort !== null) {
    return releases
      .filter(
        (r): r is T & { versionSort: string } =>
          r.versionSort !== null && r.versionSort > fromSort && r.versionSort <= toSort,
      )
      .sort((a, b) => asc(a.versionSort, b.versionSort));
  }

  // Fallback: a non-numeric bound (e.g. "jaguar") can't be version-ordered —
  // anchor on the from/to releases by exact version string and bound by date.
  const fromRel = releases.find((r) => r.version === range.from);
  const toRel = releases.find((r) => r.version === range.to);
  if (fromRel?.publishedAt && toRel?.publishedAt) {
    const fromDate = fromRel.publishedAt;
    const toDate = toRel.publishedAt;
    return releases
      .filter(
        (r): r is T & { publishedAt: string } =>
          r.publishedAt !== null && r.publishedAt > fromDate && r.publishedAt <= toDate,
      )
      .sort((a, b) => asc(a.publishedAt, b.publishedAt));
  }

  return [];
}
