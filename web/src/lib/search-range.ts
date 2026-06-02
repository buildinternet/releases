/**
 * Timeframe presets for the search page. The single source of truth for the
 * range dropdown, the URL `?range=` contract, and the `since` value forwarded
 * to `/v1/search`. Each `since` is a relative-shorthand string the API's
 * `resolveDateParam` understands (`Nd`/`Nw`/`Nm`/`Ny`); "Any time" carries no
 * bound.
 */
export type SearchRangeKey = "any" | "30d" | "3m" | "6m" | "1y" | "2y";

export const SEARCH_RANGES: { key: SearchRangeKey; label: string; since?: string }[] = [
  { key: "any", label: "Any time" },
  { key: "30d", label: "Past 30 days", since: "30d" },
  { key: "3m", label: "Past 3 months", since: "3m" },
  { key: "6m", label: "Past 6 months", since: "6m" },
  { key: "1y", label: "Past year", since: "1y" },
  { key: "2y", label: "Past 2 years", since: "2y" },
];

/** Default window: bias to recent so stale releases don't rank on top. */
export const DEFAULT_RANGE: SearchRangeKey = "1y";

/** The API `since` shorthand for a range key, or `undefined` for "any time". */
export function rangeSince(key: SearchRangeKey): string | undefined {
  return SEARCH_RANGES.find((r) => r.key === key)?.since;
}

/**
 * Coerce arbitrary input (a URL `?range=` value, etc.) to a known key,
 * defaulting to {@link DEFAULT_RANGE} when unrecognized or absent.
 */
export function parseRangeKey(raw: string | null | undefined): SearchRangeKey {
  return SEARCH_RANGES.some((r) => r.key === raw) ? (raw as SearchRangeKey) : DEFAULT_RANGE;
}
