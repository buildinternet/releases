import { getApiUrl, getApiKey, isAdminMode } from "../lib/mode.js";
import { logger } from "@releases/lib/logger";
import type {
  Source, Release, Organization, OrgAccount, IgnoredUrl, BlockedUrl,
  ReleaseSummary, NewReleaseSummary, Product, Tag, DomainAlias, KnowledgePage,
  ReleaseType,
} from "@releases/core/schema";
import type {
  SourceWithOrg, Stats, UnifiedSearchResponse, SourceChangelogResponse,
  ReleaseWithSource, StatsSummary, FetchLogEntry, LatestRelease,
  UsageBreakdownRow, UsageStatsResponse, Session,
  EmbedBackfillResponse, EmbedStatusResponse, MediaItem,
} from "./types.js";
export type {
  SourceWithOrg, SourcePatchInput, ReleaseWithSource, StatsSummary,
  FetchLogEntry, LatestRelease, UsageBreakdownRow, UsageStatsResponse,
  Session, EmbedBackfillResponse, EmbedStatusResponse,
  SearchResult, Stats, SourceListItem,
} from "./types.js";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const url = `${getApiUrl()}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts?.headers as Record<string, string>,
  };
  // Only send auth header when an API key is configured (admin mode)
  if (isAdminMode()) {
    headers["Authorization"] = `Bearer ${getApiKey()}`;
  }
  const res = await fetch(url, {
    ...opts,
    headers,
  });

  if (res.status === 404 && (!opts?.method || opts.method === "GET")) return null as T;

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    const message = (body as { message?: string }).message ?? res.statusText;
    throw new Error(`API error (${res.status}) on ${opts?.method ?? "GET"} ${path}: ${message}`);
  }

  return res.json();
}

// ── Source queries ──

export async function findSource(identifier: string): Promise<Source | null> {
  // API returns enriched data — extra fields are harmlessly ignored by callers expecting Source
  return apiFetch<Source | null>(`/v1/sources/${identifier}`);
}

export async function sourceChangelog(
  slug: string,
  range?: { path?: string; offset?: number; limit?: number; tokens?: number },
): Promise<SourceChangelogResponse | null> {
  const params = new URLSearchParams();
  if (range?.path !== undefined) params.set("path", range.path);
  if (range?.offset !== undefined) params.set("offset", String(range.offset));
  if (range?.limit !== undefined) params.set("limit", String(range.limit));
  if (range?.tokens !== undefined) params.set("tokens", String(range.tokens));
  const qs = params.toString();
  return apiFetch<SourceChangelogResponse | null>(`/v1/sources/${slug}/changelog${qs ? `?${qs}` : ""}`);
}

export async function findSourcesByUrls(urls: string[]): Promise<Source[]> {
  if (urls.length === 0) return [];
  const params = urls.map((u) => `url=${encodeURIComponent(u)}`).join("&");
  return apiFetch<Source[]>(`/v1/sources?filterByUrls=true&${params}`);
}

// ── Org queries ──

export async function findOrg(identifier: string): Promise<Organization | null> {
  return apiFetch<Organization | null>(`/v1/orgs/${identifier}`);
}

async function suggestEntities(
  endpoint: string,
  term: string,
  limit: number,
): Promise<Array<{ slug: string; name: string }>> {
  const all = await apiFetch<Array<{ slug: string; name: string }>>(`${endpoint}?limit=200`) ?? [];
  const lower = term.toLowerCase();
  return all
    .filter((e) => e.slug.includes(lower) || e.name.toLowerCase().includes(lower))
    .slice(0, limit);
}

export const suggestOrgs = (term: string, limit: number) => suggestEntities("/v1/orgs", term, limit);
export const suggestSources = (term: string, limit: number) => suggestEntities("/v1/sources", term, limit);

export async function getSourcesByOrg(orgId: string): Promise<Source[]> {
  return apiFetch<Source[]>(`/v1/sources?orgId=${orgId}`);
}

export async function listOrgs(opts?: { query?: string; platform?: string }): Promise<Organization[]> {
  const params = new URLSearchParams();
  if (opts?.query) params.set("q", opts.query);
  if (opts?.platform) params.set("platform", opts.platform);
  const qs = params.toString();
  return apiFetch<Organization[]>(`/v1/orgs${qs ? `?${qs}` : ""}`);
}

export async function getOrgAccountByPlatform(orgId: string, platform: string): Promise<OrgAccount | null> {
  return apiFetch<OrgAccount | null>(`/v1/orgs/${orgId}/accounts?platform=${platform}`);
}

// ── Ignored URLs (org-scoped) ──

export async function findIgnoredUrl(url: string, orgId: string): Promise<IgnoredUrl | null> {
  const encoded = encodeURIComponent(url);
  return apiFetch<IgnoredUrl | null>(`/v1/orgs/${orgId}/ignored-urls?url=${encoded}&single=true`);
}

export async function addIgnoredUrl(url: string, orgId: string, reason?: string): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/ignored-urls`, {
    method: "POST",
    body: JSON.stringify({ url, reason }),
  });
}

