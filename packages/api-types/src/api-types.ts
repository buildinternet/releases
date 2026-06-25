/**
 * Shared API response types — single source of truth for the wire protocol.
 * Consumed by: web frontend, MCP worker, OSS CLI, and the API worker.
 */

import type { z } from "zod";

export type {
  SourceType,
  SourceDiscovery,
  SourceFetchPriority,
} from "@buildinternet/releases-core/source-enums";
// Re-export above doesn't create local bindings; import for use in interfaces below.
import type { SourceType, SourceFetchPriority } from "@buildinternet/releases-core/source-enums";
import type { ApiScope } from "@buildinternet/releases-core/api-token";
import type { BreakingLevel } from "@buildinternet/releases-core/breaking";
import type {
  MediaItemSchema,
  PaginationSchema,
  StatsSchema,
  ErrorResponseSchema,
  ReleaseTypeSchema,
  ReleaseCompositionSchema,
  ReleaseItemSchema,
  ReleaseSummaryItemSchema,
  OverviewPageItemSchema,
  OverviewCitationSchema,
} from "./schemas/shared.js";
import type {
  OrgListItemSchema,
  OrgListResponseSchema,
  OrgAccountItemSchema,
  OrgAccountsResponseSchema,
  OrgTagsResponseSchema,
  CreateOrgBodySchema,
  UpdateOrgBodySchema,
  SetOrgAvatarBodySchema,
  SetOrgAvatarResponseSchema,
  OrgDetailSchema,
  OrgCatalogItemSchema,
  OrgCatalogResponseSchema,
  OrgCollectionsResponseSchema,
  AddOrgAccountBodySchema,
  IgnoredUrlItemSchema,
  OrgIgnoredUrlsResponseSchema,
  AddIgnoredUrlBodySchema,
  AddIgnoredUrlResponseSchema,
  DeleteIgnoredUrlResponseSchema,
  OrgTagsBodySchema,
  OrgTagsMutationResponseSchema,
  CreateTagBodySchema,
  TagRowSchema,
  OrgActivityResponseSchema,
  OrgHeatmapResponseSchema,
  OrgSparklinesResponseSchema,
  OrgReleaseItemSchema,
  OrgFeedPaginationSchema,
  OrgReleasesFeedResponseSchema,
  OrgRecentReleaseItemSchema,
  OrgRecentReleasesResponseSchema,
  DeleteOrgAccountResponseSchema,
} from "./schemas/orgs.js";
import type {
  UploadAvatarResponseSchema,
  WorkspaceProfileFieldsSchema,
  PatchWorkspaceProfileBodySchema,
  WorkspaceProfileResponseSchema,
} from "./schemas/account-profile.js";
import type {
  SourceListItemSchema,
  SourceWithOrgSchema,
  SourceListResponseSchema,
  SourceListResultSchema,
  SourceDetailSchema,
  SourceFeedPaginationSchema,
  SourceMutationResponseSchema,
  AppStoreMaterializeResponseSchema,
  SourceOrgRefSchema,
  SourcePatchInputSchema,
  CreateSourceBodySchema,
  ChangelogFileSummarySchema,
  SourceChangelogResponseSchema,
  SourceActivityResponseSchema,
  SourceHeatmapResponseSchema,
  SourceKnownReleaseItemSchema,
  SourceKnownReleasesResponseSchema,
  SourceRecentReleasesResponseSchema,
  SourceSessionsResponseSchema,
  SourceSummaryRowSchema,
  SourceSummariesResponseSchema,
  CreateSourceSummaryBodySchema,
  CreateSourceSummaryResponseSchema,
  SourceFetchResponseSchema,
  SourceContentHashResponseSchema,
  SourceContentHashBodySchema,
  ChangelogTokensResponseSchema,
  SourceMetadataResponseSchema,
  ChangelogProbeResponseSchema,
  DeleteSourceResponseSchema,
  DeleteSourceReleasesResponseSchema,
  InsertReleaseResponseSchema,
  BatchReleasesResponseSchema,
  RawSnapshotResponseSchema,
  OversizedChangelogFileRowSchema,
  OversizedChangelogFilesResponseSchema,
  FetchableSourcesResponseSchema,
  FeedSourcesResponseSchema,
  ChangedSourcesResponseSchema,
} from "./schemas/sources.js";
import type {
  ProductRowSchema,
  ProductCreateResponseSchema,
  ProductListItemSchema,
  ProductListResponseSchema,
  ProductDetailSourceSchema,
  ProductDetailSchema,
  CreateProductBodySchema,
  UpdateProductBodySchema,
  AdoptProductBodySchema,
  ProductAdoptResultSchema,
  ProductAdoptDryRunSchema,
  ProductAdoptResponseSchema,
  ProductDeleteResponseSchema,
  ProductTagsListResponseSchema,
  ProductTagsBodySchema,
  ProductTagsMutationResponseSchema,
  ProductActivityResponseSchema,
  ProductHeatmapResponseSchema,
} from "./schemas/products.js";
import type {
  ReleaseLatestSourceSchema,
  ReleaseLatestProductSchema,
  ReleaseLatestItemSchema,
  ReleaseLatestResponseSchema,
  ReleaseCoverageSiblingSchema,
  ReleaseCoverageRowSchema,
  ReleaseCoverageResponseSchema,
  LinkReleaseCoverageBodySchema,
  LinkReleaseCoverageResponseSchema,
  UnlinkReleaseCoverageResponseSchema,
  ReleaseWithMediaRowSchema,
  ReleasesWithMediaResponseSchema,
  ReleaseDetailOrgSchema,
  ReleaseDetailResponseSchema,
  UpdateReleaseBodySchema,
  ReleasePatchResponseSchema,
  ReleaseDeleteResponseSchema,
  ReleaseBatchDeleteBodySchema,
  ReleaseBatchDeleteResponseSchema,
  ReleaseSuppressResponseSchema,
  ReleaseUnsuppressResponseSchema,
  ReleaseSuppressBodySchema,
  ReleaseBatchSuppressBodySchema,
  ReleaseBatchSuppressResponseSchema,
  ReleaseStreamMessageSchema,
} from "./schemas/releases.js";
import type {
  LookupStatusSchema,
  LookupBodySchema,
  LookupSourceSchema,
  LookupReleaseSchema,
  LookupRelatedOrgSchema,
  LookupResponseSchema,
  LookupSourceBySlugResponseSchema,
  LookupProductBySlugResponseSchema,
  DomainLookupOrgSchema,
  DomainLookupProductSchema,
  DomainLookupResponseSchema,
} from "./schemas/lookups.js";
import type {
  SearchOrgHitSchema,
  SearchCatalogHitSchema,
  SearchSourceHitSchema,
  SearchReleaseHitSchema,
  SearchChunkHitSchema,
  SearchCollectionHitSchema,
  LookupResultPayloadSchema,
  UnifiedSearchResponseSchema,
} from "./schemas/search.js";
import type {
  TaxonomyOrgSchema,
  TaxonomyProductSchema,
  CategoryListItemSchema,
  CategoryListResponseSchema,
  CategoryDetailSchema,
  UpdateCategoryRequestSchema,
  UpdateCategoryResponseSchema,
  CategoryFeedPaginationSchema,
  CategoryReleasesResponseSchema,
  TagDetailSchema,
} from "./schemas/taxonomy.js";
import type {
  StatsSourceActivitySchema,
  StatsRecentActivitySchema,
  StatsResponseSchema,
} from "./schemas/stats.js";
import type {
  FeedbackTypeSchema,
  FeedbackStatusSchema,
  FeedbackItemSchema,
  FeedbackListResponseSchema,
  FeedbackUpdateBodySchema,
  FeedbackDeleteResponseSchema,
} from "./schemas/feedback.js";
import type { SitemapSourceSchema, SitemapPayloadSchema } from "./schemas/sitemap.js";
import type {
  RelatedScopeSchema,
  RelatedReleaseThumbnailSchema,
  RelatedReleaseSourceSchema,
  RelatedReleaseItemSchema,
  RelatedSourceItemSchema,
  RelatedReleasesOkResponseSchema,
  RelatedReleasesDegradedResponseSchema,
  RelatedReleasesResponseSchema,
  RelatedSourcesOkResponseSchema,
  RelatedSourcesDegradedResponseSchema,
  RelatedSourcesResponseSchema,
} from "./schemas/related.js";
import type {
  CollectionMemberOrgSchema,
  ProductParentOrgSchema,
  CollectionMemberProductSchema,
  CollectionMemberSchema,
  CollectionListItemSchema,
  CollectionListResponseSchema,
  CollectionDetailSchema,
  CollectionReleaseItemSchema,
  CollectionFeedPaginationSchema,
  CollectionReleasesResponseSchema,
  CollectionRowSchema,
  CreateCollectionRequestSchema,
  UpdateCollectionRequestSchema,
  CollectionMemberInputSchema,
  AddCollectionMemberRequestSchema,
  ReplaceCollectionMembersRequestSchema,
  ResolvedCollectionMemberSchema,
  ReplaceCollectionMembersResponseSchema,
  AddCollectionMemberResponseSchema,
  CollectionDailySummarySchema,
  CollectionDailySummariesResponseSchema,
} from "./schemas/collections.js";
import type {
  OrgOverviewResponseSchema,
  IncomingOverviewCitationSchema,
  RegenerateOverviewBodySchema,
  RegenerateOverviewResponseSchema,
  ProductOverviewResponseSchema,
  OverviewInputsCheckResponseSchema,
  OverviewInputsFullResponseSchema,
  OverviewInputsResponseSchema,
  PlaybookResponseSchema,
  UpdatePlaybookNotesBodySchema,
  UpdatePlaybookNotesResponseSchema,
} from "./schemas/overviews.js";

