import { z } from "zod";
import {
  SOURCE_TYPES,
  SOURCE_DISCOVERY,
  SOURCE_FETCH_PRIORITIES,
} from "@buildinternet/releases-core/source-enums";
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";
import { ListResponseSchema, ReleaseItemSchema, ReleaseSummaryItemSchema } from "./shared.js";

export const SourceTypeSchema = z.enum(SOURCE_TYPES);
export const SourceDiscoverySchema = z.enum(SOURCE_DISCOVERY);
export const SourceFetchPrioritySchema = z.enum(SOURCE_FETCH_PRIORITIES);

/**
 * Per-source row used in list/embedded contexts (e.g. nested inside OrgDetail).
 * Most fields are optional — embedded shapes (org detail) only carry the
 * subset needed for that view.
 */
export const SourceListItemSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  type: SourceTypeSchema,
  url: z.string().optional(),
  // `orgSlug` is populated on the standalone `/v1/sources` list path; the
  // `OrgDetail.sources` embedded path omits it (the parent already names the org).
  orgSlug: z.string().nullable().optional(),
  releaseCount: z.number().int().min(0),
  latestVersion: z.string().nullable(),
  latestDate: z.string().nullable(),
  latestAddedAt: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  /**
   * How the row was created. Optional on the wire so older API responses
   * (mid-deploy or pinned old workers) degrade gracefully — consumers that
   * see `undefined` should treat it as `"curated"`.
   */
  discovery: SourceDiscoverySchema.optional(),
  fetchPriority: SourceFetchPrioritySchema.nullable().optional(),
  lastFetchedAt: z.string().nullable().optional(),
  lastPolledAt: z.string().nullable().optional(),
  changeDetectedAt: z.string().nullable().optional(),
  consecutiveNoChange: z.number().int().nullable().optional(),
  consecutiveErrors: z.number().int().nullable().optional(),
  nextFetchAfter: z.string().nullable().optional(),
  medianGapDays: z.number().nullable().optional(),
  lastRetieredAt: z.string().nullable().optional(),
  metadata: z.string().nullable().optional(),
  productName: z.string().nullable().optional(),
  productSlug: z.string().nullable().optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  // GitHub stargazer count. `nullable().optional()` (the house idiom for these
  // shapes): non-github sources and older responses omit it; a fetched row may
  // carry `null`. Consumers treat null/undefined as "unknown".
  stars: z.number().int().min(0).nullable().optional(),
  starsFetchedAt: z.string().nullable().optional(),
});

/**
 * Canonical row returned by `GET /v1/sources` (list). Superset of
 * `SourceListItem` with required `id` / `orgName` / `orgSlug` fields used by
 * the CLI `list` command.
 */
export const SourceWithOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  type: SourceTypeSchema,
  url: z.string(),
  orgName: z.string().nullable(),
  orgSlug: z.string().nullable(),
  productName: z.string().nullable(),
  productSlug: z.string().nullable(),
  isPrimary: z.boolean(),
  isHidden: z.boolean().nullable(),
  discovery: SourceDiscoverySchema.optional(),
  metadata: z.string().nullable(),
  releaseCount: z.number().int().min(0),
  latestVersion: z.string().nullable(),
  latestDate: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  lastPolledAt: z.string().nullable(),
  fetchPriority: SourceFetchPrioritySchema.nullable(),
  changeDetectedAt: z.string().nullable(),
  consecutiveNoChange: z.number().int().nullable(),
  consecutiveErrors: z.number().int().nullable(),
  nextFetchAfter: z.string().nullable(),
  medianGapDays: z.number().nullable(),
  lastRetieredAt: z.string().nullable(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  // GitHub stargazer count. `nullable().optional()` (the house idiom for these
  // shapes): non-github sources and older responses omit it; a fetched row may
  // carry `null`. Consumers treat null/undefined as "unknown".
  stars: z.number().int().min(0).nullable().optional(),
  starsFetchedAt: z.string().nullable().optional(),
});

export const SourceListResponseSchema = ListResponseSchema(SourceWithOrgSchema);

/**
 * `GET /v1/sources` returns a bare array by default and an envelope when
 * `?envelope=true` is passed. The OpenAPI spec advertises the union so
 * either client expectation is documented.
 */
