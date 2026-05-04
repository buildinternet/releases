import { asc, eq, or, sql, type SQL } from "drizzle-orm";
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

/**
 * Catalog completers return `org/slug` coordinates, not bare slugs. The
 * downstream tools (`summarize_changes`, `compare_products`,
 * `get_latest_releases`, `get_catalog_entry`) reject bare slugs because per-org
 * slug uniqueness (#690) makes them ambiguous, so handing back a bare slug
 * would invite a 400 on the next tool call. Org completion stays bare because
 * `organizations.slug` is still globally unique.
 */
async function completeCoordinate(
  db: D1Db,
  table: SQLiteTable,
  slugCol: SQLiteColumn,
  nameCol: SQLiteColumn,
  orgIdCol: SQLiteColumn,
  value: string,
): Promise<string[]> {
  const needle = sanitize(value);
  if (!needle) return [];
  const substring = `%${needle}%`;
  const prefix = `${needle}%`;
  const rows = await db
    .select({ slug: slugCol, orgSlug: organizations.slug })
    .from(table)
    .innerJoin(organizations, eq(orgIdCol, organizations.id))
    .where(
      or(sql`LOWER(${slugCol}) LIKE ${substring}`, sql`LOWER(${nameCol}) LIKE ${substring}`) as SQL,
    )
    .orderBy(
      sql`CASE WHEN LOWER(${slugCol}) LIKE ${prefix} OR LOWER(${nameCol}) LIKE ${prefix} THEN 0 ELSE 1 END`,
      asc(slugCol),
    )
    .limit(COMPLETE_LIMIT);
  return rows.map((r) => `${r.orgSlug}/${r.slug}`);
}

export const completeProductSlug = (db: D1Db, value: string) =>
  completeCoordinate(db, products, products.slug, products.name, products.orgId, value);

export const completeSourceSlug = (db: D1Db, value: string) =>
  completeCoordinate(db, sources, sources.slug, sources.name, sources.orgId, value);

/**
 * Union product + source coordinate completion for the unified catalog
 * resource. Fires both lookups in parallel; coordinate collisions across the
 * two spaces are de-duped (products win). Capped at COMPLETE_LIMIT so the
 * MCP client doesn't receive more than expected.
 */
export async function completeCatalogSlug(db: D1Db, value: string): Promise<string[]> {
  const [productCoords, sourceCoords] = await Promise.all([
    completeProductSlug(db, value),
    completeSourceSlug(db, value),
  ]);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const coord of [...productCoords, ...sourceCoords]) {
    if (seen.has(coord)) continue;
    seen.add(coord);
    merged.push(coord);
    if (merged.length >= COMPLETE_LIMIT) break;
  }
  return merged;
}
