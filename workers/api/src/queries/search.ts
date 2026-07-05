import { asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  domainAliases,
  organizationsActive,
  organizationsPublic,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { toFtsMatchQuery } from "@buildinternet/releases-core/fts";
import { likeContains } from "@buildinternet/releases-core/sql-like";
import { rankEntityCandidates, ENTITY_CANDIDATE_LIMIT } from "@releases/lib/entity-match";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
import type { D1Db } from "../db.js";
import type {
  ReleaseType,
  SearchOrgHit,
  SearchCatalogHit,
  RawSourceHit,
  SearchCollectionHit,
  CollectionMember,
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
  /** Raw source.metadata JSON — parsed into the App Store icon/platform (#1206). */
  sourceMetadata?: string | null;
  orgSlug: string | null;
  orgName: string | null;
  /** Owning product's slug (for product-aware byline links); null for orphan sources. */
  productSlug: string | null;
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
  /** Breaking-change level (#1696/#1710). `"unknown"` fail-open default; NULL
   *  only on rows predating the column. Optional because the hybrid (Vectorize)
   *  hit-builder path constructs rows without it. */
  breaking?: string | null;
  /** Number of demoted siblings rolling up via `release_coverage` (0 when standalone). */
  coverageCount: number;
}

/**
 * Optional `orgId` narrows the result set to a single organization. Used
 * by the `?domain=` filter on /v1/search — the route resolves the domain
 * to an org first and then passes the id through here, which keeps the
 * filter applied at the SQL layer instead of post-filtering after a
 * wider query.
 *
 * `includeEmpty` opts back into orgs that have no indexed releases yet
 * (#746). Defaulted off in the LIKE-on-name path because curator stubs
 * inflate the result set with noise; the `?domain=` short-circuit always
 * surfaces the resolved org regardless.
 *
 * `kind` filters by entity kind. For releases, COALESCE(source.kind,
 * product.kind) is applied. For catalog rows (products/sources), only the
 * row's own `kind` column is matched — no inheritance.
 *
 * `since` / `until` are canonical ISO bounds on `published_at` (resolved from
 * any relative shorthand by the route). They apply only to the release
 * helpers; the org/product/source helpers ignore them. Both bounds drop rows
 * with a NULL `published_at`.
 */
type ScopeOpts = {
  orgId?: string;
  includeEmpty?: boolean;
  kind?: string;
  since?: string;
  until?: string;
  /**
   * Narrow release hits to these specific source IDs. Used by the
   * `?product=` filter on `/v1/search` — the route pre-resolves the product
   * to its source list and passes the IDs through here so both the FTS path
   * and the entity-enrichment path stay scoped.
   *
   * Chunked at 90 IDs per `IN` clause to stay inside D1's 100-bound limit.
   * When the array is empty (product has no sources) the query returns no
   * release hits — mirrors the "no matching org sources" behaviour.
   */
  sourceIds?: string[];
};

/**
 * Build an `IN (...)` value list from a `sourceIds` scope, chunked at 90 IDs
 * to stay inside D1's 100-bound limit. Callers guard the empty-array case
 * before reaching here (an empty product returns no hits, not `IN ()`).
 */
function sourceIdInList(sourceIds: string[]) {
  return sql`(${sql.join(
    sourceIds.slice(0, 90).map((id) => sql`${id}`),
    sql`, `,
  )})`;
}

// ── Entity matching ───────────────────────────────────────────────────
//
// The entity helpers below candidate via SQL `LIKE %q%` (cheap, index-free,
// and a strict superset of what we keep), then post-filter and rank in TS
// through `rankEntityCandidates` (@releases/lib/entity-match — shared with the
// MCP worker so both surfaces stay in lockstep). Substring-only candidates —
// "ai" hitting React Em·ai·l or the `.ai` TLD — are dropped, and the survivors
// order by match tier (exact > name prefix > name word > slug/domain >
// category) instead of the alphabetical ORDER BY that used to stand in for
// relevance.

/** Split a `GROUP_CONCAT(domain)` column back into hostnames (commas can't
 * appear inside a hostname, so the default separator is unambiguous). */
function splitConcat(value: string | null): string[] {
  return value ? value.split(",") : [];
}

export async function searchOrgs(
  db: D1Db,
  query: string,
  limit: number,
  opts: ScopeOpts = {},
): Promise<SearchOrgHit[]> {
  const nonEmptyClause = opts.includeEmpty
    ? sql``
    : sql`AND EXISTS (
        SELECT 1
        FROM sources_visible s2
        JOIN releases_visible r2 ON r2.source_id = s2.id
        WHERE s2.org_id = o.id
      )`;

  const candidates = await db.all<SearchOrgHit & { aliasDomains: string | null }>(sql`
    SELECT o.slug, o.name, o.domain, o.avatar_url as avatarUrl, o.category,
           GROUP_CONCAT(da.domain) as aliasDomains
    FROM organizations_active o
    LEFT JOIN domain_aliases da ON da.org_id = o.id
    WHERE (${likeContains(sql`o.name`, query)} OR ${likeContains(sql`o.slug`, query)}
      OR ${likeContains(sql`o.domain`, query)} OR ${likeContains(sql`da.domain`, query)}
      OR ${likeContains(sql`o.category`, query)})
      ${opts.orgId ? sql`AND o.id = ${opts.orgId}` : sql``}
      ${nonEmptyClause}
    GROUP BY o.id
    ORDER BY o.name LIMIT ${ENTITY_CANDIDATE_LIMIT}
  `);
  return rankEntityCandidates(candidates, query, limit, (c) => ({
    name: c.name,
    slug: c.slug,
    domains: [c.domain, ...splitConcat(c.aliasDomains)],
    categories: [c.category],
  })).map(({ aliasDomains: _drop, ...hit }) => hit);
}

export async function searchProducts(
  db: D1Db,
  query: string,
  limit: number,
  opts: ScopeOpts = {},
): Promise<SearchCatalogHit[]> {
  // When sourceIds is an empty array the caller has a product with no sources;
  // return no hits to avoid an invalid `IN ()` clause.
  if (opts.sourceIds && opts.sourceIds.length === 0) return [];
  // When narrowing by sourceIds, restrict to products that own any of those
  // sources (via an EXISTS subquery against sources_active).
  const sourceIdExistsClause =
    opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND EXISTS (
          SELECT 1 FROM sources_visible sa
          WHERE sa.product_id = p.id
            AND sa.id IN ${sourceIdInList(opts.sourceIds)}
        )`
      : sql``;
  const candidates = await db.all<SearchCatalogHit & { aliasDomains: string | null }>(sql`
    SELECT p.slug, p.name, o.slug as orgSlug, o.name as orgName,
           o.avatar_url as orgAvatarUrl, p.category, 'product' as entryType, p.kind,
           GROUP_CONCAT(da.domain) as aliasDomains
    FROM products_active p
    INNER JOIN organizations_active o ON o.id = p.org_id
    LEFT JOIN domain_aliases da ON da.product_id = p.id
    WHERE (${likeContains(sql`p.name`, query)} OR ${likeContains(sql`p.slug`, query)}
      OR ${likeContains(sql`da.domain`, query)})
      ${opts.orgId ? sql`AND o.id = ${opts.orgId}` : sql``}
      ${opts.kind ? sql`AND p.kind = ${opts.kind}` : sql``}
      ${sourceIdExistsClause}
      AND EXISTS (SELECT 1 FROM sources_visible sv WHERE sv.product_id = p.id)
    GROUP BY p.id
    ORDER BY p.name LIMIT ${ENTITY_CANDIDATE_LIMIT}
  `);
  return rankEntityCandidates(candidates, query, limit, (c) => ({
    name: c.name,
    slug: c.slug,
    domains: splitConcat(c.aliasDomains),
  })).map(({ aliasDomains: _drop, ...hit }) => hit);
}

export async function searchSources(
  db: D1Db,
  query: string,
  limit: number,
  opts: ScopeOpts = {},
): Promise<RawSourceHit[]> {
  // When sourceIds is an empty array the caller has a product with no sources;
  // short-circuit to avoid an invalid `IN ()` clause.
  if (opts.sourceIds && opts.sourceIds.length === 0) return [];
  const sourceIdClause =
    opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND s.id IN ${sourceIdInList(opts.sourceIds)}`
      : sql``;
  // `s.stargazers_count as stars` is selected for the SearchSourceHit shape;
  // catalog-hit surfacing of stars is deferred with the search-results render
  // (foldSourcesIntoCatalog drops it today).
  const candidates = await db.all<RawSourceHit & { url: string | null }>(sql`
    SELECT s.slug, s.name, s.type, s.url, o.slug as orgSlug, o.name as orgName,
           o.avatar_url as orgAvatarUrl,
           p.slug as productSlug, p.name as productName, p.category as productCategory,
           s.kind as entityKind, s.stargazers_count as stars
    FROM sources_active s
    LEFT JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (${likeContains(sql`s.name`, query)} OR ${likeContains(sql`s.slug`, query)}
        OR ${likeContains(sql`s.url`, query)})
      ${opts.orgId ? sql`AND s.org_id = ${opts.orgId}` : sql``}
      ${opts.kind ? sql`AND s.kind = ${opts.kind}` : sql``}
      ${sourceIdClause}
    ORDER BY s.name LIMIT ${ENTITY_CANDIDATE_LIMIT}
  `);
  return rankEntityCandidates(candidates, query, limit, (c) => ({
    name: c.name,
    slug: c.slug,
    urls: [c.url],
  })).map(({ url: _drop, ...hit }) => hit);
}

export async function searchReleasesFts(
  db: D1Db,
  query: string,
  limit: number,
  offset: number,
  opts: { includeCoverage?: boolean } & ScopeOpts = {},
): Promise<RawSearchReleaseRow[]> {
  // When sourceIds is an empty array the caller has a product with no sources;
  // short-circuit to avoid an invalid `IN ()` clause and return no hits.
  if (opts.sourceIds && opts.sourceIds.length === 0) return [];
  const sourceIdClause =
    opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND r.source_id IN ${sourceIdInList(opts.sourceIds)}`
      : sql``;
  const ftsQuery = toFtsMatchQuery(query);
  return db.all<RawSearchReleaseRow>(sql`
    SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
           s.metadata as sourceMetadata,
           o.slug as orgSlug, o.name as orgName, p.slug as productSlug,
           r.version, r.title,
           COALESCE(r.summary, SUBSTR(r.content, 1, 150)) as summary,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.breaking as breaking,
           r.content as content,
           r.media as media,
           r.published_at as publishedAt,
           r.type as type,
           ${sql.raw(COVERAGE_COUNT_EXPR)} as coverageCount
    FROM releases_fts
    JOIN releases r ON r.rowid = releases_fts.rowid
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE releases_fts MATCH ${ftsQuery}
      AND (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${opts.includeCoverage ? sql`` : sql`AND r.id IN (SELECT id FROM releases_visible)`}
      ${opts.orgId ? sql`AND s.org_id = ${opts.orgId}` : sql``}
      ${sourceIdClause}
      ${opts.kind ? sql`AND COALESCE(s.kind, p.kind) = ${opts.kind}` : sql``}
      ${opts.since ? sql`AND r.published_at >= ${opts.since}` : sql``}
      ${opts.until ? sql`AND r.published_at <= ${opts.until}` : sql``}
    ORDER BY rank LIMIT ${limit} OFFSET ${offset}
  `);
}

export async function searchReleasesFromMatchedEntities(
  db: D1Db,
  orgSlugs: string[],
  productSlugs: string[],
  limit: number,
  opts: { includeCoverage?: boolean } & ScopeOpts = {},
): Promise<RawSearchReleaseRow[]> {
  // When sourceIds is an empty array the caller has a product with no sources;
  // short-circuit to avoid an invalid `IN ()` clause and return no hits.
  if (opts.sourceIds && opts.sourceIds.length === 0) return [];
  const sourceIdClause =
    opts.sourceIds && opts.sourceIds.length > 0
      ? sql`AND r.source_id IN ${sourceIdInList(opts.sourceIds)}`
      : sql``;
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
           s.metadata as sourceMetadata,
           o.slug as orgSlug, o.name as orgName, p.slug as productSlug,
           r.version, r.title,
           COALESCE(r.summary, SUBSTR(r.content, 1, 150)) as summary,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.breaking as breaking,
           r.content as content,
           r.media as media,
           r.published_at as publishedAt,
           r.type as type,
           ${sql.raw(COVERAGE_COUNT_EXPR)} as coverageCount
    FROM ${opts.includeCoverage ? sql`releases` : sql`releases_visible`} r
    JOIN sources_active s ON s.id = r.source_id
    LEFT JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE (s.is_hidden = 0 OR s.is_hidden IS NULL)
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      AND (${sql.join(conditions, sql` OR `)})
      ${sourceIdClause}
      ${opts.kind ? sql`AND COALESCE(s.kind, p.kind) = ${opts.kind}` : sql``}
      ${opts.since ? sql`AND r.published_at >= ${opts.since}` : sql``}
      ${opts.until ? sql`AND r.published_at <= ${opts.until}` : sql``}
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

// ── Collection search helpers ─────────────────────────────────────────
//
// Two complementary paths surface collections on /v1/search:
//
//  - `searchCollectionsDirect`   — LIKE on the collection's own
//                                  name/slug/description. Cheap. Runs in
//                                  every mode so a user typing the
//                                  collection's name doesn't need vectors.
//  - `findCollectionsByMemberOrgs` — joins through `collection_members` so
//                                  a collection containing a hit org rolls
//                                  up automatically. Independent of the
//                                  query string — driven entirely by the
//                                  org-hit set the caller already
//                                  computed.
//
// Both go through `organizationsPublic`/`collectionMembers`, so soft-deleted
// and `on_demand` orgs never inflate `memberCount` or leak via a collection.

/**
 * LIKE-based collection match. `memberCount` is computed in the same query
 * via a correlated subquery against `collectionMembers` ⋈ `organizationsPublic`
 * so the wire row is final without a second round-trip.
 */
export async function searchCollectionsDirect(
  db: D1Db,
  query: string,
  limit: number,
): Promise<SearchCollectionHit[]> {
  // Correlated subquery: count publicly visible members per collection.
  // Sub-100µs at our scale (collections table is tiny); a window function
  // would be overkill.
  const memberCountSql = sql<number>`(
    SELECT COUNT(*)
    FROM ${collectionMembers} cm
    INNER JOIN ${organizationsPublic} op ON op.id = cm.org_id
    WHERE cm.collection_id = ${collections.id}
  )`;
  const rows = await db.all<{
    slug: string;
    name: string;
    description: string | null;
    memberCount: number;
  }>(sql`
    SELECT ${collections.slug} as slug,
           ${collections.name} as name,
           ${collections.description} as description,
           ${memberCountSql} as memberCount
    FROM ${collections}
    WHERE ${likeContains(sql`${collections.name}`, query)}
       OR ${likeContains(sql`${collections.slug}`, query)}
       OR ${likeContains(sql`${collections.description}`, query)}
    ORDER BY ${collections.name}
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    memberCount: Number(r.memberCount),
    via: "direct" as const,
  }));
}

