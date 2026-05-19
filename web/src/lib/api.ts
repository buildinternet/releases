import type {
  Stats,
  OrgListItem,
  OrgDetail,
  SourceListItem,
  SourceDetail,
  UnifiedSearchResponse,
  SourceActivity,
  OrgActivity,
  OrgHeatmap,
  SourceHeatmap,
  OrgSparklines,
  OrgReleasesResponse,
  ReleaseDetail,
  ProductDetail,
  SourceChangelogResponse,
  ChangelogFileSummary,
  SitemapPayload,
  ReleaseCoverageRow,
  ReleaseCoverageResponse,
  CategoryDetail,
  CategoryListItem,
  CategoryReleaseItem,
  CategoryReleasesResponse,
  TagDetail,
  ListResponse,
  MediaItem,
  CollectionListItem,
  CollectionDetail,
  CollectionMember,
  CollectionMemberOrg,
  CollectionMemberProduct,
  CollectionReleaseItem,
  CollectionReleasesResponse,
} from "@buildinternet/releases-api-types";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";

export type {
  ReleaseSummaryItem,
  ReleaseItem,
  SearchReleaseHit,
  SearchChunkHit,
  SearchOrgHit,
  SearchCatalogHit,
  SearchCollectionHit,
  SearchSourceHit,
  OrgReleaseItem,
  OverviewPageItem,
  KnowledgePageItem,
  LookupResultPayload,
  LookupStatus,
} from "@buildinternet/releases-api-types";

export type {
  Stats,
  OrgListItem,
  OrgDetail,
  SourceListItem,
  SourceDetail,
  UnifiedSearchResponse,
  SourceActivity,
  OrgActivity,
  OrgHeatmap,
  SourceHeatmap,
  OrgSparklines,
  OrgReleasesResponse,
  ReleaseDetail,
  ProductDetail,
  SourceChangelogResponse,
  ChangelogFileSummary,
  SitemapPayload,
  ReleaseCoverageRow,
  ReleaseCoverageResponse,
  CategoryDetail,
  CategoryListItem,
  CategoryReleaseItem,
  CategoryReleasesResponse,
  TagDetail,
  CollectionListItem,
  CollectionDetail,
  CollectionMember,
  CollectionMemberOrg,
  CollectionMemberProduct,
  CollectionReleaseItem,
  CollectionReleasesResponse,
};

export const API_URL = process.env.RELEASED_API_URL ?? "http://localhost:3456";
// Trusted-proxy secret — bypasses the API's per-IP rate limiter for
// server-to-server traffic from Vercel. Does NOT carry admin privileges, so
// admin-gated fields (e.g. org playbook) never leak into the public cache.
const PROXY_KEY = process.env.RELEASES_PROXY_KEY;
// Admin bearer — server-only. Do NOT pass this to fetchApi or any path that
// serves cached public responses. Use adminFetchApi from server components
// for dev-gated views that need admin content.
const API_SECRET = process.env.RELEASED_API_KEY;

// Identifies server-side web→API traffic in Cloudflare analytics. UA shows up
// in the "Source user agents" panel; X-Requested-With has its own panel.
// Filter or exclude these to see real visitor traffic.
const WEB_UA_VERSION =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.VERCEL_ENV ?? "dev";
export const WEB_USER_AGENT = `releases-web/${WEB_UA_VERSION} (+https://releases.sh)`;
export const WEB_REQUESTED_WITH = "releases-web";

export function webApiHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": WEB_USER_AGENT,
    "X-Requested-With": WEB_REQUESTED_WITH,
    // Lets the API attribute requests to the public site rather than direct
    // API consumers — read by the search-query log on /v1/search.
    "X-Releases-Surface": "web",
  };
  if (PROXY_KEY) headers["X-Releases-Proxy-Key"] = PROXY_KEY;
  if (extra) Object.assign(headers, extra);
  return headers;
}

export class ApiSetupError extends Error {
  setup: string[];
  constructor(message: string, setup: string[]) {
    super(message);
    this.name = "ApiSetupError";
    this.setup = setup;
  }
}

export class ApiNotFoundError extends Error {
  constructor(path: string) {
    super(`API 404: ${path}`);
    this.name = "ApiNotFoundError";
  }
}

