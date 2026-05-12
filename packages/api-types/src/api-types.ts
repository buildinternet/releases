/**
 * Shared API response types — single source of truth for the wire protocol.
 * Consumed by: web frontend, MCP worker, OSS CLI, and the API worker.
 */

import type { z } from "zod";

export type {
  SourceType,
  SourceDiscovery,
  SourceFetchPriority,
} from "@buildinternet/releases-core/source-enums";
import type {
  MediaItemSchema,
  PaginationSchema,
  StatsSchema,
  ErrorResponseSchema,
  ReleaseTypeSchema,
  ReleaseItemSchema,
  ReleaseSummaryItemSchema,
  OverviewPageItemSchema,
  OverviewCitationSchema,
} from "./schemas/shared.js";
import type {
  OrgListItemSchema,
  OrgListResponseSchema,
  OrgAccountItemSchema,
  OrgAccountsResponseSchema,
  OrgTagsResponseSchema,
  CreateOrgBodySchema,
  UpdateOrgBodySchema,
  OrgDetailSchema,
} from "./schemas/orgs.js";
import type {
  SourceListItemSchema,
  SourceWithOrgSchema,
  SourceListResponseSchema,
  SourceListResultSchema,
  SourceDetailSchema,
  SourceMutationResponseSchema,
  SourceOrgRefSchema,
  SourcePatchInputSchema,
  CreateSourceBodySchema,
  ChangelogFileSummarySchema,
  SourceChangelogResponseSchema,
} from "./schemas/sources.js";
import type {
  ProductRowSchema,
  ProductListItemSchema,
  ProductListResponseSchema,
  ProductDetailSourceSchema,
  ProductDetailSchema,
  CreateProductBodySchema,
  UpdateProductBodySchema,
  AdoptProductBodySchema,
  ProductAdoptResultSchema,
  ProductAdoptDryRunSchema,
  ProductAdoptResponseSchema,
  ProductDeleteResponseSchema,
} from "./schemas/products.js";
import type {
  ReleaseLatestSourceSchema,
  ReleaseLatestItemSchema,
  ReleaseLatestResponseSchema,
  ReleaseCoverageRowSchema,
  ReleaseCoverageResponseSchema,
  LinkReleaseCoverageBodySchema,
  LinkReleaseCoverageResponseSchema,
  UnlinkReleaseCoverageResponseSchema,
  ReleaseWithMediaRowSchema,
  ReleasesWithMediaResponseSchema,
} from "./schemas/releases.js";
import type {
  LookupStatusSchema,
  LookupBodySchema,
  LookupSourceSchema,
  LookupReleaseSchema,
  LookupRelatedOrgSchema,
  LookupResponseSchema,
  LookupSourceBySlugResponseSchema,
  LookupProductBySlugResponseSchema,
  DomainLookupOrgSchema,
  DomainLookupProductSchema,
  DomainLookupResponseSchema,
} from "./schemas/lookups.js";

export {
  MediaItemSchema,
  PaginationSchema,
  ListResponseSchema,
  StatsSchema,
  ErrorResponseSchema,
  ReleaseTypeSchema,
  ReleaseItemSchema,
  ReleaseSummaryItemSchema,
  OverviewPageItemSchema,
  OverviewCitationSchema,
  CategorySchema,
} from "./schemas/shared.js";
export {
  OrgListItemSchema,
  OrgListResponseSchema,
  OrgAccountItemSchema,
  OrgAccountsResponseSchema,
  OrgTagsResponseSchema,
  CreateOrgBodySchema,
  UpdateOrgBodySchema,
  OrgDetailSchema,
} from "./schemas/orgs.js";
export {
  SourceListItemSchema,
  SourceWithOrgSchema,
  SourceListResponseSchema,
  SourceListResultSchema,
  SourceDetailSchema,
  SourceMutationResponseSchema,
  SourceOrgRefSchema,
  SourcePatchInputSchema,
  CreateSourceBodySchema,
  ChangelogFileSummarySchema,
  SourceChangelogResponseSchema,
} from "./schemas/sources.js";
export {
  ProductRowSchema,
  ProductListItemSchema,
  ProductListResponseSchema,
  ProductDetailSourceSchema,
  ProductDetailSchema,
  CreateProductBodySchema,
  UpdateProductBodySchema,
  AdoptProductBodySchema,
  ProductAdoptResultSchema,
  ProductAdoptDryRunSchema,
  ProductAdoptResponseSchema,
  ProductDeleteResponseSchema,
} from "./schemas/products.js";
export {
  LookupStatusSchema,
  LookupBodySchema,
  LookupSourceSchema,
  LookupReleaseSchema,
  LookupRelatedOrgSchema,
  LookupResponseSchema,
  LookupSourceBySlugResponseSchema,
  LookupProductBySlugResponseSchema,
  DomainLookupOrgSchema,
  DomainLookupProductSchema,
  DomainLookupResponseSchema,
} from "./schemas/lookups.js";
export {
  ReleaseLatestSourceSchema,
  ReleaseLatestItemSchema,
  ReleaseLatestResponseSchema,
  ReleaseCoverageRowSchema,
  ReleaseCoverageResponseSchema,
  LinkReleaseCoverageBodySchema,
  LinkReleaseCoverageResponseSchema,
  UnlinkReleaseCoverageResponseSchema,
  ReleaseWithMediaRowSchema,
  ReleasesWithMediaResponseSchema,
} from "./schemas/releases.js";

