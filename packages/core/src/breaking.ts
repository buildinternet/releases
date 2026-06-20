/**
 * Machine-readable breaking-change classification for a release (#1696).
 *
 * Pure, drizzle-free, zod-free — the canonical enum lives here so the schema
 * column (`releases.breaking`), the AI classifier (`@releases/ai-internal/
 * breaking-classifier`), the wire types, and the OSS CLI all read one
 * definition without dragging the composite Drizzle schema into the AI package.
 *
 * Orthogonal to release `type` (feature/rollup describes shape; this describes
 * upgrade risk). `"unknown"` is the fail-open default — every existing row,
 * every row whose source kind doesn't qualify for classification (see
 * `qualifiesForBreakingClassification` in `./kinds`), and every classifier miss
 * reads `"unknown"`, never a false verdict. Ordered low→high risk.
 */
export const BREAKING_LEVELS = [
  /** Could not be determined, or not classified (the fail-open default). */
  "unknown",
  /** No breaking changes — safe to take. */
  "none",
  /** Small or edge-case break, or a shimmed/announced deprecation — most consumers unaffected or trivial migration. */
  "minor",
  /** Removals, signature changes, or required config/data migration — semver-major-worthy. */
  "major",
] as const;

export type BreakingLevel = (typeof BREAKING_LEVELS)[number];

/** True when `value` is one of the {@link BREAKING_LEVELS} members. */
export function isBreakingLevel(value: string): value is BreakingLevel {
  return (BREAKING_LEVELS as readonly string[]).includes(value);
}
