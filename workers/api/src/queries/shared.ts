import { and, asc, desc, eq, inArray, sql, type Column, type SQL } from "drizzle-orm";
import { orgAccounts } from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../db.js";

/**
 * Returns `[col IS NULL, col ASC|DESC]` — a two-key ORDER BY that sinks NULLs
 * to the bottom regardless of direction. Callers append their own tiebreakers.
 */
export function nullsLastOrderBy(col: Column, dir: "asc" | "desc"): SQL[] {
  return [sql`${col} IS NULL`, dir === "asc" ? asc(col) : desc(col)];
}

/** Common row type for source list items with release stats */
export type SourceWithStats = {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string;
  is_primary: number | null;
  is_hidden: number | null;
  discovery: "curated" | "agent" | "on_demand" | null;
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
  kind: string | null;
  metadata: string | null;
};

// D1 caps prepared statements at 100 bound params; chunk `inArray` lookups at 90.
const ORG_ID_CHUNK = 90;

/**
 * Batched replacement for a correlated per-row github-handle lookup: loads the
 * earliest-created (ties broken by `id`) github `org_accounts.handle` for each
 * of the given org ids in one or more chunked `IN` queries, instead of a
 * scalar subquery re-run once per result row. `org_accounts` only enforces
 * UNIQUE(platform, handle) globally -- not per (org, platform) -- so a
 * multi-handle org needs this same deterministic tiebreak.
 *
 * Callers: run the main query selecting plain org id columns, collect the
 * distinct org ids across the result rows, call this once, then map
 * `githubHandle` from the returned `Map` (absent key -> no github account,
 * map to `null`). Backed by `idx_org_accounts_org_platform (org_id, platform)`.
 */
export async function loadOrgGithubHandles(
  db: AnyDb,
  orgIds: readonly string[],
): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(orgIds)];
  if (uniqueIds.length === 0) return new Map();

  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += ORG_ID_CHUNK) {
    chunks.push(uniqueIds.slice(i, i + ORG_ID_CHUNK));
  }

  const rowsByChunk = await Promise.all(
    chunks.map((idChunk) =>
      db
        .select({ orgId: orgAccounts.orgId, handle: orgAccounts.handle })
        .from(orgAccounts)
        .where(and(inArray(orgAccounts.orgId, idChunk), eq(orgAccounts.platform, "github")))
        .orderBy(asc(orgAccounts.createdAt), asc(orgAccounts.id)),
    ),
  );

  const handles = new Map<string, string>();
  for (const row of rowsByChunk.flat()) {
    if (!handles.has(row.orgId)) handles.set(row.orgId, row.handle);
  }
  return handles;
}

/** Common row type for org list items */
export type OrgListRow = {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  avatar_url: string | null;
  featured: number;
  tier: "stub" | "tracked";
  source_count: number;
  release_count: number;
  last_activity: string | null;
  recent_release_count: number;
  top_products: string | null;
  alias_domains: string | null;
};