// ── Media ──

export type MediaItem = z.infer<typeof MediaItemSchema>;

// ── Stats ──

export type Stats = z.infer<typeof StatsSchema>;

// ── Pagination ──

export type Pagination = z.infer<typeof PaginationSchema>;

export interface ListResponse<T> {
  items: T[];
  pagination: Pagination;
}

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ── Sitemap (bulk URL emission) ──

export interface SitemapPayload {
  orgs: Array<{ slug: string; lastActivity: string | null }>;
  sources: Array<{
    orgSlug: string;
    slug: string;
    latestDate: string | null;
    /**
     * Whether this source has a stored GitHub CHANGELOG file. Used by the web
     * sitemap to emit `/{org}/{src}/changelog` URLs only for sources where the
     * route resolves (#875). Optional for backwards compatibility — older
     * clients ignore it.
     */
    hasChangelog?: boolean;
    /**
     * Whether this source has any rolling or monthly highlight summaries.
     * Drives `/{org}/{src}/highlights` sitemap emission (#875).
     */
    hasHighlights?: boolean;
  }>;
  products: Array<{ orgSlug: string; slug: string }>;
  collections: Array<{ slug: string; updatedAt: string }>;
}

// ── Organizations ──

export type OrgListItem = z.infer<typeof OrgListItemSchema>;
export type OrgListResponse = z.infer<typeof OrgListResponseSchema>;
export type OrgAccountItem = z.infer<typeof OrgAccountItemSchema>;
export type OrgAccountsResponse = z.infer<typeof OrgAccountsResponseSchema>;
export type OrgTagsResponse = z.infer<typeof OrgTagsResponseSchema>;
export type CreateOrgBody = z.infer<typeof CreateOrgBodySchema>;
export type UpdateOrgBody = z.infer<typeof UpdateOrgBodySchema>;

export type OrgDetail = z.infer<typeof OrgDetailSchema>;

// ── Sources ──

export type SourceListItem = z.infer<typeof SourceListItemSchema>;
export type SourceWithOrg = z.infer<typeof SourceWithOrgSchema>;
export type SourceListResponse = z.infer<typeof SourceListResponseSchema>;
export type SourceListResult = z.infer<typeof SourceListResultSchema>;
export type SourcePatchInput = z.infer<typeof SourcePatchInputSchema>;
export type CreateSourceBody = z.infer<typeof CreateSourceBodySchema>;
export type ChangelogFileSummary = z.infer<typeof ChangelogFileSummarySchema>;
export type SourceChangelogResponse = z.infer<typeof SourceChangelogResponseSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
export type SourceMutationResponse = z.infer<typeof SourceMutationResponseSchema>;
export type SourceOrgRef = z.infer<typeof SourceOrgRefSchema>;

// ── Admin telemetry: orgs rollup ──

export interface OrgsRollupRow {
  /** Org slug, or "—" for sources without an org. */
  orgSlug: string;
  sourceCount: number;
  /** Sources with no release on file or `latestDate` older than `staleDays`. */
  staleCount: number;
  /** Most-recent release across all of the org's sources, or null. */
  mostRecentRelease: string | null;
  mostRecentAgeDays: number | null;
  /** True iff every source in the org is stale (and the org has at least one source). */
  allStale: boolean;
}

export interface OrgsRollupResponse extends ListResponse<OrgsRollupRow> {
  meta: {
    /** Stale cutoff used server-side, in days. */
    staleDays: number;
    totalOrgs: number;
    /** Orgs where every source is stale. */
    dormantOrgs: number;
    /** Orgs with at least one stale source. */
    anyStaleOrgs: number;
  };
}

// ── Releases ──

/**
 * Release type — mirrors `RELEASE_TYPES` in `@buildinternet/releases-core/schema`.
 * Optional on the wire so older API responses (mid-deploy or pinned old workers)
 * degrade gracefully — consumers that see `undefined` should treat it as `"feature"`.
 */
