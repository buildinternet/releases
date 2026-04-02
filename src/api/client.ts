import { getApiUrl, getApiKey } from "../lib/mode.js";
import { daysAgoIso } from "../lib/dates.js";
import type {
  Source, Release, Organization, OrgAccount, IgnoredUrl, BlockedUrl,
  ReleaseSummary, NewReleaseSummary, Product,
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
    throw new Error(`API error (${res.status}) on ${opts?.method ?? "GET"} ${path}: ${message}`);
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

// ── Ignored URLs (org-scoped) ──

export async function findIgnoredUrl(url: string, orgId: string): Promise<IgnoredUrl | null> {
  const encoded = encodeURIComponent(url);
  return apiFetch<IgnoredUrl | null>(`/api/orgs/${orgId}/ignored-urls?url=${encoded}&single=true`);
}

export async function addIgnoredUrl(url: string, orgId: string, reason?: string): Promise<void> {
  await apiFetch(`/api/orgs/${orgId}/ignored-urls`, {
    method: "POST",
    body: JSON.stringify({ url, reason }),
  });
}

export async function listIgnoredUrls(orgId: string): Promise<IgnoredUrl[]> {
  return apiFetch<IgnoredUrl[]>(`/api/orgs/${orgId}/ignored-urls`);
}

export async function removeIgnoredUrl(url: string, orgId: string): Promise<void> {
  await apiFetch(`/api/orgs/${orgId}/ignored-urls/${encodeURIComponent(url)}`, { method: "DELETE" });
}

// ── Blocked URLs (global) ──

export async function findBlockedUrl(url: string): Promise<BlockedUrl | null> {
  const encoded = encodeURIComponent(url);
  return apiFetch<BlockedUrl | null>(`/api/blocked-urls?url=${encoded}&single=true`);
}

export async function addBlockedUrl(pattern: string, type: "exact" | "domain", reason?: string): Promise<void> {
  await apiFetch("/api/blocked-urls", {
    method: "POST",
    body: JSON.stringify({ pattern, type, reason }),
  });
}

export async function listBlockedUrls(): Promise<BlockedUrl[]> {
  return apiFetch<BlockedUrl[]>("/api/blocked-urls");
}

export async function removeBlockedUrl(pattern: string): Promise<void> {
  await apiFetch(`/api/blocked-urls/${encodeURIComponent(pattern)}`, { method: "DELETE" });
}

// ── Release CRUD ──

export interface ReleaseWithSource {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  contentSummary: string | null;
  url: string | null;
  contentHash: string | null;
  metadata: string | null;
  publishedAt: string | null;
  suppressed: boolean;
  suppressedReason: string | null;
  fetchedAt: string;
  sourceName: string | null;
  sourceSlug: string | null;
}

export async function getRelease(id: string): Promise<ReleaseWithSource | null> {
  return apiFetch<ReleaseWithSource | null>(`/api/releases/${id}`);
}

export async function deleteRelease(id: string): Promise<boolean> {
  const result = await apiFetch<{ deleted: boolean } | null>(`/api/releases/${id}`, { method: "DELETE" });
  return result?.deleted ?? false;
}

export async function updateRelease(id: string, data: Record<string, unknown>): Promise<ReleaseWithSource> {
  return apiFetch<ReleaseWithSource>(`/api/releases/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── Release suppression ──

export async function suppressRelease(releaseId: string, reason?: string): Promise<boolean> {
  const result = await apiFetch<{ suppressed: boolean }>(`/api/releases/${releaseId}/suppress`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  return result?.suppressed ?? false;
}

export async function unsuppressRelease(releaseId: string): Promise<boolean> {
  const result = await apiFetch<{ unsuppressed: boolean }>(`/api/releases/${releaseId}/unsuppress`, {
    method: "POST",
  });
  return result?.unsuppressed ?? false;
}

// ── Content hash ──

export async function checkContentHash(source: Source, contentHash: string): Promise<boolean> {
  const result = await apiFetch<{ unchanged: boolean } | null>(`/api/sources/${source.slug}/content-hash`, {
    method: "POST",
    body: JSON.stringify({ contentHash }),
  });
  return result?.unchanged ?? false;
}

// ── Search ──

export async function searchReleasesForApi(query: string, limit: number, offset: number) {
  const result = await apiFetch<{ results: unknown[] }>(
    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
  );
  return result.results;
}

export interface SearchResultRemote {
  sourceSlug: string;
  sourceName: string;
  orgSlug: string | null;
  version: string | null;
  title: string;
  summary: string;
  publishedAt: string | null;
}

export async function searchReleasesRemote(
  query: string,
  limit: number,
  opts?: { org?: string },
): Promise<SearchResultRemote[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit), offset: "0" });
  if (opts?.org) params.set("org", opts.org);
  const result = await apiFetch<{ results: SearchResultRemote[] }>(`/api/search?${params}`);
  return result.results;
}

// ── List sources with org ──

export interface SourceWithOrg {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
  lastFetchedAt: string | null;
  orgName: string | null;
  productName: string | null;
  productSlug: string | null;
  metadata: string | null;
  isPrimary: boolean;
  isHidden?: boolean;
}

export async function listSourcesWithOrg(opts?: {
  orgSlug?: string;
  productSlug?: string;
  hasFeed?: boolean;
  enrichable?: boolean;
  query?: string;
  includeHidden?: boolean;
}): Promise<SourceWithOrg[]> {
  const params = new URLSearchParams();
  if (opts?.orgSlug) params.set("orgSlug", opts.orgSlug);
  if (opts?.productSlug) params.set("productSlug", opts.productSlug);
  if (opts?.hasFeed) params.set("has_feed", "true");
  if (opts?.enrichable) params.set("enrichable", "true");
  if (opts?.query) params.set("query", opts.query);
  if (opts?.includeHidden) params.set("include_hidden", "true");
  const qs = params.toString();

  // The API GET /api/sources returns enriched source data — map to the shape the CLI needs
  const rows = await apiFetch<Array<{
    slug: string; name: string; type: string; url: string;
    orgSlug: string | null; releaseCount: number;
    latestVersion: string | null; latestDate: string | null;
    metadata: string | null;
    isPrimary?: boolean;
    isHidden?: boolean;
    productName?: string | null;
    productSlug?: string | null;
  }>>(`/api/sources${qs ? `?${qs}` : ""}`);

  return rows.map((r) => ({
    id: "",
    name: r.name,
    slug: r.slug,
    type: r.type,
    url: r.url,
    lastFetchedAt: null,
    orgName: r.orgSlug,
    productName: r.productName ?? null,
    productSlug: r.productSlug ?? null,
    metadata: r.metadata ?? null,
    isPrimary: r.isPrimary ?? false,
    isHidden: r.isHidden ?? false,
  }));
}

// ── Stats ──

export interface StatsSummary {
  period: { days: number; cutoff: string };
  totals: {
    organizations: number;
    sources: number;
    releases: number;
    releasesInPeriod: number;
  };
  sourceHealth: {
    upToDate: number;
    stale: number;
    neverFetched: number;
  };
  sources: Array<{
    sourceName: string;
    sourceSlug: string;
    sourceType: string;
    orgName: string | null;
    lastFetchedAt: string | null;
    totalReleases: number;
    recentReleases: number;
  }>;
  recentActivity: Array<{
    sourceName: string;
    sourceSlug: string;
    orgName: string | null;
    releasesFound: number;
    releasesInserted: number;
    totalReleases: number;
    status: string;
    durationMs: number | null;
    error: string | null;
    createdAt: string;
  }>;
}

export async function getStatsSummary(days: number): Promise<StatsSummary> {
  const cutoff = daysAgoIso(days);

  // Compose from existing endpoints
  const [statsData, fetchLogData, sourcesData] = await Promise.all([
    apiFetch<{ orgs: number; sources: number; releases: number }>("/api/stats"),
    apiFetch<Array<{
      id: string; sourceId: string; releasesFound: number; releasesInserted: number;
      durationMs: number | null; status: string; error: string | null; createdAt: string;
    }>>("/api/fetch-log?limit=20"),
    apiFetch<Array<{
      slug: string; name: string; type: string; url: string;
      orgSlug: string | null; releaseCount: number;
    }>>("/api/sources"),
  ]);

  return {
    period: { days, cutoff },
    totals: {
      organizations: statsData.orgs,
      sources: statsData.sources,
      releases: statsData.releases,
      releasesInPeriod: 0, // Not available from basic stats endpoint
    },
    sourceHealth: {
      upToDate: 0,
      stale: 0,
      neverFetched: 0,
    },
    sources: sourcesData.map((s) => ({
      sourceName: s.name,
      sourceSlug: s.slug,
      sourceType: s.type,
      orgName: s.orgSlug,
      lastFetchedAt: null,
      totalReleases: s.releaseCount,
      recentReleases: 0,
    })),
    recentActivity: fetchLogData.map((f) => ({
      sourceName: "",
      sourceSlug: "",
      orgName: null,
      releasesFound: f.releasesFound,
      releasesInserted: f.releasesInserted,
      totalReleases: 0,
      status: f.status,
      durationMs: f.durationMs,
      error: f.error,
      createdAt: f.createdAt,
    })),
  };
}

// ── Usage log ──

export interface UsageBreakdownRow {
  label: string | null;
  totalInput: number;
  totalOutput: number;
  count: number;
}

export interface UsageStatsResponse {
  totals: { totalInput: number; totalOutput: number; count: number };
  byOperation: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  bySource: UsageBreakdownRow[];
}

export async function getUsageStats(days: number): Promise<UsageStatsResponse> {
  return apiFetch<UsageStatsResponse>(`/api/usage-log/stats?days=${days}`);
}

export async function postUsageLog(entry: {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  sourceSlug?: string | null;
  releaseCount?: number | null;
}): Promise<void> {
  await apiFetch("/api/usage-log", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

// ── Fetch log write ──

export async function postFetchLog(entry: {
  sourceId: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs?: number | null;
  status: "success" | "error" | "no_change" | "dry_run";
  error?: string | null;
  rawContent?: string | null;
}): Promise<void> {
  await apiFetch("/api/fetch-log", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

// ── Fetch log read ──

export interface FetchLogEntry {
  id: string;
  sourceName: string;
  sourceSlug: string;
  status: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export async function getFetchLogs(opts: {
  sourceSlug?: string;
  limit: number;
}): Promise<FetchLogEntry[]> {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.sourceSlug) params.set("source", opts.sourceSlug);
  const logs = await apiFetch<Array<{
    id: string; sourceId: string; releasesFound: number; releasesInserted: number;
    durationMs: number | null; status: string; error: string | null;
    rawContent: string | null; createdAt: string;
  }>>(`/api/fetch-log?${params}`);

  // The API fetch-log endpoint returns raw fetch_log rows without source name/slug.
  // In remote mode we don't have the join data, so we provide what we can.
  return logs.map((l) => ({
    id: l.id,
    sourceName: "",
    sourceSlug: "",
    status: l.status,
    releasesFound: l.releasesFound,
    releasesInserted: l.releasesInserted,
    durationMs: l.durationMs,
    error: l.error,
    createdAt: l.createdAt,
  }));
}

// ── Latest releases ──

export interface LatestRelease {
  title: string;
  version: string | null;
  publishedAt: string | null;
  sourceName: string;
}

type SourceReleaseResponse = {
  name: string;
  releases: Array<{ version: string | null; title: string; publishedAt: string | null }>;
};

function byPublishedAtDesc(a: LatestRelease, b: LatestRelease): number {
  if (!a.publishedAt && !b.publishedAt) return 0;
  if (!a.publishedAt) return 1;
  if (!b.publishedAt) return -1;
  return b.publishedAt.localeCompare(a.publishedAt);
}

async function collectReleasesFromSources(
  slugs: string[],
  pageSize: number,
): Promise<LatestRelease[]> {
  const results = await Promise.all(
    slugs.map((slug) => apiFetch<SourceReleaseResponse>(`/api/sources/${slug}?pageSize=${pageSize}`)),
  );
  const all: LatestRelease[] = [];
  for (const srcData of results) {
    if (!srcData) continue;
    for (const r of srcData.releases) {
      all.push({
        title: r.title,
        version: r.version,
        publishedAt: r.publishedAt,
        sourceName: srcData.name,
      });
    }
  }
  return all;
}

export async function getLatestReleases(opts: {
  slug?: string;
  orgSlug?: string;
  count: number;
}): Promise<LatestRelease[]> {
  if (opts.slug) {
    const data = await apiFetch<SourceReleaseResponse>(`/api/sources/${opts.slug}?pageSize=${opts.count}`);
    if (!data) return [];
    return data.releases.map((r) => ({
      title: r.title,
      version: r.version,
      publishedAt: r.publishedAt,
      sourceName: data.name,
    }));
  }

  if (opts.orgSlug) {
    const data = await apiFetch<{
      sources: Array<{ slug: string; name: string }>;
    }>(`/api/orgs/${opts.orgSlug}`);
    if (!data) return [];
    const all = await collectReleasesFromSources(data.sources.map((s) => s.slug), opts.count);
    return all.sort(byPublishedAtDesc).slice(0, opts.count);
  }

  const sourcesData = await apiFetch<Array<{ slug: string; name: string }>>("/api/sources");
  const all = await collectReleasesFromSources(sourcesData.slice(0, 10).map((s) => s.slug), opts.count);
  return all.sort(byPublishedAtDesc).slice(0, opts.count);
}

// ── Enrichable releases ──

export async function getEnrichableReleases(sourceSlug: string, limit?: number): Promise<Release[]> {
  const params = new URLSearchParams({ enrichable: "true" });
  if (limit) params.set("limit", String(limit));
  const res = await apiFetch<{ releases: Release[] }>(`/api/sources/${sourceSlug}/releases?${params}`);
  return res?.releases ?? [];
}

// ── Known releases for incremental parsing ──

export async function getKnownReleasesForSource(
  sourceSlug: string,
  limit: number,
): Promise<Array<{ version: string | null; title: string; publishedAt: string | null }>> {
  const data = await apiFetch<Array<{ version: string | null; title: string; publishedAt: string | null }>>(
    `/api/sources/${sourceSlug}/known-releases?limit=${limit}`,
  );
  return data ?? [];
}

// ── Fetchable sources ──

export async function listFetchableSources(opts: {
  mode: "all" | "unfetched" | "stale" | "retry_errors";
  staleHours?: number;
}): Promise<Source[]> {
  const params = new URLSearchParams({ mode: opts.mode });
  if (opts.staleHours) params.set("staleHours", String(opts.staleHours));
  return apiFetch<Source[]>(`/api/sources/fetchable?${params}`);
}

// ── Source CRUD ──

export async function updateSource(slug: string, data: Record<string, unknown>): Promise<Source> {
  return apiFetch<Source>(`/api/sources/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteSource(slug: string): Promise<void> {
  await apiFetch(`/api/sources/${slug}`, { method: "DELETE" });
}

export async function insertReleasesBatch(sourceSlug: string, releaseRows: Array<{
  version?: string | null; title: string; content: string;
  url?: string | null; contentHash?: string | null; publishedAt?: string | null;
}>): Promise<{ inserted: number; total: number }> {
  // Send in concurrent chunks to stay under D1/Worker request size limits
  const chunks: typeof releaseRows[] = [];
  for (let i = 0; i < releaseRows.length; i += 5) {
    chunks.push(releaseRows.slice(i, i + 5));
  }
  const results = await Promise.all(
    chunks.map((chunk) =>
      apiFetch<{ inserted: number; total: number }>(`/api/sources/${sourceSlug}/releases/batch`, {
        method: "POST",
        body: JSON.stringify({ releases: chunk }),
      })
    )
  );
  const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0);
  const lastTotal = results[results.length - 1]?.total ?? 0;
  return { inserted: totalInserted, total: lastTotal };
}

export async function deleteReleasesForSource(sourceSlug: string): Promise<{ deleted: number }> {
  return apiFetch(`/api/sources/${sourceSlug}/releases`, { method: "DELETE" });
}

export async function createSource(data: {
  name: string;
  slug: string;
  type: string;
  url: string;
  orgId?: string | null;
  productId?: string | null;
  metadata?: string;
}): Promise<Source> {
  return apiFetch<Source>("/api/sources", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ── Org CRUD ──

export async function createOrg(
  name: string,
  opts?: { slug?: string; domain?: string; description?: string },
): Promise<Organization> {
  return apiFetch<Organization>("/api/orgs", {
    method: "POST",
    body: JSON.stringify({ name, slug: opts?.slug, domain: opts?.domain, description: opts?.description }),
  });
}

export async function removeOrg(slug: string): Promise<void> {
  await apiFetch(`/api/orgs/${slug}`, { method: "DELETE" });
}

export async function getOrgAccountsBySlug(
  orgSlug: string,
): Promise<Array<{ platform: string; handle: string }>> {
  const data = await apiFetch<{
    accounts: Array<{ platform: string; handle: string }>;
  }>(`/api/orgs/${orgSlug}`);
  return data?.accounts ?? [];
}

export async function linkOrgAccount(
  orgSlug: string,
  platform: string,
  handle: string,
): Promise<OrgAccount> {
  return apiFetch<OrgAccount>(`/api/orgs/${orgSlug}/accounts`, {
    method: "POST",
    body: JSON.stringify({ platform, handle }),
  });
}

export async function unlinkOrgAccount(
  orgSlug: string,
  platform: string,
  handle: string,
): Promise<void> {
  // The API doesn't have a dedicated unlink endpoint — use PATCH to update org or
  // we need to add one. For now, this is a placeholder that will need a matching API endpoint.
  // The simplest approach: DELETE /api/orgs/:slug/accounts/:platform/:handle
  await apiFetch(`/api/orgs/${orgSlug}/accounts/${platform}/${encodeURIComponent(handle)}`, {
    method: "DELETE",
  });
}

// ── Product queries ──

export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string },
): Promise<Product> {
  return apiFetch<Product>(`/api/products`, {
    method: "POST",
    body: JSON.stringify({ orgId, name, slug: opts?.slug, url: opts?.url, description: opts?.description }),
  });
}

export async function findProduct(identifier: string): Promise<Product | null> {
  return apiFetch<Product | null>(`/api/products/${identifier}`);
}

export async function getProductsByOrg(orgId: string): Promise<Array<Product & { sourceCount: number }>> {
  return apiFetch<Array<Product & { sourceCount: number }>>(`/api/products?orgId=${orgId}`);
}

export async function updateProduct(slug: string, data: Record<string, unknown>): Promise<Product> {
  return apiFetch<Product>(`/api/products/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteProduct(productId: string): Promise<void> {
  await apiFetch(`/api/products/${productId}`, { method: "DELETE" });
}

// ── Status events ──

export async function postStatusEvent(event: {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}): Promise<{ cancelRequested: boolean }> {
  try {
    const result = await apiFetch<{ cancelRequested?: boolean }>("/api/status/event", {
      method: "POST",
      body: JSON.stringify(event),
    });
    return { cancelRequested: result?.cancelRequested === true };
  } catch {
    // Graceful fallback if the response isn't JSON or the request fails
    return { cancelRequested: false };
  }
}

// ── Recent releases ──

export async function getRecentReleases(sourceSlug: string, cutoffIso: string): Promise<Release[]> {
  return apiFetch<Release[]>(`/api/sources/${sourceSlug}/recent-releases?cutoff=${cutoffIso}`);
}

// ── Release summaries ──

export async function getSummariesForSource(sourceId: string): Promise<ReleaseSummary[]> {
  return apiFetch<ReleaseSummary[]>(`/api/summaries?sourceId=${sourceId}`);
}

export async function upsertSummary(data: NewReleaseSummary): Promise<void> {
  await apiFetch("/api/summaries", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getMonthlySummary(
  sourceId: string,
  year: number,
  month: number,
): Promise<ReleaseSummary | undefined> {
  const rows = await apiFetch<ReleaseSummary[]>(
    `/api/summaries?sourceId=${sourceId}&type=monthly&year=${year}&month=${month}`,
  );
  return rows[0];
}

// ── Media Assets ──

import type { MediaAssetInput } from "../db/queries.js";

export async function insertMediaAssets(
  assets: MediaAssetInput[],
): Promise<{ inserted: number }> {
  return apiFetch("/api/media/assets", {
    method: "POST",
    body: JSON.stringify({ assets }),
  });
}

export async function getMediaAssetStats(): Promise<{ count: number; totalBytes: number }> {
  return apiFetch("/api/media/assets/stats");
}

export async function queryReleasesWithMedia(): Promise<{ id: string; sourceId: string; media: string }[]> {
  return apiFetch("/api/releases?hasMedia=true&fields=id,sourceId,media");
}

// ── Sessions ──

export interface Session {
  sessionId: string;
  company: string;
  type: "onboard" | "update";
  status: "running" | "complete" | "error" | "cancelled";
  step?: string;
  totalSources?: number;
  sourcesFetched?: number;
  releasesFound?: number;
  releasesInserted?: number;
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt: number;
  error?: string;
  activeSources?: string[];
  cancelRequested?: boolean;
}

export async function listSessions(): Promise<Session[]> {
  return apiFetch<Session[]>("/api/sessions");
}

export async function getSession(sessionId: string): Promise<Session | null> {
  return apiFetch<Session | null>(`/api/sessions/${sessionId}`);
}

export async function getActiveSources(): Promise<{ slugs: string[]; sessionMap: Record<string, string> }> {
  return apiFetch<{ slugs: string[]; sessionMap: Record<string, string> }>("/api/sessions/active-sources");
}

export async function cancelSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch<{ ok: boolean; error?: string }>(`/api/sessions/${sessionId}/cancel`, {
    method: "POST",
  });
}
