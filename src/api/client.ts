import { getApiUrl, getApiKey } from "../lib/mode.js";
import type {
  Source, Organization, OrgAccount, IgnoredUrl,
} from "../db/schema.js";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
      ...opts?.headers,
    },
  });

  if (res.status === 404) return null as T;

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    const message = (body as { message?: string }).message ?? res.statusText;
    throw new Error(`API error (${res.status}): ${message}`);
  }

  return res.json();
}

// ── Source queries ──

export async function findSourceBySlug(slug: string): Promise<Source | null> {
  // API returns enriched data — extra fields are harmlessly ignored by callers expecting Source
  return apiFetch<Source | null>(`/api/sources/${slug}`);
}

export async function findSourcesByUrls(urls: string[]): Promise<Source[]> {
  if (urls.length === 0) return [];
  const params = urls.map((u) => `url=${encodeURIComponent(u)}`).join("&");
  return apiFetch<Source[]>(`/api/sources?filterByUrls=true&${params}`);
}

// ── Org queries ──

export async function findOrg(identifier: string): Promise<Organization | null> {
  return apiFetch<Organization | null>(`/api/orgs/${identifier}`);
}

export async function getSourcesByOrg(orgId: string): Promise<Source[]> {
  return apiFetch<Source[]>(`/api/sources?orgId=${orgId}`);
}

export async function listOrgs(opts?: { query?: string; platform?: string }): Promise<Organization[]> {
  const params = new URLSearchParams();
  if (opts?.query) params.set("q", opts.query);
  if (opts?.platform) params.set("platform", opts.platform);
  const qs = params.toString();
  return apiFetch<Organization[]>(`/api/orgs${qs ? `?${qs}` : ""}`);
}

export async function getOrgAccountByPlatform(orgId: string, platform: string): Promise<OrgAccount | null> {
  return apiFetch<OrgAccount | null>(`/api/orgs/${orgId}/accounts?platform=${platform}`);
}

// ── Ignore queries ──

export async function findIgnoredUrl(url: string): Promise<IgnoredUrl | null> {
  const encoded = encodeURIComponent(url);
  return apiFetch<IgnoredUrl | null>(`/api/ignore?url=${encoded}&single=true`);
}

export async function addIgnoredUrl(url: string, opts?: { orgId?: string; reason?: string }): Promise<void> {
  await apiFetch("/api/ignore", {
    method: "POST",
    body: JSON.stringify({ url, orgId: opts?.orgId, reason: opts?.reason }),
  });
}

export async function listIgnoredUrls(orgId?: string): Promise<IgnoredUrl[]> {
  const qs = orgId ? `?orgId=${orgId}` : "";
  return apiFetch<IgnoredUrl[]>(`/api/ignore${qs}`);
}

export async function removeIgnoredUrl(url: string): Promise<void> {
  await apiFetch(`/api/ignore/${encodeURIComponent(url)}`, { method: "DELETE" });
}

// ── Content hash ──

export async function checkContentHash(source: Source, contentHash: string): Promise<boolean> {
  const result = await apiFetch<{ unchanged: boolean }>(`/api/sources/${source.slug}/content-hash`, {
    method: "POST",
    body: JSON.stringify({ contentHash }),
  });
  return result.unchanged;
}

// ── Search ──

export async function searchReleasesForApi(query: string, limit: number, offset: number) {
  const result = await apiFetch<{ results: unknown[] }>(
    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
  );
  return result.results;
}