export {
  MediaItemSchema,
  PaginationSchema,
  ListResponseSchema,
  StatsSchema,
  ErrorResponseSchema,
  ReleaseTypeSchema,
  ReleaseCompositionSchema,
  ReleaseItemSchema,
  ReleaseSummaryItemSchema,
  OverviewPageItemSchema,
  OverviewCitationSchema,
  CategorySchema,
  NoticeSchema,
} from "./schemas/shared.js";
export { SiteNoticeSchema, SiteNoticeResponseSchema } from "./schemas/site-notice.js";
export {
  OrgListItemSchema,
  OrgListResponseSchema,
  OrgAccountItemSchema,
  OrgAccountsResponseSchema,
  OrgTagsResponseSchema,
  CreateOrgBodySchema,
  UpdateOrgBodySchema,
  SetOrgAvatarBodySchema,
  SetOrgAvatarResponseSchema,
  OrgDetailSchema,
  OrgCatalogItemSchema,
  OrgCatalogResponseSchema,
  OrgCollectionsResponseSchema,
  AddOrgAccountBodySchema,
  IgnoredUrlItemSchema,
  OrgIgnoredUrlsResponseSchema,
  AddIgnoredUrlBodySchema,
  AddIgnoredUrlResponseSchema,
  DeleteIgnoredUrlResponseSchema,
  OrgTagsBodySchema,
  OrgTagsMutationResponseSchema,
  CreateTagBodySchema,
  TagRowSchema,
  OrgActivityResponseSchema,
  OrgHeatmapResponseSchema,
  OrgSparklinesResponseSchema,
  OrgReleaseItemSchema,
  OrgFeedPaginationSchema,
  OrgReleasesFeedResponseSchema,
  OrgRecentReleaseItemSchema,
  OrgRecentReleasesResponseSchema,
  DeleteOrgAccountResponseSchema,
} from "./schemas/orgs.js";
export {
  UploadAvatarResponseSchema,
  WorkspaceProfileFieldsSchema,
  PatchWorkspaceProfileBodySchema,
  WorkspaceProfileResponseSchema,
} from "./schemas/account-profile.js";
export {
  ReleasesJsonConfigSchema,
  ReleasesJsonProductSchema,
  SyncWellKnownResponseSchema,
} from "./schemas/well-known.js";
export type { ReleasesJsonConfig, ReleasesJsonProduct } from "./schemas/well-known.js";
export {
  SourceListItemSchema,
  SourceWithOrgSchema,
  SourceListResponseSchema,
  SourceListResultSchema,
  SourceDetailSchema,
  SourceFeedPaginationSchema,
  SourceMutationResponseSchema,
  AppStoreMaterializeResponseSchema,
  SourceOrgRefSchema,
  SourcePatchInputSchema,
  CreateSourceBodySchema,
  ChangelogFileSummarySchema,
  SourceChangelogResponseSchema,
  SourceActivityResponseSchema,
  SourceHeatmapResponseSchema,
  SourceKnownReleaseItemSchema,
  SourceKnownReleasesResponseSchema,
  SourceRecentReleasesResponseSchema,
  SourceSessionsResponseSchema,
  SourceSummaryRowSchema,
  SourceSummariesResponseSchema,
  CreateSourceSummaryBodySchema,
  CreateSourceSummaryResponseSchema,
  SourceFetchResponseSchema,
  SourceContentHashResponseSchema,
  SourceContentHashBodySchema,
  ChangelogTokensResponseSchema,
  SourceMetadataResponseSchema,
  ChangelogProbeResponseSchema,
  DeleteSourceResponseSchema,
  DeleteSourceReleasesResponseSchema,
  InsertReleaseResponseSchema,
  BatchReleasesResponseSchema,
  RawSnapshotResponseSchema,
  OversizedChangelogFileRowSchema,
  OversizedChangelogFilesResponseSchema,
  FetchableSourcesResponseSchema,
  FeedSourcesResponseSchema,
  ChangedSourcesResponseSchema,
} from "./schemas/sources.js";
export {
  ProductRowSchema,
  ProductCreateResponseSchema,
  ProductListItemSchema,
  ProductListResponseSchema,
  ProductDetailSourceSchema,
  ProductDetailSchema,
  CreateProductBodySchema,
  UpdateProductBodySchema,
  AdoptProductBodySchema,
  ProductAdoptResultSchema,
  ProductAdoptDryRunSchema,
  ProductAdoptResponseSchema,
  ProductDeleteResponseSchema,
  ProductTagsListResponseSchema,
  ProductTagsBodySchema,
  ProductTagsMutationResponseSchema,
  ProductActivityResponseSchema,
  ProductHeatmapResponseSchema,
} from "./schemas/products.js";
export {
  LookupStatusSchema,
  LookupBodySchema,
  LookupSourceSchema,
  LookupReleaseSchema,
  LookupRelatedOrgSchema,
  LookupResponseSchema,
  LookupSourceBySlugResponseSchema,
  LookupProductBySlugResponseSchema,
  DomainLookupOrgSchema,
  DomainLookupProductSchema,
  DomainLookupResponseSchema,
} from "./schemas/lookups.js";
export {
  TaxonomyOrgSchema,
  TaxonomyProductSchema,
  CategoryListItemSchema,
  CategoryListResponseSchema,
  CategoryDetailSchema,
  UpdateCategoryRequestSchema,
  UpdateCategoryResponseSchema,
  CategoryReleaseItemSchema,
  CategoryFeedPaginationSchema,
  CategoryReleasesResponseSchema,
  TagDetailSchema,
} from "./schemas/taxonomy.js";
export {
  ReleaseLatestSourceSchema,
  ReleaseLatestProductSchema,
  ReleaseLatestItemSchema,
  ReleaseLatestResponseSchema,
  ReleaseCoverageSiblingSchema,
  ReleaseCoverageRowSchema,
  ReleaseCoverageResponseSchema,
  LinkReleaseCoverageBodySchema,
  LinkReleaseCoverageResponseSchema,
  UnlinkReleaseCoverageResponseSchema,
  ReleaseWithMediaRowSchema,
  ReleasesWithMediaResponseSchema,
  ReleaseDetailOrgSchema,
  ReleaseDetailResponseSchema,
  UpdateReleaseBodySchema,
  ReleasePatchResponseSchema,
  ReleaseDeleteResponseSchema,
  ReleaseBatchDeleteBodySchema,
  ReleaseBatchDeleteResponseSchema,
  ReleaseSuppressResponseSchema,
  ReleaseUnsuppressResponseSchema,
  ReleaseSuppressBodySchema,
  ReleaseBatchSuppressBodySchema,
  ReleaseBatchSuppressResponseSchema,
  ReleaseStreamMessageSchema,
} from "./schemas/releases.js";
export {
  SearchOrgHitSchema,
  SearchCatalogHitSchema,
  SearchSourceHitSchema,
  SearchReleaseHitSchema,
  SearchChunkHitSchema,
  SearchCollectionHitSchema,
  LookupResultPayloadSchema,
  UnifiedSearchResponseSchema,
} from "./schemas/search.js";
export {
  StatsSourceActivitySchema,
  StatsRecentActivitySchema,
  StatsResponseSchema,
} from "./schemas/stats.js";
export {
  FeedbackTypeSchema,
  FeedbackStatusSchema,
  FeedbackItemSchema,
  FeedbackListResponseSchema,
  FeedbackUpdateBodySchema,
  FeedbackDeleteResponseSchema,
} from "./schemas/feedback.js";
export { SitemapSourceSchema, SitemapPayloadSchema } from "./schemas/sitemap.js";
export {
  RelatedScopeSchema,
  RelatedReleaseThumbnailSchema,
  RelatedReleaseSourceSchema,
  RelatedReleaseItemSchema,
  RelatedSourceItemSchema,
  RelatedReleasesOkResponseSchema,
  RelatedReleasesDegradedResponseSchema,
  RelatedReleasesResponseSchema,
  RelatedSourcesOkResponseSchema,
  RelatedSourcesDegradedResponseSchema,
  RelatedSourcesResponseSchema,
} from "./schemas/related.js";
export {
  CollectionMemberOrgSchema,
  ProductParentOrgSchema,
  CollectionMemberProductSchema,
  CollectionMemberSchema,
  CollectionListItemSchema,
  CollectionListResponseSchema,
  CollectionDetailSchema,
  CollectionReleaseItemSchema,
  CollectionFeedPaginationSchema,
  CollectionReleasesResponseSchema,
  CollectionRowSchema,
  CreateCollectionRequestSchema,
  UpdateCollectionRequestSchema,
  CollectionMemberInputSchema,
  AddCollectionMemberRequestSchema,
  ReplaceCollectionMembersRequestSchema,
  ResolvedCollectionMemberSchema,
  ReplaceCollectionMembersResponseSchema,
  AddCollectionMemberResponseSchema,
  CollectionDailySummarySchema,
  CollectionDailySummariesResponseSchema,
} from "./schemas/collections.js";
export {
  OrgOverviewResponseSchema,
  IncomingOverviewCitationSchema,
  RegenerateOverviewBodySchema,
  RegenerateOverviewResponseSchema,
  ProductOverviewResponseSchema,
  OverviewInputsCheckResponseSchema,
  OverviewInputsFullResponseSchema,
  OverviewInputsResponseSchema,
  PlaybookResponseSchema,
  UpdatePlaybookNotesBodySchema,
  UpdatePlaybookNotesResponseSchema,
} from "./schemas/overviews.js";
export { ResolveResponseSchema } from "./schemas/resolve.js";
export type { ResolveResponse } from "./schemas/resolve.js";

