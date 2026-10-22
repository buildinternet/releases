import { RELEASE_TYPES, type ReleaseType } from "./schema.js";

/**
 * Map any value onto a stored release `type` (`feature` or `rollup`).
 *
 * Those two values pass through. Missing values and anything else — including
 * labels a model invents (`"fix"`, `"update"`), which the extraction JSON-schema
 * enum does not reliably reject — become `"feature"`. Call this wherever a
 * release row is written, and when resolving GraphQL `Release.type`: that
 * field is a non-null enum, so one unknown stored value nulls the parent list.
 */
export function coerceReleaseType(value: unknown): ReleaseType {
  if (typeof value === "string" && (RELEASE_TYPES as readonly string[]).includes(value)) {
    return value as ReleaseType;
  }
  return "feature";
}
