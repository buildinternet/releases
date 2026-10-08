import { daysAgoIso } from "@buildinternet/releases-core/dates";
import type { Kind } from "@buildinternet/releases-core/kinds";
import type { Source, KnowledgePage } from "@buildinternet/releases-core/schema";
import type {
  SourceWithOrg,
  Stats,
  UnifiedSearchResponse,
  SourceChangelogResponse,
  StatsSummary,
  FetchLogEntry,
  ActiveFetchSession,
  UsageStatsResponse,
  Session,
  EmbedBackfillResponse,
  EmbedStatusResponse,
  EvaluationResult,
  MediaItem,
  AppStoreMaterializeResponse,
  VideoMaterializeResponse,
} from "./types.js";
import type {
  DomainLookupResponse,
  OverviewCitation,
  OverviewInputsCheck,
  OverviewManifestResponse,
} from "@buildinternet/releases-api-types";
import { apiFetch, SCOPE_RESOURCE } from "./core.js";
import { assertCleanIdentifier, assertSafeReadPath } from "../lib/validate-input.js";
import { type ListResponse } from "@buildinternet/releases-core/cli-contracts";
import { findBlockedUrl, findIgnoredUrl } from "./orgs.js";
import type { Organization } from "@buildinternet/releases-core/schema";

// ── Source queries ──

export interface AmbiguousSourceCandidate {
  id: string;
  slug: string;
  orgSlug: string | null;
}

/**
 * Raised when a bare source slug matches sources in more than one org. Source
 * slugs are unique per-org but not globally (#690), so a bare `blog` can sit
 * under several orgs. Rather than silently resolving to one (the old
 * oldest-match behavior, which could read from — or mutate — the wrong org),
 * resolution throws this and the CLI prints the `org/slug` + `src_…`
 * disambiguators carried in `candidates` (#264).
 */
export class AmbiguousSourceError extends Error {
  readonly slug: string;
  readonly candidates: AmbiguousSourceCandidate[];
  constructor(slug: string, candidates: AmbiguousSourceCandidate[]) {
    super(
      `Source slug "${slug}" is ambiguous — it matches ${candidates.length} sources across orgs.`,
    );
    this.name = "AmbiguousSourceError";
    this.slug = slug;
    this.candidates = candidates;
  }
}

/**
 * Lists every source whose slug **exactly** matches `slug`, across all orgs,
 * including hidden sources (matching the visibility the legacy
 * `source-by-slug` resolver had against `sources_active`). Distinct from the
 * `?q=` substring search. Backs the cross-org ambiguity check in
 * `resolveSourceTarget` (#264).
 *
 * The exact-slug match is re-applied client-side so the result stays correct
 * even against an older API build that doesn't yet honor `?slug=` (it would
 * otherwise return an unfiltered page and make every bare slug look ambiguous).
 */
export async function listSourcesBySlug(slug: string): Promise<SourceWithOrg[]> {
  const rows =
    (await apiFetch<SourceWithOrg[] | null>(
      `/v1/sources?slug=${encodeURIComponent(slug)}&include_hidden=true`,
    )) ?? [];
  return rows.filter((r) => r.slug === slug);
}

/**
 * Resolves an operator-supplied source identifier to a path the API can match
 * without ambiguity. Accepts:
 *
 *   - `src_…` typed IDs: pass straight through; globally unique.
 *   - `org/slug` coordinates: split locally; the API takes the org-scoped
 *     pair directly.
 *   - bare slugs: enumerate every org's source with this exact slug via
 *     `listSourcesBySlug`. Resolve only when exactly one matches; throw
 *     `AmbiguousSourceError` when more than one org claims the slug so the
 *     caller can surface `org/slug` + `src_…` disambiguators instead of
 *     silently picking the oldest (#264).
 *
 * Returns `null` when no matching source exists. Throws `AmbiguousSourceError`
 * on a cross-org bare-slug collision, or `Error` on API failures.
 */