export type ReleaseType = z.infer<typeof ReleaseTypeSchema>;

export type ReleaseItem = z.infer<typeof ReleaseItemSchema>;

export interface ReleaseDetail {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  /** AI-generated summary (#852, renamed in #860). Nullable — most rows unpopulated. */
  summary: string | null;
  /**
   * AI-generated self-contained news-headline form of the release (#852,
   * renamed in #860). Nullable because most rows are unpopulated — fall
   * back to `title` for display. `.optional()` for the same mid-deploy /
   * pinned-worker reason as `type` on {@link ReleaseItem}.
   */
  titleGenerated?: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). Same fallback as `titleGenerated`. */
  titleShort?: string | null;
  url: string | null;
  media: MediaItem[];
  publishedAt: string | null;
  fetchedAt: string;
  sourceName: string;
  sourceSlug: string;
  sourceType: string;
  org: { slug: string; name: string } | null;
  /** Release type. See {@link ReleaseType}. */
  type?: ReleaseType;
}

export type ReleaseCoverageRow = z.infer<typeof ReleaseCoverageRowSchema>;
export type ReleaseCoverageResponse = z.infer<typeof ReleaseCoverageResponseSchema>;
export type LinkReleaseCoverageBody = z.infer<typeof LinkReleaseCoverageBodySchema>;
export type LinkReleaseCoverageResponse = z.infer<typeof LinkReleaseCoverageResponseSchema>;
export type UnlinkReleaseCoverageResponse = z.infer<typeof UnlinkReleaseCoverageResponseSchema>;

export type ReleaseLatestSource = z.infer<typeof ReleaseLatestSourceSchema>;
export type ReleaseLatestItem = z.infer<typeof ReleaseLatestItemSchema>;
export type ReleaseLatestResponse = z.infer<typeof ReleaseLatestResponseSchema>;

export type ReleaseWithMediaRow = z.infer<typeof ReleaseWithMediaRowSchema>;
export type ReleasesWithMediaResponse = z.infer<typeof ReleasesWithMediaResponseSchema>;

export type ReleaseSummaryItem = z.infer<typeof ReleaseSummaryItemSchema>;

// ── Search ──

export interface SearchOrgHit {
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
  category: string | null;
}

/**
 * Unified catalog entry — either a product row or a standalone source
 * presented as product-shaped. `kind` routes clicks to the right URL but
 * the two forms are otherwise interchangeable for display. `kind` (not
 * `type`) because source rows already carry `type: github|scrape|feed|agent`
 * on the wire.
 */
export interface SearchCatalogHit {
  slug: string;
  name: string;
  orgSlug: string | null;
  orgName: string | null;
  category: string | null;
  kind: "product" | "source";
  sourceSlug?: string;
  sourceType?: string;
}

/** @deprecated Use SearchCatalogHit. */
export type SearchProductHit = SearchCatalogHit;

export interface SearchSourceHit {
  slug: string;
  name: string;
  type: string;
  orgSlug: string | null;
  orgName: string | null;
  productSlug: string | null;
}

export interface RawSourceHit extends SearchSourceHit {
  productName?: string;
  productCategory?: string;
}

/**
 * Fold source hits into the catalog list. Sources under a matched product
 * are dropped (product wins); orphan sources become `kind: "source"`.
 */
export function foldSourcesIntoCatalog(
  existingProducts: SearchCatalogHit[],
  rawSources: RawSourceHit[],
): SearchCatalogHit[] {
  const result: SearchCatalogHit[] = existingProducts.map((p) => ({ ...p, kind: "product" }));
  const seen = new Set(result.map((p) => p.slug));
  for (const s of rawSources) {
    if (s.productSlug) {
      if (seen.has(s.productSlug)) continue;
      result.push({
        slug: s.productSlug,
        name: s.productName ?? s.name,
        orgSlug: s.orgSlug,
        orgName: s.orgName,
        category: s.productCategory ?? null,
        kind: "product",
      });
      seen.add(s.productSlug);
    } else {
      result.push({
        slug: s.slug,
        name: s.name,
        orgSlug: s.orgSlug,
        orgName: s.orgName,
        category: null,
        kind: "source",
        sourceSlug: s.slug,
        sourceType: s.type,
      });
    }
  }
  return result;
}

/** @deprecated Use foldSourcesIntoCatalog. */
export const foldSourcesIntoProducts = foldSourcesIntoCatalog;

