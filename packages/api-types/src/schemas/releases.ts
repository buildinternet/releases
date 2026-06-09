import { z } from "zod";
import { SOURCE_TYPES } from "@buildinternet/releases-core/source-enums";
import {
  AppStoreSourceInfoSchema,
  MediaItemSchema,
  ReleaseCompositionSchema,
  ReleaseTypeSchema,
  VideoSourceInfoSchema,
} from "./shared.js";

// ReleaseCompositionSchema lives in ./shared.js (single source of truth) — both
// this file and ReleaseItemSchema reference it from there.

/**
 * Per-row shape returned by `GET /v1/releases/latest`. Distinct from the
 * shared `ReleaseItemSchema` because the latest-feed handler joins the
 * source row in and exposes it as a nested `source` object instead of
 * leaving the caller to do a second lookup.
 *
 * `type` is required here — the latest handler reads it directly from
 * `releases.type` (NOT NULL with DB-default `'feature'`), so mid-deploy
 * degrade-gracefully nullability doesn't apply on this path.
 */
export const ReleaseLatestSourceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  type: z.enum(SOURCE_TYPES),
  orgSlug: z.string().nullable(),
  /** Owning org's display name (e.g. "Cloudflare"), distinct from the source
   *  name. Null when the source has no org. Additive — older responses omit it. */
  orgName: z.string().nullable().optional(),
});

export const ReleaseLatestProductSchema = z.object({
  slug: z.string(),
  name: z.string(),
});

export const ReleaseLatestItemSchema = z.object({
  id: z.string(),
  version: z.string().nullable(),
  type: ReleaseTypeSchema,
  title: z.string(),
  summary: z.string().nullable(),
  titleGenerated: z.string().nullable(),
  titleShort: z.string().nullable(),
  publishedAt: z.string().nullable(),
  url: z.string().nullable(),
  media: z.array(MediaItemSchema),
  source: ReleaseLatestSourceSchema,
  /**
   * Owning product, when the release's source is grouped under a product.
   * `null` when the source has no `product_id`. Additive — older API responses
   * omit this field; treat `undefined` as `null`. #1217.
   */
  product: ReleaseLatestProductSchema.nullable().optional(),
  coverageCount: z.number().int().min(0).optional(),
  // Cached release-body size hint — see {@link ReleaseItemSchema} for the
  // same fields on the org / collection feeds. #958.
  contentChars: z.number().int().min(0).nullable().optional(),
  contentTokens: z.number().int().min(0).nullable().optional(),
  composition: ReleaseCompositionSchema.nullable().optional(),
});

export const ReleaseLatestResponseSchema = z.object({
  releases: z.array(ReleaseLatestItemSchema),
});

/**
 * Display fields for the counterpart release a coverage row points at —
 * the canonical for a `coverage`-role response, or each rolled-up coverage
 * release for a `canonical`-role response. Lets `GET /releases/:id/coverage`
 * render a cluster without a follow-up `GET /releases/:id` per sibling.
 * `null` when the counterpart is suppressed or its source was removed.
 *
 * Coverage-side rows are surfaced here on purpose, even though the
 * `releases_visible` view (and thus `GET /releases/:id`) hides them — a
 * cluster view's whole job is to show its members.
 */
export const ReleaseCoverageSiblingSchema = z.object({
  id: z.string(),
  version: z.string().nullable(),
  title: z.string(),
  sourceName: z.string(),
  publishedAt: z.string().nullable(),
  org: z.object({ slug: z.string(), name: z.string() }).nullable(),
});

/**
 * Single row of the `release_coverage` join table. Drives the
 * GET /releases/:id/coverage response. `sibling` carries the counterpart
 * release's display fields (see {@link ReleaseCoverageSiblingSchema}); it is
 * optional so an older server that doesn't populate it still validates.
 */
export const ReleaseCoverageRowSchema = z.object({
  coverageId: z.string(),
  canonicalId: z.string(),
  reason: z.string().nullable(),
  decidedBy: z.string(),
  decidedAt: z.string(),
  sibling: ReleaseCoverageSiblingSchema.nullable().optional(),
});

