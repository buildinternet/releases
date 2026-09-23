/**
 * The search-page tab filter, shared between the server page (which parses
 * the `?filter=` deep link) and the client results component (which owns the
 * live tab state). Lives outside the "use client" component module so the
 * server page can call `parseSearchFilter` during SSR.
 */

export type SearchFilter = "all" | "orgs" | "products" | "collections" | "releases";

export const SEARCH_FILTERS: { value: SearchFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "orgs", label: "Organizations" },
  { value: "products", label: "Products" },
  { value: "collections", label: "Collections" },
  { value: "releases", label: "Releases" },
];

const FILTER_VALUES = new Set<string>(SEARCH_FILTERS.map((f) => f.value));

/** Parse a `?filter=` query param, falling back to "all" for junk values. */
export function parseSearchFilter(raw: string | undefined | null): SearchFilter {
  return raw && FILTER_VALUES.has(raw) ? (raw as SearchFilter) : "all";
}