export const SourceListResultSchema = z.union([
  z.array(SourceWithOrgSchema),
  SourceListResponseSchema,
]);

const SourceDetailSummariesSchema = z.object({
  rolling: ReleaseSummaryItemSchema.nullable(),
  monthly: z.array(ReleaseSummaryItemSchema),
});

/**
 * Cursor pagination shape for the source detail's embedded release feed.
 * Mirrors `OrgFeedPaginationSchema` and `CollectionFeedPaginationSchema` —
 * release lists are feed-shaped (append-only, mutates between calls), so they
 * use cursor pagination per the AGENTS.md convention.
 */
export const SourceFeedPaginationSchema = z.object({
  nextCursor: z.string().nullable(),
  limit: z.number().int().min(1),
});

/**
 * Resolved attribution block returned alongside a source row. `id` is
 * additive vs the legacy `{ slug, name }` shape — older clients that ignored
 * it still parse cleanly. `productId` / `productSlug` are sibling top-level
 * fields on the source response (kept flat to mirror `orgId`), not nested
 * inside this block.
 */
export const SourceOrgRefSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});

export const SourceDetailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: SourceTypeSchema,
  url: z.string(),
  orgId: z.string().nullable(),
  productId: z.string().nullable(),
  productSlug: z.string().nullable(),
  // Hidden sources are reachable by direct URL but excluded from listings,
  // sitemap, and AI features. On-demand lookups and admin-suppressed rows
  // set this true; canonical curated/agent sources leave it false.
  isHidden: z.boolean(),
  // Pairs with `isHidden` to distinguish admin-suppressed rows (`curated` /
  // `agent` + hidden) from rows materialized by `/v1/lookups` (`on_demand`).
  // Optional for graceful degradation against older API responses.
  discovery: SourceDiscoverySchema.optional(),
  isPrimary: z.boolean(),
  metadata: z.string(),
  changelogUrl: z.string().nullable().optional(),
  hasChangelogFile: z.boolean().optional(),
  org: SourceOrgRefSchema.nullable(),
  releaseCount: z.number().int().min(0),
  releasesLast30Days: z.number().int().min(0),
  avgReleasesPerWeek: z.number(),
  latestVersion: z.string().nullable(),
  latestDate: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  lastPolledAt: z.string().nullable(),
  trackingSince: z.string(),
  releases: z.array(ReleaseItemSchema),
  pagination: SourceFeedPaginationSchema,
  summaries: SourceDetailSummariesSchema,
  kind: z.enum(KIND_VALUES).nullable().optional(),
  // GitHub stargazer count. `nullable().optional()` (the house idiom for these
  // shapes): non-github sources and older responses omit it; a fetched row may
  // carry `null`. Consumers treat null/undefined as "unknown".
  stars: z.number().int().min(0).nullable().optional(),
  starsFetchedAt: z.string().nullable().optional(),
});

/**
 * Response returned by `POST /v1/sources` and `PATCH /v1/sources/:slug`.
 *
 * Pre-#794 these endpoints returned the bare drizzle row, leaving callers to
 * round-trip a separate `GET` to confirm the resolved org/product attribution.
 * Now they return the same source row plus a resolved `org { id, slug, name }`
 * block and `productSlug`, so an agent can answer "did the write take?" from
 * the response alone.
 *
 * Wire fields are loosely-typed (`z.unknown()`) for the timestamps/counters
 * that aren't load-bearing for callers — the row is large and we don't want
 * to hand-mirror every column. Stable, agent-relevant fields are typed.
 */
export const SourceMutationResponseSchema = z.looseObject({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: SourceTypeSchema,
  url: z.string(),
  orgId: z.string().nullable(),
  productId: z.string().nullable(),
  productSlug: z.string().nullable(),
  org: SourceOrgRefSchema.nullable(),
  metadata: z.string().nullable(),
  isPrimary: z.boolean().nullable().optional(),
  isHidden: z.boolean().nullable().optional(),
  discovery: SourceDiscoverySchema.optional(),
  createdAt: z.string().optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
});