/**
 * Roll up: given the org-hit set the caller already computed for this
 * query, find every collection containing one of those orgs and return the
 * collection plus the subset of org slugs that triggered the rollup. Lets
 * the UI render "shown because Vercel is in this collection" without a
 * second round-trip.
 *
 * Returns `[]` when `orgSlugs` is empty — callers should skip the SQL.
 */
export async function findCollectionsByMemberOrgs(
  db: D1Db,
  orgSlugs: string[],
  limit: number,
): Promise<SearchCollectionHit[]> {
  if (orgSlugs.length === 0) return [];
  const memberCountSql = sql<number>`(
    SELECT COUNT(*)
    FROM ${collectionMembers} cm2
    INNER JOIN ${organizationsPublic} op2 ON op2.id = cm2.org_id
    WHERE cm2.collection_id = ${collections.id}
  )`;
  const rows = await db.all<{
    slug: string;
    name: string;
    description: string | null;
    memberCount: number;
    matchedOrgSlug: string;
  }>(sql`
    SELECT ${collections.slug} as slug,
           ${collections.name} as name,
           ${collections.description} as description,
           ${memberCountSql} as memberCount,
           ${organizationsPublic.slug} as matchedOrgSlug
    FROM ${collections}
    INNER JOIN ${collectionMembers} cm ON cm.collection_id = ${collections.id}
    INNER JOIN ${organizationsPublic} ON ${organizationsPublic.id} = cm.org_id
    WHERE ${organizationsPublic.slug} IN (${sql.join(
      orgSlugs.map((s) => sql`${s}`),
      sql`, `,
    )})
    ORDER BY ${collections.name}, ${organizationsPublic.slug}
  `);
  // SQLite has no array_agg; the row-by-row fold is cheap at our scale
  // (typical collection sizes are <10 orgs, total collections <100).
  const byCollection = new Map<string, SearchCollectionHit>();
  for (const r of rows) {
    const existing = byCollection.get(r.slug);
    if (existing) {
      existing.matchedOrgSlugs!.push(r.matchedOrgSlug);
    } else {
      byCollection.set(r.slug, {
        slug: r.slug,
        name: r.name,
        description: r.description,
        memberCount: Number(r.memberCount),
        via: "member",
        matchedOrgSlugs: [r.matchedOrgSlug],
      });
    }
  }
  return [...byCollection.values()].slice(0, limit);
}

