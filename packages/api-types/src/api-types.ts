/**
 * Shared API response types.
 *
 * This is the single source of truth for all API response shapes.
 * Consumed by: web frontend, CLI client, and (optionally) API worker routes.
 */

// ── Media ──

export interface MediaItem {
  type: "image" | "video" | "gif";
  url: string;
  alt?: string;
  r2Url?: string;
}

// ── Stats ──

export interface Stats {
  orgs: number;
  sources: number;
  releases: number;
  products: number;
}

// ── Pagination ──

export interface Pagination {
  page: number;
  pageSize: number;
  returned: number;
  totalItems?: number;
  totalPages?: number;
  hasMore: boolean;
}

export interface ListResponse<T> {
  items: T[];
  pagination: Pagination;
}

// ── Sitemap (bulk URL emission) ──

export interface SitemapPayload {
  orgs: Array<{ slug: string; lastActivity: string | null }>;
  sources: Array<{ orgSlug: string; slug: string; latestDate: string | null }>;
  products: Array<{ orgSlug: string; slug: string }>;
}

// ── Organizations ──

export interface OrgListItem {
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
  githubHandle: string | null;
  sourceCount: number;
  releaseCount: number;
  recentReleaseCount: number;
  lastActivity: string | null;
  topProducts: string[];
  sparkline: number[];
}

export type OrgListResponse = ListResponse<OrgListItem>;

export interface OrgAccountItem {
  platform: string;
  handle: string;
}

export type OrgAccountsResponse = ListResponse<OrgAccountItem>;
export type OrgTagsResponse = ListResponse<string>;

export interface OrgDetail {
  id?: string;
  slug: string;
  name: string;
  domain: string | null;
  description?: string | null;
  category?: string | null;
  avatarUrl: string | null;
  tags?: string[];
  sourceCount: number;
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  lastFetchedAt: string | null;
  lastPolledAt: string | null;
  trackingSince: string;
  aliases?: string[];
  accounts: OrgAccountItem[];
  products: Array<{
    id: string;
    slug: string;
    name: string;
    url: string | null;
    description: string | null;
    sourceCount: number;
  }>;
  sources: SourceListItem[];
  overview?: OverviewPageItem | null;
  playbook?: { scope: "playbook"; content: string; updatedAt: string } | null;
}

// ── Sources ──

export interface SourceListItem {
  slug: string;
  name: string;
  type: string;
  url?: string;
  orgSlug?: string | null;
  releaseCount: number;
  latestVersion: string | null;
  latestDate: string | null;
  latestAddedAt?: string | null;
  isPrimary?: boolean;
  isHidden?: boolean;
  /**
   * How the row was created. Optional on the wire so older API responses
   * (mid-deploy or pinned old workers) degrade gracefully — consumers that
   * see `undefined` should treat it as `"curated"`.
   */
  discovery?: "curated" | "agent" | "on_demand";
  fetchPriority?: "normal" | "low" | "paused" | null;
  lastFetchedAt?: string | null;
  lastPolledAt?: string | null;
  changeDetectedAt?: string | null;
  consecutiveNoChange?: number | null;
  consecutiveErrors?: number | null;
  nextFetchAfter?: string | null;
  medianGapDays?: number | null;
  lastRetieredAt?: string | null;
  metadata?: string | null;
  productName?: string | null;
  productSlug?: string | null;
}

/**
 * Canonical shape returned by GET /v1/sources (list) and used by both
 * local-mode queries and the remote API client. Superset of SourceListItem
 * with required fields (id, orgName, orgSlug) that the CLI `list` command needs.
 */
export interface SourceWithOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
  orgName: string | null;
  orgSlug: string | null;
  productName: string | null;
  productSlug: string | null;
  isPrimary: boolean;
  isHidden: boolean | null;
  discovery?: "curated" | "agent" | "on_demand";
  metadata: string | null;
  releaseCount: number;
  latestVersion: string | null;
  latestDate: string | null;
  lastFetchedAt: string | null;
  lastPolledAt: string | null;
  fetchPriority: string | null;
  changeDetectedAt: string | null;
  consecutiveNoChange: number | null;
  consecutiveErrors: number | null;
  nextFetchAfter: string | null;
  medianGapDays: number | null;
  lastRetieredAt: string | null;
}

