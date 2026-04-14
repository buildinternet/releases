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
  metadata?: string | null;
  productName?: string | null;
  productSlug?: string | null;
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
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}

export interface UnifiedSearchResponse {
  query: string;
  orgs: SearchOrgHit[];
  products: SearchProductHit[];
  sources: SearchSourceHit[];
  releases: SearchReleaseHit[];
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