export async function listIgnoredUrls(orgId: string): Promise<IgnoredUrl[]> {
  return apiFetch<IgnoredUrl[]>(`/v1/orgs/${orgId}/ignored-urls`);
}

export async function removeIgnoredUrl(url: string, orgId: string): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/ignored-urls/${encodeURIComponent(url)}`, { method: "DELETE" });
}

// ── Blocked URLs (global) ──

export async function findBlockedUrl(url: string): Promise<BlockedUrl | null> {
  const encoded = encodeURIComponent(url);
  return apiFetch<BlockedUrl | null>(`/v1/blocked-urls?url=${encoded}&single=true`);
}

export async function addBlockedUrl(pattern: string, type: "exact" | "domain", reason?: string): Promise<void> {
  await apiFetch("/v1/blocked-urls", {
    method: "POST",
    body: JSON.stringify({ pattern, type, reason }),
  });
}

export async function listBlockedUrls(): Promise<BlockedUrl[]> {
  return apiFetch<BlockedUrl[]>("/v1/blocked-urls");
}

export async function removeBlockedUrl(pattern: string): Promise<void> {
  await apiFetch(`/v1/blocked-urls/${encodeURIComponent(pattern)}`, { method: "DELETE" });
}

// ── Release CRUD ──

export async function getRelease(id: string): Promise<ReleaseWithSource | null> {
  return apiFetch<ReleaseWithSource | null>(`/v1/releases/${id}`);
}

export async function deleteRelease(id: string): Promise<boolean> {
  const result = await apiFetch<{ deleted: boolean } | null>(`/v1/releases/${id}`, { method: "DELETE" });
  return result?.deleted ?? false;
}

export async function updateRelease(id: string, data: Record<string, unknown>): Promise<ReleaseWithSource> {
  return apiFetch<ReleaseWithSource>(`/v1/releases/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

// ── Release suppression ──

export async function suppressRelease(releaseId: string, reason?: string): Promise<boolean> {
  const result = await apiFetch<{ suppressed: boolean }>(`/v1/releases/${releaseId}/suppress`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
  return result?.suppressed ?? false;
}

export async function unsuppressRelease(releaseId: string): Promise<boolean> {
  const result = await apiFetch<{ unsuppressed: boolean }>(`/v1/releases/${releaseId}/unsuppress`, {
    method: "POST",
  });
  return result?.unsuppressed ?? false;
}

// ── Content hash ──

export async function checkContentHash(source: Source, contentHash: string): Promise<boolean> {
  const result = await apiFetch<{ unchanged: boolean } | null>(`/v1/sources/${source.slug}/content-hash`, {
    method: "POST",
    body: JSON.stringify({ contentHash }),
  });
  return result?.unchanged ?? false;
}

// ── Search ──

export async function unifiedSearch(
  query: string,
  limit: number,
  opts?: { org?: string; mode?: "lexical" | "semantic" | "hybrid" },
): Promise<UnifiedSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (opts?.org) params.set("org", opts.org);
  if (opts?.mode) params.set("mode", opts.mode);
  return apiFetch<UnifiedSearchResponse>(`/v1/search?${params}`);
}