export interface SearchReleaseHit {
  id: string;
  sourceSlug: string;
  sourceName: string;
  /** Source type (github, scrape, feed, agent) — drives the byline icon. */
  sourceType?: string;
  orgSlug: string | null;
  /** Owning organization's display name — byline disambiguation. */
  orgName?: string | null;
  version: string | null;
  title: string;
  summary: string;
  /** AI-generated headline (#852, renamed in #860). Optional + nullable: most rows are unpopulated. */
  titleGenerated?: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). Same caveat as titleGenerated. */
  titleShort?: string | null;
  /**
   * Full release body, media URLs hydrated through the MEDIA_ORIGIN proxy.
   * Present so the web can render the same markdown + thumbnail treatment
   * as the org/source feeds instead of a plain summary snippet.
   */
  content?: string;
  /** Release media with r2Url resolved. Undefined means "not hydrated". */
  media?: MediaItem[];
  publishedAt: string | null;
  /**
   * Hybrid fusion score. Present on hybrid/semantic responses (including
   * degraded fallbacks); absent on the legacy lexical path. Clients can
   * use this to interleave release and chunk hits into a single ranked list.
   */
  score?: number;
  /** Release type. See {@link ReleaseType}. */
  type?: ReleaseType;
}

/**
 * A heading-aware CHANGELOG.md slice returned by hybrid / semantic search.
 * Clients can deep-link to `/source/<sourceSlug>?tab=changelog&offset=<offset>`
 * to read the surrounding file content.
 */
export interface SearchChunkHit {
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  /** Owning organization's display name — byline disambiguation. */
  orgName?: string | null;
  filePath: string;
  offset: number;
  length: number;
  heading: string | null;
  snippet: string;
  score: number;
}

// ── Lookups ──

export type LookupStatus = z.infer<typeof LookupStatusSchema>;
export type LookupBody = z.infer<typeof LookupBodySchema>;
export type LookupSourceRow = z.infer<typeof LookupSourceSchema>;
export type LookupReleaseRow = z.infer<typeof LookupReleaseSchema>;
export type LookupRelatedOrg = z.infer<typeof LookupRelatedOrgSchema>;
export type LookupResponse = z.infer<typeof LookupResponseSchema>;
export type LookupSourceBySlugResponse = z.infer<typeof LookupSourceBySlugResponseSchema>;
export type LookupProductBySlugResponse = z.infer<typeof LookupProductBySlugResponseSchema>;
export type DomainLookupOrg = z.infer<typeof DomainLookupOrgSchema>;
export type DomainLookupProduct = z.infer<typeof DomainLookupProductSchema>;
export type DomainLookupResponse = z.infer<typeof DomainLookupResponseSchema>;

/**
 * Slim wire payload embedded in a search response when the query is a GitHub
 * coordinate (org/repo) and no existing entity matched. The server performs an
 * on-demand lookup and includes the result here so the client can surface a
 * "just indexed" or "not found" rail without a second round trip.
 */
export interface LookupResultPayload {
  status: LookupStatus;
  source?: {
    id: string;
    slug: string;
    name: string;
    url: string;
    discovery: "curated" | "agent" | "on_demand";
  };
  releases?: Array<{
    id: string;
    version: string | null;
    title: string;
    publishedAt: string | null;
  }>;
  /**
   * Unambiguous "did you mean" rail: the curated org that owns GitHub repos
   * under the same org segment, plus its top sources. Null when the org
   * segment matches multiple curated orgs or none.
   */
  relatedOrg: {
    org: { id: string; slug: string; name: string };
    sources: Array<{ id: string; slug: string; name: string; url: string }>;
  } | null;
}

export interface UnifiedSearchResponse {
  query: string;
  /**
   * Normalized form of `?domain=` when the caller passed it. The server
   * does the normalization once and echoes the canonical form back so
   * clients don't have to re-normalize for analytics or display. Absent
   * when no domain filter was applied.
   */
  domain?: string;
  /**
   * Outcome of the `?domain=` resolution step. `"matched"` means the
   * domain resolved to a known org and results below are scoped to it.
   * `"not_found"` means the domain didn't match anything; in that case
   * orgs/catalog/releases will all be empty arrays — the caller can
   * distinguish "no hits in scope" from "scope didn't exist."
   */
  domainStatus?: "matched" | "not_found";
  orgs: SearchOrgHit[];
  /** Products and standalone sources folded into a single list. */
  catalog: SearchCatalogHit[];
  /** @deprecated Use `catalog`. Kept as an alias populated with the same array. */
  products: SearchCatalogHit[];
  sources: SearchSourceHit[];
  releases: SearchReleaseHit[];
  /** Present on hybrid/semantic responses; omitted on pure lexical. */
  chunks?: SearchChunkHit[];
  /** Mode actually used by the server. Present for semantic/hybrid responses. */
  mode?: "lexical" | "semantic" | "hybrid";
  /** True when a hybrid/semantic request fell back to lexical. */
  degraded?: boolean;
  /** Human-readable reason for degradation (e.g., missing Vectorize binding). */
  degradedReason?: string;
  /**
   * On-demand lookup result. Present when the query parsed as a GitHub
   * `org/repo` coordinate and no existing entities matched. Null otherwise.
   */
  lookup?: LookupResultPayload | null;
}