async function resolveSourceTarget(
  identifier: string,
): Promise<{ pathSegment: string; sourceId: string } | null> {
  assertCleanIdentifier(identifier, "source");
  if (identifier.startsWith("src_")) {
    return { pathSegment: `/v1/sources/${encodeURIComponent(identifier)}`, sourceId: identifier };
  }
  const slash = identifier.indexOf("/");
  if (slash > 0 && slash < identifier.length - 1) {
    const orgSlug = identifier.slice(0, slash);
    const sourceSlug = identifier.slice(slash + 1);
    return {
      pathSegment: `/v1/orgs/${encodeURIComponent(orgSlug)}/sources/${encodeURIComponent(sourceSlug)}`,
      sourceId: "", // unknown until we hydrate via findSource — callers that need the ID re-read source.id from the result
    };
  }
  // Bare slug — slugs are unique per-org but not globally, so enumerate every
  // org's source with this exact slug.
  const matches = await listSourcesBySlug(identifier);
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new AmbiguousSourceError(
      identifier,
      matches.map((m) => ({ id: m.id, slug: m.slug, orgSlug: m.orgSlug })),
    );
  }
  // Exactly one match — hydrate through the globally-unambiguous typed id.
  const only = matches[0]!;
  return { pathSegment: `/v1/sources/${encodeURIComponent(only.id)}`, sourceId: only.id };
}

export async function findSource(identifier: string): Promise<Source | null> {
  // API returns enriched data — extra fields are harmlessly ignored by callers expecting Source
  const target = await resolveSourceTarget(identifier);
  if (!target) return null;
  return apiFetch<Source | null>(target.pathSegment);
}

export async function sourceChangelog(
  identifier: string,
  range?: { path?: string; offset?: number; limit?: number; tokens?: number },
): Promise<SourceChangelogResponse | null> {
  if (range?.path !== undefined) assertSafeReadPath(range.path);
  const target = await resolveSourceTarget(identifier);
  if (!target) return null;
  const params = new URLSearchParams();
  if (range?.path !== undefined) params.set("path", range.path);
  if (range?.offset !== undefined) params.set("offset", String(range.offset));
  if (range?.limit !== undefined) params.set("limit", String(range.limit));
  if (range?.tokens !== undefined) params.set("tokens", String(range.tokens));
  const qs = params.toString();
  return apiFetch<SourceChangelogResponse | null>(
    `${target.pathSegment}/changelog${qs ? `?${qs}` : ""}`,
  );
}

/** Result of `POST /v1/sources/:id/fetch` — union of the inline-fetch, queued,
 * and render-dry-run branches. All fields optional; the caller inspects which
 * branch fired (`renderCheck` / `fetched` / `queued`). */
export interface SourceFetchResult {
  fetched?: boolean;
  queued?: boolean;
  type?: string;
  status?: string;
  releasesFound?: number;
  releasesInserted?: number;
  // Render dry-run probe (#1528):
  renderCheck?: boolean;
  rendered?: boolean;
  candidateCount?: number;
  sampleUrls?: string[];
  durationMs?: number;
  error?: string;
}

/**
 * Trigger a single-source fetch via `POST /v1/sources/:id/fetch`. With
 * `dryRun`, the server runs the parser (or, for a client-rendered scrape
 * source, renders the index once) without writing to D1 and without the
 * managed-agent extraction loop. `idOrSlug` should be a resolved `src_…` id.
 */
export async function triggerSourceFetch(
  idOrSlug: string,
  opts: { dryRun?: boolean } = {},
): Promise<SourceFetchResult> {
  const qs = opts.dryRun ? "?dryRun=true" : "";
  return apiFetch<SourceFetchResult>(`/v1/sources/${encodeURIComponent(idOrSlug)}/fetch${qs}`, {
    method: "POST",
  });
}

export async function findSourcesByUrls(urls: string[]): Promise<Source[]> {
  if (urls.length === 0) return [];
  const params = urls.map((u) => `url=${encodeURIComponent(u)}`).join("&");
  return apiFetch<Source[]>(`/v1/sources?filterByUrls=true&${params}`);
}

// ── Content hash ──

export async function checkContentHash(source: Source, contentHash: string): Promise<boolean> {
  // Use the stable typed ID — slug-form bare paths return 400 after #698.
  const result = await apiFetch<{ unchanged: boolean } | null>(
    `/v1/sources/${encodeURIComponent(source.id)}/content-hash`,
    {
      method: "POST",
      body: JSON.stringify({ contentHash }),
    },
  );
  return result?.unchanged ?? false;
}

// ── Search ──

