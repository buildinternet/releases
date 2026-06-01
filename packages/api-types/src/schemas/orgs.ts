import { z } from "zod";
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";
import {
  AppStoreSourceInfoSchema,
  CategorySchema,
  ListResponseSchema,
  OverviewPageItemSchema,
  PaginationSchema,
  ReleaseItemSchema,
  VideoSourceInfoSchema,
} from "./shared.js";
import { SourceListItemSchema } from "./sources.js";
import { ProductListItemSchema } from "./products.js";
import { CollectionListItemSchema } from "./collections.js";

export const OrgListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  description: z.string().nullable(),
  category: CategorySchema.nullable(),
  avatarUrl: z.string().nullable(),
  featured: z.boolean(),
  sourceCount: z.number().int().min(0),
  releaseCount: z.number().int().min(0),
  recentReleaseCount: z.number().int().min(0),
  lastActivity: z.string().nullable(),
  topProducts: z.array(z.string()),
  sparkline: z.array(z.number().int().min(0)).length(30),
});

/**
 * Per-request side-channel for the orgs list (#746). `emptyOrgCount` is the
 * number of orgs that match the same `q` filter but have zero indexed
 * releases — used to label a "Show empty orgs" toggle without a second
 * round-trip. The value is scoped by the search term but independent of
 * `?includeEmpty=` so the toggle CTA can render a count whether the current
 * response included empty orgs or not.
 */
export const OrgListMetaSchema = z.object({
  emptyOrgCount: z.number().int().min(0),
});

/**
 * `meta` is optional on the wire so older workers / pinned clients mid-deploy
 * don't trip the schema check. New clients can treat missing as
 * `emptyOrgCount: 0` (the toggle just won't render a count).
 */
export const OrgListResponseSchema = z.object({
  items: z.array(OrgListItemSchema),
  pagination: PaginationSchema,
  meta: OrgListMetaSchema.optional(),
});

export const OrgAccountItemSchema = z.object({
  platform: z.string(),
  handle: z.string(),
});

export const OrgAccountsListResponseSchema = ListResponseSchema(OrgAccountItemSchema);

/**
 * Response shape for `GET /v1/orgs/:slug/accounts`. Returns the paginated list
 * by default; with `?platform=<name>` returns a single matching account or
 * `null` when no row matches. The dual shape is preserved for compatibility
 * with the OSS CLI which calls `?platform=` and expects a single row.
 */
export const OrgAccountsResponseSchema = z.union([
  OrgAccountsListResponseSchema,
  OrgAccountItemSchema,
  z.null(),
]);
export const OrgTagsResponseSchema = ListResponseSchema(z.string());

/**
 * Body accepted by `POST /v1/orgs`. `category` is a non-empty string at the
 * wire boundary so callers can pass either a canonical slug or one of its
 * configured aliases (resolved server-side via `resolveCategoryInput`).
 * Responses always carry the canonical slug. Empty strings are rejected so
 * the truthy-guard around `resolveCategoryInput` in the handler can't be
 * bypassed into persisting an invalid `""` value.
 */
export const CreateOrgBodySchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  domain: z.string().optional(),
  description: z.string().optional(),
  category: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * Body accepted by `PATCH /v1/orgs/:slug`. Same alias-allowed string rule
 * as create, plus `null` to explicitly clear the overlay. Empty strings
 * stay rejected so callers must pick between a slug/alias or `null`.
 */
export const UpdateOrgBodySchema = z.object({
  name: z.string().optional(),
  slug: z.string().optional(),
  domain: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().min(1).nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  /** Admin-only: pause/unpause all ingest for this org without touching sources (#1057). */
  fetchPaused: z.boolean().optional(),
  /** Admin-only: hide the org from the homepage ticker + /v1/orgs directory. Stays reachable via detail, search, sitemap. */
  isHidden: z.boolean().optional(),
  /** Admin-only: opt the org into automatic AI content — org overviews AND per-release summaries (single backend flag `auto_generate_content`). */
  autoGenerateContent: z.boolean().optional(),
  /** Admin-only: promote this org on the home-page featured rail. */
  featured: z.boolean().optional(),
});