// ── Overview Pages ──

export type OverviewPageItem = z.infer<typeof OverviewPageItemSchema>;
export type OverviewCitation = z.infer<typeof OverviewCitationSchema>;

/** @deprecated Use OverviewPageItem */
export type KnowledgePageItem = OverviewPageItem;

// ── Overview Manifest (admin planning) ──

export type OverviewStaleness = "missing" | "behind" | "fresh";
export type OverviewPlanAction = "missing" | "refresh" | "skip";

/**
 * Per-org row returned by GET /v1/admin/overviews. Designed for orchestrators
 * planning a maintenance sweep — `releasesSinceOverview` is the freshness
 * signal that matters, not date diff alone.
 */
export interface OverviewManifestRow {
  orgSlug: string;
  orgName: string;
  discovery: "curated" | "agent" | "on_demand";
  overviewUpdatedAt: string | null;
  overviewGeneratedAt: string | null;
  lastContributingReleaseAt: string | null;
  orgLastActivity: string | null;
  releasesSinceOverview: number;
  recentReleaseCount: number;
  staleness: OverviewStaleness;
  /** Only populated when ?format=plan. */
  action?: OverviewPlanAction;
  /** Only populated when ?format=plan. */
  needsFetch?: boolean;
}

export type OverviewManifestResponse = ListResponse<OverviewManifestRow>;

// ── Overview inputs (?check=true) ──

/**
 * Lightweight pre-flight payload returned by GET /v1/orgs/:slug/overview/inputs?check=true.
 * Skips the heavy release-content hydration so an orchestrator can decide whether
 * to dispatch without paying for the full payload.
 */
export interface OverviewInputsCheck {
  orgSlug: string;
  selected: number;
  totalAvailable: number;
  hasExistingContent: boolean;
  wouldRegenerate: boolean;
  windowDays: number;
}

/** @deprecated Use UnifiedSearchResponse */
export type SearchResult = SearchReleaseHit;
/** @deprecated Use UnifiedSearchResponse */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

// ── Activity ──

export interface WeeklyBucket {
  weekStart: string;
  count: number;
  earliestVersion: string | null;
  latestVersion: string | null;
}

export interface SourceActivity {
  source: { slug: string; name: string; orgSlug: string | null; orgName: string | null };
  range: { from: string; to: string };
  weeklyBuckets: WeeklyBucket[];
}

export interface OrgActivitySource {
  slug: string;
  name: string;
  releaseCount: number;
  avgReleasesPerWeek: number;
  earliestVersion: string | null;
  latestVersion: string | null;
  latestDate: string | null;
  weeklyBuckets: WeeklyBucket[];
}

export interface OrgActivity {
  org: { slug: string; name: string };
  range: { from: string; to: string };
  sources: OrgActivitySource[];
  aggregateWeekly: Array<{ weekStart: string; count: number }>;
}

// ── Org Sparklines (per-source/product breakdown) ──

export interface OrgSparklines {
  org: { slug: string; name: string };
  range: { from: string; to: string };
  aggregate: number[];
  sources: Array<{ slug: string; name: string; sparkline: number[] }>;
  products: Array<{ slug: string; name: string; sparkline: number[] }>;
}

// ── Org Heatmap ──

export interface OrgHeatmap {
  org: { slug: string; name: string };
  range: { from: string; to: string };
  dailyCounts: Array<{ date: string; count: number }>;
  total: number;
}

// ── Source Heatmap ──

export interface SourceHeatmap {
  source: { slug: string; name: string };
  range: { from: string; to: string };
  dailyCounts: Array<{ date: string; count: number }>;
  total: number;
}

// ── Org Releases ──

export interface OrgReleaseItem extends ReleaseItem {
  source: { slug: string; name: string; type: string };
}

export interface OrgReleasesResponse {
  releases: OrgReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
}

// Source-scoped release feed — the source identity is encoded in the URL, so
// items omit the redundant `source` block carried by the org feed.
export interface SourceReleasesResponse {
  releases: ReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
}

// ── Products ──

