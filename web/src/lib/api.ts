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

export interface Stats { orgs: number; sources: number; releases: number; }

export interface OrgListItem {
  slug: string; name: string; domain: string | null;
  sourceCount: number; releaseCount: number; recentReleaseCount: number;
  lastActivity: string | null;
}

export interface OrgDetail {
  slug: string; name: string; domain: string | null;
  sourceCount: number; releaseCount: number;
  releasesLast30Days: number; avgReleasesPerWeek: number;
  lastFetchedAt: string | null;
  trackingSince: string;
  accounts: { platform: string; handle: string }[];
  sources: SourceListItem[];
}

export interface SourceListItem {
  slug: string; name: string; type: string; url?: string;
  orgSlug?: string | null; releaseCount: number;
  latestVersion: string | null; latestDate: string | null;
  isPrimary?: boolean;
}

export interface SourceDetail {
  slug: string; name: string; type: string; url: string;
  changelogUrl?: string | null;
  org: { slug: string; name: string } | null;
  releaseCount: number; releasesLast30Days: number; avgReleasesPerWeek: number;
  latestVersion: string | null; latestDate: string | null;
  lastFetchedAt: string | null;
  trackingSince: string;
  releases: ReleaseItem[];
  pagination: { page: number; pageSize: number; totalPages: number; totalItems: number };
  summaries: {
    rolling: ReleaseSummaryItem | null;
    monthly: ReleaseSummaryItem[];
  };
}

export interface ReleaseSummaryItem {
  year?: number | null;
  month?: number | null;
  windowDays?: number | null;
  summary: string;
  releaseCount: number;
  generatedAt: string;
}

export interface ReleaseItem {
  id?: string;
  version: string | null; title: string; summary: string;
  content?: string;
  publishedAt: string | null; url: string | null;
  media?: Array<{ type: "image" | "video" | "gif"; url: string; alt?: string; r2Url?: string }>;
}

export interface ReleaseDetail {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  contentSummary: string | null;
  url: string | null;
  media: Array<{ type: "image" | "video" | "gif"; url: string; alt?: string; r2Url?: string }>;
  publishedAt: string | null;
  fetchedAt: string;
  sourceName: string;
  sourceSlug: string;
  sourceType: string;
  org: { slug: string; name: string } | null;
}

export interface SearchResult {
  sourceSlug: string; sourceName: string; orgSlug: string | null;
  version: string | null; title: string; summary: string; publishedAt: string | null;
}

export interface SearchResponse { query: string; results: SearchResult[]; }

export interface SourceActivity {
  source: { slug: string; name: string; orgSlug: string | null; orgName: string | null };
  range: { from: string; to: string };
  weeklyBuckets: Array<{ weekStart: string; count: number; earliestVersion: string | null; latestVersion: string | null }>;
}

export interface OrgActivitySource {
  slug: string;
  name: string;
  releaseCount: number;
  avgReleasesPerWeek: number;
  earliestVersion: string | null;
  latestVersion: string | null;
  latestDate: string | null;
  weeklyBuckets: Array<{ weekStart: string; count: number; earliestVersion: string | null; latestVersion: string | null }>;
}

export interface OrgActivity {
  org: { slug: string; name: string };
  range: { from: string; to: string };
  sources: OrgActivitySource[];
  aggregateWeekly: Array<{ weekStart: string; count: number }>;
}

export interface OrgReleaseItem extends ReleaseItem {
  source: { slug: string; name: string; type: string };
}

export interface OrgReleasesResponse {
  releases: OrgReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
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
