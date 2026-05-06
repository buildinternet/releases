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
  sources: Array<{ orgSlug: string; slug: string; latestDate: string | null }>;
  products: Array<{ orgSlug: string; slug: string }>;
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
  contentSummary: string | null;
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

export interface ReleaseCoverageRow {
  coverageId: string;
  canonicalId: string;
  reason: string | null;
  decidedBy: string;
  decidedAt: string;
}

export type ReleaseCoverageResponse =
  | { role: "standalone"; canonical: null; covers: [] }
  | { role: "coverage"; canonical: ReleaseCoverageRow; covers: [] }
  | { role: "canonical"; canonical: null; covers: ReleaseCoverageRow[] };

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

// ── Lookup (on-demand GitHub index) ──

export type LookupStatus = "indexed" | "existing" | "empty" | "not_found" | "deferred";

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
  orgs: TaxonomyOrg[];
  products: TaxonomyProduct[];
}

export interface TagDetail {
  slug: string;
  name: string;
  orgs: TaxonomyOrg[];
  products: TaxonomyProduct[];
}

// ── Releases (enriched) ──

/** Flat release shape returned by GET /v1/releases/:id with source metadata. */
export interface ReleaseWithSource {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  contentSummary: string | null;
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
  contentSummary: string | null;
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
  status: "running" | "complete" | "error" | "cancelled";
  step?: string;
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