/**
 * Discriminated by `role`:
 * - `standalone` — release is neither canonical nor coverage of anything.
 * - `coverage` — release is coverage rolling up to `canonical`.
 * - `canonical` — release is the canonical row; `covers` enumerates rollups.
 */
export const ReleaseCoverageResponseSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("standalone"),
    canonical: z.null(),
    covers: z.array(z.never()).length(0),
  }),
  z.object({
    role: z.literal("coverage"),
    canonical: ReleaseCoverageRowSchema,
    covers: z.array(z.never()).length(0),
  }),
  z.object({
    role: z.literal("canonical"),
    canonical: z.null(),
    covers: z.array(ReleaseCoverageRowSchema),
  }),
]);

/**
 * Body accepted by `POST /v1/releases/:id/coverage`. `decidedBy` MUST be
 * prefixed with `human:` or `agent:` so the audit trail records who linked
 * the rows; the handler enforces this with a regex.
 */
export const LinkReleaseCoverageBodySchema = z.object({
  coverageIds: z.array(z.string()).min(1),
  reason: z.string().nullable().optional(),
  decidedBy: z.string().regex(/^(human:|agent:)/),
});

export const LinkReleaseCoverageResponseSchema = z.object({
  canonicalId: z.string(),
  coverageIds: z.array(z.string()),
  linked: z.number().int().min(0),
});

/**
 * Response for `DELETE /v1/releases/:id/coverage`. Idempotent — the handler
 * returns `{ unlinked: false }` when the release isn't in a cluster, so the
 * remote client can skip a brittle error-message sniff.
 */
export const UnlinkReleaseCoverageResponseSchema = z.object({
  unlinked: z.boolean(),
});

/**
 * Row returned by `GET /v1/releases?hasMedia=true`. Internal/admin escape
 * hatch consumed by the `media backfill` CLI command.
 */
export const ReleaseWithMediaRowSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  media: z.string().nullable(),
});

export const ReleasesWithMediaResponseSchema = z.array(ReleaseWithMediaRowSchema);

/**
 * Nested org context joined into the `GET /v1/releases/:id` response.
 * Both fields are nullable — releases whose source has no org attached
 * return `null` for this object entirely.
 */
export const ReleaseDetailOrgSchema = z.object({
  slug: z.string(),
  name: z.string(),
  /**
   * Resolved org avatar URL (the `organizations.avatar_url` column). `null`
   * when the org has no stored avatar. Additive — older servers omit it, so
   * treat `undefined` as `null`. Mirrors the `orgAvatarUrl` field on the
   * related-rail feed.
   */
  avatarUrl: z.string().nullable().optional(),
});

/**
 * Full release detail returned by `GET /v1/releases/:id`. Joins source
 * name/slug/type and a nullable org object; media is parsed from the raw
 * JSON stored in D1 and typed URLs are rewritten to the CDN origin. The
 * route only surfaces non-suppressed, non-coverage rows (filtered via the
 * `releases_visible` view).
 */
export const ReleaseDetailResponseSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  version: z.string().nullable(),
  type: ReleaseTypeSchema,
  title: z.string(),
  content: z.string(),
  summary: z.string().nullable(),
  titleGenerated: z.string().nullable(),
  titleShort: z.string().nullable(),
  url: z.string().nullable(),
  contentHash: z.string().nullable(),
  media: z.array(MediaItemSchema),
  publishedAt: z.string().nullable(),
  suppressed: z.boolean().nullable(),
  suppressedReason: z.string().nullable(),
  prerelease: z.boolean().nullable(),
  fetchedAt: z.string().nullable(),
  sourceName: z.string().nullable(),
  sourceSlug: z.string().nullable(),
  sourceType: z.enum(SOURCE_TYPES).nullable(),
  org: ReleaseDetailOrgSchema.nullable(),
  /**
   * Owning product, when the release's source is grouped under a product
   * (`sources.product_id`). `null` when the source has no product. Additive —
   * older servers omit this field; treat `undefined` as `null`. Reuses the
   * `{ slug, name }` shape from the latest feed.
   */
  product: ReleaseLatestProductSchema.nullable().optional(),
  composition: ReleaseCompositionSchema.nullable(),
  appStore: AppStoreSourceInfoSchema.nullable().optional(),
  video: VideoSourceInfoSchema.nullable().optional(),
});