// Org detail's products query selects a strict subset of `ProductListItem` —
// no category/orgId because the parent already names the org; createdAt is
// included for age-based filtering by consumers.
const OrgDetailProductSchema = ProductListItemSchema.pick({
  id: true,
  slug: true,
  name: true,
  url: true,
  description: true,
  sourceCount: true,
  kind: true,
  createdAt: true,
}).extend({
  releaseCount: z.number().int().min(0),
});

const OrgDetailPlaybookSchema = z.object({
  scope: z.literal("playbook"),
  content: z.string(),
  updatedAt: z.string(),
});

// ── Org catalog (/orgs/:slug/catalog) ──

const OrgCatalogProductItemSchema = z.object({
  entryType: z.literal("product"),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  category: CategorySchema.nullable(),
});

const OrgCatalogSourceItemSchema = z.object({
  entryType: z.literal("source"),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: z.string(),
  url: z.string(),
  productId: z.string().nullable(),
});

/**
 * Combined product + source catalog for `GET /v1/orgs/:slug/catalog`.
 * `entryType` discriminates between the two row shapes (`"product"` vs
 * `"source"`). `kind` carries the entity taxonomy (platform/sdk/mobile/…).
 * Products carry `category` and `description`; sources carry `type` and
 * `productId`.
 */
export const OrgCatalogItemSchema = z.discriminatedUnion("entryType", [
  OrgCatalogProductItemSchema,
  OrgCatalogSourceItemSchema,
]);

export const OrgCatalogResponseSchema = z.object({
  org: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  items: z.array(OrgCatalogItemSchema),
});

// ── Org collections membership (/orgs/:slug/collections) ──

/**
 * List of collections the org belongs to, returned by
 * `GET /v1/orgs/:slug/collections`. Each item follows the same shape as
 * `CollectionListItem` on `GET /v1/collections` — `previewMembers` is
 * omitted here because the context (one org's collections) makes inline
 * member previews redundant.
 */
export const OrgCollectionsResponseSchema = z.array(CollectionListItemSchema);

// ── Org accounts (/orgs/:slug/accounts) ──

/**
 * Body accepted by `POST /v1/orgs/:slug/accounts`.
 * Both `platform` and `handle` are required.
 */
export const AddOrgAccountBodySchema = z.object({
  platform: z.string().min(1),
  handle: z.string().min(1),
});

// ── Org ignored URLs (/orgs/:slug/ignored-urls) ──

export const IgnoredUrlItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  orgId: z.string(),
  reason: z.string().nullable(),
  ignoredAt: z.string(),
});

export const OrgIgnoredUrlsListResponseSchema = ListResponseSchema(IgnoredUrlItemSchema);

/**
 * Response shape for `GET /v1/orgs/:slug/ignored-urls`. Returns the paginated
 * list by default; with `?url=<encoded>&single=1` returns the matching single
 * row or `null` when not present.
 */
export const OrgIgnoredUrlsResponseSchema = z.union([
  OrgIgnoredUrlsListResponseSchema,
  IgnoredUrlItemSchema,
  z.null(),
]);

/**
 * Body accepted by `POST /v1/orgs/:slug/ignored-urls`.
 * `reason` is optional.
 */
export const AddIgnoredUrlBodySchema = z.object({
  url: z.string().min(1),
  reason: z.string().optional(),
});

/** Response shape for `POST /v1/orgs/:slug/ignored-urls`. */
export const AddIgnoredUrlResponseSchema = z.object({
  ignored: z.literal(true),
});

/** Response shape for `DELETE /v1/orgs/:slug/ignored-urls/:url`. */
export const DeleteIgnoredUrlResponseSchema = z.object({
  deleted: z.literal(true),
});

// ── Org tags (/orgs/:slug/tags and PUT /DELETE) ──