/**
 * Response from `POST /v1/sources/appstore` — materializes an App Store listing
 * into a curated Org → Product → Source → first Release (modeled on the GitHub
 * coordinate `LookupResponse`).
 *
 * Unlike `SourceMutationResponse`, the `source` here is the **bare inserted (or
 * idempotently looked-up) drizzle row** the materialize handler returns verbatim:
 * no resolved `org { id, slug, name }` block and no `productSlug`. `loose` so the
 * untyped timestamp/counter columns on the row pass through.
 *
 * `status: "indexed"` is a brand-new source (HTTP 201); `"existing"` is the
 * idempotent hit on a prior materialize of the same trackId (HTTP 200).
 */
export const AppStoreMaterializeResponseSchema = z.object({
  status: z.enum(["indexed", "existing"]),
  source: z.looseObject({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    type: SourceTypeSchema,
    url: z.string(),
    orgId: z.string().nullable(),
    productId: z.string().nullable(),
    metadata: z.string().nullable(),
    kind: z.enum(KIND_VALUES).nullable().optional(),
    discovery: SourceDiscoverySchema.optional(),
    isHidden: z.boolean().nullable().optional(),
    createdAt: z.string().optional(),
  }),
  releaseCount: z.number(),
});

/** Body accepted by `PATCH /v1/sources/:slug`. */
export const SourcePatchInputSchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  type: SourceTypeSchema.optional(),
  slug: z.string().optional(),
  metadata: z.string().optional(),
  orgId: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
  lastFetchedAt: z.string().nullable().optional(),
  lastContentHash: z.string().nullable().optional(),
  fetchPriority: SourceFetchPrioritySchema.optional(),
  consecutiveNoChange: z.number().int().optional(),
  consecutiveErrors: z.number().int().optional(),
  nextFetchAfter: z.string().nullable().optional(),
  isPrimary: z.boolean().optional(),
  isHidden: z.boolean().optional(),
  changeDetectedAt: z.string().nullable().optional(),
  lastPolledAt: z.string().nullable().optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  /** Admin-only: promote or demote the source's discovery status (curated/agent/on_demand). */
  discovery: SourceDiscoverySchema.optional(),
});

/** Body accepted by `POST /v1/sources`. */
export const CreateSourceBodySchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  type: SourceTypeSchema.optional(),
  slug: z.string().optional(),
  orgId: z.string().optional(),
  orgSlug: z.string().optional(),
  /**
   * Either accepted; `productId` wins when both are supplied. `productSlug`
   * resolves within the requested org (slug uniqueness is per-org). The
   * legacy `productId` ingestion path is preserved for callers that already
   * resolve products client-side; new agent flows should pass `productSlug`.
   */
  productId: z.string().optional(),
  productSlug: z.string().optional(),
  metadata: z.string().optional(),
  isPrimary: z.boolean().optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
});

export const ChangelogFileSummarySchema = z.object({
  path: z.string(),
  filename: z.string(),
  url: z.string(),
  bytes: z.number().int().min(0),
  fetchedAt: z.string(),
});

export const SourceChangelogResponseSchema = z.object({
  path: z.string(),
  filename: z.string(),
  url: z.string(),
  rawUrl: z.string(),
  content: z.string(),
  bytes: z.number().int().min(0),
  fetchedAt: z.string(),
  /** Character offset of the first character in `content` within the full file. */
  offset: z.number().int().min(0),
  /** The limit (in chars) that was applied to produce this slice. */
  limit: z.number().int().min(0),
  /** Next offset to request for the next slice, or null if `content` is the tail. */
  nextOffset: z.number().int().nullable(),
  /** Total length of the full file in characters. */
  totalChars: z.number().int().min(0),
  /** Requested token budget when in token mode (cl100k_base). */
  tokens: z.number().int().optional(),
  /** Encoded token count of the returned `content`. Set in token mode. */
  sliceTokens: z.number().int().optional(),
  /** Full-file token count (cl100k_base). Always populated. */
  totalTokens: z.number().int().min(0),
  /** True when the upstream file exceeded the 1MB cap and content was sliced. */
  truncated: z.boolean(),
  /** Byte offset where the file was truncated, or null when not truncated. */
  truncatedAt: z.number().int().nullable(),
  /**
   * Index of every changelog file tracked for this source (root plus any
   * discovered per-package files). Always present even for single-file
   * sources so clients can lazily render a file picker.
   */
  files: z.array(ChangelogFileSummarySchema),
});