/**
 * Body accepted by `PATCH /v1/releases/:id`. All fields are optional;
 * omitted fields are not updated. The nullable string columns (`version`,
 * `url`, `publishedAt`, `contentHash`) accept a string or `null`. AI-generated
 * fields (`summary`, `titleGenerated`, `titleShort`) accept `null` to
 * explicitly clear the stored value. Non-whitelisted fields are rejected
 * via `.strict()` — the handler also re-runs the field-set check after
 * sanitization so an empty update payload still 400s.
 */
export const UpdateReleaseBodySchema = z
  .object({
    title: z.string().optional(),
    content: z.string().optional(),
    version: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    publishedAt: z.string().nullable().optional(),
    contentHash: z.string().nullable().optional(),
    summary: z.string().nullable().optional(),
    titleGenerated: z.string().nullable().optional(),
    titleShort: z.string().nullable().optional(),
    // `null` removes `$.composition` from metadata; an object replaces it.
    composition: ReleaseCompositionSchema.nullable().optional(),
  })
  .strict();

/**
 * Response returned by `PATCH /v1/releases/:id`. The handler returns the raw
 * Drizzle row from the `releases` table — distinct from the augmented
 * `ReleaseDetailResponseSchema` shape served by `GET /v1/releases/:id`, which
 * adds joined source/org metadata and parses `media` from raw JSON. Clients
 * that need the augmented shape after an edit should re-fetch via GET.
 */
export const ReleasePatchResponseSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  version: z.string().nullable(),
  type: ReleaseTypeSchema,
  title: z.string(),
  content: z.string(),
  summary: z.string().nullable(),
  titleGenerated: z.string().nullable(),
  titleShort: z.string().nullable(),
  url: z.string().nullable(),
  contentHash: z.string().nullable(),
  metadata: z.string().nullable(),
  // Raw JSON string of the media array — not parsed at this endpoint.
  media: z.string().nullable(),
  publishedAt: z.string().nullable(),
  prerelease: z.boolean().nullable(),
  suppressed: z.boolean().nullable(),
  suppressedReason: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  embeddedAt: z.string().nullable(),
});

/** Response returned by `DELETE /v1/releases/:id`. */
export const ReleaseDeleteResponseSchema = z.object({
  deleted: z.literal(true),
});

/** Response returned by `POST /v1/releases/:id/suppress`. */
export const ReleaseSuppressResponseSchema = z.object({
  suppressed: z.literal(true),
});

/** Response returned by `POST /v1/releases/:id/unsuppress`. */
export const ReleaseUnsuppressResponseSchema = z.object({
  unsuppressed: z.literal(true),
});

/**
 * Body accepted by `POST /v1/releases/:id/suppress`. The `reason` field
 * is optional; when omitted the stored `suppressed_reason` is set to null.
 */
export const ReleaseSuppressBodySchema = z.object({
  reason: z.string().optional(),
});

/**
 * WebSocket message schema for the `GET /v1/releases/stream` endpoint.
 * Each message is a JSON object with one of the following shapes:
 * - `{ type: "ready", seq: number }` — sent on connect to give the caller
 *   the current head sequence number for later resume.
 * - `{ type: "release.created", seq: number, release: object }` — a new
 *   release was indexed; `release` carries the full release row.
 * - `{ type: "snapshot_gap" }` — the requested `since` sequence fell
 *   behind the oldest buffered event; the client must REST-backfill.
 */
export const ReleaseStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), seq: z.number().int() }),
  z.object({
    type: z.literal("release.created"),
    seq: z.number().int(),
    release: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal("snapshot_gap") }),
]);