// ── Media ──

export type MediaItem = z.infer<typeof MediaItemSchema>;

// ── Stats ──

export type Stats = z.infer<typeof StatsSchema>;

// ── Pagination ──

export type Pagination = z.infer<typeof PaginationSchema>;

export interface ListResponse<T> {
  items: T[];
  pagination: Pagination;
}

// === User-owned API keys (relu_) — self-serve surface served by /v1/api-keys ===

/** A user-owned API key (relu_) as returned by GET /v1/api-keys. */
export interface UserApiKey {
  id: string;
  name: string | null;
  start: string | null;
  scope: ApiScope | null;
  enabled: boolean | null;
  remaining: number | null;
  lastRequest: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  expiresAt: string | null; // ISO 8601
}

/** POST /v1/api-keys create response — includes the full key string exactly once. */
export interface CreatedUserApiKey extends Omit<UserApiKey, "enabled" | "lastRequest"> {
  key: string;
}

/** GET /v1/api-keys response envelope. */
export interface ListUserApiKeysResponse {
  apiKeys: UserApiKey[];
}

/** POST /v1/api-keys request body. Self-serve mints are capped at read server-side. */
export interface CreateUserApiKeyBody {
  name: string;
  scope?: ApiScope;
  expiresInDays?: number;
}

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// ── Sitemap (bulk URL emission) ──

export type SitemapSource = z.infer<typeof SitemapSourceSchema>;
export type SitemapPayload = z.infer<typeof SitemapPayloadSchema>;

// ── Related (Vectorize neighbors) ──

export type RelatedScope = z.infer<typeof RelatedScopeSchema>;
export type RelatedReleaseThumbnail = z.infer<typeof RelatedReleaseThumbnailSchema>;
export type RelatedReleaseSource = z.infer<typeof RelatedReleaseSourceSchema>;
export type RelatedReleaseItem = z.infer<typeof RelatedReleaseItemSchema>;
export type RelatedSourceItem = z.infer<typeof RelatedSourceItemSchema>;
export type RelatedReleasesOkResponse = z.infer<typeof RelatedReleasesOkResponseSchema>;
export type RelatedReleasesDegradedResponse = z.infer<typeof RelatedReleasesDegradedResponseSchema>;
export type RelatedReleasesResponse = z.infer<typeof RelatedReleasesResponseSchema>;
export type RelatedSourcesOkResponse = z.infer<typeof RelatedSourcesOkResponseSchema>;
export type RelatedSourcesDegradedResponse = z.infer<typeof RelatedSourcesDegradedResponseSchema>;
export type RelatedSourcesResponse = z.infer<typeof RelatedSourcesResponseSchema>;

// ── Organizations ──

export type OrgListItem = z.infer<typeof OrgListItemSchema>;
export type OrgListResponse = z.infer<typeof OrgListResponseSchema>;
export type OrgAccountItem = z.infer<typeof OrgAccountItemSchema>;
export type OrgAccountsResponse = z.infer<typeof OrgAccountsResponseSchema>;
export type OrgTagsResponse = z.infer<typeof OrgTagsResponseSchema>;
export type CreateOrgBody = z.infer<typeof CreateOrgBodySchema>;
export type UpdateOrgBody = z.infer<typeof UpdateOrgBodySchema>;
export type SetOrgAvatarBody = z.infer<typeof SetOrgAvatarBodySchema>;
export type SetOrgAvatarResponse = z.infer<typeof SetOrgAvatarResponseSchema>;
export type UploadAvatarResponse = z.infer<typeof UploadAvatarResponseSchema>;
export type WorkspaceProfileFields = z.infer<typeof WorkspaceProfileFieldsSchema>;
export type PatchWorkspaceProfileBody = z.infer<typeof PatchWorkspaceProfileBodySchema>;
export type WorkspaceProfileResponse = z.infer<typeof WorkspaceProfileResponseSchema>;
export type OrgDetail = z.infer<typeof OrgDetailSchema>;

export type OrgCatalogItem = z.infer<typeof OrgCatalogItemSchema>;
export type OrgCatalogResponse = z.infer<typeof OrgCatalogResponseSchema>;
export type OrgCollectionsResponse = z.infer<typeof OrgCollectionsResponseSchema>;
export type AddOrgAccountBody = z.infer<typeof AddOrgAccountBodySchema>;
export type IgnoredUrlItem = z.infer<typeof IgnoredUrlItemSchema>;
export type OrgIgnoredUrlsResponse = z.infer<typeof OrgIgnoredUrlsResponseSchema>;
export type AddIgnoredUrlBody = z.infer<typeof AddIgnoredUrlBodySchema>;
export type AddIgnoredUrlResponse = z.infer<typeof AddIgnoredUrlResponseSchema>;
export type DeleteIgnoredUrlResponse = z.infer<typeof DeleteIgnoredUrlResponseSchema>;
export type OrgTagsBody = z.infer<typeof OrgTagsBodySchema>;
export type OrgTagsMutationResponse = z.infer<typeof OrgTagsMutationResponseSchema>;
export type CreateTagBody = z.infer<typeof CreateTagBodySchema>;
export type TagRow = z.infer<typeof TagRowSchema>;
export type OrgActivityResponse = z.infer<typeof OrgActivityResponseSchema>;
export type OrgHeatmapResponse = z.infer<typeof OrgHeatmapResponseSchema>;
export type OrgSparklinesResponse = z.infer<typeof OrgSparklinesResponseSchema>;
export type OrgReleaseItem = z.infer<typeof OrgReleaseItemSchema>;
export type OrgFeedPagination = z.infer<typeof OrgFeedPaginationSchema>;
export type OrgReleasesFeedResponse = z.infer<typeof OrgReleasesFeedResponseSchema>;
export type OrgRecentReleaseItem = z.infer<typeof OrgRecentReleaseItemSchema>;
export type OrgRecentReleasesResponse = z.infer<typeof OrgRecentReleasesResponseSchema>;
export type DeleteOrgAccountResponse = z.infer<typeof DeleteOrgAccountResponseSchema>;

// ── Sources ──

