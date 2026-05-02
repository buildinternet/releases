import { asc, desc, ne, or, sql, type Column, type SQL } from "drizzle-orm";
import { sources, releases, organizations } from "@buildinternet/releases-core/schema";

/**
 * Returns `[col IS NULL, col ASC|DESC]` — a two-key ORDER BY that sinks NULLs
 * to the bottom regardless of direction. Callers append their own tiebreakers.
 */
export function nullsLastOrderBy(col: Column, dir: "asc" | "desc"): SQL[] {
  return [sql`${col} IS NULL`, dir === "asc" ? asc(col) : desc(col)];
}

/** Exclude hidden sources: (is_hidden = 0 OR is_hidden IS NULL) */
export const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;

/** Exclude suppressed releases — for use in Drizzle WHERE clauses */
export const notSuppressed = sql`(${releases.suppressed} IS NULL OR ${releases.suppressed} = 0)`;

/** Exclude coverage-side releases — use as a bare Drizzle condition via `and(notCoverage, ...)`. */
export const notCoverage = sql`NOT EXISTS (SELECT 1 FROM release_coverage WHERE release_coverage.coverage_id = ${releases.id})`;

/** Exclude on-demand orgs (anonymous lookup-materialized rows) from public catalog views. */
export const orgNotOnDemand = or(
  ne(organizations.discovery, "on_demand"),
  sql`${organizations.discovery} IS NULL`,
);

/** Common row type for source list items with release stats */
export type SourceWithStats = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  is_primary: number | null;
  is_hidden: number | null;
  fetch_priority: string | null;
  last_fetched_at: string | null;
  last_polled_at: string | null;
  release_count: number;
  latest_version_by_date: string | null;
  latest_date: string | null;
  latest_version_by_fetch: string | null;
  latest_added_at: string | null;
  product_slug: string | null;
  product_name: string | null;
};

/** Common row type for org list items */
export type OrgListRow = {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  source_count: number;
  release_count: number;
  last_activity: string | null;
  recent_release_count: number;
  top_products: string | null;
};