// `Category` lives in @buildinternet/releases-core/categories — import it from
// there. CategorySchema is re-exported here for OpenAPI / Zod consumers only.
export type ProductRow = z.infer<typeof ProductRowSchema>;
export type ProductListItem = z.infer<typeof ProductListItemSchema>;
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;
export type ProductDetailSource = z.infer<typeof ProductDetailSourceSchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;
export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;
export type AdoptProductBody = z.infer<typeof AdoptProductBodySchema>;
export type ProductAdoptResult = z.infer<typeof ProductAdoptResultSchema>;
export type ProductAdoptDryRun = z.infer<typeof ProductAdoptDryRunSchema>;
export type ProductAdoptResponse = z.infer<typeof ProductAdoptResponseSchema>;
export type ProductDeleteResponse = z.infer<typeof ProductDeleteResponseSchema>;

// ── Taxonomy (categories + tags) ──

export interface TaxonomyOrg {
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
}

export interface TaxonomyProduct {
  slug: string;
  name: string;
  description: string | null;
  orgSlug: string;
  orgName: string;
}

export interface CategoryDetail {
  slug: string;
  /**
   * Display name — operator override from the `categories` table if present,
   * otherwise `categoryDisplayName(slug)` from `@buildinternet/releases-core`.
   */
  name: string;
  /**
   * Operator-authored byline shown on the web category page. Null when no
   * description has been set; clients render their own fallback copy.
   */
  description: string | null;
  /**
   * Alternative slugs that redirect to this canonical category. Empty when
   * no aliases have been configured.
   */
  aliases: string[];
  orgs: TaxonomyOrg[];
  products: TaxonomyProduct[];
}

/**
 * Item shape on GET /v1/categories — the overview list. Categories are a
 * fixed taxonomy (`CATEGORIES` in `@buildinternet/releases-core/categories`),
 * so the API always returns every slug, including ones with zero members.
 * `orgCount` counts orgs whose `category` matches; `productCount` counts
 * products whose own `category` matches (overriding any parent-org category).
 * Both counts pass through `organizations_public`, so on_demand and
 * soft-deleted orgs are excluded. `description` comes from the optional
 * `categories` metadata overlay; null when no override has been set.
 */
export interface CategoryListItem {
  slug: string;
  name: string;
  description: string | null;
  aliases: string[];
  orgCount: number;
  productCount: number;
}

/**
 * PATCH /v1/categories/:slug request body. All fields are optional. `name`
 * and `description` accept `null` to clear the override; `aliases` replaces
 * the full set when provided (pass `[]` to clear). The row is upserted —
 * a category that has never been customized has no row in the table.
 *
 * Each alias must be a kebab-case slug not already in `CATEGORIES` and not
 * claimed by another category row.
 */
export interface UpdateCategoryRequest {
  name?: string | null;
  description?: string | null;
  aliases?: string[];
}

/**
 * Aggregated release feed row for a category rollup — same wire shape as
 * `CollectionReleaseItem` (both surfaces aggregate releases across multiple
 * orgs). Aliased rather than duplicated so renderers can treat them as one.
 */
export type CategoryReleaseItem = CollectionReleaseItem;

export interface CategoryReleasesResponse {
  releases: CategoryReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
}

export interface TagDetail {
  slug: string;
  name: string;
  orgs: TaxonomyOrg[];
  products: TaxonomyProduct[];
}

// ── Collections ──
//
// Curated, named groups of orgs that drive a public "playlist" page (e.g.
// /collections/frontier-ai-labs). Independent of the fixed `category` taxonomy.

export interface CollectionMemberOrg {
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
  /** GitHub handle from org_accounts; lets the avatar fall back to github.com/<handle>.png. */
  githubHandle: string | null;
  description: string | null;
}

/** Item shape on GET /v1/collections (list) and GET /v1/orgs/:slug/collections. */
export interface CollectionListItem {
  slug: string;
  name: string;
  description: string | null;
  memberCount: number;
  /** First few members for inline preview on the list page (capped at 3). */
  previewMembers?: CollectionMemberOrg[];
}

/** Detail shape on GET /v1/collections/:slug. */
export interface CollectionDetail {
  slug: string;
  name: string;
  description: string | null;
  orgs: CollectionMemberOrg[];
}

/**
 * Cross-org release feed row. Same shape as `OrgReleaseItem` plus the origin
 * `org` block, so the web's release card can render it identically — full
 * `content` lets "Show more" expand to the body instead of the truncated
 * `summary`.
 */
export interface CollectionReleaseItem extends OrgReleaseItem {
  org: { slug: string; name: string };
  /**
   * Product the release belongs to, if the source is bound to one. Powers
   * the timeline's same-product rollup ("3 earlier Claude Code releases
   * today") on the collections view. `null` for orgs without products or
   * standalone sources. Optional on the wire so older workers mid-rollout
   * (and hand-constructed test fixtures) don't trip the typecheck — clients
   * should treat missing and `null` identically.
   */
  product?: { slug: string; name: string } | null;
}

export interface CollectionReleasesResponse {
  releases: CollectionReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
}

