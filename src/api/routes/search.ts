import { unifiedSearchLocal } from "../../db/fts.js";

export function handleSearch(q: string, limit: number, offset: number) {
  return { query: q, ...unifiedSearchLocal(q, limit, offset) };
}
