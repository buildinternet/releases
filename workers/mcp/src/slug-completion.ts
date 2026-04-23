import { asc, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { organizations, products, sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "./db.js";

const COMPLETE_LIMIT = 20;

/** Strip SQL LIKE wildcards so user-supplied `%`/`_` can't widen the match; trim whitespace-only input to empty so the caller's early-return can skip the query. */
function sanitize(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.toLowerCase().replace(/[%_]/g, "");
}

/**
 * Case-insensitive substring match against slug + display name, ranking
 * prefix hits first and capping at 20 slugs. Substring LIKE forces a full
 * table scan — acceptable at current catalog scale (low-thousands of rows)
 * since a leading wildcard defeats B-tree indexes regardless. Revisit with
 * FTS5 or trigram indexing if a table grows by 100×.
 */
async function completeBySlugOrName(
  db: D1Db,
  table: SQLiteTable,
  slugCol: SQLiteColumn,
  nameCol: SQLiteColumn,
  value: string,
): Promise<string[]> {
  const needle = sanitize(value);
  if (!needle) return [];
  const substring = `%${needle}%`;
  const prefix = `${needle}%`;
  const rows = await db
    .select({ slug: slugCol })
    .from(table)
    .where(
      or(sql`LOWER(${slugCol}) LIKE ${substring}`, sql`LOWER(${nameCol}) LIKE ${substring}`) as SQL,
    )
    .orderBy(
      sql`CASE WHEN LOWER(${slugCol}) LIKE ${prefix} OR LOWER(${nameCol}) LIKE ${prefix} THEN 0 ELSE 1 END`,
      asc(slugCol),
    )
    .limit(COMPLETE_LIMIT);
  return rows.map((r) => r.slug as string);
}

export const completeOrgSlug = (db: D1Db, value: string) =>
  completeBySlugOrName(db, organizations, organizations.slug, organizations.name, value);

export const completeProductSlug = (db: D1Db, value: string) =>
  completeBySlugOrName(db, products, products.slug, products.name, value);

export const completeSourceSlug = (db: D1Db, value: string) =>
  completeBySlugOrName(db, sources, sources.slug, sources.name, value);
