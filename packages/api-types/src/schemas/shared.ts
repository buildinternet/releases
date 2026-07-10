import { z } from "zod";
import { RELEASE_TYPES } from "@buildinternet/releases-core/schema";
import { BREAKING_LEVELS } from "@buildinternet/releases-core/breaking";
import { CATEGORIES } from "@buildinternet/releases-core/categories";
import { isValidNoticeCoordinate } from "@buildinternet/releases-core/notice";
import { IMPORTANCE_MAX, IMPORTANCE_MIN } from "@buildinternet/releases-core/importance";

export const CategorySchema = z.enum(CATEGORIES);

/**
 * AI-scored release importance, 1 (housekeeping) to 5 (landmark). Scored at
 * ingest; `.nullable().optional()` — null when unscored, absent on older
 * servers/pinned workers.
 */
export const ImportanceScoreSchema = z
  .number()
  .int()
  .min(IMPORTANCE_MIN)
  .max(IMPORTANCE_MAX)
  .nullable()
  .optional();

export const MediaItemSchema = z.object({
  type: z.enum(["image", "video", "gif"]),
  url: z.string(),
  alt: z.string().optional(),
  // R2 object key (`releases/<hash>.<ext>`) for media mirrored into the
  // `released-media` bucket; read paths resolve it to a same-origin `r2Url`
  // (`resolveR2Url`). Stamped by `processMediaForR2` at ingest / manual edit and
  // part of the stored `media[]` JSON — surfaced on the wire so a curator round-
  // tripping `media` through `PATCH /v1/releases/:id` can preserve an already-
  // mirrored item without forcing a re-fetch.
  r2Key: z.string().optional(),
  r2Url: z.string().optional(),
  // For `type: "video"` items promoted from a hosted-video link found inline in
  // a release body (Wistia/Loom/Vimeo/YouTube), `url` holds the poster/thumbnail
  // (mirrored to R2 like any image) and `linkUrl` holds the human watch URL the
  // play-card links out to. Absent for ordinary image/gif media. See
  // `detectInlineVideos` in `@releases/rendering/video-embed` and web's
  // release-content video card.
  linkUrl: z.string().optional(),
});

/**
 * App Store platform + icon for a `type: "appstore"` source. Threaded onto
 * read surfaces so the UI can render the compact app-update row (app icon +
 * "Available for iOS/macOS") instead of the standard version/notes/thumbnail
 * layout. Sourced from `source.metadata.appStore` server-side. #mobile-appstore-feed-row
 */
export const AppStoreSourceInfoSchema = z.object({
  platform: z.enum(["ios", "macos"]),
  iconUrl: z.string().nullable(),
});

/** Video provider tag, present only when `sourceType === "video"`. Thumbnail
 * and watch URL reuse the release's existing `media[]` / `url`. */
export const VideoSourceInfoSchema = z.object({
  provider: z.enum(["youtube", "vimeo", "wistia"]),
});

/**
 * Org tier surfaced on read paths (#1947). `stub` = known only by declared
 * release locations (no processed sources yet); `tracked` = a normal org whose
 * sources fetch. The column is `organizations.tier`; the wire name is `status`.
 * Optional on the wire so a pinned client mid-deploy tolerates its absence —
 * treat a missing value as `"tracked"`.
 */
export const OrgStatusSchema = z.enum(["stub", "tracked"]);

/**
 * A declared release location (#1947) — one `release_locations` row on the
 * wire, the same shape a releases.json `releases[]` entry carries plus its
 * provenance `basis` and, once promoted, the `sourceId` it materialized into.
 * Surfaced on stub orgs so an agent gets "release info is published at these
 * locations" instead of an empty sources list.
 */
export const ReleaseLocationItemSchema = z.object({
  url: z.string().optional(),
  feed: z.string().optional(),
  github: z.string().optional(),
  appstore: z.string().optional(),
  file: z.string().optional(),
  title: z.string().nullable().optional(),
  canonical: z.boolean(),
  basis: z.enum(["curator", "declared", "detected", "generated"]),
  /** Owning product id when the locator is product-scoped, else null. */
  productId: z.string().nullable(),
  /** Set once the locator has been promoted into a source, else null. */
  sourceId: z.string().nullable(),
});

export const PaginationSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  returned: z.number().int().min(0),
  totalItems: z.number().int().min(0).optional(),
  totalPages: z.number().int().min(0).optional(),
  hasMore: z.boolean(),
});

export const ListResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    pagination: PaginationSchema,
  });

export const StatsSchema = z.object({
  orgs: z.number().int().min(0),
  sources: z.number().int().min(0),
  releases: z.number().int().min(0),
  products: z.number().int().min(0),
});

export const ReleaseTypeSchema = z.enum(RELEASE_TYPES);

/**
 * Per-category item counts produced by the AI release-content pass and
 * persisted on `releases.metadata.composition`. Surfaces as a chip on the
 * release detail UI ("12 fixes · 3 features"); `null` when the row hasn't
 * been through the AI pass yet, the body was empty/boilerplate, or all
 * three counts came back zero (we filter that case out on the parse side).
 */
export const ReleaseCompositionSchema = z.object({
  bugs: z.number().int().min(0),
  features: z.number().int().min(0),
  enhancements: z.number().int().min(0),
});