// ── Source activity (/sources/:slug/activity, /orgs/:orgSlug/sources/:sourceSlug/activity) ──

const SourceActivityWeeklyBucketSchema = z.object({
  weekStart: z.string(),
  count: z.number().int().min(0),
  earliestVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
});

/**
 * Response shape for `GET /v1/sources/:slug/activity` and the org-scoped twin.
 * Returns week-bucketed release counts for the full tracking lifetime of the source.
 * Optional `?from=YYYY-MM-DD` and `?to=YYYY-MM-DD` narrow the range.
 */
export const SourceActivityResponseSchema = z.object({
  source: z.object({
    slug: z.string(),
    name: z.string(),
    orgSlug: z.string().nullable(),
    orgName: z.string().nullable(),
  }),
  range: z.object({ from: z.string(), to: z.string() }),
  weeklyBuckets: z.array(SourceActivityWeeklyBucketSchema),
});

// ── Source heatmap (/sources/:slug/heatmap, /orgs/:orgSlug/sources/:sourceSlug/heatmap) ──

/**
 * Response shape for `GET /v1/sources/:slug/heatmap` and the org-scoped twin.
 * Returns daily release counts for the trailing 365 days — contribution-graph
 * visualization for the source detail page.
 */
export const SourceHeatmapResponseSchema = z.object({
  source: z.object({ slug: z.string(), name: z.string() }),
  range: z.object({ from: z.string(), to: z.string() }),
  dailyCounts: z.array(z.object({ date: z.string(), count: z.number().int().min(0) })),
  total: z.number().int().min(0),
});

// ── Source known releases (/sources/:slug/known-releases, /orgs/:orgSlug/…) ──

/**
 * Single row returned inside `GET /v1/sources/:slug/known-releases`. Minimal
 * identifier set used by the incremental parsing agent to skip already-known
 * versions without fetching full content.
 */
export const SourceKnownReleaseItemSchema = z.object({
  version: z.string().nullable(),
  title: z.string(),
  publishedAt: z.string().nullable(),
});

/**
 * Response shape for `GET /v1/sources/:slug/known-releases`. Returns the
 * N most-recent non-suppressed releases (default N=10, max 500), ordered
 * by `publishedAt` descending. Accepts `?limit=N`.
 */
export const SourceKnownReleasesResponseSchema = z.array(SourceKnownReleaseItemSchema);

// ── Source recent releases (/sources/:slug/recent-releases, /orgs/:orgSlug/…) ──

/**
 * Response shape for `GET /v1/sources/:slug/recent-releases`. Returns the
 * full release rows (non-suppressed, published at or after `?cutoff=`) ordered
 * by `publishedAt` descending. Used by the summarization agent to retrieve the
 * release window it needs to summarize. `?cutoff=` is required (ISO-8601 date
 * string); missing `?cutoff=` returns 400.
 */
export const SourceRecentReleasesResponseSchema = z.array(
  z.looseObject({
    id: z.string(),
    sourceId: z.string(),
    version: z.string().nullable(),
    title: z.string(),
    content: z.string(),
    url: z.string().nullable(),
    publishedAt: z.string().nullable(),
    fetchedAt: z.string().optional(),
  }),
);

// ── Source sessions (/sources/:slug/sessions) ──

/**
 * Response shape for `GET /v1/sources/:slug/sessions`. Returns the active
 * discovery session (if any) touching this source. The session object is the
 * live DO state blob from the `StatusHub` Durable Object. Returns `{ sessions:
 * [] }` when no active session references this source.
 */
export const SourceSessionsResponseSchema = z.object({
  sessions: z.array(z.record(z.string(), z.unknown())),
});

// ── Source summaries (/sources/:slug/summaries) ──

/**
 * Full summary row as stored in `release_summaries`, returned by
 * `GET /v1/sources/:slug/summaries`. Filter by `?type=rolling|monthly`,
 * `?year=`, `?month=`.
 */
