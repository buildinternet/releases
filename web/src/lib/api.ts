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
  OrgReleasesFeedResponse,
  ReleaseDetail,
  ProductDetail,
  ProductActivityResponse,
  ProductHeatmapResponse,
  SourceChangelogResponse,
  ChangelogFileSummary,
  SitemapPayload,
  SitemapReleasesPayload,
  ReleaseCoverageRow,
  ReleaseCoverageResponse,
  ReleaseCoverageSibling,
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
  CollectionDailySummary,
  CollectionDailySummariesResponse,
  CollectionWeeklyDigestListItem,
  CollectionWeeklyDigestsResponse,
  CollectionWeeklyDigestDetail,
  DigestCoveredRelease,
  OverviewPageItem,
  ResolveResponse,
} from "@buildinternet/releases-api-types";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import type { StoredSiteNotice } from "@buildinternet/releases-core/site-notice";
import { apiBaseUrl, serverApiKey } from "./env";

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
  OrgStatus,
  ReleaseLocationItem,
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
  OrgReleasesFeedResponse,
  ReleaseDetail,
  ProductDetail,
  ProductActivityResponse,
  ProductHeatmapResponse,
  SourceChangelogResponse,
  ChangelogFileSummary,
  SitemapPayload,
  SitemapReleasesPayload,
  ReleaseCoverageRow,
  ReleaseCoverageResponse,
  ReleaseCoverageSibling,
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
  CollectionDailySummary,
  CollectionDailySummariesResponse,
  CollectionWeeklyDigestListItem,
  CollectionWeeklyDigestsResponse,
  CollectionWeeklyDigestDetail,
  DigestCoveredRelease,
};

export const API_URL = apiBaseUrl() ?? "http://localhost:3456";
// Trusted-proxy secret — bypasses the API's per-IP rate limiter for
// server-to-server traffic from Vercel. Does NOT carry admin privileges, so
// admin-gated fields (e.g. org playbook) never leak into the public cache.
const PROXY_KEY = process.env.RELEASES_PROXY_KEY;
// Admin bearer — server-only. Do NOT pass this to fetchApi or any path that
// serves cached public responses. Use adminFetchApi from server components
// for dev-gated views that need admin content.
const API_SECRET = serverApiKey();

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

/**
 * Minimal read of the API's standardized nested error envelope
 * `{ error: { code, type, message, details? } }`. Returns null for any body
 * that isn't a well-formed envelope. Inlined rather than using api-types'
 * `decodeApiError` — see the note at its call site in `fetchApi`.
 */
function readNestedApiError(
  body: unknown,
): { code: string; message: string; details?: unknown } | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return null;
  const { code, message, details } = err as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof code !== "string" || typeof message !== "string") return null;
  return { code, message, details };
}

export type FetchCacheInit = { cache?: RequestCache; next?: { revalidate?: number | false } };

/**
 * Default Data Cache / ISR revalidate window (seconds) for API reads.
 *
 * A statically-rendered route's regeneration frequency is the MIN of its
 * `export const revalidate` and every fetch revalidate on it, so this default
 * governs how often the org/source/product ISR pages regenerate (and thus their
 * Vercel ISR write volume). It MUST stay in sync with the `revalidate = 900`
 * literals on those pages — a lower value here silently overrides them. 15 min
 * keeps freshly-ingested releases visible quickly (ingestion writes via the API
 * worker, not Next's revalidatePath) while keeping regeneration writes bounded.
 */
const DEFAULT_REVALIDATE_SECONDS = 900;

/**
 * Apply cache-or-ISR options to a RequestInit, defaulting to
 * DEFAULT_REVALIDATE_SECONDS so reads stay aligned with the API's own KV cache
 * TTLs. Shared by REST and GraphQL transports — drift here would mean two
 * caches with different lifetimes.
 */