export type SourceListItem = z.infer<typeof SourceListItemSchema>;
export type SourceWithOrg = z.infer<typeof SourceWithOrgSchema>;
export type SourceListResponse = z.infer<typeof SourceListResponseSchema>;
export type SourceListResult = z.infer<typeof SourceListResultSchema>;
export type SourcePatchInput = z.infer<typeof SourcePatchInputSchema>;
export type CreateSourceBody = z.infer<typeof CreateSourceBodySchema>;
export type ChangelogFileSummary = z.infer<typeof ChangelogFileSummarySchema>;
export type SourceChangelogResponse = z.infer<typeof SourceChangelogResponseSchema>;
export type SourceDetail = z.infer<typeof SourceDetailSchema>;
export type SourceFeedPagination = z.infer<typeof SourceFeedPaginationSchema>;
export type SourceMutationResponse = z.infer<typeof SourceMutationResponseSchema>;
export type AppStoreMaterializeResponse = z.infer<typeof AppStoreMaterializeResponseSchema>;
export type SourceOrgRef = z.infer<typeof SourceOrgRefSchema>;
export type SourceActivityResponse = z.infer<typeof SourceActivityResponseSchema>;
export type SourceHeatmapResponse = z.infer<typeof SourceHeatmapResponseSchema>;
export type SourceKnownReleaseItem = z.infer<typeof SourceKnownReleaseItemSchema>;
export type SourceKnownReleasesResponse = z.infer<typeof SourceKnownReleasesResponseSchema>;
export type SourceRecentReleasesResponse = z.infer<typeof SourceRecentReleasesResponseSchema>;
export type SourceSessionsResponse = z.infer<typeof SourceSessionsResponseSchema>;
export type SourceSummaryRow = z.infer<typeof SourceSummaryRowSchema>;
export type SourceSummariesResponse = z.infer<typeof SourceSummariesResponseSchema>;
export type CreateSourceSummaryBody = z.infer<typeof CreateSourceSummaryBodySchema>;
export type CreateSourceSummaryResponse = z.infer<typeof CreateSourceSummaryResponseSchema>;
export type SourceFetchResponse = z.infer<typeof SourceFetchResponseSchema>;
export type SourceContentHashResponse = z.infer<typeof SourceContentHashResponseSchema>;
export type SourceContentHashBody = z.infer<typeof SourceContentHashBodySchema>;
export type ChangelogTokensResponse = z.infer<typeof ChangelogTokensResponseSchema>;
export type SourceMetadataResponse = z.infer<typeof SourceMetadataResponseSchema>;
export type ChangelogProbeResponse = z.infer<typeof ChangelogProbeResponseSchema>;
export type DeleteSourceResponse = z.infer<typeof DeleteSourceResponseSchema>;
export type DeleteSourceReleasesResponse = z.infer<typeof DeleteSourceReleasesResponseSchema>;
export type InsertReleaseResponse = z.infer<typeof InsertReleaseResponseSchema>;
export type BatchReleasesResponse = z.infer<typeof BatchReleasesResponseSchema>;
export type RawSnapshotResponse = z.infer<typeof RawSnapshotResponseSchema>;
export type OversizedChangelogFileRow = z.infer<typeof OversizedChangelogFileRowSchema>;
export type OversizedChangelogFilesResponse = z.infer<typeof OversizedChangelogFilesResponseSchema>;
export type FetchableSourcesResponse = z.infer<typeof FetchableSourcesResponseSchema>;
export type FeedSourcesResponse = z.infer<typeof FeedSourcesResponseSchema>;
export type ChangedSourcesResponse = z.infer<typeof ChangedSourcesResponseSchema>;

// ── Admin telemetry: orgs rollup ──

export interface OrgsRollupRow {
  /** Org slug, or "—" for sources without an org. */
  orgSlug: string;
  sourceCount: number;
  /** Sources with no release on file or `latestDate` older than `staleDays`. */
  staleCount: number;
  /** Most-recent release across all of the org's sources, or null. */
  mostRecentRelease: string | null;
  mostRecentAgeDays: number | null;
  /** True iff every source in the org is stale (and the org has at least one source). */
  allStale: boolean;
}

export interface OrgsRollupResponse extends ListResponse<OrgsRollupRow> {
  meta: {
    /** Stale cutoff used server-side, in days. */
    staleDays: number;
    totalOrgs: number;
    /** Orgs where every source is stale. */
    dormantOrgs: number;
    /** Orgs with at least one stale source. */
    anyStaleOrgs: number;
  };
}

// ── Admin telemetry: stuck sources ──

/**
 * A source whose recent fetch history is all errors with no reachability — a
 * candidate for pausing. "Stuck" means: within the last `window` non-`dry_run`
 * fetch attempts, every one was an `error` (zero `success`/`no_change`) and
 * there were at least `minAttempts` of them.
 *
 * This keys off the `fetch_log` error streak rather than
 * `sources.consecutive_errors`, because the scrape/agent fetch path never bumps
 * that column (a source can fail for days with `consecutive_errors = 0`).
 */
export interface StuckSource {
  sourceId: string;
  sourceSlug: string;
  name: string;
  type: SourceType;
  url: string;
  kind: string | null;
  orgSlug: string | null;
  orgName: string | null;
  /** Current fetch tier — `paused` rows only appear when `includePaused`. */
  fetchPriority: SourceFetchPriority;
  /** True when this is the org's primary changelog (Firebase's was). */
  isPrimary: boolean;
  isHidden: boolean;
  /** Non-`dry_run` attempts examined in the window (all errors when stuck). */
  recentAttempts: number;
  /**
   * Failed or degraded attempts (`error`, `crawl_timeout`, `blocked`) among the
   * examined attempts (equals `recentAttempts` when stuck).
   */
  recentErrors: number;
  /** Most-recent fetch attempt timestamp (ISO), or null. */
  lastAttemptAt: string | null;
  /** Most-recent error message. */
  lastError: string | null;
  /** Most-recent error category, when the fetcher classified it. */
  lastErrorCategory: string | null;
  /** Last time the source was reachable (`success`/`no_change`), ISO; null = never. */
  lastSuccessAt: string | null;
  /** `sources.last_fetched_at` — null when the source has never fetched. */
  lastFetchedAt: string | null;
  /** When the source row was created (ISO) — proxy for how long it's failed. */
  sourceCreatedAt: string | null;
}

export interface StuckSourcesResponse extends ListResponse<StuckSource> {
  meta: {
    /** Recent non-`dry_run` attempts examined per source. */
    window: number;
    /** Minimum attempts in the window required to flag a source. */
    minAttempts: number;
    /** Whether already-paused sources were included. */
    includePaused: boolean;
  };
}

// ── Releases ──

/**
 * Release type — mirrors `RELEASE_TYPES` in `@buildinternet/releases-core/schema`.
 * Optional on the wire so older API responses (mid-deploy or pinned old workers)
 * degrade gracefully — consumers that see `undefined` should treat it as `"feature"`.
 */
export type ReleaseType = z.infer<typeof ReleaseTypeSchema>;

export type ReleaseItem = z.infer<typeof ReleaseItemSchema>;
export type ReleaseComposition = z.infer<typeof ReleaseCompositionSchema>;

/**
 * One entry in a {@link WhatsChangedResponse} — a release in the requested
 * upgrade range; a slim, release-derived projection. `breaking`/`migrationNotes`
 * come from #1696 (`"unknown"` until classified or for non-dev-facing kinds).
 */
export interface WhatsChangedEntry {
  version: string | null;
  publishedAt: string | null;
  /** AI-generated title when present, else the raw release title. */
  title: string | null;
  summary: string | null;
  breaking: BreakingLevel;
  migrationNotes: string | null;
  url: string | null;
}

/**
 * Response of `GET /v1/whats-changed` (#1697, upgrade intelligence Phase 1) —
 * the changelog entries in the half-open version range `(from, to]` for a
 * package (`from` exclusive, `to` inclusive). `status: "unknown"` (still
 * HTTP 200 — a valid answer, not an error) when the package can't be resolved
 * read-only from the catalog (e.g. an npm/PyPI name absent until #1345).
 * `entries` are ordered oldest→newest; a range wider than the token budget is
 * truncated (newest entries kept), flagged by `truncated` + `truncatedAtTokens`.
 */
export interface WhatsChangedResponse {
  status: "resolved" | "unknown";
  package: string;
  ecosystem: "npm" | "pypi" | "github" | null;
  from: string;
  to: string;
  source: { sourceId: string; sourceSlug: string; orgSlug: string } | null;
  entries: WhatsChangedEntry[];
  count: number;
  truncated: boolean;
  truncatedAtTokens?: number;
}

export interface ReleaseDetail {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  /** AI-generated summary (#852, renamed in #860). Nullable — most rows unpopulated. */
  summary: string | null;
  /**
   * AI-generated self-contained news-headline form of the release (#852,
   * renamed in #860). Nullable because most rows are unpopulated — fall
   * back to `title` for display. `.optional()` for the same mid-deploy /
   * pinned-worker reason as `type` on {@link ReleaseItem}.
   */
  titleGenerated?: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). Same fallback as `titleGenerated`. */
  titleShort?: string | null;
  /**
   * Machine-readable breaking-change level (#1696). `.optional()` for mid-deploy
   * / pinned-worker tolerance; absent or `"unknown"` means not classified (the
   * fail-open default). Populated live at ingest for developer-facing source
   * kinds; history is `"unknown"` pending a backfill. Route population + the web
   * chip are #1696 follow-ups.
   */
  breaking?: BreakingLevel;
  /** Explicit upgrade/migration steps lifted from the body (#1696); null when the body gives none. */
  migrationNotes?: string | null;
  url: string | null;
  media: MediaItem[];
  publishedAt: string | null;
  fetchedAt: string;
  sourceName: string;
  sourceSlug: string;
  sourceType: string;
  /**
   * Owning org. `avatarUrl` is the resolved `organizations.avatar_url`
   * (nullable; `.optional()` for mid-deploy / pinned-worker tolerance).
   * `discovery` and `isHidden` are additive — older servers omit them.
   */
  org: {
    slug: string;
    name: string;
    avatarUrl?: string | null;
    /** How the org was created. Additive — older servers omit it. */
    discovery?: "curated" | "agent" | "on_demand";
    /** Whether the org is hidden from public listings. Additive — older servers omit it. */
    isHidden?: boolean;
  } | null;
  /**
   * Owning product, when the source is grouped under one (`sources.product_id`).
   * `null` when ungrouped; `.optional()` so older servers that omit it still type.
   */
  product?: { slug: string; name: string } | null;
  /** Release type. See {@link ReleaseType}. */
  type?: ReleaseType;
  /** Per-category item counts from the AI release-content pass. See {@link ReleaseComposition}. */
  composition?: ReleaseComposition | null;
  /** App Store platform + icon, present only when `sourceType === "appstore"`. */
  appStore?: { platform: "ios" | "macos"; iconUrl: string | null } | null;
  /** Video provider tag, present only when `sourceType === "video"`. */
  video?: { provider: "youtube" | "vimeo" | "wistia" } | null;
  /**
   * Whether the release's source is hidden from public listings. Additive —
   * older servers omit it; treat `undefined` as `false`.
   */
  sourceIsHidden?: boolean;
}