export const SourceSummaryRowSchema = z.object({
  id: z.string().optional(),
  sourceId: z.string(),
  orgId: z.string().nullable(),
  type: z.enum(["rolling", "monthly"]),
  year: z.number().int().nullable(),
  month: z.number().int().nullable(),
  windowDays: z.number().int().nullable(),
  summary: z.string(),
  releaseCount: z.number().int().min(0),
  generatedAt: z.string(),
});

export const SourceSummariesResponseSchema = z.array(SourceSummaryRowSchema);

/**
 * Body accepted by `POST /v1/sources/:slug/summaries`.
 *
 * `month` is calendar-bounded (1..12) and `windowDays` must be a positive
 * integer when present — silently dropping wrong-typed values masks client
 * bugs, so the validator rejects them explicitly. `year` is not bound-checked
 * (any cutoff would be arbitrary).
 */
export const CreateSourceSummaryBodySchema = z.object({
  type: z.enum(["rolling", "monthly"]),
  year: z.number().int().nullable().optional(),
  month: z.number().int().min(1).max(12).nullable().optional(),
  windowDays: z.number().int().min(1).nullable().optional(),
  summary: z.string().min(1),
  releaseCount: z.number().int().min(0),
});

/** Response for `POST /v1/sources/:slug/summaries` (upsert). */
export const CreateSourceSummaryResponseSchema = z.object({
  ok: z.literal(true),
});

// ── Source fetch trigger (POST /sources/:slug/fetch) ──

/**
 * Response shape for `POST /v1/sources/:slug/fetch`. Two branches:
 *   - Feed/GitHub/scraped-with-feed sources: `{ fetched: true, releasesInserted, … }`
 *   - Scrape/agent sources (flagged for CLI pickup): `{ queued: true, type: "flagged" }`
 */
export const SourceFetchResponseSchema = z.union([
  z.looseObject({ fetched: z.literal(true) }),
  z.object({ queued: z.literal(true), type: z.string() }),
]);

// ── Source content-hash check (POST /sources/:slug/content-hash) ──

/** Response for `POST /v1/sources/:slug/content-hash`. */
export const SourceContentHashResponseSchema = z.union([
  z.object({ unchanged: z.literal(true) }),
  z.object({ unchanged: z.literal(false) }),
]);

/** Body for `POST /v1/sources/:slug/content-hash`. */
export const SourceContentHashBodySchema = z.object({
  contentHash: z.string().min(1),
});

// ── Changelog token backfill (PATCH /sources/:slug/changelog/tokens) ──

/** Response for `PATCH /v1/sources/:slug/changelog/tokens`. */
export const ChangelogTokensResponseSchema = z.object({
  path: z.string(),
  oldTokens: z.number().int().nullable(),
  tokens: z.number().int().min(0),
});

// ── Source metadata merge (PATCH /sources/:slug/metadata) ──

/** Response for `PATCH /v1/sources/:slug/metadata`. Echoes the merged metadata object. */
export const SourceMetadataResponseSchema = z.object({
  metadata: z.record(z.string(), z.unknown()),
});

// ── Changelog probe (POST /sources/:slug/changelog/probe) ──

/**
 * A discovered CHANGELOG path returned by the probe. Mirrors
 * `DiscoveredChangelogPath` from `@releases/adapters/github-discovery`:
 * `origin` tags where the path came from (repo root, a workspace package, or
 * an explicit `metadata.changelogPaths` override) and `exists` is true when a
 * directory listing confirmed the file on HEAD.
 */
export const DiscoveredChangelogPathSchema = z.object({
  path: z.string(),
  origin: z.enum(["root", "workspace", "override"]),
  exists: z.boolean(),
});

/** Response for `POST /v1/sources/:slug/changelog/probe`. */
export const ChangelogProbeResponseSchema = z.object({
  sourceId: z.string(),
  sourceSlug: z.string(),
  url: z.string(),
  paths: z.array(DiscoveredChangelogPathSchema),
});

// ── Delete source (DELETE /sources/:slug) ──

/**
 * Response for `DELETE /v1/sources/:slug`. Two shapes:
 *   - Soft delete: `{ deleted: true, deletedAt: "<iso>" }`
 *   - Hard delete (`?hard=true`): `{ deleted: true, hard: true }`
 */