export function applyCacheInit(target: RequestInit, init?: FetchCacheInit): void {
  if (init?.cache) {
    target.cache = init.cache;
  } else {
    (target as RequestInit & { next?: FetchCacheInit["next"] }).next = init?.next ?? {
      revalidate: DEFAULT_REVALIDATE_SECONDS,
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
    // Branch on the standardized nested envelope's `code`, reading the setup
    // steps from `details.setup` (#1830 item 3). Decoded inline rather than via
    // api-types' `decodeApiError`: that package is a TS-source barrel whose `.js`
    // re-exports Next's bundler can't resolve, so the web imports only *types*
    // from it — a runtime value import pulls the whole barrel into the build.
    const apiErr = readNestedApiError(body);
    if (apiErr?.code === "database_not_initialized") {
      const rawSetup = (apiErr.details as { setup?: unknown } | undefined)?.setup;
      const setup =
        Array.isArray(rawSetup) && rawSetup.every((s) => typeof s === "string")
          ? (rawSetup as string[])
          : apiSetupSteps;
      throw new ApiSetupError(apiErr.message, setup);
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

/**
 * Server-only admin POST. Same Bearer + server-boundary rules as
 * {@link adminFetchApi}; returns `null` on any non-2xx so callers can treat
 * "couldn't resolve" uniformly. Used by the dev-only changelog parse viewer.
 */
async function adminPostApi<T>(path: string, body: unknown): Promise<T | null> {
  if (!API_SECRET) return null;
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: webApiHeaders({
      Authorization: `Bearer ${API_SECRET}`,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * One parsed release from `POST /v1/changelog/parse` — the deterministic
 * "tier-0" shape (AI fields always null, `media` always empty). Mirrors the
 * worker's `ParsedReleaseSchema`; kept local until the endpoint graduates from
 * experimental and the shape is promoted to `@buildinternet/releases-api-types`.
 */
export interface GhParsedRelease {
  version: string | null;
  type: "feature";
  title: string;
  content: string;
  url: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  summary: null;
  titleGenerated: null;
  titleShort: null;
  media: unknown[];
}

/** Full `POST /v1/changelog/parse` response. */
export interface GhChangelogParseResult {
  repo: string;
  source: "github_releases" | "changelog_file" | null;
  parsable: boolean;
  /** GitHub Releases hit the single-page (100) cap — older releases exist. */
  capped: boolean;
  format: "keep-a-changelog" | "conventional" | "plain" | "unknown" | null;
  file: {
    path: string;
    url: string;
    rawUrl: string;
    size: number | null;
    truncated: boolean;
  } | null;
  releases: GhParsedRelease[];
  stats: {
    releasesParsed: number;
    headingsScanned: number;
    skipped: number;
    githubRequests: number;
    bytes: number;
    elapsedMs: number;
  };
}

/** Canonical org-scoped home of an indexed source, from the read-only lookup. */
export interface IndexedSourceRef {
  sourceId: string;
  sourceSlug: string;
  orgSlug: string;
}

export const adminApi = {
  orgPlaybook: (slug: string) =>
    adminFetchApi<{ content: string; updatedAt: string } | null>(
      `/v1/orgs/${encodeURIComponent(slug)}/playbook`,
    ),
  /**
   * Deterministic changelog parse for any GitHub repo (no persistence). Bearer
   * (write)-gated, so this is server-only — the dev-gated /gh/[owner]/[repo]
   * viewer is the sole caller. Returns `null` when the repo can't be resolved
   * (missing, rate-limited, or no admin key configured).
   */
  parseChangelog: (input: {
    repo: string;
    path?: string;
    source?: "auto" | "github_releases" | "changelog_file";
  }) => adminPostApi<GhChangelogParseResult>("/v1/changelog/parse", input),
  /**
   * Read-only "is this repo already in the catalog?" check (never materializes
   * a stub). Returns the canonical org-scoped home, or `null` when un-indexed.
   */
  sourceByCoordinate: (coordinate: string) =>
    adminFetchApi<IndexedSourceRef>(
      `/v1/lookups/source-by-coordinate?coordinate=${encodeURIComponent(coordinate)}`,
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
  /** Breaking-change level (#1696/#1710). Absent or "unknown" = not classified. */
  breaking?: "unknown" | "none" | "minor" | "major";
  publishedAt: string | null;
  url: string | null;
  media: MediaItem[];
  source: { slug: string; name: string; type: string; orgSlug: string | null };
  coverageCount?: number;
}

/** An empty unified-search payload — the shared "no results" / error fallback. */
export function emptyResults(query: string): UnifiedSearchResponse {
  return { query, orgs: [], catalog: [], sources: [], releases: [] };
}

export const api = {
  stats: () => fetchApi<Stats>("/v1/stats"),
  siteNotice: () =>
    fetchApi<{ notice: StoredSiteNotice | null }>("/v1/site-notice", { next: { revalidate: 60 } }),
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
    opts: { includeEmpty?: boolean; category?: string; featured?: boolean } = {},
  ): Promise<{ items: OrgListItem[]; emptyOrgCount: number }> => {
    const params = new URLSearchParams();
    if (opts.includeEmpty) params.set("includeEmpty", "true");
    if (opts.category) params.set("category", opts.category);
    if (opts.featured) params.set("featured", "true");
    const qs = params.toString();
    type OrgsBody =
      | (ListResponse<OrgListItem> & { meta?: { emptyOrgCount?: number } })
      | OrgListItem[];
    const body = await fetchApi<OrgsBody>(`/v1/orgs${qs ? `?${qs}` : ""}`);
    if (Array.isArray(body)) return { items: body, emptyOrgCount: 0 };
    return { items: body?.items ?? [], emptyOrgCount: body?.meta?.emptyOrgCount ?? 0 };
  },
  sitemap: () => fetchApi<SitemapPayload>("/v1/sitemap"),
  sitemapReleases: () => fetchApi<SitemapReleasesPayload>("/v1/sitemap/releases"),
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
  search: (q: string, limit = 20, offset = 0, since?: string) => {
    // Coordinate-shaped queries skip the hybrid semantic rail so the API's
    // on-demand lookup fallback can fire — otherwise weakly-matched chunks
    // suppress it.
    const mode = parseCoordinate(q.trim()) ? "&mode=lexical" : "";
    // `since` narrows release hits to a published-at window (relative
    // shorthand resolved by the API). Omitted for "any time".
    const sinceParam = since ? `&since=${encodeURIComponent(since)}` : "";
    return fetchApi<UnifiedSearchResponse>(
      `/v1/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}${mode}${sinceParam}`,
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
      product?: string;
    } = {},
  ) => {
    const { cursor, limit = 20, sourceType, includePrereleases, product } = opts;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== 20) params.set("limit", String(limit));
    if (sourceType && sourceType !== "all") params.set("source_type", sourceType);
    if (includePrereleases) params.set("include_prereleases", "true");
    if (product) params.set("product", product);
    const qs = params.toString();
    return fetchApi<OrgReleasesFeedResponse>(`/v1/orgs/${slug}/releases${qs ? `?${qs}` : ""}`);
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
  resolve: (ref: { orgSlug: string; slug: string }) =>
    fetchApi<ResolveResponse>(
      `/v1/orgs/${encodeURIComponent(ref.orgSlug)}/resolve/${encodeURIComponent(ref.slug)}`,
    ),
  sourceById: (id: string, opts: { cursor?: string | null; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.cursor != null) params.set("cursor", opts.cursor);
    if (opts.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return fetchApi<SourceDetail>(`/v1/sources/${encodeURIComponent(id)}${qs ? `?${qs}` : ""}`);
  },
  productOverview: (identifier: string) =>
    fetchApi<OverviewPageItem | null>(`/v1/products/${identifier}/overview`),
  /**
   * Thin org overview knowledge page (`GET /v1/orgs/:slug/overview`). Prefer
   * this over `orgDetail` when only the overview is needed — avoids re-fetching
   * the full org shell (#2047).
   */
  orgOverview: (slug: string) =>
    fetchApi<OverviewPageItem | null>(`/v1/orgs/${encodeURIComponent(slug)}/overview`),
  productActivity: (ref: { orgSlug: string; productSlug: string }, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return fetchApi<ProductActivityResponse>(
      `/v1/orgs/${ref.orgSlug}/products/${ref.productSlug}/activity${qs ? `?${qs}` : ""}`,
    );
  },
  productHeatmap: (ref: { orgSlug: string; productSlug: string }) =>
    fetchApi<ProductHeatmapResponse>(`/v1/orgs/${ref.orgSlug}/products/${ref.productSlug}/heatmap`),
  productCollections: (ref: { orgSlug: string; productSlug: string }) =>
    fetchApi<CollectionListItem[]>(
      `/v1/orgs/${ref.orgSlug}/products/${ref.productSlug}/collections`,
    ),
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
  collections: (opts: { featured?: boolean } = {}) =>
    fetchApi<CollectionListItem[]>(`/v1/collections${opts.featured ? "?featured=1" : ""}`),
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
  collectionDailySummaries: (slug: string, from?: string, to?: string) => {
    const qs = new URLSearchParams();
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetchApi<CollectionDailySummariesResponse>(
      `/v1/collections/${slug}/daily-summaries${suffix}`,
    );
  },
  collectionWeeklyDigests: (slug: string, opts: { cursor?: string; limit?: number } = {}) => {
    const { cursor, limit = 20 } = opts;
    const qs = new URLSearchParams();
    if (cursor) qs.set("cursor", cursor);
    if (limit !== 20) qs.set("limit", String(limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetchApi<CollectionWeeklyDigestsResponse>(`/v1/collections/${slug}/digests${suffix}`);
  },
  collectionWeeklyDigest: (slug: string, weekStart: string) =>
    fetchApi<CollectionWeeklyDigestDetail>(`/v1/collections/${slug}/digests/${weekStart}`),
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
  relatedReleases: (
    releaseId: string,
    scope: "org" | "global" = "global",
    limit = 8,
    excludeOrg?: string | null,
  ) =>
    fetchApi<RelatedReleasesResponse>(
      `/v1/related/releases?release=${encodeURIComponent(releaseId)}&scope=${scope}&limit=${limit}${
        excludeOrg ? `&excludeOrg=${encodeURIComponent(excludeOrg)}` : ""
      }`,
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
  /** AI-scored importance 1–5; null when unscored. Optional for older servers. */
  importance?: number | null;
  thumbnail: { url: string; alt?: string } | null;
  score: number;
  source: {
    id: string;
    slug: string;
    name: string;
    productName: string | null;
    orgSlug: string | null;
    orgName: string | null;
    orgAvatarUrl: string | null;
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
