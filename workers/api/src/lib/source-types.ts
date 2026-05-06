export const SOURCE_TYPES = ["github", "scrape", "feed", "agent"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

const SOURCE_TYPE_SET: ReadonlySet<string> = new Set(SOURCE_TYPES);

/**
 * Normalize and validate `?exclude=` input shared by REST. Trims, lowers,
 * dedupes, and rejects unknown tokens with the offenders. The GraphQL
 * `excludeSourceTypes` arg uses a typed enum instead, so this is REST-only.
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
