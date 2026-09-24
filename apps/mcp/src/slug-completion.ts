import { and, asc, eq, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable, SQLiteView } from "drizzle-orm/sqlite-core";
import {
  organizationsActive,
  productsActive,
  sourcesVisible,
} from "@buildinternet/releases-core/schema";
import type { D1Db } from "./db.js";

const COMPLETE_LIMIT = 20;

// Completion suggests what the directory and catalog would list, so it reads
// the live views: soft-deleted orgs, products, and sources never appear, and
// neither do hidden orgs or hidden sources (`list_organizations` and
// `list_catalog` omit them too). A hidden org still resolves when typed in
// full; it just isn't suggested.
const orgs = organizationsActive;
const visibleOrg = sql`(${orgs.isHidden} = 0 OR ${orgs.isHidden} IS NULL)`;

type Source = SQLiteTable | SQLiteView;

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
  table: Source,
  slugCol: SQLiteColumn,
  nameCol: SQLiteColumn,
  value: string,
  scope: SQL = sql`1 = 1`,
): Promise<string[]> {
  const needle = sanitize(value);
  if (!needle) return [];
  const substring = `%${needle}%`;
  const prefix = `${needle}%`;
  const rows = await db
    .select({ slug: slugCol })
    .from(table)
    .where(
      and(
        scope,
        or(sql`LOWER(${slugCol}) LIKE ${substring}`, sql`LOWER(${nameCol}) LIKE ${substring}`),
      ) as SQL,
    )
    .orderBy(
      sql`CASE WHEN LOWER(${slugCol}) LIKE ${prefix} OR LOWER(${nameCol}) LIKE ${prefix} THEN 0 ELSE 1 END`,
      asc(slugCol),
    )
    .limit(COMPLETE_LIMIT);
  return rows.map((r) => r.slug as string);
}

export const completeOrgSlug = (db: D1Db, value: string) =>
  completeBySlugOrName(db, orgs, orgs.slug, orgs.name, value, visibleOrg);

/**
 * Catalog completers return `org/slug` coordinates, not bare slugs. The
 * downstream tools (`get_latest_releases`, `get_catalog_entry`) reject bare
 * slugs because per-org slug uniqueness (#690) makes them ambiguous, so
 * handing back a bare slug
 * would invite a 400 on the next tool call. Org completion stays bare because
 * `orgs.slug` is still globally unique.
 *
 * Coordinate-form input — when the user has already typed `org/` or
 * `org/slug-prefix` — gets parsed locally so the org segment narrows results
 * to that org and the slug segment is the substring needle. This keeps the
 * format the completer returns aligned with the format it accepts as input.
 */
async function completeCoordinate(
  db: D1Db,
  table: Source,
  slugCol: SQLiteColumn,
  nameCol: SQLiteColumn,
  orgIdCol: SQLiteColumn,
  value: string,
): Promise<string[]> {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");

  // Coordinate form: filter by exact org slug + substring on the slug segment.
  // Empty slug segment (just "vercel/") returns every catalog entry under that org.
  if (slash >= 0) {
    const orgNeedle = trimmed.slice(0, slash).toLowerCase().trim();
    const slugNeedle = sanitize(trimmed.slice(slash + 1));
    if (!orgNeedle) return [];
    const slugSubstring = `%${slugNeedle}%`;
    const slugPrefix = `${slugNeedle}%`;
    const rows = await db
      .select({ slug: slugCol, orgSlug: orgs.slug })
      .from(table)
      .innerJoin(orgs, eq(orgIdCol, orgs.id))
      .where(
        and(
          visibleOrg,
          eq(sql`LOWER(${orgs.slug})`, orgNeedle),
          slugNeedle ? (sql`LOWER(${slugCol}) LIKE ${slugSubstring}` as SQL) : sql`1 = 1`,
        ) as SQL,
      )
      .orderBy(sql`CASE WHEN LOWER(${slugCol}) LIKE ${slugPrefix} THEN 0 ELSE 1 END`, asc(slugCol))
      .limit(COMPLETE_LIMIT);
    return rows.map((r) => `${r.orgSlug}/${r.slug}`);
  }

  // Bare-prefix form: fan out across slug + display name.
  const needle = sanitize(trimmed);
  if (!needle) return [];
  const substring = `%${needle}%`;
  const prefix = `${needle}%`;
  const rows = await db
    .select({ slug: slugCol, orgSlug: orgs.slug })
    .from(table)
    .innerJoin(orgs, eq(orgIdCol, orgs.id))
    .where(
      and(
        visibleOrg,
        or(sql`LOWER(${slugCol}) LIKE ${substring}`, sql`LOWER(${nameCol}) LIKE ${substring}`),
      ) as SQL,
    )
    .orderBy(
      sql`CASE WHEN LOWER(${slugCol}) LIKE ${prefix} OR LOWER(${nameCol}) LIKE ${prefix} THEN 0 ELSE 1 END`,
      asc(slugCol),
    )
    .limit(COMPLETE_LIMIT);
  return rows.map((r) => `${r.orgSlug}/${r.slug}`);
}

export const completeProductSlug = (db: D1Db, value: string) =>
  completeCoordinate(
    db,
    productsActive,
    productsActive.slug,
    productsActive.name,
    productsActive.orgId,
    value,
  );

export const completeSourceSlug = (db: D1Db, value: string) =>
  completeCoordinate(
    db,
    sourcesVisible,
    sourcesVisible.slug,
    sourcesVisible.name,
    sourcesVisible.orgId,
    value,
  );

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