/** Body accepted by `PUT` and `DELETE` `/v1/orgs/:slug/tags`. */
export const OrgTagsBodySchema = z.object({
  tags: z.array(z.string()),
});

/** Response shape returned by `PUT` and `DELETE` `/v1/orgs/:slug/tags`. */
export const OrgTagsMutationResponseSchema = z.object({
  ok: z.literal(true),
});

// ── POST /tags (global tag creation) ──

/** Body accepted by `POST /v1/tags`. */
export const CreateTagBodySchema = z.object({
  name: z.string().min(1),
});

/** Row returned by `POST /v1/tags` (201 on create, 200 if already exists). */
export const TagRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
});

// ── Org activity (/orgs/:slug/activity) ──

const OrgActivityWeeklyBucketSchema = z.object({
  weekStart: z.string(),
  count: z.number().int().min(0),
  earliestVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
});

const OrgActivitySourceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  releaseCount: z.number().int().min(0),
  avgReleasesPerWeek: z.number(),
  earliestVersion: z.string().nullable(),
  latestVersion: z.string().nullable(),
  latestDate: z.string().nullable(),
  weeklyBuckets: z.array(OrgActivityWeeklyBucketSchema),
});

/**
 * Response shape for `GET /v1/orgs/:slug/activity`. Returns per-source
 * weekly release buckets plus an aggregate rollup — used for timeline
 * visualization in the web org detail page.
 */
export const OrgActivityResponseSchema = z.object({
  org: z.object({ slug: z.string(), name: z.string() }),
  range: z.object({ from: z.string(), to: z.string() }),
  sources: z.array(OrgActivitySourceSchema),
  aggregateWeekly: z.array(z.object({ weekStart: z.string(), count: z.number().int().min(0) })),
});

// ── Org heatmap (/orgs/:slug/heatmap) ──

/**
 * Response shape for `GET /v1/orgs/:slug/heatmap`. Returns daily release
 * counts for the trailing 365 days — used for contribution-graph
 * visualization in the web org detail page.
 */
export const OrgHeatmapResponseSchema = z.object({
  org: z.object({ slug: z.string(), name: z.string() }),
  range: z.object({ from: z.string(), to: z.string() }),
  dailyCounts: z.array(z.object({ date: z.string(), count: z.number().int().min(0) })),
  total: z.number().int().min(0),
});

// ── Org sparklines (/orgs/:slug/sparklines) ──

const SparklineSourceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  sparkline: z.array(z.number().int().min(0)).length(30),
});

/**
 * Response shape for `GET /v1/orgs/:slug/sparklines`. Returns 30-day daily
 * release counts per source and per product, plus an aggregate rollup.
 */
export const OrgSparklinesResponseSchema = z.object({
  org: z.object({ slug: z.string(), name: z.string() }),
  range: z.object({ from: z.string(), to: z.string() }),
  aggregate: z.array(z.number().int().min(0)).length(30),
  sources: z.array(SparklineSourceSchema),
  products: z.array(SparklineSourceSchema),
});

// ── Org releases feed (/orgs/:slug/releases) ──

/**
 * Release feed item on `GET /v1/orgs/:slug/releases`. Extends `ReleaseItem`
 * with a `source` block identifying the originating source within the org.
 */
export const OrgReleaseItemSchema = ReleaseItemSchema.extend({
  source: z.object({
    slug: z.string(),
    name: z.string(),
    type: z.string(),
    appStore: AppStoreSourceInfoSchema.optional(),
    video: VideoSourceInfoSchema.optional(),
  }),
  /**
   * Owning product, when the release's source is grouped under a product.
   * `null` when the source has no `product_id`. Additive — older API responses
   * omit this field; treat `undefined` as `null`. #1217.
   */
  product: z.object({ slug: z.string(), name: z.string() }).nullable().optional(),
  /**
   * Server-resolved grouping identity — `COALESCE(product.slug, source.slug)` /
   * `COALESCE(product.name, source.name)`. The web releases feed keys and labels
   * SDK/package-cluster rollups on these instead of reconstructing
   * `product ?? source` client-side. Optional on the wire: older workers omit
   * them, so clients must fall back to deriving from `product ?? source`. Never
   * null when present (`source` is always set). #1234
   */
  groupSlug: z.string().optional(),
  groupName: z.string().optional(),
});

