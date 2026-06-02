"use client";

import { useSearch } from "./search-provider";
import { SearchResults } from "./search-results";

/**
 * Renders the shared search results from the provider. Seeded with the server's
 * initial results on first paint (so deep links / no-JS still show results),
 * then driven entirely by the client-side live search after that.
 */
export function SearchResultsLive() {
  const search = useSearch();
  // Highlight against the committed (debounced) query so tokens track the
  // fetched results instead of repainting the whole list on every keystroke.
  return <SearchResults query={search?.committedQuery} results={search?.results ?? null} />;
}
