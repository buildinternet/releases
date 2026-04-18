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
  trackingSince: string;
  aliases?: string[];
  accounts: { platform: string; handle: string }[];
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
  /** @deprecated Use overview */
  knowledgePage?: OverviewPageItem | null;
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
  fetchPriority?: "normal" | "low" | "paused" | null;
  lastFetchedAt?: string | null;
  changeDetectedAt?: string | null;
  consecutiveNoChange?: number | null;
  consecutiveErrors?: number | null;
  nextFetchAfter?: string | null;
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
  metadata: string | null;
  releaseCount: number;
  latestVersion: string | null;
  latestDate: string | null;
  lastFetchedAt: string | null;
  fetchPriority: string | null;
  changeDetectedAt: string | null;
  consecutiveNoChange: number | null;
  consecutiveErrors: number | null;
  nextFetchAfter: string | null;
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
  changelogUrl?: string | null;
  hasChangelogFile?: boolean;
  org: { slug: string; name: string } | null;
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  latestVersion: string | null;
  latestDate: string | null;
  lastFetchedAt: string | null;
  trackingSince: string;
  releases: ReleaseItem[];
  pagination: { page: number; pageSize: number; totalPages: number; totalItems: number };
  summaries: {
    rolling: ReleaseSummaryItem | null;
    monthly: ReleaseSummaryItem[];
  };
}

// ── Releases ──

export interface ReleaseItem {
  id?: string;
  version: string | null;
  title: string;
  summary: string;
  content?: string;
  publishedAt: string | null;
  url: string | null;
  media?: MediaItem[];
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

export interface SearchProductHit {
  slug: string;
  name: string;
  orgSlug: string | null;
  orgName: string | null;
  category: string | null;
  /** Distinguishes standalone sources folded into the products list */
  kind?: "product" | "source";
  /** For source-kind entries: the source slug (used for URL routing) */
  sourceSlug?: string;
}

export interface SearchSourceHit {
  slug: string;
  name: string;
  type: string;
  orgSlug: string | null;
  orgName: string | null;
  productSlug: string | null;
}

/** Extended source hit with product metadata for folding into products list */
export interface RawSourceHit extends SearchSourceHit {
  productName?: string;
  productCategory?: string;
}

/** Fold raw source hits into the products list, deduplicating against existing products */
export function foldSourcesIntoProducts(
  existingProducts: SearchProductHit[],
  rawSources: RawSourceHit[],
): SearchProductHit[] {
  const products = [...existingProducts];
  const seen = new Set(products.map((p) => p.slug));
  for (const s of rawSources) {
    if (s.productSlug) {
      if (seen.has(s.productSlug)) continue;
      products.push({
        slug: s.productSlug,
        name: s.productName ?? s.name,
        orgSlug: s.orgSlug,
        orgName: s.orgName,
        category: s.productCategory ?? null,
      });
      seen.add(s.productSlug);
    } else {
      products.push({
        slug: s.slug,
        name: s.name,
        orgSlug: s.orgSlug,
        orgName: s.orgName,
        category: null,
        kind: "source",
        sourceSlug: s.slug,
      });
    }
  }
  return products;
}

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

export interface UnifiedSearchResponse {
  query: string;
  orgs: SearchOrgHit[];
  products: SearchProductHit[];
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
  activeSources?: string[];
  cancelRequested?: boolean;
}

// ── Embed (admin) ──

export interface EmbedBackfillResponse {
  processed: number;
  succeeded: number;
  failed: number;
  remaining: number;
  dryRun?: boolean;
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
