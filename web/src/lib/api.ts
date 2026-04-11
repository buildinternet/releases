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
  OrgReleasesResponse,
  ReleaseDetail,
  ProductDetail,
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
  OrgReleasesResponse,
  ReleaseDetail,
  ProductDetail,
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

async function fetchApi<T>(path: string): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = {};
  if (API_SECRET) {
    headers["Authorization"] = `Bearer ${API_SECRET}`;
  }
  try {
    res = await fetch(`${API_URL}${path}`, { headers, next: { revalidate: 60 } });
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
  release: (id: string) => fetchApi<ReleaseDetail>(`/v1/releases/${id}`),
  productDetail: (slug: string) => fetchApi<ProductDetail>(`/v1/products/${slug}`),
};
