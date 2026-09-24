import { eq, inArray, sql } from "drizzle-orm";
import {
  organizationsPublic,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { COVERAGE_COUNT_EXPR } from "@releases/core-internal/release-coverage-sql";
// Domain → org resolution lives in the shared read layer (packages/queries) so
// MCP `lookup_domain` runs the same query. Re-exported for existing importers.
export { findOrgByDomain, type OrgByDomainRow } from "@releases/queries/domain-lookup";
// Lexical FTS lives in @releases/search so MCP and API share one MATCH site.
// Re-export the row type + helper for existing route/test import paths.
export {
  searchReleasesFts,
  type RawSearchReleaseRow,
  type SearchReleasesFtsOpts,
} from "@releases/search/releases-fts.js";
import type { RawSearchReleaseRow } from "@releases/search/releases-fts.js";
import type { D1Db } from "../db.js";
import type { SearchCollectionHit, CollectionMember } from "@buildinternet/releases-api-types";

export {
  categoryCollectionClauses,
  searchOrgs,
  searchProducts,
  searchSources,
  sourceIdInList,
  splitConcat,
  type ScopeOpts,
} from "@releases/queries/search-entities";
import {
  categoryCollectionClauses,
  sourceIdInList,
  type ScopeOpts,
} from "@releases/queries/search-entities";

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

  const contentSelect = opts.includeContent ? sql`r.content as content,` : sql``;
  return db.all<RawSearchReleaseRow>(sql`
    SELECT r.id as id, s.slug as sourceSlug, s.name as sourceName, s.type as sourceType,
           s.metadata as sourceMetadata,
           o.slug as orgSlug, o.name as orgName, p.slug as productSlug,
           r.version, r.title,
           COALESCE(r.summary, SUBSTR(r.content, 1, 150)) as summary,
           r.url as url,
           r.title_generated as titleGenerated,
           r.title_short as titleShort,
           r.breaking as breaking,
           r.importance as importance,
           ${contentSelect}
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
      ${categoryCollectionClauses(opts, sql`s.org_id`)}
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

// Collection search (direct LIKE + member-org rollup) lives in the shared read
// layer (packages/queries) so the MCP `search` tool runs the same queries.
// Re-exported for existing route/test import paths.
export {
  searchCollectionsDirect,
  findCollectionsByMemberOrgs,
} from "@releases/queries/collections";

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
