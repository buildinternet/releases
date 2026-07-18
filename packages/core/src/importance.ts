/**
 * AI-scored release importance (1–5).
 *
 * Pure, drizzle-free, zod-free — the canonical range lives here so the schema
 * column (`releases.importance`), the AI parser (`@releases/ai-internal`
 * release-content), the wire-schema bounds, and route validation all read one
 * definition, following the `./breaking` precedent.
 *
 * Semantics: 5 = landmark (significant beyond the vendor's own users),
 * 4 = major for the vendor, 3 = notable, 2 = routine, 1 = housekeeping.
 * `null` (no score) is the fail-open default — unscored history, empty
 * bodies, and parser misses all read `null`, never a fabricated score.
 */
export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 5;

/**
 * High-signal floor — the AI-scored importance at/above which a release is
 * "notable" (`4` = major, `5` = landmark). This is the same threshold the web
 * flame glyph renders at (`ImportanceMarker`) and the overview/digest selectors
 * bias toward. Consumers that gate on "is this important enough to surface"
 * (e.g. deprioritizing routine mobile-app updates out of cross-promo rails)
 * should compare `(importance ?? 0) >= IMPORTANCE_HIGH` so an unscored (`null`)
 * release folds below the floor rather than being treated as important.
 */
export const IMPORTANCE_HIGH = 4;

/** True when `value` is an integer within the 1–5 importance range. */
export function isImportanceScore(value: number): boolean {
  return Number.isInteger(value) && value >= IMPORTANCE_MIN && value <= IMPORTANCE_MAX;
}
