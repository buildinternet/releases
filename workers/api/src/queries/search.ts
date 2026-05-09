import { asc, eq, or, sql } from "drizzle-orm";
import { domainAliases, organizationsActive } from "@buildinternet/releases-core/schema";
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import type { D1Db } from "../db.js";
import type {
  ReleaseType,
  SearchOrgHit,
  SearchCatalogHit,
  RawSourceHit,
} from "@buildinternet/releases-api-types";

/**
 * Raw release row returned by the search queries. `content` and `media`
 * still need media-URL hydration + JSON parsing — the route does that so
 * SQL helpers stay thin.
 */
export interface RawSearchReleaseRow {
  id: string;
  sourceSlug: string;
  sourceName: string;
  sourceType: string;
  orgSlug: string | null;
  orgName: string | null;
  version: string | null;
  title: string;
  summary: string;
  /** Raw markdown with media URLs not yet rewritten through MEDIA_ORIGIN. */
  content: string;
  /** JSON-encoded MediaItem[] or null. */
  media: string | null;
  publishedAt: string | null;
  /** Release type — "feature" (default) or "rollup". */
  type: ReleaseType;
  titleGenerated: string | null;
  titleShort: string | null;
}

/**
 * Optional `orgId` narrows the result set to a single organization. Used
 * by the `?domain=` filter on /v1/search — the route resolves the domain
 * to an org first and then passes the id through here, which keeps the
 * filter applied at the SQL layer instead of post-filtering after a
 * wider query.
 */
type ScopeOpts = { orgId?: string };

export async function searchOrgs(
  db: D1Db,
  query: string,
  limit: number,
  opts: ScopeOpts = {},
): Promise<SearchOrgHit[]> {
  return db.all<SearchOrgHit>(sql`
    SELECT DISTINCT o.slug, o.name, o.domain, NULL as avatarUrl, o.category
    FROM organizations_active o
    LEFT JOIN domain_aliases da ON da.org_id = o.id
    WHERE (${likeContains(sql`o.name`, query)} OR ${likeContains(sql`o.slug`, query)}
      OR ${likeContains(sql`o.domain`, query)} OR ${likeContains(sql`da.domain`, query)})
      ${opts.orgId ? sql`AND o.id = ${opts.orgId}` : sql``}
    ORDER BY o.name LIMIT ${limit}
  `);
}

export async function searchProducts(
  db: D1Db,
  query: string,
  limit: number,
  opts: ScopeOpts = {},
): Promise<SearchCatalogHit[]> {
  return db.all<SearchCatalogHit>(sql`
    SELECT DISTINCT p.slug, p.name, o.slug as orgSlug, o.name as orgName, p.category,
           'product' as kind
    FROM products_active p
    INNER JOIN organizations_active o ON o.id = p.org_id
    LEFT JOIN domain_aliases da ON da.product_id = p.id
    WHERE (${likeContains(sql`p.name`, query)} OR ${likeContains(sql`p.slug`, query)}
      OR ${likeContains(sql`da.domain`, query)})
      ${opts.orgId ? sql`AND o.id = ${opts.orgId}` : sql``}
    ORDER BY p.name LIMIT ${limit}
  `);
}

export async function searchSources(
  db: D1Db,
  query: string,
  limit: number,
  opts: ScopeOpts = {},
): Promise<RawSourceHit[]> {
  return db.all<RawSourceHit>(sql`
    SELECT s.slug, s.name, s.type, o.slug as orgSlug, o.name as orgName,
           p.slug as productSlug, p.name as productName, p.category as productCategory
    FROM sources_active s
    LEFT JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (${likeContains(sql`s.name`, query)} OR ${likeContains(sql`s.slug`, query)}
        OR ${likeContains(sql`s.url`, query)})
      ${opts.orgId ? sql`AND s.org_id = ${opts.orgId}` : sql``}
    ORDER BY s.name LIMIT ${limit}
  `);
}

export async function searchReleasesFts(
  db: D1Db,
  query: string,
  limit: number,
  offset: number,
  opts: { includeCoverage?: boolean } & ScopeOpts = {},
): Promise<RawSearchReleaseRow[]> {
  const ftsQuery = toFtsMatchQuery(query);
  return db.all<RawSearchReleaseRow>(sql`
    SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
           o.slug as orgSlug, o.name as orgName,
           r.version, r.title,
           COALESCE(r.summary, SUBSTR(r.content, 1, 150)) as summary,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.content as content,
           r.media as media,
           r.published_at as publishedAt,
           r.type as type
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    WHERE releases_fts MATCH ${ftsQuery}
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${opts.includeCoverage ? sql`` : sql`AND r.id IN (SELECT id FROM releases_visible)`}
      ${opts.orgId ? sql`AND s.org_id = ${opts.orgId}` : sql``}
    ORDER BY rank LIMIT ${limit} OFFSET ${offset}
  `);
}

export async function searchReleasesFromMatchedEntities(
  db: D1Db,
  orgSlugs: string[],
  productSlugs: string[],
  limit: number,
  opts: { includeCoverage?: boolean } = {},
): Promise<RawSearchReleaseRow[]> {
  const conditions = [];
  if (orgSlugs.length > 0)
    conditions.push(
      sql`o.slug IN (${sql.join(
        orgSlugs.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (productSlugs.length > 0)
    conditions.push(
      sql`p.slug IN (${sql.join(
        productSlugs.map((s) => sql`${s}`),
        sql`, `,
      )})`,
    );
  if (conditions.length === 0) return [];

  return db.all<RawSearchReleaseRow>(sql`
    SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
           o.slug as orgSlug, o.name as orgName,
           r.version, r.title,
           COALESCE(r.summary, SUBSTR(r.content, 1, 150)) as summary,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.content as content,
           r.media as media,
           r.published_at as publishedAt,
           r.type as type
    FROM ${opts.includeCoverage ? sql`releases` : sql`releases_visible`} r
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (${sql.join(conditions, sql` OR `)})
    ORDER BY r.published_at DESC LIMIT ${limit}
  `);
}

/**
 * Row shape returned by `findOrgByDomain`. `matchedVia` distinguishes a hit
 * on `organizations.domain` from a hit via `domain_aliases`.
 */
export interface OrgByDomainRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  description: string | null;
  category: string | null;
  avatarUrl: string | null;
  matchedVia: "primary" | "alias";
}

/**
 * Resolve a (pre-normalized) domain to its owning org. Single LEFT JOIN
 * against `domain_aliases` handles both primary and alias matches in one
 * round-trip; both columns are uniquely indexed so a single hit is
 * dispositive. Returns `null` when no row matches.
 */
export async function findOrgByDomain(db: D1Db, domain: string): Promise<OrgByDomainRow | null> {
  const [row] = await db
    .select({
      id: organizationsActive.id,
      slug: organizationsActive.slug,
      name: organizationsActive.name,
      domain: organizationsActive.domain,
      description: organizationsActive.description,
      category: organizationsActive.category,
      avatarUrl: organizationsActive.avatarUrl,
      matchedVia: sql<
        "primary" | "alias"
      >`CASE WHEN ${organizationsActive.domain} = ${domain} THEN 'primary' ELSE 'alias' END`,
    })
    .from(organizationsActive)
    .leftJoin(domainAliases, eq(domainAliases.orgId, organizationsActive.id))
    .where(or(eq(organizationsActive.domain, domain), eq(domainAliases.domain, domain)))
    .orderBy(asc(organizationsActive.createdAt), asc(organizationsActive.id))
    .limit(1);
  return row ?? null;
}