/** Body for POST /v1/collections. `slug` derives from `name` via toSlug() if omitted. */
export interface CreateCollectionRequest {
  slug?: string;
  name: string;
  description?: string | null;
}

/** Body for PATCH /v1/collections/:slug. All fields optional; slug rename is allowed. */
export interface UpdateCollectionRequest {
  slug?: string;
  name?: string;
  description?: string | null;
}

/** A single member entry accepted by the member-write endpoints. */
export interface CollectionMemberInput {
  /** Either `orgId` (org_…) or `orgSlug` is required; if both are given, `orgId` wins. */
  orgId?: string;
  orgSlug?: string;
  /** Authoring position (default 0). For PUT, omit to use array index. */
  position?: number;
}

/** Body for POST /v1/collections/:slug/members. */
export type AddCollectionMemberRequest = CollectionMemberInput;

/** Body for PUT /v1/collections/:slug/members. Replaces the full membership atomically. */
export interface ReplaceCollectionMembersRequest {
  orgs: CollectionMemberInput[];
}

/** Bare row returned by POST/PATCH on /v1/collections. */
export interface CollectionRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Releases (enriched) ──

/** Flat release shape returned by GET /v1/releases/:id with source metadata. */
export interface ReleaseWithSource {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  /** AI-generated summary (#852, renamed in #860). Nullable — most rows unpopulated. */
  summary: string | null;
  /** AI-generated headline (#852, renamed in #860). See {@link ReleaseDetail.titleGenerated}. */
  titleGenerated?: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). */
  titleShort?: string | null;
  url: string | null;
  contentHash: string | null;
  metadata: string | null;
  publishedAt: string | null;
  suppressed: boolean;
  suppressedReason: string | null;
  fetchedAt: string;
  sourceName: string | null;
  sourceSlug: string | null;
}

export interface LatestRelease {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  sourceName: string;
  sourceSlug: string;
  /** AI-generated summary (#852, renamed in #860). Nullable — most rows unpopulated. */
  summary: string | null;
  /** AI-generated headline (#852, renamed in #860). See {@link ReleaseDetail.titleGenerated}. */
  titleGenerated?: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). */
  titleShort?: string | null;
  media: MediaItem[];
}

// ── Stats ──

export interface StatsSummary {
  period: { days: number; cutoff: string };
  totals: {
    organizations: number;
    sources: number;
    releases: number;
    releasesInPeriod: number;
  };
  sourceHealth: {
    upToDate: number;
    stale: number;
    neverFetched: number;
  };
  sourceActivity: Array<{
    sourceName: string;
    sourceSlug: string;
    sourceType: string;
    orgName: string | null;
    lastFetchedAt: string | null;
    totalReleases: number;
    recentReleases: number;
  }>;
  recentActivity: Array<{
    sourceName: string;
    sourceSlug: string;
    orgName: string | null;
    releasesFound: number;
    releasesInserted: number;
    totalReleases: number;
    status: string;
    durationMs: number | null;
    error: string | null;
    createdAt: string;
  }>;
}

// ── Fetch log ──