/** Cursor pagination shape for the org releases feed. */
export const OrgFeedPaginationSchema = z.object({
  nextCursor: z.string().nullable(),
  limit: z.number().int().min(1),
});

/**
 * Response shape for `GET /v1/orgs/:slug/releases`.
 * Cursor-paginated; `nextCursor` is `null` when this is the last page.
 */
export const OrgReleasesFeedResponseSchema = z.object({
  releases: z.array(OrgReleaseItemSchema),
  pagination: OrgFeedPaginationSchema,
});

// ── Org recent releases (/orgs/:slug/recent-releases) ──

/**
 * Row returned by `GET /v1/orgs/:slug/recent-releases`. This is the full
 * `releasesVisible` row with `sourceName` and `sourceSlug` joined from
 * `sourcesVisible` — intended for summarization / grouping by agents.
 * Many fields are nullable because they may not be populated at ingest time.
 */
export const OrgRecentReleaseItemSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  version: z.string().nullable(),
  type: z.string().optional(),
  title: z.string(),
  content: z.string(),
  summary: z.string().nullable(),
  titleGenerated: z.string().nullable().optional(),
  titleShort: z.string().nullable().optional(),
  url: z.string().nullable(),
  contentHash: z.string().nullable(),
  metadata: z.string().nullable(),
  media: z.string().nullable(),
  publishedAt: z.string().nullable(),
  suppressed: z.number().optional(),
  suppressedReason: z.string().nullable().optional(),
  fetchedAt: z.string().optional(),
  embeddedAt: z.string().nullable().optional(),
  sourceName: z.string(),
  sourceSlug: z.string(),
});

export const OrgRecentReleasesResponseSchema = z.array(OrgRecentReleaseItemSchema);

// ── Org accounts mutation responses ──

/** Response returned by `DELETE /v1/orgs/:slug/accounts/:platform/:handle`. */
export const DeleteOrgAccountResponseSchema = z.object({
  deleted: z.literal(true),
});

export const OrgDetailSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  description: z.string().nullable().optional(),
  category: CategorySchema.nullable().optional(),
  avatarUrl: z.string().nullable(),
  /** Admin display flag: true when the org is hidden from listings (homepage + /v1/orgs). Optional on the wire for older workers mid-deploy. */
  isHidden: z.boolean().optional(),
  /** Admin display flag: org is opted into automatic overviews + per-release summaries. Optional on the wire for older workers mid-deploy. */
  autoGenerateContent: z.boolean().optional(),
  /** Admin display flag: org is promoted on the home-page featured rail. Optional on the wire for older workers mid-deploy. */
  featured: z.boolean().optional(),
  /** Admin display flag: all ingest paused for this org. */
  fetchPaused: z.boolean().optional(),
  /** How the org row was created. `on_demand` orgs are excluded from overview generation regardless of `autoGenerateContent`. */
  discovery: z.enum(["curated", "agent", "on_demand"]).optional(),
  tags: z.array(z.string()).optional(),
  sourceCount: z.number().int().min(0),
  releaseCount: z.number().int().min(0),
  releasesLast30Days: z.number().int().min(0),
  avgReleasesPerWeek: z.number(),
  lastFetchedAt: z.string().nullable(),
  lastPolledAt: z.string().nullable(),
  trackingSince: z.string(),
  aliases: z.array(z.string()).optional(),
  accounts: z.array(OrgAccountItemSchema),
  products: z.array(OrgDetailProductSchema),
  sources: z.array(SourceListItemSchema),
  overview: OverviewPageItemSchema.nullable().optional(),
  playbook: OrgDetailPlaybookSchema.nullable().optional(),
});