/** Fields accepted by PATCH /v1/sources/:slug. */
export interface SourcePatchInput {
  name?: string;
  url?: string;
  type?: string;
  slug?: string;
  metadata?: string;
  orgId?: string | null;
  productId?: string | null;
  lastFetchedAt?: string | null;
  lastContentHash?: string | null;
  fetchPriority?: string;
  consecutiveNoChange?: number;
  consecutiveErrors?: number;
  nextFetchAfter?: string | null;
  isPrimary?: boolean;
  isHidden?: boolean;
  changeDetectedAt?: string | null;
  lastPolledAt?: string | null;
}

/** Lightweight summary of a changelog file — used for the file index. */
export interface ChangelogFileSummary {
  path: string;
  filename: string;
  url: string;
  bytes: number;
  fetchedAt: string;
}

export interface SourceChangelogResponse {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  bytes: number;
  fetchedAt: string;
  /** Character offset of the first character in `content` within the full file. */
  offset: number;
  /** The limit (in chars) that was applied to produce this slice. */
  limit: number;
  /** Next offset to request for the next slice, or null if `content` is the tail. */
  nextOffset: number | null;
  /** Total length of the full file in characters. */
  totalChars: number;
  /** Requested token budget when in token mode (cl100k_base). */
  tokens?: number;
  /** Encoded token count of the returned `content`. Set in token mode. */
  sliceTokens?: number;
  /** Full-file token count (cl100k_base). Always populated. */
  totalTokens: number;
  /** True when the upstream file exceeded the 1MB cap and content was sliced. */
  truncated: boolean;
  /** Byte offset where the file was truncated, or null when not truncated. */
  truncatedAt: number | null;
  /**
   * Index of every changelog file tracked for this source (root plus any
   * discovered per-package files). Always present even for single-file
   * sources so clients can lazily render a file picker.
   */
  files: ChangelogFileSummary[];
}

export interface SourceDetail {
  slug: string;
  name: string;
  type: string;
  url: string;
  /**
   * Hidden sources are reachable by direct URL but excluded from listings,
   * sitemap, and AI features. Set on on-demand lookups and admin-suppressed
   * rows; absent on canonical curated/agent sources.
   */
  isHidden?: boolean;
  /**
   * Pairs with `isHidden` to distinguish admin-suppressed rows (`curated` /
   * `agent` + hidden) from rows materialized by `/v1/lookups` (`on_demand`).
   * Optional for graceful degradation against older API responses.
   */
  discovery?: "curated" | "agent" | "on_demand";
  changelogUrl?: string | null;
  hasChangelogFile?: boolean;
  org: { slug: string; name: string } | null;
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  latestVersion: string | null;
  latestDate: string | null;
  lastFetchedAt: string | null;
  lastPolledAt: string | null;
  trackingSince: string;
  releases: ReleaseItem[];
  pagination: Pagination;
  summaries: {
    rolling: ReleaseSummaryItem | null;
    monthly: ReleaseSummaryItem[];
  };
}

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
export type ReleaseType = "feature" | "rollup";

export interface ReleaseItem {
  id?: string;
  version: string | null;
  title: string;
  summary: string;
  content?: string;
  publishedAt: string | null;
  url: string | null;
  media?: MediaItem[];
  /** Release type. See {@link ReleaseType}. */
  type?: ReleaseType;
}

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

export interface ReleaseSummaryItem {
  year?: number | null;
  month?: number | null;
  windowDays?: number | null;
  summary: string;
  releaseCount: number;
  generatedAt: string;
}

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

export interface OverviewPageItem {
  scope: "org" | "product";
  orgSlug?: string | null;
  productSlug?: string | null;
  content: string;
  releaseCount: number;
  lastContributingReleaseAt: string | null;
  generatedAt: string;
  updatedAt: string;
}

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

export interface ProductListItem {
  id: string;
  name: string;
  slug: string;
  orgId: string;
  url: string | null;
  description: string | null;
  category: string | null;
  createdAt: string;
  sourceCount: number;
}

export type ProductListResponse = ListResponse<ProductListItem>;

export interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  orgId: string;
  url: string | null;
  description: string | null;
  category: string | null;
  createdAt: string;
  sources: Array<{ id: string; slug: string; name: string; type: string; url: string }>;
  tags: string[];
}

export interface ProductAdoptResult {
  product: ProductDetail;
  sourcesMoved: number;
  accountsMoved: number;
  sourceOrgDeleted: string;
}

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
