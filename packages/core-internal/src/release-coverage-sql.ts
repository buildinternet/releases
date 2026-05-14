/**
 * Correlated subquery yielding the count of demoted siblings rolling up into
 * a release via `release_coverage`. Assumes the outer query aliases
 * `releases` (or `releases_visible`) as `r`. Callers add their own `AS …`
 * alias because some SQL sites prefer snake_case (`coverage_count`) and
 * others camelCase (`coverageCount`) on the wire.
 *
 * Implemented as a correlated scalar — runs once per output row via the
 * `idx_release_coverage_canonical` index — rather than a materialized
 * `LEFT JOIN (... GROUP BY canonical_id) rc`, which would scan the entire
 * `release_coverage` table on every list/search query.
 *
 * `COUNT(*)` returns 0 (never NULL) when the release has no siblings, so
 * callers don't need to `COALESCE` it.
 */
export const COVERAGE_COUNT_EXPR =
  "(SELECT COUNT(*) FROM release_coverage WHERE canonical_id = r.id)";
