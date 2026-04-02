export type {
  ReleaseSummaryItem,
  ReleaseItem,
  SearchResult,
  OrgReleaseItem,
} from "@shared/api/types";

import type {
  Stats,
  OrgListItem,
  OrgDetail,
  SourceListItem,
  SourceDetail,
  SearchResponse,
  SourceActivity,
  OrgActivity,
  OrgReleasesResponse,
  ReleaseDetail,
} from "@shared/api/types";

export type {
  Stats,
  OrgListItem,
  OrgDetail,
  SourceListItem,
  SourceDetail,
  SearchResponse,
  SourceActivity,
  OrgActivity,
  OrgReleasesResponse,
  ReleaseDetail,
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
  stats: () => fetchApi<Stats>("/api/stats"),
  orgs: () => fetchApi<OrgListItem[]>("/api/orgs"),
  orgDetail: (slug: string) => fetchApi<OrgDetail>(`/api/orgs/${slug}`),
  sources: (independent?: boolean) => fetchApi<SourceListItem[]>(`/api/sources${independent ? "?independent=true" : ""}`),
  sourceDetail: (slug: string, page = 1, pageSize = 20) =>
    fetchApi<SourceDetail>(`/api/sources/${slug}?page=${page}&pageSize=${pageSize}`),
  search: (q: string, limit = 20, offset = 0) =>
    fetchApi<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
  sourceActivity: (slug: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return fetchApi<SourceActivity>(`/api/sources/${slug}/activity${qs ? `?${qs}` : ""}`);
  },
  orgActivity: (slug: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return fetchApi<OrgActivity>(`/api/orgs/${slug}/activity${qs ? `?${qs}` : ""}`);
  },
  orgReleases: (slug: string, cursor?: string, limit = 20) => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== 20) params.set("limit", String(limit));
    const qs = params.toString();
    return fetchApi<OrgReleasesResponse>(`/api/orgs/${slug}/releases${qs ? `?${qs}` : ""}`);
  },
  release: (id: string) => fetchApi<ReleaseDetail>(`/api/releases/${id}`),
};
