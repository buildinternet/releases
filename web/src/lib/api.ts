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
} from "@shared/api/types";

export type {
  ReleaseSummaryItem,
  ReleaseItem,
  SearchReleaseHit,
  SearchOrgHit,
  SearchProductHit,
  SearchSourceHit,
  OrgReleaseItem,
  OverviewPageItem,
  KnowledgePageItem,
} from "@shared/api/types";

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
};

const API_URL = process.env.RELEASED_API_URL ?? "http://localhost:3456";
const API_SECRET = process.env.RELEASED_API_KEY;

export class ApiSetupError extends Error {
  setup: string[];
  constructor(message: string, setup: string[]) {
    super(message);
    this.name = "ApiSetupError";
    this.setup = setup;
  }
}

async function fetchApi<T>(path: string, init?: { cache?: RequestCache; next?: { revalidate?: number | false } }): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (API_SECRET) {
    headers["Authorization"] = `Bearer ${API_SECRET}`;
  }
  const fetchInit: RequestInit = { headers };
  if (init?.cache) {
    fetchInit.cache = init.cache;
  } else {
    (fetchInit as { next?: { revalidate?: number | false } }).next = init?.next ?? { revalidate: 60 };
  }
  try {
    res = await fetch(`${API_URL}${path}`, fetchInit);
  } catch {
    throw new ApiSetupError(
      `Cannot connect to the API at ${API_URL}. Is the server running?`,
      [`bun run dev:api    # start the Cloudflare worker API`, `# or`, `bun run api         # start the local Bun API server`]
    );
  }

  if (res.status === 503) {
    const body = await res.json().catch(() => null);
    if (body?.error === "database_not_initialized") {
      throw new ApiSetupError(body.message, body.setup);
    }
  }

  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  stats: () => fetchApi<Stats>("/v1/stats"),
  orgs: () => fetchApi<OrgListItem[]>("/v1/orgs"),
  orgDetail: (slug: string) => fetchApi<OrgDetail>(`/v1/orgs/${slug}`),
  sources: (independent?: boolean) => fetchApi<SourceListItem[]>(`/v1/sources${independent ? "?independent=true" : ""}`),
  sourceDetail: (slug: string, page = 1, pageSize = 20) =>
    fetchApi<SourceDetail>(`/v1/sources/${slug}?page=${page}&pageSize=${pageSize}`),
  search: (q: string, limit = 20, offset = 0) =>
    fetchApi<UnifiedSearchResponse>(`/v1/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
  sourceActivity: (slug: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return fetchApi<SourceActivity>(`/v1/sources/${slug}/activity${qs ? `?${qs}` : ""}`);
  },
  orgActivity: (slug: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return fetchApi<OrgActivity>(`/v1/orgs/${slug}/activity${qs ? `?${qs}` : ""}`);
  },
  orgReleases: (slug: string, cursor?: string, limit = 20) => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== 20) params.set("limit", String(limit));
    const qs = params.toString();
    return fetchApi<OrgReleasesResponse>(`/v1/orgs/${slug}/releases${qs ? `?${qs}` : ""}`);
  },
  orgHeatmap: (slug: string) => fetchApi<OrgHeatmap>(`/v1/orgs/${slug}/heatmap`),
  orgSparklines: (slug: string) => fetchApi<OrgSparklines>(`/v1/orgs/${slug}/sparklines`),
  // Release details bypass Next's Data Cache so stale successful responses
  // don't outlive a delete/replace on the API side — a deleted release must
  // 404 on the very next request, not on the next revalidate cycle.
  release: (id: string) => fetchApi<ReleaseDetail>(`/v1/releases/${id}`, { cache: "no-store" }),
  sourceHeatmap: (slug: string) => fetchApi<SourceHeatmap>(`/v1/sources/${slug}/heatmap`),
  productDetail: (slug: string) => fetchApi<ProductDetail>(`/v1/products/${slug}`),
  sourceChangelog: (slug: string, range?: { offset?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (range?.offset !== undefined) params.set("offset", String(range.offset));
    if (range?.limit !== undefined) params.set("limit", String(range.limit));
    const qs = params.toString();
    return fetchApi<SourceChangelogResponse>(
      `/v1/sources/${slug}/changelog${qs ? `?${qs}` : ""}`,
    );
  },
};