export const ReleaseItemSchema = z.object({
  id: z.string().optional(),
  version: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  content: z.string().optional(),
  publishedAt: z.string().nullable(),
  // ISO timestamp of when the row was fetched/inserted — used by the feed
  // cursor's tie-break (publishedAt|fetchedAt|id) so that same-`publishedAt`
  // rows stay stably ordered across paginated requests. `.optional()` because
  // not every endpoint that returns a ReleaseItem populates it (notably
  // single-release reads).
  fetchedAt: z.string().optional(),
  url: z.string().nullable(),
  media: z.array(MediaItemSchema).optional(),
  // `.optional()` — older API responses (mid-deploy or pinned old workers)
  // may omit `type`; consumers should treat `undefined` as `"feature"`.
  type: ReleaseTypeSchema.optional(),
  // Pre-release flag (alpha/beta/rc/preview/nightly). Computed at ingest —
  // GitHub uses the API's authoritative `prerelease` field; other adapters
  // fall back to a SemVer-prerelease regex. `.optional()` for the same
  // older-response degrade-gracefully reason as `type`.
  prerelease: z.boolean().optional(),
  // AI-generated headline forms paired with `summary` (#852, renamed in #860).
  // Both nullable — most rows in the DB have neither populated, and we don't
  // plan to backfill, so consumers must fall back to `title` for display.
  // `.optional()` for the same mid-deploy / pinned-worker reason as `type`.
  titleGenerated: z.string().nullable().optional(),
  titleShort: z.string().nullable().optional(),
  // Machine-readable breaking-change level (#1696, surfaced on read paths in
  // #1710). `.optional()` for mid-deploy / pinned-worker tolerance and because
  // rows predating the column omit it; absent or `"unknown"` means not
  // classified (the fail-open default). List paths carry `breaking` only —
  // `migrationNotes` stays detail-route-only to keep list payloads slim.
  breaking: z.enum(BREAKING_LEVELS).optional(),
  importance: ImportanceScoreSchema,
  // Count of demoted siblings rolling up into this row via `release_coverage`
  // (0 when standalone). Lets list views show a cluster indicator without a
  // detail-page round trip. `.optional()` — older API responses and pinned
  // workers omit the field; treat undefined as 0.
  coverageCount: z.number().int().min(0).optional(),
  // Cached `LENGTH(content)` and `countTokensSafe(content)` for the release
  // body — lets feed surfaces ("releases get <org>", `/v1/releases/latest`,
  // MCP `get_latest_releases`) advertise "this release is ~1.5K tokens" so
  // agents can decide whether to pull the full body. `.optional()` and
  // nullable because pre-existing rows landed without the columns; the
  // backfill script populates them and renderers degrade to "size unknown"
  // when null. See #958.
  contentChars: z.number().int().min(0).nullable().optional(),
  contentTokens: z.number().int().min(0).nullable().optional(),
  // Per-category item counts produced by the AI release-content pass and
  // stored on `releases.metadata.composition`. `null`/`undefined` when the
  // row hasn't been through the AI pass yet or the body was boilerplate.
  composition: ReleaseCompositionSchema.nullable().optional(),
});

export const ReleaseSummaryItemSchema = z.object({
  year: z.number().int().nullable().optional(),
  month: z.number().int().nullable().optional(),
  windowDays: z.number().int().nullable().optional(),
  summary: z.string(),
  releaseCount: z.number().int().min(0),
  generatedAt: z.string(),
});

/**
 * A source attached to an overview page (#846, reshaped #1934). Each row names
 * a source the overview drew on — `sourceUrl` plus, when it resolved to an
 * on-registry release, `releaseId` + a canonical `releaseWebUrl`. This is a
 * source *list*, not span-anchored provenance: the old body char offsets +
 * verbatim quote are removed. Optional everywhere it appears — consumers should
 * degrade gracefully.
 */
export const OverviewCitationSchema = z.object({
  sourceUrl: z.string(),
  title: z.string().nullable().optional(),
  /** Best-effort link to the on-registry release this source maps to (resolved server-side). */
  releaseId: z.string().nullable().optional(),
  /**
   * Canonical web URL of the on-registry release page for this source, when
   * `releaseId` resolved (#1934). The Sources footer links here (internal,
   * crawlable) in preference to the external `sourceUrl`.
   */
  releaseWebUrl: z.string().nullable().optional(),
  /**
   * @deprecated Body char offsets / verbatim quote — removed with span-anchored
   * citations (#1934). Kept optional for wire back-compat; no producer emits
   * them and no consumer should read them.
   */
  startIndex: z.number().int().min(0).optional(),
  endIndex: z.number().int().min(0).optional(),
  citedText: z.string().optional(),
});

/**
 * Entity notice — a small curator-set note on an org / product / source. Stored
 * under the `notice` key of the entity's metadata JSON; mirrors the `Notice`
 * type in @buildinternet/releases-core/notice. `coordinate` is an internal
 * registry path ("org" / "org/slug"); `href` is an external URL; at most one.
 */
export const NoticeSchema = z
  .object({
    message: z.string().min(1).max(280),
    linkText: z.string().min(1).max(60).optional(),
    coordinate: z.string().min(1).max(200).optional(),
    href: z.url().max(500).optional(),
  })
  .refine((n) => !(n.coordinate && n.href), {
    message: "notice may set coordinate or href, not both",
  })
  .refine((n) => !n.coordinate || isValidNoticeCoordinate(n.coordinate), {
    message: "notice.coordinate must be 'org' or 'org/slug'",
  });

/**
 * Display thumbnail derived server-side from a release's first image/gif media
 * entry. Shared by the coverage, lookup, and related-release payloads.
 */
export const ReleaseThumbnailSchema = z.object({
  url: z.string(),
  alt: z.string().optional(),
});

export const OverviewPageItemSchema = z.object({
  scope: z.enum(["org", "product"]),
  orgSlug: z.string().nullable().optional(),
  productSlug: z.string().nullable().optional(),
  content: z.string(),
  releaseCount: z.number().int().min(0),
  lastContributingReleaseAt: z.string().nullable(),
  generatedAt: z.string(),
  updatedAt: z.string(),
  citations: z.array(OverviewCitationSchema).optional(),
});