export type ReleaseCoverageSibling = z.infer<typeof ReleaseCoverageSiblingSchema>;
export type ReleaseCoverageRow = z.infer<typeof ReleaseCoverageRowSchema>;
export type ReleaseCoverageResponse = z.infer<typeof ReleaseCoverageResponseSchema>;
export type LinkReleaseCoverageBody = z.infer<typeof LinkReleaseCoverageBodySchema>;
export type LinkReleaseCoverageResponse = z.infer<typeof LinkReleaseCoverageResponseSchema>;
export type UnlinkReleaseCoverageResponse = z.infer<typeof UnlinkReleaseCoverageResponseSchema>;

export type ReleaseLatestSource = z.infer<typeof ReleaseLatestSourceSchema>;
export type ReleaseLatestProduct = z.infer<typeof ReleaseLatestProductSchema>;
export type ReleaseLatestItem = z.infer<typeof ReleaseLatestItemSchema>;
export type ReleaseLatestResponse = z.infer<typeof ReleaseLatestResponseSchema>;

export type ReleaseWithMediaRow = z.infer<typeof ReleaseWithMediaRowSchema>;
export type ReleasesWithMediaResponse = z.infer<typeof ReleasesWithMediaResponseSchema>;

export type ReleaseDetailOrg = z.infer<typeof ReleaseDetailOrgSchema>;
export type ReleaseDetailResponse = z.infer<typeof ReleaseDetailResponseSchema>;
export type UpdateReleaseBody = z.infer<typeof UpdateReleaseBodySchema>;
export type ReleasePatchResponse = z.infer<typeof ReleasePatchResponseSchema>;
export type ReleaseDeleteResponse = z.infer<typeof ReleaseDeleteResponseSchema>;
export type ReleaseBatchDeleteBody = z.infer<typeof ReleaseBatchDeleteBodySchema>;
export type ReleaseBatchDeleteResponse = z.infer<typeof ReleaseBatchDeleteResponseSchema>;
export type ReleaseSuppressResponse = z.infer<typeof ReleaseSuppressResponseSchema>;
export type ReleaseUnsuppressResponse = z.infer<typeof ReleaseUnsuppressResponseSchema>;
export type ReleaseSuppressBody = z.infer<typeof ReleaseSuppressBodySchema>;
export type ReleaseBatchSuppressBody = z.infer<typeof ReleaseBatchSuppressBodySchema>;
export type ReleaseBatchSuppressResponse = z.infer<typeof ReleaseBatchSuppressResponseSchema>;
export type ReleaseStreamMessage = z.infer<typeof ReleaseStreamMessageSchema>;

export type ReleaseSummaryItem = z.infer<typeof ReleaseSummaryItemSchema>;

// ── Follows ──

/** What a user can follow. */
export type FollowTarget = "org" | "product";

/** A user's follow, enriched for rendering (returned by GET /v1/me/follows). */
export interface Follow {
  targetType: FollowTarget;
  targetId: string;
  name: string;
  slug: string;
  avatarUrl: string | null;
  /** Owning org slug for product follows (null for org follows). */
  orgSlug: string | null;
  createdAt: string;
}

/** GET /v1/me/follows response. */
export interface FollowsListResponse {
  follows: Follow[];
}

/** POST /v1/me/follows request body. */
export interface FollowRequest {
  targetType: FollowTarget;
  targetId: string;
}

/** POST/DELETE /v1/me/follows response. */
export interface FollowMutationResponse {
  success: true;
  following: boolean;
}

/**
 * A user's personalized feed token, including the full re-revealable feed URL.
 * The token is reversible (stored recoverably) because the feed serves only
 * public release data and carries no PII — so the URL can be re-displayed and
 * copied on any visit (see #1519 design, decision 6). One per user.
 */