/**
 * Attach a small org-avatar preview to already-merged collection hits so the
 * search card can render the same facepile as the collections list page. Runs
 * once over the final hit set (after `mergeCollectionHits`) rather than threading
 * previews through each origin query. Org-kind only and capped at 3 — search's
 * `memberCount` counts org members, so the facepile's "+N more" stays consistent.
 * `githubHandle` is null (avatar falls back to the stored URL / a monogram),
 * matching the category preview's trade-off.
 */
export async function attachCollectionPreviews(
  db: D1Db,
  hits: SearchCollectionHit[],
): Promise<SearchCollectionHit[]> {
  const COLLECTION_PREVIEW_LIMIT = 3;
  if (hits.length === 0) return hits;
  const rows = await db
    .select({
      collectionSlug: collections.slug,
      slug: organizationsPublic.slug,
      name: organizationsPublic.name,
      domain: organizationsPublic.domain,
      avatarUrl: organizationsPublic.avatarUrl,
    })
    .from(collectionMembers)
    .innerJoin(collections, eq(collections.id, collectionMembers.collectionId))
    .innerJoin(organizationsPublic, eq(organizationsPublic.id, collectionMembers.orgId))
    .where(
      inArray(
        collections.slug,
        hits.map((h) => h.slug),
      ),
    )
    .orderBy(collectionMembers.position, organizationsPublic.name);

  const previewBySlug = new Map<string, CollectionMember[]>();
  for (const r of rows) {
    const arr = previewBySlug.get(r.collectionSlug) ?? [];
    if (arr.length < COLLECTION_PREVIEW_LIMIT) {
      arr.push({
        kind: "org",
        slug: r.slug,
        name: r.name,
        domain: r.domain,
        avatarUrl: r.avatarUrl,
        githubHandle: null,
        description: null,
      });
    }
    previewBySlug.set(r.collectionSlug, arr);
  }

  return hits.map((h) => {
    const previewMembers = previewBySlug.get(h.slug);
    return previewMembers && previewMembers.length > 0 ? { ...h, previewMembers } : h;
  });
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