export interface FetchLogEntry {
  id: string;
  sourceName: string;
  sourceSlug: string;
  status: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

// ── Usage ──

export interface UsageBreakdownRow {
  label: string | null;
  totalInput: number;
  totalOutput: number;
  count: number;
}

export interface UsageStatsResponse {
  totals: { totalInput: number; totalOutput: number; count: number };
  byOperation: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  bySource: UsageBreakdownRow[];
}

// ── Sessions ──

/**
 * Where the session error originated.
 * - `provider`: managed-agents service / Anthropic-side (e.g. unknown_error, model_overloaded, retries_exhausted)
 * - `us`: this codebase / our agent setup (e.g. parser failure, no tools called, timeout)
 */
export type SessionErrorSource = "provider" | "us";

export interface Session {
  sessionId: string;
  company: string;
  type: "onboard" | "update";
  /**
   * Sub-agent **role** label that ran this session — `"coordinator"` is the
   * parent orchestrator (typically Sonnet) when a multi-agent session
   * delegates, `"sonnet"` / `"haiku"` are direct single-agent runs.
   * Surfaces on the detail GET.
   *
   * This is a logical role label, not the runtime model identifier. The
   * resolved Anthropic model string (e.g. `claude-sonnet-4-6`,
   * `claude-haiku-4-5`) lives on `usage.model` when the session reported
   * one — consult that field for the concrete model.
   */
  agent?: "sonnet" | "haiku" | "coordinator";
  /** Identifies the client that started this session (e.g. hostname). */
  runner?: string;
  /** Correlation ID for end-to-end tracing across CLI → API → managed agent. */
  correlationId?: string;
  /** Anthropic session ID for linking to console logs. */
  anthropicSessionId?: string;
  status: "running" | "complete" | "error" | "cancelled";
  step?: string;
  sourcesFound?: number;
  sourcesValidated?: number;
  totalSources?: number;
  sourcesFetched?: number;
  releasesFound?: number;
  releasesInserted?: number;
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt: number;
  error?: string;
  /** Where the error originated. Absent on legacy sessions; treat as `"us"`. */
  errorSource?: SessionErrorSource;
  /** Provider error type (e.g. `unknown_error`, `model_overloaded_error`). */
  errorType?: string;
  /** Stop reason from the final `session.status_idle` event (e.g. `retries_exhausted`). */
  stopReason?: string;
  /** Number of provider `session.error` events observed before terminal. */
  retryCount?: number;
  /** Non-fatal warnings collected during the session. */
  warnings?: string[];
  /**
   * Token usage + estimated cost from the managed-agents session. `estimatedUsd`
   * is a snapshot of Anthropic list prices at session-completion time.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    model?: string;
    estimatedUsd?: number;
  };
  /**
   * Final agent-reported state for terminal `onboard` sessions — the JSON
   * blob the agent passed to its `releases_report_state` tool, plus an
   * `agentSessionId` field stitched in server-side. Empty on `update`
   * sessions and pre-report errors. Typed as `Record<string, unknown>`
   * because the shape is owned by the discovery system prompt and may
   * grow new fields without a wire bump; the keys produced today are:
   *
   * - `product` (`string`) — company name
   * - `domain` (`string | null`) — discovered domain
   * - `githubOrg` (`string | null`) — discovered GitHub org
   * - `startedAt`, `updatedAt` (ISO strings)
   * - `status` (e.g. `"awaiting_review"`)
   * - `sources` (`Array<{ url, type, slug, label, confidence,
   *   validated, validationError?, releaseCount, releasesFetched,
   *   fetched, contentDepth }>`)
   * - `agentSessionId` (`string`) — Anthropic session ID, useful for
   *   cross-referencing console logs
   */
  result?: Record<string, unknown>;
  activeSources?: string[];
  cancelRequested?: boolean;
}

export type SessionListResponse = ListResponse<Session>;

// ── Admin URL Lists ──

export interface IgnoredUrlItem {
  id: string;
  url: string;
  orgId: string;
  reason: string | null;
  ignoredAt: string;
}

export interface BlockedUrlItem {
  id: string;
  pattern: string;
  type: "exact" | "domain";
  reason: string | null;
  createdAt: string;
}

export type IgnoredUrlListResponse = ListResponse<IgnoredUrlItem>;
export type BlockedUrlListResponse = ListResponse<BlockedUrlItem>;

// ── Embed (admin) ──

export interface EmbedBackfillResponse {
  processed: number;
  succeeded: number;
  failed: number;
  remaining: number;
  dryRun?: boolean;
}

/**
 * Cascade-scope preview returned by `GET /v1/admin/orgs/:slug/dependents`.
 * Backs the confirmation prompt in CLI/web before a hard-delete on an org —
 * post-#690 Phase C, hard-deleting an org cascades into every source row
 * tied to it and every per-source dependent table listed below.
 */
export interface OrgDependentsResponse {
  org: { id: string; slug: string; name: string };
  counts: {
    sources: number;
    releases: number;
    fetchLog: number;
    sourceChangelogFiles: number;
    sourceChangelogChunks: number;
    releaseSummaries: number;
    mediaAssets: number;
    webhookSubscriptions: number;
  };
}

export interface EmbedStatusResponse {
  releases: { total: number; embedded: number; unembedded: number };
  entities: {
    total: number;
    embedded: number;
    unembedded: number;
    breakdown: {
      org: { total: number; embedded: number; unembedded: number };
      product: { total: number; embedded: number; unembedded: number };
      source: { total: number; embedded: number; unembedded: number };
    };
  };
  chunks: { total: number; embedded: number; unembedded: number };
}

// ── Evaluate (URL recommendation) ──

/**
 * Returned verbatim by GET /v1/evaluate. Lives in the public api-types package
 * so external consumers (CLI, third-party clients) can import the shape
 * without depending on worker-internal AI helpers.
 */
export interface EvaluationResult {
  recommendedMethod: "feed" | "github" | "markdown" | "scrape" | "crawl";
  recommendedUrl: string;
  feedUrl?: string;
  feedType?: "rss" | "atom" | "jsonfeed";
  githubRepo?: string;
  pageStructure: "single-page" | "index" | "unknown";
  alternatives: Array<{ url: string; method: string; note: string }>;
  confidence: "high" | "medium" | "low";
  provider?: string;
  notes?: string;
}