export interface FeedToken {
  /** Absolute, tokenized Atom URL — e.g. https://api.releases.sh/v1/feed/relf_…_….atom */
  feedUrl: string;
  /** Non-secret public handle (for masked display). */
  lookupId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** `GET /v1/me/feed/token` — the token, or null if the user has none yet. */
export interface FeedTokenResponse {
  token: FeedToken | null;
}

/** Cursor pagination shape for GET /v1/me/feed (same as other release feeds). */
export type PersonalizedFeedPagination = OrgFeedPagination;

/**
 * GET /v1/me/feed response — the personalized release feed. Reuses the same item
 * shape as /v1/releases/latest (ReleaseLatestItem); cursor-paginated like other
 * feed-shaped surfaces.
 */
export interface PersonalizedFeedResponse {
  items: ReleaseLatestItem[];
  pagination: PersonalizedFeedPagination;
}

// ── User webhooks ──

/** High-level delivery posture derived from summary columns (no AE query). */
export type WebhookDeliveryHealth =
  | "never_delivered"
  | "healthy"
  | "degraded"
  | "failing"
  | "paused"
  | "auto_paused";

/** Self-serve webhook filter scope. */
export type UserWebhookScope = "org" | "follows";

/** Optional per-event filter on release taxonomy type. */
export type UserWebhookReleaseTypeFilter = "feature" | "rollup";

/** Webhook delivery output format. */
export type UserWebhookFormat = "json" | "slack";

/** A user-owned webhook subscription row (no signing secret). */
export interface UserWebhookSubscription {
  id: string;
  userId: string;
  scope: UserWebhookScope;
  orgId: string | null;
  url: string;
  sourceId: string | null;
  productId: string | null;
  releaseType: UserWebhookReleaseTypeFilter | null;
  format: UserWebhookFormat;
  enabled: boolean;
  description: string | null;
  secretVersion: number;
  createdAt: string;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorMsg: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  failureStreakStartedAt: string | null;
}

/** Delivery health fields returned on user webhook read paths. */
export interface UserWebhookDeliveryHealth {
  deliveryHealth: WebhookDeliveryHealth;
  deliveryHealthSummary: string;
}

/** List item returned by GET /v1/me/webhooks — includes org/source display fields. */
export interface UserWebhookListItem
  extends Omit<UserWebhookSubscription, "userId">, UserWebhookDeliveryHealth {
  orgSlug: string | null;
  orgName: string | null;
  sourceSlug: string | null;
  sourceName: string | null;
  productSlug: string | null;
  productName: string | null;
}

/** GET /v1/me/webhooks response. */
export interface UserWebhookListResponse {
  subscriptions: UserWebhookListItem[];
}

/** POST /v1/me/webhooks response — signing key shown once at creation (omitted for slack format). */
export interface CreateUserWebhookResponse
  extends UserWebhookSubscription, UserWebhookDeliveryHealth {
  orgSlug: string | null;
  orgName: string | null;
  signingKey?: string;
}

/** POST /v1/me/webhooks/:id/rotate-secret response. */
export interface RotateUserWebhookSecretResponse {
  secretVersion: number;
  signingKey: string;
}

/** POST /v1/me/webhooks/:id/test response. */
export interface TestUserWebhookResponse {
  enqueued: true;
  eventId: string;
}

// ── Digest emails ──

/** How often a user wants a digest email. `off` = no emails. */
export type DigestCadence = "off" | "daily" | "weekly";

/** GET /v1/me/digest response — the caller's current cadence. */
export interface DigestPrefsResponse {
  cadence: DigestCadence;
}

/** PUT /v1/me/digest request body. */
export interface DigestPrefsRequest {
  cadence: DigestCadence;
}

// ── Search ──

export type SearchOrgHit = z.infer<typeof SearchOrgHitSchema>;
export type SearchCatalogHit = z.infer<typeof SearchCatalogHitSchema>;

export type SearchSourceHit = z.infer<typeof SearchSourceHitSchema>;

export interface RawSourceHit extends SearchSourceHit {
  productName?: string;
  productCategory?: string;
  /** Owning org's avatar URL — folded onto the catalog hit for the byline avatar. */
  orgAvatarUrl?: string | null;
  /** Entity taxonomy kind from the `sources.kind` column. */
  entityKind?: string | null;
}

/**
 * Fold source hits into the catalog list. Sources under a matched product
 * are dropped (product wins); orphan sources become `entryType: "source"`.
 */
export function foldSourcesIntoCatalog(
  existingProducts: SearchCatalogHit[],
  rawSources: RawSourceHit[],
): SearchCatalogHit[] {
  const result: SearchCatalogHit[] = existingProducts.map((p) => ({
    ...p,
    entryType: "product" as const,
  }));
  const seen = new Set(result.map((p) => p.slug));
  for (const s of rawSources) {
    if (s.productSlug) {
      if (seen.has(s.productSlug)) continue;
      result.push({
        slug: s.productSlug,
        name: s.productName ?? s.name,
        orgSlug: s.orgSlug,
        orgName: s.orgName,
        orgAvatarUrl: s.orgAvatarUrl ?? null,
        category: s.productCategory ?? null,
        entryType: "product",
        kind: undefined,
      });
      seen.add(s.productSlug);
    } else {
      result.push({
        slug: s.slug,
        name: s.name,
        orgSlug: s.orgSlug,
        orgName: s.orgName,
        orgAvatarUrl: s.orgAvatarUrl ?? null,
        category: null,
        entryType: "source",
        kind: (s.entityKind as SearchCatalogHit["kind"]) ?? undefined,
        sourceSlug: s.slug,
        sourceType: s.type,
      });
    }
  }
  return result;
}

export type SearchReleaseHit = z.infer<typeof SearchReleaseHitSchema>;
export type SearchChunkHit = z.infer<typeof SearchChunkHitSchema>;
export type SearchCollectionHit = z.infer<typeof SearchCollectionHitSchema>;

/**
 * Merge collection hits from three independent sources into one ordered,
 * deduped array on the wire:
 *
 *   1. Direct lexical matches   — name/slug/description LIKE.
 *   2. Direct semantic matches  — vector hit (hybrid/semantic only).
 *   3. Member rollups           — collections containing one of the result orgs.
 *
 * A direct row always wins for a given slug; member rollups attach their
 * `matchedOrgSlugs` to a winning direct row so the UI keeps the "shown
 * because" affordance. Within each `via` bucket, rows order by score desc
 * (missing scores last) then by name.
 *
 * Pure: no DB, no Workers runtime. Used by both `/v1/search` and the MCP
 * `search` tool so the merge stays in lockstep across surfaces.
 */
export function mergeCollectionHits(
  direct: SearchCollectionHit[],
  semantic: SearchCollectionHit[],
  member: SearchCollectionHit[],
  limit: number,
): SearchCollectionHit[] {
  // Pure: never mutate caller-owned objects. Always replace map entries with
  // shallow copies so two callers (e.g. API and MCP merging from the same
  // upstream list) can't see each other's writes.
  const bySlug = new Map<string, SearchCollectionHit>();
  for (const c of direct) bySlug.set(c.slug, { ...c });
  for (const c of semantic) {
    const existing = bySlug.get(c.slug);
    if (existing) {
      if (c.score !== undefined && (existing.score === undefined || c.score > existing.score)) {
        bySlug.set(c.slug, { ...existing, score: c.score });
      }
    } else {
      bySlug.set(c.slug, { ...c });
    }
  }
  for (const c of member) {
    const existing = bySlug.get(c.slug);
    if (existing) {
      bySlug.set(c.slug, { ...existing, matchedOrgSlugs: c.matchedOrgSlugs });
    } else {
      bySlug.set(c.slug, { ...c });
    }
  }
  return [...bySlug.values()]
    .toSorted((a, b) => {
      if (a.via !== b.via) return a.via === "direct" ? -1 : 1;
      const sa = a.score ?? -Infinity;
      const sb = b.score ?? -Infinity;
      if (sa !== sb) return sb - sa;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

// ── Lookups ──

export type LookupStatus = z.infer<typeof LookupStatusSchema>;
export type LookupBody = z.infer<typeof LookupBodySchema>;
export type LookupSourceRow = z.infer<typeof LookupSourceSchema>;
export type LookupReleaseRow = z.infer<typeof LookupReleaseSchema>;
export type LookupRelatedOrg = z.infer<typeof LookupRelatedOrgSchema>;
export type LookupResponse = z.infer<typeof LookupResponseSchema>;
export type LookupSourceBySlugResponse = z.infer<typeof LookupSourceBySlugResponseSchema>;
export type LookupProductBySlugResponse = z.infer<typeof LookupProductBySlugResponseSchema>;
export type DomainLookupOrg = z.infer<typeof DomainLookupOrgSchema>;
export type DomainLookupProduct = z.infer<typeof DomainLookupProductSchema>;
export type DomainLookupResponse = z.infer<typeof DomainLookupResponseSchema>;

// Slim wire payload embedded in a search response when the query is a GitHub
// coordinate. `LookupResultPayload` is the search-embedded slim variant;
// `LookupResponse` (above) is the thicker payload returned by POST /v1/lookups.
export type LookupResultPayload = z.infer<typeof LookupResultPayloadSchema>;
export type UnifiedSearchResponse = z.infer<typeof UnifiedSearchResponseSchema>;

// ── Overview Pages ──

export type OverviewPageItem = z.infer<typeof OverviewPageItemSchema>;
export type OverviewCitation = z.infer<typeof OverviewCitationSchema>;

/** @deprecated Use OverviewPageItem */
export type KnowledgePageItem = OverviewPageItem;

export type OrgOverviewResponse = z.infer<typeof OrgOverviewResponseSchema>;
export type IncomingOverviewCitation = z.infer<typeof IncomingOverviewCitationSchema>;
export type RegenerateOverviewBody = z.infer<typeof RegenerateOverviewBodySchema>;
export type RegenerateOverviewResponse = z.infer<typeof RegenerateOverviewResponseSchema>;
export type ProductOverviewResponse = z.infer<typeof ProductOverviewResponseSchema>;
export type OverviewInputsCheckResponse = z.infer<typeof OverviewInputsCheckResponseSchema>;
export type OverviewInputsFullResponse = z.infer<typeof OverviewInputsFullResponseSchema>;
export type OverviewInputsResponse = z.infer<typeof OverviewInputsResponseSchema>;
export type PlaybookResponse = z.infer<typeof PlaybookResponseSchema>;
export type UpdatePlaybookNotesBody = z.infer<typeof UpdatePlaybookNotesBodySchema>;
export type UpdatePlaybookNotesResponse = z.infer<typeof UpdatePlaybookNotesResponseSchema>;

// ── Overview Manifest (admin planning) ──

export type OverviewStaleness = "missing" | "behind" | "fresh";
export type OverviewPlanAction = "missing" | "refresh" | "skip";

/**
 * Per-org row returned by GET /v1/admin/overviews. Designed for orchestrators
 * planning a maintenance sweep — `releasesSinceOverview` is the freshness
 * signal that matters, not date diff alone.
 */
export interface OverviewManifestRow {
  orgSlug: string;
  orgName: string;
  orgCreatedAt: string;
  discovery: "curated" | "agent" | "on_demand";
  overviewUpdatedAt: string | null;
  overviewGeneratedAt: string | null;
  lastContributingReleaseAt: string | null;
  orgLastActivity: string | null;
  releasesSinceOverview: number;
  recentReleaseCount: number;
  staleness: OverviewStaleness;
  /** Only populated when ?format=plan. */
  action?: OverviewPlanAction;
  /** Only populated when ?format=plan. */
  needsFetch?: boolean;
}

export type OverviewManifestResponse = ListResponse<OverviewManifestRow>;

// ── Overview inputs (?check=true) ──

/**
 * Lightweight pre-flight payload returned by GET /v1/orgs/:slug/overview/inputs?check=true.
 * Skips the heavy release-content hydration so an orchestrator can decide whether
 * to dispatch without paying for the full payload.
 */
export interface OverviewInputsCheck {
  orgSlug: string;
  selected: number;
  totalAvailable: number;
  hasExistingContent: boolean;
  wouldRegenerate: boolean;
  windowDays: number;
}

/** @deprecated Use UnifiedSearchResponse */
export type SearchResult = SearchReleaseHit;
/** @deprecated Use UnifiedSearchResponse */
export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

// ── Activity ──

export interface WeeklyBucket {
  weekStart: string;
  count: number;
  earliestVersion: string | null;
  latestVersion: string | null;
}

/**
 * @deprecated Use SourceActivityResponse (Zod-derived).
 * The hand-written interface is kept for callsite compatibility — shape is identical.
 */
export type SourceActivity = SourceActivityResponse;

// ── Org Activity (Zod-derived aliases) ──
// The old hand-written OrgActivitySource / OrgActivity / OrgSparklines /
// OrgHeatmap / OrgReleaseItem interfaces have been
// replaced by Zod-derived types in the Organizations section above. Keeping
// the interface names as deprecated aliases so callsites don't need an
// immediate churn.

/** @deprecated Use OrgActivityResponse */
export type OrgActivity = OrgActivityResponse;

/** @deprecated Use OrgSparklinesResponse */
export type OrgSparklines = OrgSparklinesResponse;

/** @deprecated Use OrgHeatmapResponse */
export type OrgHeatmap = OrgHeatmapResponse;

// ── Org Sparklines (per-source/product breakdown) ──
// (covered above)

// ── Source Heatmap ──
// (covered by SourceHeatmapResponse above)

/**
 * @deprecated Use SourceHeatmapResponse (Zod-derived).
 * The hand-written interface is kept for callsite compatibility — shape is identical.
 */
export type SourceHeatmap = SourceHeatmapResponse;

// ── Org Releases ──
// (covered by OrgReleaseItem / OrgReleasesFeedResponse above)

// Source-scoped release feed — the source identity is encoded in the URL, so
// items omit the redundant `source` block carried by the org feed.
export interface SourceReleasesResponse {
  releases: ReleaseItem[];
  pagination: { nextCursor: string | null; limit: number };
}

// ── Products ──

// `Category` lives in @buildinternet/releases-core/categories — import it from
// there. CategorySchema is re-exported here for OpenAPI / Zod consumers only.
export type ProductRow = z.infer<typeof ProductRowSchema>;
export type ProductCreateResponse = z.infer<typeof ProductCreateResponseSchema>;
export type ProductListItem = z.infer<typeof ProductListItemSchema>;
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;
export type ProductDetailSource = z.infer<typeof ProductDetailSourceSchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;
export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;
export type AdoptProductBody = z.infer<typeof AdoptProductBodySchema>;
export type ProductAdoptResult = z.infer<typeof ProductAdoptResultSchema>;
export type ProductAdoptDryRun = z.infer<typeof ProductAdoptDryRunSchema>;
export type ProductAdoptResponse = z.infer<typeof ProductAdoptResponseSchema>;
export type ProductDeleteResponse = z.infer<typeof ProductDeleteResponseSchema>;
export type ProductTagsListResponse = z.infer<typeof ProductTagsListResponseSchema>;
export type ProductTagsBody = z.infer<typeof ProductTagsBodySchema>;
export type ProductTagsMutationResponse = z.infer<typeof ProductTagsMutationResponseSchema>;
export type ProductActivityResponse = z.infer<typeof ProductActivityResponseSchema>;
export type ProductHeatmapResponse = z.infer<typeof ProductHeatmapResponseSchema>;

// ── Taxonomy (categories + tags) ──

export type TaxonomyOrg = z.infer<typeof TaxonomyOrgSchema>;
export type TaxonomyProduct = z.infer<typeof TaxonomyProductSchema>;
export type CategoryDetail = z.infer<typeof CategoryDetailSchema>;
export type CategoryListItem = z.infer<typeof CategoryListItemSchema>;
export type CategoryListResponse = z.infer<typeof CategoryListResponseSchema>;
export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequestSchema>;
export type UpdateCategoryResponse = z.infer<typeof UpdateCategoryResponseSchema>;
export type CategoryFeedPagination = z.infer<typeof CategoryFeedPaginationSchema>;
export type CategoryReleasesResponse = z.infer<typeof CategoryReleasesResponseSchema>;
export type TagDetail = z.infer<typeof TagDetailSchema>;

/**
 * Aggregated release feed row for a category rollup — same wire shape as
 * `CollectionReleaseItem` (both surfaces use `formatAggregateReleaseRow` in
 * `workers/api/src/utils.ts`). Aliased rather than duplicated so renderers
 * can treat them as one.
 */
export type CategoryReleaseItem = CollectionReleaseItem;

// ── Collections ──
//
// Curated, named groups of orgs that drive a public "playlist" page (e.g.
// /collections/frontier-ai-labs). Independent of the fixed `category` taxonomy.

export type CollectionMemberOrg = z.infer<typeof CollectionMemberOrgSchema>;
export type ProductParentOrg = z.infer<typeof ProductParentOrgSchema>;
export type CollectionMemberProduct = z.infer<typeof CollectionMemberProductSchema>;
export type CollectionMember = z.infer<typeof CollectionMemberSchema>;
export type CollectionListItem = z.infer<typeof CollectionListItemSchema>;
export type CollectionListResponse = z.infer<typeof CollectionListResponseSchema>;
export type CollectionDetail = z.infer<typeof CollectionDetailSchema>;
export type CollectionReleaseItem = z.infer<typeof CollectionReleaseItemSchema>;
export type CollectionFeedPagination = z.infer<typeof CollectionFeedPaginationSchema>;
export type CollectionReleasesResponse = z.infer<typeof CollectionReleasesResponseSchema>;
export type CollectionRow = z.infer<typeof CollectionRowSchema>;
export type CreateCollectionRequest = z.infer<typeof CreateCollectionRequestSchema>;
export type UpdateCollectionRequest = z.infer<typeof UpdateCollectionRequestSchema>;
export type CollectionMemberInput = z.infer<typeof CollectionMemberInputSchema>;
export type AddCollectionMemberRequest = z.infer<typeof AddCollectionMemberRequestSchema>;
export type ReplaceCollectionMembersRequest = z.infer<typeof ReplaceCollectionMembersRequestSchema>;
export type ResolvedCollectionMember = z.infer<typeof ResolvedCollectionMemberSchema>;
export type ReplaceCollectionMembersResponse = z.infer<
  typeof ReplaceCollectionMembersResponseSchema
>;
export type AddCollectionMemberResponse = z.infer<typeof AddCollectionMemberResponseSchema>;
export type CollectionDailySummary = z.infer<typeof CollectionDailySummarySchema>;
export type CollectionDailySummariesResponse = z.infer<
  typeof CollectionDailySummariesResponseSchema
>;

// ── Releases (enriched) ──

/** Flat release shape returned by GET /v1/releases/:id with source metadata. */
export interface ReleaseWithSource {
  id: string;
  sourceId: string;
  version: string | null;
  title: string;
  content: string;
  /** AI-generated summary (#852, renamed in #860). Nullable — most rows unpopulated. */
  summary: string | null;
  /** AI-generated headline (#852, renamed in #860). See {@link ReleaseDetail.titleGenerated}. */
  titleGenerated?: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). */
  titleShort?: string | null;
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

export interface LatestRelease {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  sourceName: string;
  sourceSlug: string;
  /**
   * Source type (`github`/`scrape`/`feed`/`agent`/`appstore`/`video`). Lets the
   * live feed render the source-type icon for a freshly-arrived event. Additive —
   * older buffered events / pinned workers omit it.
   */
  sourceType?: string;
  /**
   * Owning-org context, resolved at publish time so the live feed can render an
   * avatar + org name the instant an event arrives. Nested to match
   * {@link ReleaseDetail.org} and the build-event input. Additive/nullable:
   * absent for orphan sources or older buffered events. Avatar fallback chain:
   * `avatarUrl` → `github.com/<githubHandle>.png` → an initial.
   */
  org?: {
    slug: string;
    name: string;
    avatarUrl: string | null;
    githubHandle: string | null;
  } | null;
  /** AI-generated summary (#852, renamed in #860). Nullable — most rows unpopulated. */
  summary: string | null;
  /** AI-generated headline (#852, renamed in #860). See {@link ReleaseDetail.titleGenerated}. */
  titleGenerated?: string | null;
  /** AI-generated smart-brevity headline (#852, renamed in #860). */
  titleShort?: string | null;
  media: MediaItem[];
  /**
   * Cached release-body size — `LENGTH(content)` and `countTokensSafe(content)`
   * snapshotted at ingest, so clients can advertise "this release is ~1.5K
   * tokens" without round-tripping the body. Both fields are optional and
   * nullable: pre-existing rows land null until the backfill script
   * populates them. See #958.
   */
  contentChars?: number | null;
  contentTokens?: number | null;
  /**
   * Owning product, when the release's source is grouped under a product.
   * `null` / `undefined` when the source has no `product_id`. Additive — older
   * API responses omit this field; treat `undefined` as `null`. #1217.
   */
  product?: { slug: string; name: string } | null;
}

// ── Stats ──
//
// `Stats` (flat counts) lives near the top of this file alongside the other
// shared schema-derived aliases. The richer summary shape is the combined
// hybrid response served at `GET /v1/stats` — flat counts plus per-source
// rollups.

export type StatsSourceActivity = z.infer<typeof StatsSourceActivitySchema>;
export type StatsRecentActivity = z.infer<typeof StatsRecentActivitySchema>;
export type StatsResponse = z.infer<typeof StatsResponseSchema>;
/**
 * The richer subset of the `GET /v1/stats` response — period + totals +
 * sourceHealth + sourceActivity + recentActivity. The full wire shape
 * (`StatsResponse`) merges these fields with the flat back-compat `Stats`
 * counts.
 */
export type StatsSummary = Omit<StatsResponse, "orgs" | "sources" | "releases" | "products">;

// ── Feedback ──
export type FeedbackType = z.infer<typeof FeedbackTypeSchema>;
export type FeedbackStatus = z.infer<typeof FeedbackStatusSchema>;
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;
export type FeedbackListResponse = z.infer<typeof FeedbackListResponseSchema>;
export type FeedbackUpdateBody = z.infer<typeof FeedbackUpdateBodySchema>;
export type FeedbackDeleteResponse = z.infer<typeof FeedbackDeleteResponseSchema>;

// ── Fetch log ──

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

/**
 * The managed-agent session currently fetching a source, surfaced read-side on
 * the fetch-log view so an operator/agent can tell "a fetch is in flight" from
 * "stuck/dead" without waiting for a terminal `fetch_log` row (#1360). Only
 * running, non-stale sessions are reported (the StatusHub DO drops sessions idle
 * past its staleness cutoff), so the presence of this object means a fetch is
 * live; `startedAt` says how long it has been running.
 */
export interface ActiveFetchSession {
  sessionId: string;
  /** Always `running` today — only running sessions are surfaced. */
  status: string;
  /** Session start, epoch ms. */
  startedAt: number;
  /** Last session activity, epoch ms. */
  lastUpdatedAt: number;
}

// ── Usage ──

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

// ── Sessions ──

/**
 * Where the session error originated.
 * - `provider`: managed-agents service / Anthropic-side (e.g. unknown_error, model_overloaded, retries_exhausted)
 * - `us`: this codebase / our agent setup (e.g. parser failure, no tools called, timeout)
 */
export type SessionErrorSource = "provider" | "us";

export interface Session {
  sessionId: string;
  company: string;
  type: "onboard" | "update";
  /**
   * Sub-agent **role** label that ran this session — `"coordinator"` is the
   * parent orchestrator (typically Sonnet) when a multi-agent session
   * delegates, `"sonnet"` / `"haiku"` are direct single-agent runs.
   * Surfaces on the detail GET.
   *
   * This is a logical role label, not the runtime model identifier. The
   * resolved Anthropic model string (e.g. `claude-sonnet-4-6`,
   * `claude-haiku-4-5`) lives on `usage.model` when the session reported
   * one — consult that field for the concrete model.
   */
  agent?: "sonnet" | "haiku" | "coordinator";
  /** Identifies the client that started this session (e.g. hostname). */
  runner?: string;
  /** Correlation ID for end-to-end tracing across CLI → API → managed agent. */
  correlationId?: string;
  /** Anthropic session ID for linking to console logs. */
  anthropicSessionId?: string;
  status: "running" | "complete" | "error" | "cancelled";
  step?: string;
  sourcesFound?: number;
  sourcesValidated?: number;
  totalSources?: number;
  sourcesFetched?: number;
  releasesFound?: number;
  releasesInserted?: number;
  currentAction?: string;
  startedAt: number;
  lastUpdatedAt: number;
  error?: string;
  /** Where the error originated. Absent on legacy sessions; treat as `"us"`. */
  errorSource?: SessionErrorSource;
  /** Provider error type (e.g. `unknown_error`, `model_overloaded_error`). */
  errorType?: string;
  /** Stop reason from the final `session.status_idle` event (e.g. `retries_exhausted`). */
  stopReason?: string;
  /** Number of provider `session.error` events observed before terminal. */
  retryCount?: number;
  /** Non-fatal warnings collected during the session. */
  warnings?: string[];
  /**
   * Token usage + estimated cost from the managed-agents session. `estimatedUsd`
   * is a snapshot of Anthropic list prices at session-completion time.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    model?: string;
    estimatedUsd?: number;
  };
  /**
   * Final agent-reported state for terminal `onboard` sessions — the JSON
   * blob the agent passed to its `releases_report_state` tool, plus an
   * `agentSessionId` field stitched in server-side. Empty on `update`
   * sessions and pre-report errors. Typed as `Record<string, unknown>`
   * because the shape is owned by the discovery system prompt and may
   * grow new fields without a wire bump; the keys produced today are:
   *
   * - `product` (`string`) — company name
   * - `domain` (`string | null`) — discovered domain
   * - `githubOrg` (`string | null`) — discovered GitHub org
   * - `startedAt`, `updatedAt` (ISO strings)
   * - `status` (e.g. `"awaiting_review"`)
   * - `sources` (`Array<{ url, type, slug, label, confidence,
   *   validated, validationError?, releaseCount, releasesFetched,
   *   fetched, contentDepth }>`)
   * - `agentSessionId` (`string`) — Anthropic session ID, useful for
   *   cross-referencing console logs
   */
  result?: Record<string, unknown>;
  activeSources?: string[];
  cancelRequested?: boolean;
}

export type SessionListResponse = ListResponse<Session>;

// ── Admin URL Lists ──
// `IgnoredUrlItem` is now the Zod-derived type exported in the Organizations
// section. The hand-written interface below is removed to avoid a duplicate
// identifier; callsites that imported it from here continue to work because
// the Zod-derived alias has the same shape.

export interface BlockedUrlItem {
  id: string;
  pattern: string;
  type: "exact" | "domain";
  reason: string | null;
  createdAt: string;
}

export type IgnoredUrlListResponse = ListResponse<IgnoredUrlItem>;
export type BlockedUrlListResponse = ListResponse<BlockedUrlItem>;

// ── Embed (admin) ──

export interface EmbedBackfillResponse {
  processed: number;
  succeeded: number;
  failed: number;
  remaining: number;
  dryRun?: boolean;
}

/**
 * Cascade-scope preview returned by `GET /v1/admin/orgs/:slug/dependents`.
 * Backs the confirmation prompt in CLI/web before a hard-delete on an org —
 * post-#690 Phase C, hard-deleting an org cascades into every source row
 * tied to it and every per-source dependent table listed below.
 */
export interface OrgDependentsResponse {
  org: { id: string; slug: string; name: string };
  counts: {
    sources: number;
    releases: number;
    fetchLog: number;
    sourceChangelogFiles: number;
    sourceChangelogChunks: number;
    releaseSummaries: number;
    mediaAssets: number;
    webhookSubscriptions: number;
  };
}

export interface EmbedStatusResponse {
  releases: { total: number; embedded: number; unembedded: number };
  entities: {
    total: number;
    embedded: number;
    unembedded: number;
    breakdown: {
      org: { total: number; embedded: number; unembedded: number };
      product: { total: number; embedded: number; unembedded: number };
      source: { total: number; embedded: number; unembedded: number };
    };
  };
  chunks: { total: number; embedded: number; unembedded: number };
}

// ── Evaluate (URL recommendation) ──

/**
 * Returned verbatim by GET /v1/evaluate. Lives in the public api-types package
 * so external consumers (CLI, third-party clients) can import the shape
 * without depending on worker-internal AI helpers.
 */
export interface EvaluationResult {
  recommendedMethod: "feed" | "github" | "markdown" | "scrape" | "crawl";
  recommendedUrl: string;
  feedUrl?: string;
  feedType?: "rss" | "atom" | "jsonfeed";
  githubRepo?: string;
  pageStructure: "single-page" | "index" | "unknown";
  alternatives: Array<{ url: string; method: string; note: string }>;
  confidence: "high" | "medium" | "low";
  provider?: string;
  notes?: string;
}

/**
 * Identity returned by `GET /v1/tokens/me` — the caller introspecting its own
 * credential. `kind: "root"` is the static break-glass key (synthetic identity,
 * no DB row); `kind: "token"` is a DB-backed `relk_` token.
 */
export interface TokenIdentity {
  kind: "root" | "token";
  /** Display label; "root" for the static key, "local-dev" when no secret is bound. */
  name: string;
  /** e.g. ["read","write"] or ["*"] for root. */
  scopes: string[];
  principalType: "internal" | "agent" | "user";
  principalId?: string | null;
  /**
   * Stable internal principal id for consumption telemetry (#1719). Same value the
   * auth middleware attaches (`relk_` row id, `relu_${keyId}`, …) — never the raw
   * secret. Returned on self-introspection so MCP can distinguish `relu_` keys.
   */
  tokenId?: string | null;
  /**
   * Owning user id for a user-scoped principal (`relu_` key) — the Better Auth
   * `apikey.referenceId`. Lets a consumer bucket all of an account's credentials
   * together. Null for the static root key and machine (`relk_`) tokens, which
   * have no owning user. Distinct from `principalId`, which carries an
   * agent/internal id for machine tokens. Used by the MCP worker to bucket
   * `relu_` keys per-account on the rate-limit account tier (#1729).
   */
  userId?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}