export async function unifiedSearch(
  query: string,
  limit: number,
  opts?: {
    org?: string;
    domain?: string;
    /** Product identifier (org/slug coordinate, prod_… id, or product slug);
     *  scopes hits to that product's sources. Resolved server-side (#1218). */
    product?: string;
    /** Org category slug (validated against `releases categories`); scopes
     *  orgs/catalog/release hits to that category. Unknown → 400 (#371). */
    category?: string;
    /** Curated collection slug; scopes hits to the collection's member orgs.
     *  Unknown → empty envelope with `collectionStatus: "not_found"` (#371). */
    collection?: string;
    mode?: "lexical" | "semantic" | "hybrid";
    kind?: Kind;
    /** ISO date or relative shorthand (90d/4w/6m/2y); resolved server-side. */
    since?: string;
    until?: string;
  },
): Promise<UnifiedSearchResponse> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (opts?.org) params.set("org", opts.org);
  if (opts?.domain) params.set("domain", opts.domain);
  if (opts?.product) params.set("product", opts.product);
  if (opts?.category) params.set("category", opts.category);
  if (opts?.collection) params.set("collection", opts.collection);
  if (opts?.mode) params.set("mode", opts.mode);
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.since) params.set("since", opts.since);
  if (opts?.until) params.set("until", opts.until);
  return apiFetch<UnifiedSearchResponse>(`/v1/search?${params}`);
}

// ── Domain lookup ──

export async function lookupDomain(domain: string): Promise<DomainLookupResponse | null> {
  return apiFetch<DomainLookupResponse | null>(
    `/v1/lookups/by-domain?domain=${encodeURIComponent(domain)}`,
  );
}

// ── List sources with org ──

type ListSourcesOpts = {
  orgSlug?: string;
  productSlug?: string;
  hasFeed?: boolean;
  query?: string;
  includeHidden?: boolean;
  category?: string;
  kind?: Kind;
  limit?: number;
  page?: number;
};

export async function listSourcesWithOrg(opts?: ListSourcesOpts): Promise<SourceWithOrg[]>;
export async function listSourcesWithOrg(
  opts: ListSourcesOpts & { envelope: true },
): Promise<ListResponse<SourceWithOrg>>;
export async function listSourcesWithOrg(
  opts?: ListSourcesOpts & { envelope?: boolean },
): Promise<SourceWithOrg[] | ListResponse<SourceWithOrg>> {
  const params = new URLSearchParams();
  if (opts?.orgSlug) params.set("orgSlug", opts.orgSlug);
  if (opts?.productSlug) params.set("productSlug", opts.productSlug);
  if (opts?.hasFeed) params.set("has_feed", "true");
  if (opts?.query) params.set("query", opts.query);
  if (opts?.includeHidden) params.set("include_hidden", "true");
  if (opts?.category) params.set("category", opts.category);
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.page != null) params.set("page", String(opts.page));
  if (opts?.envelope) params.set("envelope", "true");
  const qs = params.toString();

  return apiFetch<SourceWithOrg[] | ListResponse<SourceWithOrg>>(
    `/v1/sources${qs ? `?${qs}` : ""}`,
  );
}

// ── Stats ──

