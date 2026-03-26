import { searchReleasesForApi } from "../../db/fts.js";

export function handleSearch(q: string, limit: number, offset: number) {
  const results = searchReleasesForApi(q, limit, offset);
  return { query: q, results };
}
