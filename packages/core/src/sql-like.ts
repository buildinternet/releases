import { sql, type SQL } from "drizzle-orm";

/** Escape `\`, `%`, `_` so user input matches as a literal substring. Pair with `LIKE ? ESCAPE '\'`. */
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Build a `column LIKE %query% ESCAPE '\'` fragment from raw user input.
 * Centralises the escape + ESCAPE-clause pairing so call sites can't drift
 * apart and forget one or the other.
 */
export function likeContains(column: SQL, query: string): SQL {
  const pattern = `%${escapeLikePattern(query)}%`;
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
