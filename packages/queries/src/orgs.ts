/**
 * Org reads shared by the MCP worker (and, as they converge, the API).
 *
 * Visibility follows the API:
 * - Direct lookups (`findOrgByAnyIdentifier`) skip soft-deleted orgs but
 *   still resolve hidden ones, like `GET /v1/orgs/:slug`.
 * - Directory listings (`listOrgDirectoryPage`) skip deleted and hidden orgs,
 *   like `getOrgsWithStats` behind `GET /v1/orgs`.
 */
import { sql, type SQL } from "drizzle-orm";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import type { AnyDb } from "@releases/lib/db";

/**
 * Correlated EXISTS: "the outer `o` org has at least one visible release"
 * (#746 empty-org filter). The outer query must alias the org table as `o`.
 */
export const orgHasVisibleRelease = sql`EXISTS (
  SELECT 1
  FROM sources_visible s2
  JOIN releases_visible r2 ON r2.source_id = s2.id
  WHERE s2.org_id = o.id
)`;

export interface OrgLookupRow {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  metadata: string | null;
  tier: "stub" | "tracked";
}

/**
 * Resolve an org by `org_` id, slug, primary domain, case-insensitive name,
 * domain alias, or account handle, in one round-trip. Reads
 * `organizations_active`, so a soft-deleted org never matches on any key
 * (including its mangled `<slug>--<id>` slug). Hidden orgs still resolve:
 * they are left out of listings, not out of direct lookups.
 */
export async function findOrgByAnyIdentifier(
  db: AnyDb,
  identifier: string,
): Promise<OrgLookupRow | null> {
  const id = identifier.trim();
  const rows = await db.all<OrgLookupRow>(sql`
    SELECT o.id, o.name, o.slug, o.domain, o.description, o.category, o.metadata, o.tier
    FROM organizations_active o
    WHERE o.id = ${id} OR o.slug = ${id} OR o.domain = ${id} OR LOWER(o.name) = LOWER(${id})
    UNION
    SELECT o.id, o.name, o.slug, o.domain, o.description, o.category, o.metadata, o.tier
    FROM organizations_active o
    JOIN domain_aliases da ON da.org_id = o.id
    WHERE da.domain = ${id}
    UNION
    SELECT o.id, o.name, o.slug, o.domain, o.description, o.category, o.metadata, o.tier
    FROM organizations_active o
    JOIN org_accounts oa ON oa.org_id = o.id
    WHERE oa.handle = ${id}
    LIMIT 1
  `);
  return rows[0] ?? null;
}

export interface OrgDirectoryFilter {
  /** Substring match on name, slug, primary domain, alias domain, or account handle. */
  query?: string;
  /** Only orgs with an account on this platform (e.g. `github`). */
  platform?: string;
  /** Canonical category slug (caller resolves aliases). */
  category?: string;
  /** Include orgs with no visible releases. Stub-tier orgs are always included. */
  includeEmpty?: boolean;
  limit: number;
  offset: number;
}

export interface OrgDirectoryRow {
  name: string;
  slug: string;
  domain: string | null;
  tier: "stub" | "tracked";
}

/**
 * One page of the org directory plus the filter-aware total. Hidden and
 * soft-deleted orgs never appear. The `query` match is broader than the
 * API's (`orgListWhere` matches name and slug only).
 */
export async function listOrgDirectoryPage(
  db: AnyDb,
  f: OrgDirectoryFilter,
): Promise<{ rows: OrgDirectoryRow[]; total: number }> {
  const q = f.query || undefined;
  const joins: SQL[] = [];
  const conds: SQL[] = [sql`o.is_hidden = 0`];

  if (q) joins.push(sql`LEFT JOIN domain_aliases da ON da.org_id = o.id`);
  if (f.platform) joins.push(sql`JOIN org_accounts oa ON oa.org_id = o.id`);
  else if (q) joins.push(sql`LEFT JOIN org_accounts oa ON oa.org_id = o.id`);

  if (q) {
    conds.push(sql`(${likeContains(sql`o.name`, q)}
      OR ${likeContains(sql`o.slug`, q)}
      OR ${likeContains(sql`o.domain`, q)}
      OR ${likeContains(sql`da.domain`, q)}
      OR ${likeContains(sql`oa.handle`, q)})`);
  }
  if (f.platform) conds.push(sql`oa.platform = ${f.platform}`);
  // Stub orgs (#1947) have no releases by design but belong in the directory.
  if (!f.includeEmpty) conds.push(sql`(${orgHasVisibleRelease} OR o.tier = 'stub')`);
  if (f.category) conds.push(sql`o.category = ${f.category}`);

  const fromWhere = sql`FROM organizations_active o ${sql.join(joins, sql` `)}
    WHERE ${sql.join(conds, sql` AND `)}`;
  // Alias/account joins fan one org into several rows; dedupe only when joined.
  const fannedOut = joins.length > 0;

  const [rows, totalRow] = await Promise.all([
    db.all<OrgDirectoryRow>(sql`
      SELECT ${fannedOut ? sql`DISTINCT` : sql``} o.name, o.slug, o.domain, o.tier
      ${fromWhere}
      ORDER BY o.name, o.slug
      LIMIT ${f.limit} OFFSET ${f.offset}
    `),
    fannedOut
      ? db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM (SELECT DISTINCT o.id ${fromWhere})`)
      : db.all<{ n: number }>(sql`SELECT COUNT(*) AS n ${fromWhere}`),
  ]);
  return { rows, total: Number(totalRow[0]?.n ?? 0) };
}
