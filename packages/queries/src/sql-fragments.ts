/**
 * Small SQL fragments reused across read queries. Keep these dialect-neutral
 * where possible; SQLite-isms are called out in docs/architecture/storage-portability.md.
 */
import { asc, desc, sql, type Column, type SQL } from "drizzle-orm";

/**
 * Returns `[col IS NULL, col ASC|DESC]` — a two-key ORDER BY that sinks NULLs
 * to the bottom regardless of direction. Callers append their own tiebreakers.
 */
export function nullsLastOrderBy(col: Column, dir: "asc" | "desc"): SQL[] {
  return [sql`${col} IS NULL`, dir === "asc" ? asc(col) : desc(col)];
}

/**
 * Correlated subquery that picks a single deterministic GitHub handle per org
 * so a multi-handle org doesn't fan out the JOIN. `org_accounts` only enforces
 * UNIQUE(platform, handle) globally — not per (org, platform) — so order by
 * (created_at, id) and take the first.
 *
 * `orgIdExpr` is the outer query's org-id expression, e.g.
 * `` sql`o.id` `` or `` sql`${organizations.id}` ``.
 */
export function githubHandleSubquery(orgIdExpr: SQL) {
  return sql<string | null>`(
    SELECT handle FROM org_accounts
    WHERE org_id = ${orgIdExpr} AND platform = 'github'
    ORDER BY created_at, id LIMIT 1
  )`;
}