export const DeleteSourceResponseSchema = z.union([
  z.object({ deleted: z.literal(true), deletedAt: z.string() }),
  z.object({ deleted: z.literal(true), hard: z.literal(true) }),
]);

// ── Delete source releases (DELETE /sources/:slug/releases) ──

/**
 * Response for `DELETE /v1/sources/:slug/releases`. Two shapes:
 *   - Soft (`?hard` absent): `{ suppressed: N }` — releases hidden, not deleted
 *   - Hard (`?hard=true`): `{ deleted: N, hard: true }`
 */
export const DeleteSourceReleasesResponseSchema = z.union([
  z.object({ suppressed: z.number().int().min(0) }),
  z.object({ deleted: z.number().int().min(0), hard: z.literal(true) }),
]);

// ── Single release insert (POST /sources/:slug/releases) ──

/**
 * Response for `POST /v1/sources/:slug/releases`. Returns the inserted release
 * row (201) or `{ skipped: true }` (200) on URL conflict.
 */
export const InsertReleaseResponseSchema = z.union([
  z.looseObject({
    id: z.string(),
    sourceId: z.string(),
    title: z.string(),
  }),
  z.object({ skipped: z.literal(true) }),
]);

// ── Batch release insert (POST /sources/:slug/releases/batch) ──

/** Response for `POST /v1/sources/:slug/releases/batch`. */
export const BatchReleasesResponseSchema = z.object({
  inserted: z.number().int().min(0),
  total: z.number().int().min(0),
});

// ── Raw page snapshot (POST /sources/:slug/raw-snapshot) ──

/**
 * Response for `POST /v1/sources/:slug/raw-snapshot` (#1283). On a store or a
 * content-hash dedup hit, all fields are present; `stored` is `false` for the
 * dedup case. When the `RAW_SNAPSHOTS` bucket is unbound the capture soft-fails
 * with `{ stored: false, reason: "no_binding" }` and the snapshot fields are
 * omitted — capture is best-effort and never errors ingest.
 */
export const RawSnapshotResponseSchema = z.object({
  stored: z.boolean(),
  r2Key: z.string().optional(),
  contentHash: z.string().optional(),
  bytes: z.number().int().min(0).optional(),
  // Only set on the soft-fail path; bounded so consumers can branch on it.
  reason: z.enum(["no_binding"]).optional(),
});

// ── Oversized changelog files (GET /sources/changelog-files/oversized) ──

/**
 * Row returned by `GET /v1/sources/changelog-files/oversized`. Each row is a
 * changelog file whose content length exceeds `?minBytes=` (default 256 KB).
 * Used by `scripts/backfill-changelog-tokens.ts` to find rows with estimated
 * (not exact) token counts.
 */
export const OversizedChangelogFileRowSchema = z.object({
  sourceId: z.string(),
  sourceSlug: z.string(),
  sourceName: z.string(),
  orgSlug: z.string(),
  path: z.string(),
  filename: z.string(),
  bytes: z.number().int().min(0),
  tokens: z.number().int().nullable(),
  fetchedAt: z.string(),
});

export const OversizedChangelogFilesResponseSchema = z.array(OversizedChangelogFileRowSchema);

// ── Fetchable sources (GET /sources/fetchable) ──

/**
 * Response for `GET /v1/sources/fetchable`. Returns raw source rows matching
 * the requested fetch mode (`?mode=unfetched|stale|retry_errors|all`).
 * Accepts `?staleHours=N` when `mode=stale`.
 */
export const FetchableSourcesResponseSchema = z.array(
  z.looseObject({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    type: SourceTypeSchema,
    url: z.string(),
    metadata: z.string().nullable(),
  }),
);

// ── Feed sources (GET /sources/feeds) ──

/**
 * Response for `GET /v1/sources/feeds`. Returns visible source rows where
 * `metadata.feedUrl` is set and `fetchPriority != 'paused'`.
 */
export const FeedSourcesResponseSchema = FetchableSourcesResponseSchema;

// ── Changed sources (GET /sources/changes) ──

/**
 * Response for `GET /v1/sources/changes`. Returns visible source rows that
 * have a non-null `changeDetectedAt` — the set flagged for CLI pickup.
 */
export const ChangedSourcesResponseSchema = FetchableSourcesResponseSchema;