export type FetchCacheInit = { cache?: RequestCache; next?: { revalidate?: number | false } };

/**
 * Apply cache-or-ISR options to a RequestInit, defaulting to 60s revalidate
 * so reads stay aligned with the API's own KV cache TTLs. Shared by REST and
 * GraphQL transports — drift here would mean two caches with different lifetimes.
 */
export function applyCacheInit(target: RequestInit, init?: FetchCacheInit): void {
  if (init?.cache) {
    target.cache = init.cache;
  } else {
    (target as RequestInit & { next?: FetchCacheInit["next"] }).next = init?.next ?? {
      revalidate: 60,
    };
  }
}

export const apiSetupSteps = [
  `bun run dev:api    # start the Cloudflare worker API`,
  `# or`,
  `bun run api         # start the local Bun API server`,
];

async function fetchApi<T>(path: string, init?: FetchCacheInit): Promise<T> {
  let res: Response;
  const fetchInit: RequestInit = { headers: webApiHeaders() };
  applyCacheInit(fetchInit, init);
  try {
    res = await fetch(`${API_URL}${path}`, fetchInit);
  } catch {
    throw new ApiSetupError(
      `Cannot connect to the API at ${API_URL}. Is the server running?`,
      apiSetupSteps,
    );
  }

  if (res.status === 503) {
    const body = await res.json().catch(() => null);
    if (body?.error === "database_not_initialized") {
      throw new ApiSetupError(body.message, body.setup);
    }
  }

  if (res.status === 404) throw new ApiNotFoundError(path);
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Server-only admin fetch. Sends the admin Bearer token so the response can
 * include admin-gated fields. Never call from a client component or return
 * the response body as a prop — keep the result inside the server boundary.
 */
async function adminFetchApi<T>(path: string): Promise<T | null> {
  if (!API_SECRET) return null;
  const res = await fetch(`${API_URL}${path}`, {
    headers: webApiHeaders({ Authorization: `Bearer ${API_SECRET}` }),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

export const adminApi = {
  orgPlaybook: (slug: string) =>
    adminFetchApi<{ content: string; updatedAt: string } | null>(
      `/v1/orgs/${encodeURIComponent(slug)}/playbook`,
    ),
};

// Mirror the worker-side `cacheControl(300)` on /v1/related/* so Next's Data
// Cache doesn't serve fresh semantic neighbors for longer than the CDN would.
const RELATED_CACHE_OPTS = { next: { revalidate: 300 } } as const;

export interface LatestReleaseItem {
  id: string;
  version: string | null;
  type: string;
  title: string | null;
  summary: string | null;
  publishedAt: string | null;
  url: string | null;
  media: MediaItem[];
  source: { slug: string; name: string; type: string; orgSlug: string | null };
  coverageCount?: number;
}

export const api = {
  stats: () => fetchApi<Stats>("/v1/stats"),
  latestReleases: async (
    opts: { count?: number; excludeSourceTypes?: string[] } = {},
  ): Promise<LatestReleaseItem[]> => {
    const params = new URLSearchParams();
    if (opts.count !== undefined) params.set("count", String(opts.count));
    if (opts.excludeSourceTypes && opts.excludeSourceTypes.length > 0) {
      params.set("exclude", opts.excludeSourceTypes.toSorted().join(","));
    }
    const qs = params.toString();
    const body = await fetchApi<{ releases: LatestReleaseItem[] }>(
      `/v1/releases/latest${qs ? `?${qs}` : ""}`,
    );
    return body.releases ?? [];
  },
  orgs: async (
    opts: { includeEmpty?: boolean } = {},
  ): Promise<{ items: OrgListItem[]; emptyOrgCount: number }> => {
    const qs = opts.includeEmpty ? "?includeEmpty=true" : "";
    type OrgsBody =
      | (ListResponse<OrgListItem> & { meta?: { emptyOrgCount?: number } })
      | OrgListItem[];
    const body = await fetchApi<OrgsBody>(`/v1/orgs${qs}`);
    if (Array.isArray(body)) return { items: body, emptyOrgCount: 0 };
    return { items: body?.items ?? [], emptyOrgCount: body?.meta?.emptyOrgCount ?? 0 };
  },
  sitemap: () => fetchApi<SitemapPayload>("/v1/sitemap"),
  orgDetail: (slug: string) => fetchApi<OrgDetail>(`/v1/orgs/${slug}`),
  sources: (independent?: boolean) =>
    fetchApi<SourceListItem[]>(`/v1/sources${independent ? "?independent=true" : ""}`),
  sourceDetail: (
    ref: { orgSlug: string; sourceSlug: string },
    opts: { cursor?: string | null; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.cursor != null) params.set("cursor", opts.cursor);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return fetchApi<SourceDetail>(
      `/v1/orgs/${ref.orgSlug}/sources/${ref.sourceSlug}${qs ? `?${qs}` : ""}`,
    );
  },
  search: (q: string, limit = 20, offset = 0) => {
    // Coordinate-shaped queries skip the hybrid semantic rail so the API's
    // on-demand lookup fallback can fire — otherwise weakly-matched chunks
    // suppress it.
    const mode = parseCoordinate(q.trim()) ? "&mode=lexical" : "";
    return fetchApi<UnifiedSearchResponse>(
      `/v1/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}${mode}`,
    );
  },
  sourceActivity: (ref: { orgSlug: string; sourceSlug: string }, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return fetchApi<SourceActivity>(
      `/v1/orgs/${ref.orgSlug}/sources/${ref.sourceSlug}/activity${qs ? `?${qs}` : ""}`,
    );
  },
  orgActivity: (slug: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return fetchApi<OrgActivity>(`/v1/orgs/${slug}/activity${qs ? `?${qs}` : ""}`);
  },
  orgReleases: (
    slug: string,
    opts: {
      cursor?: string;
      limit?: number;
      sourceType?: string;
      includePrereleases?: boolean;
    } = {},
  ) => {
    const { cursor, limit = 20, sourceType, includePrereleases } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== 20) params.set("limit", String(limit));
    if (sourceType && sourceType !== "all") params.set("source_type", sourceType);
    if (includePrereleases) params.set("include_prereleases", "true");
    const qs = params.toString();
    return fetchApi<OrgReleasesResponse>(`/v1/orgs/${slug}/releases${qs ? `?${qs}` : ""}`);
  },
  orgHeatmap: (slug: string) => fetchApi<OrgHeatmap>(`/v1/orgs/${slug}/heatmap`),
  orgSparklines: (slug: string) => fetchApi<OrgSparklines>(`/v1/orgs/${slug}/sparklines`),
  // Release details bypass Next's Data Cache so stale successful responses
  // don't outlive a delete/replace on the API side — a deleted release must
  // 404 on the very next request, not on the next revalidate cycle.
  release: (id: string) => fetchApi<ReleaseDetail>(`/v1/releases/${id}`, { cache: "no-store" }),
  sourceHeatmap: (ref: { orgSlug: string; sourceSlug: string }) =>
    fetchApi<SourceHeatmap>(`/v1/orgs/${ref.orgSlug}/sources/${ref.sourceSlug}/heatmap`),
  /**
   * Resolves a bare slug to its canonical org-scoped home. Backs the legacy
   * `/source/[slug]` redirect page and the `.atom`/`.md`/`.json` legacy
   * format routes — both translate inbound bookmark URLs to a 308 toward
   * the canonical `/{orgSlug}/{sourceSlug}` shape.
   *
   * Hits `/v1/lookups/source-by-slug`, the dedicated bookmark-resolver
   * endpoint introduced when the bare API path stopped accepting slugs
   * (#698). It's auth-gated under `adminRoutes` so the call goes through
   * `adminFetchApi` — server-only, never returned to the client. The
   * endpoint returns the oldest match for a given slug — a deterministic
   * answer for bookmarks even when the same slug appears under multiple
   * orgs after #690.
   */
  sourceLegacyResolve: (slug: string) =>
    adminFetchApi<{ sourceId: string; sourceSlug: string; orgSlug: string }>(
      `/v1/lookups/source-by-slug?slug=${encodeURIComponent(slug)}`,
    ),
  productDetail: (ref: { orgSlug: string; productSlug: string }) =>
    fetchApi<ProductDetail>(`/v1/orgs/${ref.orgSlug}/products/${ref.productSlug}`),
  categories: () => fetchApi<CategoryListItem[]>("/v1/categories"),
  categoryDetail: (slug: string) => fetchApi<CategoryDetail>(`/v1/categories/${slug}`),
  categoryReleases: (
    slug: string,
    opts: { cursor?: string; limit?: number; includePrereleases?: boolean } = {},
  ) => {
    const { cursor, limit = 20, includePrereleases } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== 20) params.set("limit", String(limit));
    if (includePrereleases) params.set("include_prereleases", "true");
    const qs = params.toString();
    return fetchApi<CategoryReleasesResponse>(
      `/v1/categories/${slug}/releases${qs ? `?${qs}` : ""}`,
    );
  },
  tagDetail: (slug: string) => fetchApi<TagDetail>(`/v1/tags/${slug}`),
  collections: () => fetchApi<CollectionListItem[]>("/v1/collections"),
  orgCollections: (slug: string) => fetchApi<CollectionListItem[]>(`/v1/orgs/${slug}/collections`),
  collectionDetail: (slug: string) => fetchApi<CollectionDetail>(`/v1/collections/${slug}`),
  collectionReleases: (
    slug: string,
    opts: { cursor?: string; limit?: number; includePrereleases?: boolean } = {},
  ) => {
    const { cursor, limit = 20, includePrereleases } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== 20) params.set("limit", String(limit));
    if (includePrereleases) params.set("include_prereleases", "true");
    const qs = params.toString();
    return fetchApi<CollectionReleasesResponse>(
      `/v1/collections/${slug}/releases${qs ? `?${qs}` : ""}`,
    );
  },
  sourceChangelog: (
    ref: { orgSlug: string; sourceSlug: string },
    range?: { path?: string; offset?: number; limit?: number },
  ) => {
    const params = new URLSearchParams();
    if (range?.path !== undefined) params.set("path", range.path);
    if (range?.offset !== undefined) params.set("offset", String(range.offset));
    if (range?.limit !== undefined) params.set("limit", String(range.limit));
    const qs = params.toString();
    return fetchApi<SourceChangelogResponse>(
      `/v1/orgs/${ref.orgSlug}/sources/${ref.sourceSlug}/changelog${qs ? `?${qs}` : ""}`,
    );
  },
  relatedReleases: (releaseId: string, scope: "org" | "global" = "global", limit = 8) =>
    fetchApi<RelatedReleasesResponse>(
      `/v1/related/releases?release=${encodeURIComponent(releaseId)}&scope=${scope}&limit=${limit}`,
      RELATED_CACHE_OPTS,
    ),
  coverage: (releaseId: string) =>
    fetchApi<ReleaseCoverageResponse>(`/v1/releases/${encodeURIComponent(releaseId)}/coverage`),
  relatedSources: (sourceIdOrSlug: string, scope: "org" | "global" = "global", limit = 6) =>
    fetchApi<RelatedSourcesResponse>(
      `/v1/related/sources?source=${encodeURIComponent(sourceIdOrSlug)}&scope=${scope}&limit=${limit}`,
      RELATED_CACHE_OPTS,
    ),
};

export interface RelatedReleaseItem {
  id: string;
  title: string;
  version: string | null;
  url: string | null;
  publishedAt: string | null;
  summary: string;
  titleGenerated: string | null;
  titleShort: string | null;
  thumbnail: { url: string; alt?: string } | null;
  score: number;
  source: {
    id: string;
    slug: string;
    name: string;
    orgSlug: string | null;
    orgName: string | null;
  };
}

export interface RelatedSourceItem {
  id: string;
  slug: string;
  name: string;
  type: string;
  url: string | null;
  score: number;
  orgSlug: string | null;
  orgName: string | null;
  orgAvatarUrl: string | null;
  releaseCount: number;
  latestDate: string | null;
  latestTitle: string | null;
  latestVersion: string | null;
  recentCount: number;
}

export interface RelatedReleasesResponse {
  scope?: "org" | "global";
  items: RelatedReleaseItem[];
  degraded?: boolean;
  degradedReason?: string;
}

export interface RelatedSourcesResponse {
  scope?: "org" | "global";
  items: RelatedSourceItem[];
  degraded?: boolean;
  degradedReason?: string;
}