export async function getStatsSummary(days: number): Promise<StatsSummary> {
  const cutoff = daysAgoIso(days);

  // Compose from existing endpoints
  const [statsData, fetchLogData, sourcesData] = await Promise.all([
    // The endpoint serves the legacy flat counts merged with the richer
    // StatsSummary shape. `Partial` because an older API (or a fork) may still
    // send only the flat fields — the fallbacks below cover that.
    apiFetch<Stats & Partial<StatsSummary>>("/v1/stats"),
    apiFetch<
      Array<{
        id: string;
        sourceId: string;
        releasesFound: number;
        releasesInserted: number;
        durationMs: number | null;
        status: string;
        error: string | null;
        createdAt: string;
      }>
    >("/v1/admin/logs/fetch?limit=20"),
    apiFetch<
      Array<{
        slug: string;
        name: string;
        type: string;
        url: string;
        orgSlug: string | null;
        releaseCount: number;
      }>
    >("/v1/sources"),
  ]);

  // `/v1/stats` now returns the full StatsSummary shape (period / totals /
  // sourceHealth / sourceActivity) alongside the legacy flat counts. This used
  // to read only the flat fields and hardcode the rest to 0/null, which made
  // `releases stats` report every source as never-fetched with 0 releases in
  // period — the exact opposite of the truth (341 up to date, 3911 releases at
  // time of writing). An operator reading that would conclude ingestion was
  // dead. Prefer the server's values and keep the zeros only as a fallback for
  // an older API that genuinely doesn't send them.
  return {
    period: statsData.period ?? { days, cutoff },
    totals: {
      organizations: statsData.orgs,
      sources: statsData.sources,
      releases: statsData.releases,
      releasesInPeriod: statsData.totals?.releasesInPeriod ?? 0,
    },
    sourceHealth: statsData.sourceHealth ?? {
      upToDate: 0,
      stale: 0,
      neverFetched: 0,
    },
    sourceActivity:
      statsData.sourceActivity ??
      sourcesData.map((s) => ({
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

export async function getUsageStats(days: number): Promise<UsageStatsResponse> {
  return apiFetch<UsageStatsResponse>(`/v1/admin/logs/usage/stats?days=${days}`);
}

export async function postUsageLog(entry: {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  sourceSlug?: string | null;
  releaseCount?: number | null;
}): Promise<void> {
  await apiFetch("/v1/admin/logs/usage", {
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
  await apiFetch("/v1/admin/logs/fetch", {
    method: "POST",
    body: JSON.stringify(entry),
  });
}

// ── Fetch log read ──

interface RawFetchLogRow {
  id: string;
  sourceId: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs: number | null;
  status: string;
  error: string | null;
  rawContent: string | null;
  createdAt: string;
}

// The API fetch-log endpoint returns raw fetch_log rows without source name/slug.
// In remote mode we don't have the join data, so we provide what we can.
function toFetchLogEntry(l: RawFetchLogRow): FetchLogEntry {
  return {
    id: l.id,
    sourceName: "",
    sourceSlug: "",
    status: l.status,
    releasesFound: l.releasesFound,
    releasesInserted: l.releasesInserted,
    durationMs: l.durationMs,
    error: l.error,
    createdAt: l.createdAt,
  };
}

export async function getFetchLogs(opts: {
  /** Source identifier (src_… or slug). */
  source?: string;
  limit: number;
}): Promise<{ logs: FetchLogEntry[]; activeSession: ActiveFetchSession | null }> {
  // Always request the envelope: for a source-filtered query it carries the live
  // in-flight fetch (`activeSession`); for the global list it degrades to just
  // `items` (no single active session). One response shape instead of branching.
  const params = new URLSearchParams({ limit: String(opts.limit), envelope: "true" });
  if (opts.source) params.set("source", opts.source);
  const env = await apiFetch<{
    items: RawFetchLogRow[];
    activeSession?: ActiveFetchSession | null;
  } | null>(`/v1/admin/logs/fetch?${params}`);
  // apiFetch yields null on a 404 (e.g. the admin logs route is undeployed);
  // treat that as "no logs" rather than dereferencing null.
  if (!env) return { logs: [], activeSession: null };
  return {
    logs: (env.items ?? []).map(toFetchLogEntry),
    activeSession: env.activeSession ?? null,
  };
}

// ── Stuck sources ──

export interface StuckSource {
  sourceId: string;
  sourceSlug: string;
  name: string;
  type: "github" | "scrape" | "feed" | "agent";
  url: string;
  kind: string | null;
  orgSlug: string | null;
  orgName: string | null;
  fetchPriority: "normal" | "low" | "paused";
  isPrimary: boolean;
  isHidden: boolean;
  recentAttempts: number;
  recentErrors: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastErrorCategory: string | null;
  /** null = the source has NEVER fetched successfully */
  lastSuccessAt: string | null;
  lastFetchedAt: string | null;
  sourceCreatedAt: string | null;
}

export interface StuckSourcesResponse {
  items: StuckSource[];
  pagination: {
    page: number;
    pageSize: number;
    returned: number;
    totalItems?: number;
    totalPages?: number;
    hasMore: boolean;
  };
  meta: {
    window: number;
    minAttempts: number;
    includePaused: boolean;
  };
}

export async function getStuckSources(opts?: {
  window?: number;
  minAttempts?: number;
  includePaused?: boolean;
  limit?: number;
  page?: number;
}): Promise<StuckSourcesResponse> {
  const params = new URLSearchParams();
  if (opts?.window != null) params.set("window", String(opts.window));
  if (opts?.minAttempts != null) params.set("minAttempts", String(opts.minAttempts));
  if (opts?.includePaused) params.set("includePaused", "true");
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.page != null) params.set("page", String(opts.page));
  const qs = params.toString();
  return apiFetch<StuckSourcesResponse>(`/v1/admin/sources/stuck${qs ? `?${qs}` : ""}`);
}

// ── Known releases for incremental parsing ──

export async function getKnownReleasesForSource(
  sourceIdentifier: string,
  limit: number,
): Promise<Array<{ version: string | null; title: string; publishedAt: string | null }>> {
  const target = await resolveSourceTarget(sourceIdentifier);
  if (!target) return [];
  const data = await apiFetch<
    Array<{ version: string | null; title: string; publishedAt: string | null }>
  >(`${target.pathSegment}/known-releases?limit=${limit}`);
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

export async function updateSource(
  source: Pick<Source, "id">,
  data: Record<string, unknown>,
): Promise<Source> {
  return apiFetch<Source>(`/v1/sources/${encodeURIComponent(source.id)}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteSource(
  source: Pick<Source, "id">,
  opts?: { hard?: boolean },
): Promise<void> {
  // Soft delete (default) tombstones the row (sets deletedAt + mangles the
  // slug); `?hard=true` removes it outright so the URL can be re-onboarded
  // fresh. See #1184.
  const query = opts?.hard ? "?hard=true" : "";
  await apiFetch(`/v1/sources/${encodeURIComponent(source.id)}${query}`, { method: "DELETE" });
}

export async function createSource(data: {
  name: string;
  slug: string;
  type: string;
  url: string;
  orgId?: string | null;
  productId?: string | null;
  metadata?: string;
  isPrimary?: boolean;
}): Promise<Source> {
  // Strip null/undefined values so the API's z.string().optional() schema
  // doesn't reject an explicit `"productId": null` in the JSON body.
  const body = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== null && v !== undefined),
  );
  return apiFetch<Source>("/v1/sources", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Materialize an App Store source via `POST /v1/sources/appstore`. Pass exactly
 * one of `url` (`apps.apple.com/.../id<trackId>`) or `trackId` (bare numeric).
 * The endpoint resolves the listing via the iTunes Lookup API, mints the first
 * release, and backfills the product avatar, returning the source row;
 * `status: "indexed"` is a new source, `"existing"` an idempotent hit on a
 * prior materialize of the same trackId. Writes should stay serial: concurrent
 * POSTs for a brand-new org/product race on `UNIQUE(org_id, slug)`.
 */
export async function createAppStoreSource(params: {
  url?: string;
  trackId?: string;
  platform?: "ios" | "macos";
  storefront?: string;
  orgSlug?: string;
  productSlug?: string;
}): Promise<AppStoreMaterializeResponse> {
  // Strip undefined/null so optional fields don't reach the API as explicit nulls.
  const body = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined),
  );
  return apiFetch<AppStoreMaterializeResponse>("/v1/sources/appstore", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Materialize a video source via `POST /v1/sources/video`. Resolves a YouTube
 * channel/playlist URL into its Atom feed, mints a `video` source under the
 * given org, and backfills current videos as releases (description-only,
 * summarizer-cleaned, marketing-filtered). `orgSlug` or `orgId` is required —
 * unlike the App Store path, no org is derived from the feed, so the org must
 * already exist. Idempotent on the resolved feed URL: `status: "indexed"` is a
 * new source (HTTP 201), `"existing"` an idempotent hit (HTTP 200). Writes
 * should stay serial — concurrent POSTs for a brand-new org race on
 * `UNIQUE(org_id, slug)`.
 */
export async function createVideoSource(params: {
  url: string;
  orgSlug?: string;
  orgId?: string;
  productId?: string;
}): Promise<VideoMaterializeResponse> {
  // Strip undefined/null so optional fields don't reach the API as explicit nulls.
  const body = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined),
  );
  return apiFetch<VideoMaterializeResponse>("/v1/sources/video", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Overview / Playbook Pages ──

/**
 * Knowledge page plus the inline citations the read endpoint returns. The org
 * GET (`/v1/orgs/:slug/overview`) attaches `citations` ordered by character
 * position; the product GET does not, so the field is optional.
 */
export type OverviewWithCitations = KnowledgePage & { citations?: OverviewCitation[] };

export async function getOverview(
  scope: keyof typeof SCOPE_RESOURCE,
  identifier: string,
): Promise<OverviewWithCitations | null> {
  return apiFetch<OverviewWithCitations | null>(
    `/v1/${SCOPE_RESOURCE[scope]}/${encodeURIComponent(identifier)}/overview`,
  );
}

export async function getPlaybook(identifier: string): Promise<KnowledgePage | null> {
  return apiFetch<KnowledgePage | null>(`/v1/orgs/${encodeURIComponent(identifier)}/playbook`);
}

export async function upsertOverview(
  orgSlug: string,
  data: {
    content: string;
    releaseCount: number;
    lastContributingReleaseAt?: string | null;
    citations?: OverviewCitation[];
  },
): Promise<void> {
  await apiFetch(`/v1/orgs/${encodeURIComponent(orgSlug)}/overview`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updatePlaybookNotes(orgSlug: string, notes: string): Promise<void> {
  await apiFetch(`/v1/orgs/${encodeURIComponent(orgSlug)}/playbook/notes`, {
    method: "PATCH",
    body: JSON.stringify({ notes }),
  });
}

/**
 * Release shape in overview inputs. `content` is pre-hydrated (absolute CDN
 * URLs), and `media` entries carry resolved `r2Url`s — ready to paste into
 * generated markdown. This is a narrower projection than the raw `Release`
 * row: only the fields the overview agent needs.
 */
export interface OverviewInputRelease {
  id: string;
  version: string | null;
  title: string;
  content: string;
  publishedAt: string | null;
  url: string | null;
  media: MediaItem[];
}

export interface OverviewInputs {
  org: Pick<Organization, "id" | "slug" | "name" | "description">;
  sources: Pick<Source, "id" | "slug" | "name" | "type">[];
  existingContent: string | null;
  selected: OverviewInputRelease[];
  totalAvailable: number;
  windowDays: number;
}

export async function getOverviewInputs(
  slug: string,
  opts: { window?: number; limit?: number } = {},
): Promise<OverviewInputs | null> {
  const params = new URLSearchParams();
  if (opts.window !== undefined) params.set("window", String(opts.window));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return apiFetch<OverviewInputs | null>(
    `/v1/orgs/${encodeURIComponent(slug)}/overview/inputs${qs ? `?${qs}` : ""}`,
  );
}

export async function getOverviewInputsCheck(
  slug: string,
  opts: { window?: number; limit?: number } = {},
): Promise<OverviewInputsCheck | null> {
  const params = new URLSearchParams();
  params.set("check", "true");
  if (opts.window !== undefined) params.set("window", String(opts.window));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  return apiFetch<OverviewInputsCheck | null>(
    `/v1/orgs/${encodeURIComponent(slug)}/overview/inputs?${params.toString()}`,
  );
}

// ── Overview manifest (cross-org admin planning) ──

export interface OverviewManifestQueryOpts {
  staleDays?: number;
  missing?: boolean;
  hasActivity?: boolean;
  plan?: boolean;
  page?: number;
  limit?: number;
}

export async function getOverviewManifest(
  opts: OverviewManifestQueryOpts = {},
): Promise<OverviewManifestResponse> {
  const params = new URLSearchParams();
  if (opts.staleDays !== undefined) params.set("staleDays", String(opts.staleDays));
  if (opts.missing) params.set("missing", "true");
  if (opts.hasActivity) params.set("hasActivity", "true");
  if (opts.plan) params.set("format", "plan");
  if (opts.page !== undefined) params.set("page", String(opts.page));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  return apiFetch<OverviewManifestResponse>(`/v1/admin/overviews${qs ? `?${qs}` : ""}`);
}

// ── Media Assets ──

export interface MediaAssetInput {
  r2Key: string;
  sourceUrl: string;
  sourceFilename: string | null;
  contentType: string;
  contentHash: string;
  byteSize: number;
  sourceId: string;
  releaseId?: string;
}

export async function insertMediaAssets(assets: MediaAssetInput[]): Promise<{ inserted: number }> {
  return apiFetch("/v1/media/assets", {
    method: "POST",
    body: JSON.stringify({ assets }),
  });
}

export async function getMediaAssetStats(): Promise<{ count: number; totalBytes: number }> {
  return apiFetch("/v1/media/assets/stats");
}

// ── Sessions ──

export async function listSessions(opts?: {
  limit?: number;
  page?: number;
  type?: string;
  status?: string;
  recentMinutes?: number;
}): Promise<ListResponse<Session>> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.page != null) params.set("page", String(opts.page));
  if (opts?.type) params.set("type", opts.type);
  if (opts?.status) params.set("status", opts.status);
  if (opts?.recentMinutes != null) params.set("recent_minutes", String(opts.recentMinutes));
  const qs = params.toString();
  return apiFetch<ListResponse<Session>>(`/v1/sessions${qs ? `?${qs}` : ""}`);
}

export async function getSession(sessionId: string): Promise<Session | null> {
  return apiFetch<Session | null>(`/v1/sessions/${sessionId}`);
}

export async function getActiveSources(): Promise<{
  slugs: string[];
  sessionMap: Record<string, string>;
}> {
  return apiFetch<{ slugs: string[]; sessionMap: Record<string, string> }>(
    "/v1/sessions/active-sources",
  );
}

export async function cancelSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  return apiFetch<{ ok: boolean; error?: string }>(`/v1/sessions/${sessionId}/cancel`, {
    method: "POST",
  });
}

// ── URL evaluation (admin-only) ──

export async function evaluateUrl(url: string): Promise<EvaluationResult> {
  return apiFetch<EvaluationResult>(`/v1/evaluate?url=${encodeURIComponent(url)}`);
}

// ── Semantic search backfill (admin-only) ──

export async function embedReleases(body: {
  since?: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<EmbedBackfillResponse> {
  return apiFetch<EmbedBackfillResponse>("/v1/workflows/embed-releases", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function embedEntities(body: {
  kind?: "org" | "product" | "source";
  limit?: number;
  dryRun?: boolean;
}): Promise<EmbedBackfillResponse> {
  return apiFetch<EmbedBackfillResponse>("/v1/workflows/embed-entities", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function embedChangelogs(body: {
  sourceSlug?: string;
  limit?: number;
  dryRun?: boolean;
}): Promise<EmbedBackfillResponse> {
  return apiFetch<EmbedBackfillResponse>("/v1/workflows/embed-changelogs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getEmbedStatus(): Promise<EmbedStatusResponse> {
  return apiFetch<EmbedStatusResponse>("/v1/admin/embed/status");
}

// ── Source full-history backfill (admin-only) ──

/**
 * Report shape returned by POST /v1/workflows/backfill-source. Mirrors
 * `SourceBackfillReport` on the API worker (monorepo
 * workers/api/src/lib/source-backfill.ts) — kept as a local interface because
 * it is worker-internal and not part of the published `releases-api-types`.
 */
export interface SourceBackfillReport {
  source: { id: string; slug: string };
  /** How the full-page body was acquired. `snapshot` = re-extracted from a
   *  stored raw snapshot (reextract-source, #1284) with no live scrape. */
  via: "supplied" | "firecrawl" | "fetch" | "snapshot";
  windows: number;
  cappedAtWindow: boolean;
  droppedChars: number;
  /** Pre-dedup count of extracted entries. */
  extracted: number;
  /** Unique-by-url count submitted to ingest. */
  deduped: number;
  dateRange: { from: string | null; to: string | null };
  /** Rows handed to ingest. Real on both paths — a dry run knows it without
   *  ingesting, since it equals `deduped`. */
  found: number;
  /** Rows actually inserted; `null` on a dry run, where nothing was written and
   *  no count was computed. Never `0` there — see `notStored`. */
  inserted: number | null;
  /** Dry-run only: extracted URLs the source does not already have — an upper
   *  bound on what a commit run would insert. `null`/absent on the commit path
   *  (`inserted` is the measured answer) and on servers predating the field. */
  notStored?: number | null;
  dryRun: boolean;
  /** Set only when the Firecrawl window ceiling reduced a deeper request and the
   *  run stopped with untouched tail — tells the caller how to go deeper. */
  guidance?: string;
  /** Present on reextract-source: which stored snapshot the body came from. */
  snapshot?: {
    id: string;
    contentHash: string;
    capturedAt: string;
    bytes: number;
    format: string;
  };
}

/**
 * Async-dispatch shape returned (HTTP 202) by POST /v1/workflows/backfill-source
 * when a deep Firecrawl backfill is routed to the durable BackfillSourceWorkflow
 * (#1281/#1282). The caller polls {@link getBackfillStatus} until terminal.
 */
export interface BackfillAsyncResponse {
  instanceId: string;
  async: true;
  statusUrl: string;
}

/** Discriminate the 202 async-dispatch shape from a synchronous report. */
export function isBackfillAsync(
  res: SourceBackfillReport | BackfillAsyncResponse,
): res is BackfillAsyncResponse {
  return (res as BackfillAsyncResponse).async === true;
}

/**
 * Cloudflare Workflows status (`WorkflowInstance.status()`), passed through by
 * GET /v1/workflows/backfill-source/status/:instanceId. Terminal states are
 * `complete | errored | terminated`; on `complete`, `output` is the report.
 * `status` is typed as string to stay forward-compatible with new CF values.
 */
export interface BackfillStatusResponse {
  instanceId: string;
  status: string;
  output?: SourceBackfillReport;
  error?: unknown;
  [k: string]: unknown;
}

/**
 * Full-history backfill for a windowed scrape source. The endpoint rejects bare
 * slugs (ambiguous across orgs, #690), so callers must pass the typed `src_…`
 * ID — resolve via {@link findSource} first.
 *
 * Returns the report synchronously for supplied-markdown / plain-fetch sources;
 * deep Firecrawl backfills return {@link BackfillAsyncResponse} (202) — poll
 * {@link getBackfillStatus}. Use {@link isBackfillAsync} to discriminate.
 */
export async function backfillSource(body: {
  sourceId: string;
  markdown?: string;
  maxWindows?: number;
  dryRun: boolean;
}): Promise<SourceBackfillReport | BackfillAsyncResponse> {
  return apiFetch<SourceBackfillReport | BackfillAsyncResponse>("/v1/workflows/backfill-source", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Poll a durable backfill workflow's status. Returns `null` on a 404
 * (`instance_not_found`). For an instance we just dispatched, that's the brief
 * create→status race, so callers keep polling rather than hard-failing; a
 * persistent null means a wrong or expired instance ID.
 */
export async function getBackfillStatus(
  instanceId: string,
): Promise<BackfillStatusResponse | null> {
  return apiFetch<BackfillStatusResponse | null>(
    `/v1/workflows/backfill-source/status/${encodeURIComponent(instanceId)}`,
  );
}

/**
 * Re-extract releases from a stored raw snapshot (`released-raw`, #1284) — no
 * live scrape, no Firecrawl credits, deterministic input. Always synchronous.
 * Returns the standard {@link SourceBackfillReport} with `via: "snapshot"` and a
 * `snapshot` block identifying which capture was used. Like {@link backfillSource}
 * the endpoint rejects bare slugs — pass the typed `src_…` ID.
 */
export async function reextractSource(body: {
  sourceId: string;
  snapshotId?: string;
  maxWindows?: number;
  dryRun: boolean;
}): Promise<SourceBackfillReport> {
  return apiFetch<SourceBackfillReport>("/v1/workflows/reextract-source", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ── Domain Aliases ──

export async function getAliases(
  scope: keyof typeof SCOPE_RESOURCE,
  identifier: string,
): Promise<string[]> {
  const row = await apiFetch<{ aliases?: string[] } | null>(
    `/v1/${SCOPE_RESOURCE[scope]}/${encodeURIComponent(identifier)}`,
  );
  return row?.aliases ?? [];
}

export async function setAliases(
  scope: keyof typeof SCOPE_RESOURCE,
  identifier: string,
  aliases: string[],
): Promise<void> {
  await apiFetch(`/v1/${SCOPE_RESOURCE[scope]}/${encodeURIComponent(identifier)}`, {
    method: "PATCH",
    body: JSON.stringify({ aliases }),
  });
}

// ── Source metadata (merge-and-update helper) ──

/**
 * Merge a partial metadata object into the source's metadata JSON column
 * via a PATCH on the remote API.
 */
export async function updateSourceMeta(
  source: Source,
  meta: Record<string, unknown>,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  if (source.metadata) {
    try {
      const parsed = JSON.parse(source.metadata);
      if (parsed && typeof parsed === "object") existing = parsed as Record<string, unknown>;
    } catch {
      /* malformed metadata — overwrite */
    }
  }
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const serialized = JSON.stringify(merged);
  await apiFetch(`/v1/sources/${encodeURIComponent(source.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ metadata: serialized }),
  });
  source.metadata = serialized;
}

// ── Bulk source helpers ──

export async function findSourcesBySlugs(slugs: string[]): Promise<Source[]> {
  if (slugs.length === 0) return [];
  const results = await Promise.all(slugs.map((s) => findSource(s)));
  return results.filter((r): r is Source => r !== null);
}

export async function deleteSources(
  sources: Array<Pick<Source, "id">>,
  opts?: { hard?: boolean },
): Promise<void> {
  await Promise.all(sources.map((s) => deleteSource(s, opts)));
}

// ── Exclusion check (compose blocked + ignored) ──

export async function isUrlExcluded(
  url: string,
  orgId?: string,
): Promise<{ excluded: boolean; reason?: string; scope?: "blocked" | "ignored" }> {
  if (orgId) {
    const [blocked, ignored] = await Promise.all([findBlockedUrl(url), findIgnoredUrl(url, orgId)]);
    if (blocked) return { excluded: true, reason: blocked.reason ?? undefined, scope: "blocked" };
    if (ignored) return { excluded: true, reason: ignored.reason ?? undefined, scope: "ignored" };
    return { excluded: false };
  }
  const blocked = await findBlockedUrl(url);
  if (blocked) return { excluded: true, reason: blocked.reason ?? undefined, scope: "blocked" };
  return { excluded: false };
}
