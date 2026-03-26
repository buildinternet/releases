const API_URL = process.env.RELEASED_API_URL ?? "http://localhost:3456";

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { next: { revalidate: 60 } });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json();
}

export interface Stats { orgs: number; sources: number; releases: number; }

export interface OrgListItem {
  slug: string; name: string; domain: string | null;
  sourceCount: number; releaseCount: number; lastActivity: string | null;
}

export interface OrgDetail {
  slug: string; name: string; domain: string | null;
  sourceCount: number; releaseCount: number;
  releasesLast30Days: number; avgReleasesPerWeek: number;
  trackingSince: string;
  accounts: { platform: string; handle: string }[];
  sources: SourceListItem[];
}

export interface SourceListItem {
  slug: string; name: string; type: string; url?: string;
  orgSlug?: string | null; releaseCount: number;
  latestVersion: string | null; latestDate: string | null;
}

export interface SourceDetail {
  slug: string; name: string; type: string; url: string;
  org: { slug: string; name: string } | null;
  releaseCount: number; releasesLast30Days: number; avgReleasesPerWeek: number;
  latestVersion: string | null; latestDate: string | null;
  trackingSince: string;
  releases: ReleaseItem[];
  pagination: { page: number; pageSize: number; totalPages: number; totalItems: number };
}

export interface ReleaseItem {
  version: string | null; title: string; summary: string;
  publishedAt: string | null; url: string | null;
}

export interface SearchResult {
  sourceSlug: string; sourceName: string; orgSlug: string | null;
  version: string | null; title: string; summary: string; publishedAt: string | null;
}

export interface SearchResponse { query: string; results: SearchResult[]; }

export const api = {
  stats: () => fetchApi<Stats>("/api/stats"),
  orgs: () => fetchApi<OrgListItem[]>("/api/orgs"),
  orgDetail: (slug: string) => fetchApi<OrgDetail>(`/api/orgs/${slug}`),
  sources: (independent?: boolean) => fetchApi<SourceListItem[]>(`/api/sources${independent ? "?independent=true" : ""}`),
  sourceDetail: (slug: string, page = 1, pageSize = 20) =>
    fetchApi<SourceDetail>(`/api/sources/${slug}?page=${page}&pageSize=${pageSize}`),
  search: (q: string, limit = 20, offset = 0) =>
    fetchApi<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`),
};
