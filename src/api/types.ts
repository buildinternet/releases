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
  sourceCount: number;
  releaseCount: number;
  recentReleaseCount: number;
  lastActivity: string | null;
}

export interface OrgDetail {
  slug: string;
  name: string;
  domain: string | null;
  sourceCount: number;
  releaseCount: number;
  releasesLast30Days: number;
  avgReleasesPerWeek: number;
  lastFetchedAt: string | null;
  trackingSince: string;
  accounts: { platform: string; handle: string }[];
  sources: SourceListItem[];
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
  isPrimary?: boolean;
  metadata?: string | null;
  productName?: string | null;
  productSlug?: string | null;
}

export interface SourceDetail {
  slug: string;
  name: string;
  type: string;
  url: string;
  changelogUrl?: string | null;
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

export interface SearchResult {
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}

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
