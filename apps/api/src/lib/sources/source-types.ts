import { SOURCE_TYPES, type SourceType } from "@buildinternet/releases-core/source-enums";

const SOURCE_TYPE_SET: ReadonlySet<string> = new Set(SOURCE_TYPES);

/**
 * Normalize and validate REST `?exclude=` input. Trims, lowers, dedupes, and
 * rejects unknown tokens with the offenders. The GraphQL `excludeSourceTypes`
 * arg uses a typed enum and validates at the schema layer instead — this
 * helper is REST-only.
 */
export function parseExcludeSourceTypes(
  raw: ReadonlyArray<string> | string | null | undefined,
): { ok: true; values: SourceType[] } | { ok: false; invalid: string[] } {
  const tokens = (typeof raw === "string" ? raw.split(",") : (raw ?? []))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const normalized = [...new Set(tokens)];
  const invalid = normalized.filter((t) => !SOURCE_TYPE_SET.has(t));
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, values: normalized as SourceType[] };
}

/**
 * Lenient sibling of {@link parseExcludeSourceTypes} for catalog-shaped
 * surfaces that should tolerate stale clients — unknown tokens are silently
 * dropped instead of erroring. Used by the org release-feed `?source_type=`
 * filter.
 */
export function parseSourceTypesLenient(
  raw: ReadonlyArray<string> | string | null | undefined,
): SourceType[] {
  const tokens = (typeof raw === "string" ? raw.split(",") : (raw ?? []))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  return [...new Set(tokens)].filter((t): t is SourceType => SOURCE_TYPE_SET.has(t));
}
