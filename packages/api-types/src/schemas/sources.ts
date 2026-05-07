import { z } from "zod";
import {
  SOURCE_TYPES,
  SOURCE_DISCOVERY,
  SOURCE_FETCH_PRIORITIES,
} from "@buildinternet/releases-core/source-enums";
import {
  ListResponseSchema,
  PaginationSchema,
  ReleaseItemSchema,
  ReleaseSummaryItemSchema,
} from "./shared.js";

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
  pagination: PaginationSchema,
  summaries: SourceDetailSummariesSchema,
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
