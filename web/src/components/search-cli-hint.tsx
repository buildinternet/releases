"use client";

import { useSearch } from "./search-provider";
import { InlineCopyCode } from "./inline-copy-code";

/**
 * The "From the CLI: …" hint under the search box, kept in sync with the live
 * query so it always reflects what's in the box (falling back to a placeholder
 * example when empty).
 */
export function SearchCliHint() {
  const search = useSearch();
  // Track the committed query so the command matches the results on screen and
  // doesn't rebuild on every keystroke.
  const query = search?.committedQuery.trim() || "vercel";
  return (
    <p className="mt-2 text-[12px] text-stone-400 dark:text-stone-500">
      From the CLI:{" "}
      <InlineCopyCode code={`npx @buildinternet/releases search "${query.replace(/"/g, '\\"')}"`} />
    </p>
  );
}