// ── List sources with org ──

export async function listSourcesWithOrg(opts?: {
  orgSlug?: string;
  productSlug?: string;
  hasFeed?: boolean;
  query?: string;
  includeHidden?: boolean;
  category?: string;
}): Promise<SourceWithOrg[]> {
  const params = new URLSearchParams();
  if (opts?.orgSlug) params.set("orgSlug", opts.orgSlug);
  if (opts?.productSlug) params.set("productSlug", opts.productSlug);
  if (opts?.hasFeed) params.set("has_feed", "true");
  if (opts?.query) params.set("query", opts.query);
  if (opts?.includeHidden) params.set("include_hidden", "true");
  if (opts?.category) params.set("category", opts.category);
  const qs = params.toString();

  return apiFetch<SourceWithOrg[]>(`/v1/sources${qs ? `?${qs}` : ""}`);
}

// ── Stats ──

export async function getStatsSummary(days: number): Promise<StatsSummary> {
  return apiFetch<StatsSummary>(`/v1/stats?days=${days}`);
}

// ── Usage log ──

export async function getUsageStats(days: number): Promise<UsageStatsResponse> {
  return apiFetch<UsageStatsResponse>(`/v1/usage-log/stats?days=${days}`);
}

export async function postUsageLog(entry: {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  sourceSlug?: string | null;
  releaseCount?: number | null;
}): Promise<void> {
  await apiFetch("/v1/usage-log", {
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
  sessionId?: string | null;
}): Promise<void> {
  await apiFetch("/v1/fetch-log", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

// ── Fetch log read ──

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
  }>>(`/v1/fetch-log?${params}`);

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

type SourceReleaseResponse = {
  name: string;
  releases: Array<{
    id: string;
    version: string | null;
    title: string;
    summary?: string;
    media?: Array<{ type: string; url: string; alt?: string; r2Url?: string }>;
    publishedAt: string | null;
  }>;
};

function toMediaItems(raw: Array<{ type: string; url: string; alt?: string; r2Url?: string }> | undefined): MediaItem[] {
  return (raw ?? []).map((m) => ({ type: m.type as MediaItem["type"], url: m.url, alt: m.alt, r2Url: m.r2Url }));
}

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
    slugs.map(async (slug) => ({ slug, data: await apiFetch<SourceReleaseResponse>(`/v1/sources/${slug}?pageSize=${pageSize}`) })),
  );
  const all: LatestRelease[] = [];
  for (const { slug, data: srcData } of results) {
    if (!srcData) continue;
    for (const r of srcData.releases) {
      all.push({
        id: r.id,
        title: r.title,
        version: r.version,
        publishedAt: r.publishedAt,
        sourceName: srcData.name,
        sourceSlug: slug,
        contentSummary: r.summary ?? null,
        media: toMediaItems(r.media),
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
    const data = await apiFetch<SourceReleaseResponse>(`/v1/sources/${opts.slug}?pageSize=${opts.count}`);
    if (!data) return [];
    return data.releases.map((r) => ({
      id: r.id,
      title: r.title,
      version: r.version,
      publishedAt: r.publishedAt,
      sourceName: data.name,
      sourceSlug: opts.slug!,
      contentSummary: r.summary ?? null,
      media: toMediaItems(r.media),
    }));
  }

  if (opts.orgSlug) {
    const data = await apiFetch<{
      sources: Array<{ slug: string; name: string }>;
    }>(`/v1/orgs/${opts.orgSlug}`);
    if (!data) return [];
    const all = await collectReleasesFromSources(data.sources.map((s) => s.slug), opts.count);
    return all.sort(byPublishedAtDesc).slice(0, opts.count);
  }

  const sourcesData = await apiFetch<Array<{ slug: string; name: string }>>("/v1/sources");
  const all = await collectReleasesFromSources(sourcesData.slice(0, 10).map((s) => s.slug), opts.count);
  return all.sort(byPublishedAtDesc).slice(0, opts.count);
}

// ── Known releases for incremental parsing ──

export async function getKnownReleasesForSource(
  sourceSlug: string,
  limit: number,
): Promise<Array<{ version: string | null; title: string; publishedAt: string | null }>> {
  const data = await apiFetch<Array<{ version: string | null; title: string; publishedAt: string | null }>>(
    `/v1/sources/${sourceSlug}/known-releases?limit=${limit}`,
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
  return apiFetch<Source[]>(`/v1/sources/fetchable?${params}`);
}

export async function listFeedSources(): Promise<Source[]> {
  return apiFetch<Source[]>("/v1/sources/feeds");
}

export async function listSourcesWithChanges(): Promise<Source[]> {
  return apiFetch<Source[]>("/v1/sources/changes");
}

// ── Source CRUD ──

export async function updateSource(slug: string, data: Record<string, unknown>): Promise<Source> {
  return apiFetch<Source>(`/v1/sources/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteSource(slug: string): Promise<void> {
  await apiFetch(`/v1/sources/${slug}`, { method: "DELETE" });
}

export async function insertReleasesBatch(sourceSlug: string, releaseRows: Array<{
  version?: string | null; title: string; content: string;
  url?: string | null; contentHash?: string | null; publishedAt?: string | null;
  type?: ReleaseType;
}>): Promise<{ inserted: number; total: number }> {
  const chunks: typeof releaseRows[] = [];
  for (let i = 0; i < releaseRows.length; i += 5) {
    chunks.push(releaseRows.slice(i, i + 5));
  }
  const settled = await Promise.allSettled(
    chunks.map((chunk) =>
      apiFetch<{ inserted: number; total: number }>(`/v1/sources/${sourceSlug}/releases/batch`, {
        method: "POST",
        body: JSON.stringify({ releases: chunk }),
      })
    )
  );

  const succeeded = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failures = settled.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));

  if (succeeded.length === 0 && failures.length > 0) {
    throw failures[0];
  }

  if (failures.length > 0) {
    logger.warn(
      `insertReleasesBatch(${sourceSlug}): ${failures.length}/${chunks.length} chunk(s) failed — ${failures.map(String).join("; ")}`,
    );
  }

  const inserted = succeeded.reduce((sum, r) => sum + r.inserted, 0);
  const total = succeeded[succeeded.length - 1]?.total ?? 0;
  return { inserted, total };
}

export async function deleteReleasesForSource(sourceSlug: string): Promise<{ deleted: number }> {
  return apiFetch(`/v1/sources/${sourceSlug}/releases`, { method: "DELETE" });
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
  return apiFetch<Source>("/v1/sources", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ── Org CRUD ──

export async function createOrg(
  name: string,
  opts?: { slug?: string; domain?: string; description?: string; category?: string },
): Promise<Organization> {
  return apiFetch<Organization>("/v1/orgs", {
    method: "POST",
    body: JSON.stringify({ name, slug: opts?.slug, domain: opts?.domain, description: opts?.description, category: opts?.category }),
  });
}

export async function removeOrg(slug: string): Promise<void> {
  await apiFetch(`/v1/orgs/${slug}`, { method: "DELETE" });
}

export async function updateOrg(slug: string, data: Record<string, unknown>): Promise<Organization> {
  return apiFetch<Organization>(`/v1/orgs/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function getOrgAccountsBySlug(
  orgSlug: string,
): Promise<Array<{ platform: string; handle: string }>> {
  const data = await apiFetch<{
    accounts: Array<{ platform: string; handle: string }>;
  }>(`/v1/orgs/${orgSlug}`);
  return data?.accounts ?? [];
}

export async function linkOrgAccount(
  orgSlug: string,
  platform: string,
  handle: string,
): Promise<OrgAccount> {
  return apiFetch<OrgAccount>(`/v1/orgs/${orgSlug}/accounts`, {
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
  // The simplest approach: DELETE /v1/orgs/:slug/accounts/:platform/:handle
  await apiFetch(`/v1/orgs/${orgSlug}/accounts/${platform}/${encodeURIComponent(handle)}`, {
    method: "DELETE",
  });
}

// ── Product queries ──

export async function createProduct(
  orgId: string,
  name: string,
  opts?: { slug?: string; url?: string; description?: string; category?: string },
): Promise<Product> {
  return apiFetch<Product>(`/v1/products`, {
    method: "POST",
    body: JSON.stringify({ orgId, name, slug: opts?.slug, url: opts?.url, description: opts?.description, category: opts?.category }),
  });
}

export async function findProduct(identifier: string): Promise<Product | null> {
  return apiFetch<Product | null>(`/v1/products/${identifier}`);
}

export async function getProductsByOrg(orgId: string): Promise<Array<Product & { sourceCount: number }>> {
  return apiFetch<Array<Product & { sourceCount: number }>>(`/v1/products?orgId=${orgId}`);
}

export async function updateProduct(slug: string, data: Record<string, unknown>): Promise<Product> {
  return apiFetch<Product>(`/v1/products/${slug}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteProduct(productId: string): Promise<void> {
  await apiFetch(`/v1/products/${productId}`, { method: "DELETE" });
}

// ── Tags ──

export async function getOrCreateTag(name: string): Promise<Tag> {
  return apiFetch<Tag>("/v1/tags", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function getTagsForOrg(orgId: string): Promise<string[]> {
  return apiFetch<string[]>(`/v1/orgs/${orgId}/tags`);
}

export async function addTagsToOrg(orgId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function removeTagsFromOrg(orgId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/orgs/${orgId}/tags`, {
    method: "DELETE",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function getTagsForProduct(productId: string): Promise<string[]> {
  return apiFetch<string[]>(`/v1/products/${productId}/tags`);
}

export async function addTagsToProduct(productId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/products/${productId}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: tagNames }),
  });
}

export async function removeTagsFromProduct(productId: string, tagNames: string[]): Promise<void> {
  await apiFetch(`/v1/products/${productId}/tags`, {
    method: "DELETE",
    body: JSON.stringify({ tags: tagNames }),
  });
}

// ── Status events ──

export async function postStatusEvent(event: {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}): Promise<{ cancelRequested: boolean }> {
  try {
    const result = await apiFetch<{ cancelRequested?: boolean }>("/v1/status/event", {
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
  return apiFetch<Release[]>(`/v1/sources/${sourceSlug}/recent-releases?cutoff=${cutoffIso}`);
}

// ── Release summaries ──

export async function getSummariesForSource(sourceId: string): Promise<ReleaseSummary[]> {
  return apiFetch<ReleaseSummary[]>(`/v1/summaries?sourceId=${sourceId}`);
}

export async function upsertSummary(data: NewReleaseSummary): Promise<void> {
  await apiFetch("/v1/summaries", {
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
    `/v1/summaries?sourceId=${sourceId}&type=monthly&year=${year}&month=${month}`,
  );
  return rows[0];
}

// ── Overview / Playbook Pages ──

export async function getOverview(
  scope: "org" | "product",
  slug: string,
): Promise<KnowledgePage | null> {
  return apiFetch<KnowledgePage | null>(`/v1/overview?scope=${scope}&slug=${slug}`);
}

export async function getPlaybook(
  slug: string,
): Promise<KnowledgePage | null> {
  return apiFetch<KnowledgePage | null>(`/v1/playbook?slug=${slug}`);
}

/** @deprecated Use getOverview */
export async function getKnowledgePage(
  scope: "org" | "product" | "playbook",
  slug: string,
): Promise<KnowledgePage | null> {
  if (scope === "playbook") return getPlaybook(slug);
  return getOverview(scope, slug);
}

export async function upsertOverview(data: {
  scope: "org" | "product" | "playbook";
  orgId?: string | null;
  productId?: string | null;
  content: string;
  releaseCount: number;
  lastContributingReleaseAt?: string | null;
}): Promise<void> {
  await apiFetch("/v1/overview", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

/** @deprecated Use upsertOverview */
export const upsertKnowledgePage = upsertOverview;

export async function updatePlaybookNotes(orgSlug: string, notes: string): Promise<void> {
  await apiFetch(`/v1/playbook/notes?slug=${encodeURIComponent(orgSlug)}`, {
    method: "PATCH",
    body: JSON.stringify({ notes }),
  });
}

// ── Media Assets ──

import type { MediaAssetInput } from "../db/queries.js";

export async function insertMediaAssets(
  assets: MediaAssetInput[],
): Promise<{ inserted: number }> {
  return apiFetch("/v1/media/assets", {
    method: "POST",
    body: JSON.stringify({ assets }),
  });
}

export async function getMediaAssetStats(): Promise<{ count: number; totalBytes: number }> {
  return apiFetch("/v1/media/assets/stats");
}

export async function queryReleasesWithMedia(): Promise<{ id: string; sourceId: string; media: string }[]> {
  return apiFetch("/v1/releases?hasMedia=true&fields=id,sourceId,media");
}

// ── Sessions ──

export async function listSessions(): Promise<Session[]> {
  return apiFetch<Session[]>("/v1/sessions");
}

export async function getSession(sessionId: string): Promise<Session | null> {
  return apiFetch<Session | null>(`/v1/sessions/${sessionId}`);
}

export async function getActiveSources(): Promise<{ slugs: string[]; sessionMap: Record<string, string> }> {
  return apiFetch<{ slugs: string[]; sessionMap: Record<string, string> }>("/v1/sessions/active-sources");
}

export async function cancelSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch<{ ok: boolean; error?: string }>(`/v1/sessions/${sessionId}/cancel`, {
    method: "POST",
  });
}

// ── Semantic search backfill (admin-only) ──

export async function embedReleases(body: {
  since?: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<EmbedBackfillResponse> {
  return apiFetch<EmbedBackfillResponse>("/v1/admin/embed/releases", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function embedEntities(body: {
  kind?: "org" | "product" | "source";
  limit?: number;
  dryRun?: boolean;
}): Promise<EmbedBackfillResponse> {
  return apiFetch<EmbedBackfillResponse>("/v1/admin/embed/entities", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function embedChangelogs(body: {
  sourceSlug?: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<EmbedBackfillResponse> {
  return apiFetch<EmbedBackfillResponse>("/v1/admin/embed/changelogs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getEmbedStatus(): Promise<EmbedStatusResponse> {
  return apiFetch<EmbedStatusResponse>("/v1/admin/embed/status");
}

// ── Domain Aliases ──

export async function addDomainAlias(
  domain: string,
  target: { orgId?: string; productId?: string },
): Promise<DomainAlias> {
  return apiFetch<DomainAlias>("/v1/aliases", {
    method: "POST",
    body: JSON.stringify({ domain, orgId: target.orgId, productId: target.productId }),
  });
}

export async function removeDomainAlias(domain: string): Promise<boolean> {
  const result = await apiFetch<{ deleted: boolean } | null>(`/v1/aliases/${encodeURIComponent(domain)}`, { method: "DELETE" });
  return result !== null;
}

export async function listDomainAliases(
  target: { orgId?: string; productId?: string },
): Promise<DomainAlias[]> {
  if (!target.orgId && !target.productId) return [];
  const params = target.orgId ? `orgId=${target.orgId}` : `productId=${target.productId}`;
  return apiFetch<DomainAlias[]>(`/v1/aliases?${params}`);
}
